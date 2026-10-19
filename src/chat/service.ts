import {
  CHAT_IMAGES_PER_MESSAGE,
  deliverImageBatches,
  imageBatchShouldSplit,
  uploadImageSlot,
  type SendImagesOptions,
  type SendImagesResult,
} from "../x/image-attachments.js";
import { log } from "../log.js";
import type { Store } from "../store.js";
import {
  CHAT_DELETE_BATCH_LIMIT,
  deleteErrorStatus,
  deleteRetryAfterMs,
  emptyDeleteBatch,
  isDeletePermissionError,
} from "./delete-batch.js";
import type {
  DeleteBatchResult,
  DeleteHint,
  DeleteResult,
  DeleteTarget,
  DmEvent,
  MediaCaption,
  OutboundAudio,
  OutboundImage,
  OutboundVideo,
  SendMessageResult,
} from "../types.js";
import { logDecryptErrors } from "./decrypt-log.js";
import {
  MISSING_KEY_VERSION_ATTEMPTS,
  latestKeyVersion,
  mergeConversationKeySets,
  missingConversationKeyVersion,
  missingKeyFetchCooldownMs,
} from "./conversation-keys.js";
import { isChatGroupId, watermarkKey } from "./ids.js";
import { groupIdsFromInboxPage } from "./listen.js";
import {
  CHAT_MEDIA_TYPE_AUDIO,
  CHAT_MEDIA_TYPE_VIDEO,
  type ChatCipher,
  type ChatMediaAttachment,
  type EncryptMessageOptions,
  type EncryptReplyOptions,
  type ConversationKeySet,
  type SigningKeyEntry,
} from "./cipher.js";
import { loadWasmModule } from "./wasm-engine.js";
import type { ChatHttp, RawChatEvent, RawChatEventsPage } from "./http.js";
import { chatEventToDm } from "./normalize.js";
import { newestRawId, nextWatermarkId, normalizeChatPage, rawEventsAfterWatermark } from "./raw.js";
import {
  DECRYPT_KEY_REFRESH_MIN_MS,
  EMPTY_REMOTE_PUBLIC_KEY_TTL_MS,
  REMOTE_PUBLIC_KEY_TTL_MS,
  formatPublicKeyFetchedAt,
  loadRemoteKeyCache,
  saveRemoteKeyCache,
  type CachedConversationKey,
  type CachedRemoteUser,
  type MissingKeyFetchRecord,
} from "./remote-key-cache.js";
import { boundSigningEntries } from "./signing-keys.js";
import {
  addConversationKeysBody,
  deleteMessagesBody,
  latestPublicKey,
  sendMessageBody,
  type RemotePublicKey,
} from "./wire.js";

const MAX_CATCHUP_PAGES = 4;
/** One INFO summary of public_keys fetches. Not one line per user. */
export const DEFAULT_PUBLIC_KEY_SUMMARY_INTERVAL_MS = 60 * 60 * 1000;
const MIN_PUBLIC_KEY_SUMMARY_INTERVAL_MS = 60 * 1000;
/** setInterval delays above this are treated as 1ms by Node. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;
/** Key-change blobs kept for a later decrypt. This is not an HTTP retry loop. */
const MAX_PENDING_KEY_BLOBS = 80;

/**
 * Max length of the base64 raw event passed as `replyToEvent`.
 *
 * chat-xdk embeds that signed event in the reply so recipients can validate
 * the preview. A message that is already a reply contains its parent, so
 * each hop of a reply-to-reply chain grows by about the parent length.
 * Fixture sizes in `tests/fixtures/sdk_vectors.json`: a text message is 428
 * bytes and a reply to it is 980. Encrypting a reply copies the parent into
 * the ciphertext and adds about 380 bytes (428 → 808, 980 → 1360). X then
 * rejects the POST with 400 "Message is too large". A live blackjack chain
 * (`!blackjack`, then `hit`, then `stand`) dies on that third reply.
 *
 * 4096 stays above the fixture message, the fixture reply, and a normal
 * command quote, and stops embedding once a nested raw event has pushed the
 * parent past a few kilobytes. The sequence id, sender, and preview text
 * still thread the reply. Override with `CHAT_REPLY_EVENT_MAX_BYTES`
 * (a non-negative integer). Anything else uses this default.
 */
export const DEFAULT_CHAT_REPLY_EVENT_MAX_BYTES = 4096;

/** `CHAT_REPLY_EVENT_MAX_BYTES`, or {@link DEFAULT_CHAT_REPLY_EVENT_MAX_BYTES}. */
export function chatReplyEventMaxBytes(): number {
  const raw = process.env.CHAT_REPLY_EVENT_MAX_BYTES?.trim();
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_CHAT_REPLY_EVENT_MAX_BYTES;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) return DEFAULT_CHAT_REPLY_EVENT_MAX_BYTES;
  return parsed;
}

/** How much of the parent quote `encryptReply` should carry. */
type ReplyQuote = "bounded" | "preview" | "none";

/**
 * X's 400 `{"errors":[{"message":"Message is too large"}]}` on
 * `POST /2/chat/conversations/:id/messages`. Other 400s are not this.
 */
export function isChatMessageTooLarge(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (!/message is too large/i.test(message)) return false;
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status?: unknown }).status;
    if (status === 400) return true;
    if (typeof status === "number") return false;
  }
  return /\b400\b/.test(message);
}

export interface ChatServiceOptions {
  /**
   * Disk cache for member public keys and recovered conversation keys.
   * Unset keeps this process memory-only (unit tests). Not the identity file.
   */
  remoteKeyCachePath?: string;
  now?: () => number;
  remoteKeyTtlMs?: number;
  emptyRemoteKeyTtlMs?: number;
  decryptRefreshMinMs?: number;
  /**
   * Polls that may hold the cursor for one missing conversation-key version.
   * Default is {@link MISSING_KEY_VERSION_ATTEMPTS}.
   */
  missingKeyAttempts?: number;
  /**
   * How often to log one public_keys summary. Default is 60 minutes.
   * The timer is unref'd so a short script is not held open.
   */
  publicKeySummaryIntervalMs?: number;
}

interface DecryptBatch {
  events: DmEvent[];
  errors: Record<string, string>;
  errorsByBlob: Map<string, string>;
  raws: RawChatEvent[];
}

export interface ChatPull {
  newestId?: string;
  /**
   * Set when the cursor should move. Absent when every new ciphertext failed
   * to decrypt — the poller must not skip those events.
   */
  watermarkId?: string;
  events: DmEvent[];
}

export class ChatService {
  private readonly signingByUser = new Map<string, SigningKeyEntry[]>();
  private readonly remoteByUser = new Map<string, RemotePublicKey[]>();
  /** When each user's public_keys list was last fetched successfully. */
  private readonly remoteFetchedAt = new Map<string, number>();
  /** Earliest time a decrypt failure may refresh this user's keys. */
  private readonly forceRefreshAfter = new Map<string, number>();
  /**
   * `fetchedAt` of a refresh that already ran because decrypt failed.
   * Further decrypt errors wait until the TTL replaces that fetch.
   */
  private readonly decryptRefreshedAt = new Map<string, number>();
  private readonly membersLoaded = new Set<string>();
  private readonly membersByConversation = new Map<string, string[]>();
  private readonly bindingWarned = new Set<string>();
  private readonly tokens = new Map<string, string>();
  /** Key-change blobs whose decrypt did not report an error. Failures are retried. */
  private readonly seenKeyEvents = new Set<string>();
  /**
   * Every conversation-key version this process has unwrapped.
   * Outbound encrypt uses the newest. Decrypt uses the version the message names.
   */
  private readonly conversationKeys = new Map<string, Map<string, Uint8Array>>();
  /** Polls spent trying to fetch one conversation-id + key-version pair. */
  private readonly missingKeyAttempts = new Map<string, number>();
  private readonly gaveUpKeyVersions = new Set<string>();
  private readonly skippedDecryptLogged = new Set<string>();
  /**
   * Older-page cursor for a missing KeyChange. At most one extra GET per
   * conversation per poll, and only for versions whose fetch cooldown has
   * expired. `fetched` is set once an older page has actually been read.
   */
  private readonly keyHunt = new Map<string, { nextToken?: string; exhausted: boolean; fetched: boolean }>();
  /** Key-change blobs from older pages that have not unwrapped yet. */
  private readonly pendingKeyBlobs = new Map<string, string[]>();
  /**
   * Persisted outcome of a missing-key events fetch, keyed by conversation
   * then key version. While `retryAt` is in the future that pair is not fetched.
   */
  private readonly missingKeyFetches = new Map<string, Map<string, MissingKeyFetchRecord>>();
  /** After public_keys 429/402, skip further fetches until this time. */
  private publicKeyBlockedUntil = 0;
  /** After a delete 429/402, skip further delete calls until this time. */
  private deleteBlockedUntil = 0;
  /**
   * Last successful public_keys GET. Seeded from the newest cached `fetched_at`
   * so a restart does not look like the route has been idle.
   */
  private lastPublicKeySuccessAt?: number;
  /** Successful public_keys GETs since this process started. Cache hits are not included. */
  private publicKeyFetchesOk = 0;
  /** Failed public_keys GETs since this process started. A backoff skip is not a fetch. */
  private publicKeyFetchesFailed = 0;
  /** Fetches since the last summary. Reset when that line is logged. */
  private publicKeyWindowOk = 0;
  private publicKeyWindowFailed = 0;
  /** Earliest `now()` that may log the next summary. */
  private nextPublicKeySummaryAt = 0;
  private readonly publicKeySummaryIntervalMs: number;
  private readonly remoteKeyCachePath?: string;
  private readonly now: () => number;
  private readonly remoteKeyTtlMs: number;
  private readonly emptyRemoteKeyTtlMs: number;
  private readonly decryptRefreshMinMs: number;
  private readonly missingKeyAttemptLimit: number;

  /**
   * In-memory public_keys / decrypt cache. Does not fetch and does not read disk.
   * Startup loads the disk cache into these maps before any public_keys request.
   * `backoffMs` is how long new signing-key loads stay blocked after a 429/402.
   */
  publicKeyHealth(nowMs = Date.now()): {
    cachedUsers: number;
    signingKeys: number;
    conversationKeys: number;
    backoffMs: number;
    lastSuccessAtMs?: number;
    fetchesOk: number;
    fetchesFailed: number;
  } {
    let signingKeys = 0;
    for (const entries of this.signingByUser.values()) signingKeys += entries.length;
    let conversationKeys = 0;
    for (const ring of this.conversationKeys.values()) conversationKeys += ring.size;
    return {
      cachedUsers: this.remoteByUser.size,
      signingKeys,
      conversationKeys,
      backoffMs: Math.max(0, this.publicKeyBlockedUntil - nowMs),
      lastSuccessAtMs: this.lastPublicKeySuccessAt,
      fetchesOk: this.publicKeyFetchesOk,
      fetchesFailed: this.publicKeyFetchesFailed,
    };
  }

  /** How long delete calls stay blocked after a 429/402. Zero when X can be called. */
  deleteBackoffMs(nowMs = this.now()): number {
    return Math.max(0, this.deleteBlockedUntil - nowMs);
  }

  constructor(
    private readonly http: ChatHttp,
    private readonly cipher: ChatCipher,
    private readonly store: Store,
    options?: ChatServiceOptions,
  ) {
    this.remoteKeyCachePath = options?.remoteKeyCachePath;
    this.now = options?.now ?? Date.now;
    this.remoteKeyTtlMs = options?.remoteKeyTtlMs ?? REMOTE_PUBLIC_KEY_TTL_MS;
    this.emptyRemoteKeyTtlMs = options?.emptyRemoteKeyTtlMs ?? EMPTY_REMOTE_PUBLIC_KEY_TTL_MS;
    this.decryptRefreshMinMs = options?.decryptRefreshMinMs ?? DECRYPT_KEY_REFRESH_MIN_MS;
    const attempts = options?.missingKeyAttempts;
    this.missingKeyAttemptLimit =
      typeof attempts === "number" && Number.isFinite(attempts) && attempts >= 1
        ? Math.floor(attempts)
        : MISSING_KEY_VERSION_ATTEMPTS;
    this.publicKeySummaryIntervalMs = resolvePublicKeySummaryIntervalMs(options?.publicKeySummaryIntervalMs);
    this.nextPublicKeySummaryAt = this.now() + this.publicKeySummaryIntervalMs;
    if (this.remoteKeyCachePath) this.hydrateRemoteKeyCache();
    this.armPublicKeySummary();
  }

  /**
   * Fetch the newest page (and older pages until the watermark is found).
   * Ciphertext at or before the watermark is not decrypted again. Ciphertext
   * newer than the watermark that fails to decrypt is retried next poll — the
   * cursor does not move past it. A failure that names a conversation-key
   * version this process does not hold triggers at most one older-page fetch
   * for this conversation on this poll. Each version is fetched once, then
   * waits out the cooldown stored beside the remote keys. After that version
   * is given up, the cursor moves past the ciphertext.
   * Returns moderation events strictly newer than `watermarkId`, oldest first.
   */
  async pullNew(
    conversationId: string,
    watermarkId: string | undefined,
    maxResults: number,
  ): Promise<ChatPull> {
    const pages = await this.loadPages(conversationId, watermarkId, maxResults);
    const newestId = newestRawId(pages[0]);
    const newer = rawEventsAfterWatermark(pages, watermarkId);
    const onlyEncoded = new Set<string>();
    for (const raw of newer) {
      if (raw.encoded_event) onlyEncoded.add(raw.encoded_event);
    }
    // First sight of a conversation seeds the watermark in the poller and does not replay.
    if (watermarkId === undefined) {
      await this.decryptPages(conversationId, pages, { onlyEncoded });
      return { newestId, events: [], watermarkId: newestId ?? "empty" };
    }

    let batch = await this.decryptPageBatch(conversationId, pages, { onlyEncoded, logErrors: false });
    const openMissing = () =>
      missingVersionsOn(newer, batch.errorsByBlob).filter(
        (version) => !this.gaveUpKeyVersions.has(missingKeyAttemptId(conversationId, version)),
      );
    let open = openMissing();
    if (open.length > 0) {
      const sought = open.filter((version) => !this.missingKeyFetchCoolingDown(conversationId, version));
      const versionsBefore = this.conversationKeys.get(conversationId)?.size ?? 0;
      let forced: string[] = [];
      let didFetch = false;
      if (sought.length > 0 && !this.publicKeyBackoffActive()) {
        try {
          const hunted = await this.huntMissingConversationKeys(conversationId, pages, maxResults);
          forced = hunted.blobs;
          didFetch = hunted.didFetch;
        } catch (error) {
          if (rateLimitWaitMs(error) !== undefined) {
            const wait = rateLimitWaitMs(error) ?? 15_000;
            this.publicKeyBlockedUntil = Math.max(this.publicKeyBlockedUntil, this.now() + wait);
            throw error;
          }
          this.noteMissingKeyFetches(conversationId, sought, "failed");
          throw error;
        }
      } else {
        forced = this.pendingKeyBlobs.get(conversationId) ?? [];
      }
      const learned = (this.conversationKeys.get(conversationId)?.size ?? 0) > versionsBefore;
      if (learned || forced.length > 0) {
        batch = await this.decryptPageBatch(conversationId, pages, {
          onlyEncoded,
          logErrors: false,
          forceKeyEvents: forced,
        });
      }
      if (didFetch) this.noteMissingKeyFetches(conversationId, sought, "not_found");
      open = openMissing();
      const blocked = this.publicKeyBackoffActive();
      for (const version of open) {
        if (blocked && !this.missingKeyFetchCoolingDown(conversationId, version)) continue;
        this.noteMissingKeyAttempt(conversationId, version);
      }
    }
    if (openMissing().length === 0) {
      this.keyHunt.delete(conversationId);
      this.pendingKeyBlobs.delete(conversationId);
    }
    this.reportDecryptErrors(conversationId, batch);

    const newIds = new Set(newer.map((raw) => raw.id).filter((id): id is string => Boolean(id)));
    const fresh = batch.events.filter((event) => newIds.has(event.id));
    const decryptedIds = new Set(fresh.map((event) => event.id));
    for (const raw of newer) {
      if (!raw.id || !raw.encoded_event || decryptedIds.has(raw.id)) continue;
      const message = batch.errorsByBlob.get(raw.encoded_event);
      const version = message ? missingConversationKeyVersion(message) : undefined;
      if (!version) continue;
      if (!this.gaveUpKeyVersions.has(missingKeyAttemptId(conversationId, version))) continue;
      this.warnSkippedCiphertext(conversationId, raw, version);
      decryptedIds.add(raw.id);
    }
    return {
      newestId,
      events: fresh.reverse(),
      watermarkId: nextWatermarkId(newer, decryptedIds, watermarkId),
    };
  }

  /**
   * One Activity push (`chat.received`). Same decrypt path as a poll page:
   * key-change blobs first, then `encoded_event`.
   */
  async ingestActivity(input: {
    conversationId: string;
    raw: RawChatEvent;
    keyEvents: string[];
  }): Promise<DmEvent[]> {
    const page: RawChatEventsPage = {
      data: [input.raw],
      meta: { conversation_key_events: input.keyEvents },
    };
    return this.decryptPages(input.conversationId, [normalizeChatPage(page)]);
  }

  /**
   * One page of `GET /2/chat/conversations`, reduced to encrypted group ids.
   * `supported` is false when this HTTP client has no inbox call.
   */
  async listInboxGroupIds(params: {
    maxResults?: number;
    paginationToken?: string;
  }): Promise<{ ids: string[]; nextToken?: string; supported: boolean }> {
    if (!this.http.listConversations) return { ids: [], supported: false };
    const page = await this.http.listConversations(params);
    const parsed = groupIdsFromInboxPage(page);
    return { ...parsed, supported: true };
  }

  async listHistory(params: {
    conversationId: string;
    maxResults?: number;
    paginationToken?: string;
  }): Promise<{ events: DmEvent[]; nextToken?: string }> {
    const page = await this.http.getConversationEvents(params.conversationId, {
      maxResults: params.maxResults,
      paginationToken: params.paginationToken,
    });
    const events = await this.decryptPages(params.conversationId, [page]);
    return { events, nextToken: page.meta?.next_token };
  }

  async sendText(
    conversationId: string,
    text: string,
    caption?: MediaCaption,
  ): Promise<SendMessageResult> {
    return this.postOutbound(conversationId, text, caption, undefined, (error) => {
      const message = error instanceof Error ? error.message : String(error);
      return new Error(
        `Cannot encrypt a Chat reply in ${conversationId}: ${message}. The bot needs a verified KeyChange (meta.conversation_key_events) wrapped to its registered public key. If this account was added before \`npm run chat:register\`, run \`npm run chat:rotate -- ${conversationId} --confirm\` so a new key is wrapped for every current member.`,
      );
    });
  }

  /**
   * Send an inline Chat photo (conversation bubble, not a file/document).
   * Mirrors xdevplatform/xchat-agent-skeleton: encryptStream, then
   * POST /2/chat/media/upload/*, then encryptMessage with attachment_type
   * "media" and media_type omitted so clients treat it as an image.
   * Throws on failure so the caller can post the https URL as text.
   * Does not use classic DM `dm_image`.
   *
   * `encryptMessage` requires a text argument. chat-xdk accepts `""`
   * (`build_message_content` still emits a payload). A caption, when set,
   * is that text (an `@handle` for adult posts) and is not an 18+ label.
   */
  async sendImage(conversationId: string, image: OutboundImage): Promise<SendMessageResult> {
    const bytes = image.bytes;
    if (!bytes || bytes.byteLength === 0) {
      throw new Error("No image bytes to attach to Chat.");
    }
    const inspected = await inspectChatImage(bytes, image.mimeType);
    return this.sendChatMedia(
      conversationId,
      bytes,
      {
        width: inspected.width,
        height: inspected.height,
        filename: inspected.filename,
      },
      image.caption,
    );
  }

  /**
   * Several inline photos on as few Chat messages as X will take.
   * Each file is encrypted and uploaded on its own. One `encryptMessage`
   * lists up to `CHAT_IMAGES_PER_MESSAGE` attachments. Filenames are
   * numbered when there is more than one image, because clients cache
   * decrypted media by filename. A 429 or 402 stops the rest. A 400
   * `Message is too large` splits the message in half.
   */
  async sendImages(
    conversationId: string,
    images: readonly OutboundImage[],
    options?: SendImagesOptions,
  ): Promise<SendImagesResult> {
    const latest = this.latestConversationKey(conversationId);
    if (!latest) {
      throw new Error(
        `No conversation key cached for ${conversationId}. The bot must decrypt a KeyChange before sending Chat media.`,
      );
    }
    const prepared: ChatMediaAttachment[] = [];
    let uploadLimited: SendImagesResult["rateLimited"];
    let index = 0;
    const numberNames = images.length > 1;
    for (const image of images) {
      const slot = await uploadImageSlot(
        image,
        async (current) => {
          const bytes = current.bytes;
          if (!bytes || bytes.byteLength === 0) return undefined;
          index += 1;
          const inspected = await inspectChatImage(bytes, current.mimeType);
          const ciphertext = this.cipher.encryptStream(bytes, latest.key);
          if (ciphertext.byteLength === 0) {
            throw new Error("Chat media encryption produced empty ciphertext.");
          }
          const mediaHashKey = await this.http.uploadChatMedia(conversationId, ciphertext);
          return {
            mediaHashKey,
            width: inspected.width,
            height: inspected.height,
            filesizeBytes: bytes.byteLength,
            filename: numberNames ? numberedChatFilename(inspected.filename, index) : inspected.filename,
          };
        },
        options?.substitute,
      );
      if (slot.rateLimited) {
        uploadLimited = slot.rateLimited;
        break;
      }
      if (slot.value) prepared.push(slot.value);
    }
    const caption = images.find((image) => image.caption)?.caption;
    const delivered = await deliverImageBatches({
      items: prepared,
      perMessage: CHAT_IMAGES_PER_MESSAGE,
      splitOn: imageBatchShouldSplit,
      send: (batch) =>
        this.postOutbound(
          conversationId,
          caption?.text ?? "",
          caption,
          {
            conversationKey: latest.key,
            conversationKeyVersion: latest.version,
            attachments: [...batch],
          },
          (error) => {
            const message = error instanceof Error ? error.message : String(error);
            return new Error(`Cannot encrypt a Chat image in ${conversationId}: ${message}`);
          },
        ),
    });
    if (uploadLimited && !delivered.rateLimited) delivered.rateLimited = uploadLimited;
    return delivered;
  }

  /**
   * Inline Chat video. Same encrypt-and-upload path as `sendImage`, with
   * `media_type` 3 so clients play an mp4 instead of treating the bytes as a photo.
   * Throws on failure so the caller can post the temporary https URL.
   */
  async sendVideo(conversationId: string, video: OutboundVideo): Promise<SendMessageResult> {
    const bytes = video.bytes;
    if (!bytes || bytes.byteLength === 0) {
      throw new Error("No video bytes to attach to Chat.");
    }
    const width = positiveEven(video.width) ?? 1280;
    const height = positiveEven(video.height) ?? 720;
    return this.sendChatMedia(
      conversationId,
      bytes,
      {
        width,
        height,
        filename: "video.mp4",
        mediaType: CHAT_MEDIA_TYPE_VIDEO,
      },
      video.caption,
    );
  }

  /**
   * Inline Chat audio. Same encrypt-and-upload path as `sendVideo`, with
   * `media_type` 4 so clients treat the mp3 as audio (chat-xdk `MediaType::Audio`).
   * Width and height are required by the attachment descriptor; audio has no frame,
   * so they are 1. `duration_millis` is an estimate from the default 128 kbps MP3.
   * Throws on failure. There is no temporary URL to post instead.
   */
  async sendAudio(conversationId: string, audio: OutboundAudio): Promise<SendMessageResult> {
    const bytes = audio.bytes;
    if (!bytes || bytes.byteLength === 0) {
      throw new Error("No audio bytes to attach to Chat.");
    }
    const duration = positiveDuration(audio.durationMillis) ?? 1;
    return this.sendChatMedia(
      conversationId,
      bytes,
      {
        width: 1,
        height: 1,
        filename: "voice.mp3",
        mediaType: CHAT_MEDIA_TYPE_AUDIO,
        durationMillis: duration,
      },
      audio.caption,
    );
  }

  /**
   * Encrypt and POST one Chat message.
   * A reply that X rejects as too large is retried once with the sequence id
   * and preview text only, then once as a normal message carrying the same
   * text. One warning is logged for that fallback. The warning has no message
   * text and no raw event.
   */
  private async postOutbound(
    conversationId: string,
    text: string,
    caption: MediaCaption | undefined,
    extra: EncryptMessageOptions | undefined,
    encryptFailed: (error: unknown) => Error,
  ): Promise<SendMessageResult> {
    const reply = caption?.replyTo;
    const quoting = Boolean(reply && (reply.rawEvent || reply.sequenceId));
    let quote: ReplyQuote = quoting ? "bounded" : "none";
    let warned = false;
    for (;;) {
      if (quote === "preview" && !reply?.sequenceId) quote = "none";
      let payload: ReturnType<ChatCipher["encryptMessage"]>;
      try {
        payload = this.encryptOutbound(conversationId, text, caption, extra, quote);
      } catch (error) {
        throw encryptFailed(error);
      }
      const body = sendMessageBody(payload, this.tokens.get(conversationId));
      try {
        const sent = await this.http.sendChatMessage(conversationId, body);
        const dmEventId = sent.messageId || payload.messageId;
        const sequenceId =
          sent.sequenceId?.trim() ||
          this.sequenceIdFromEncodedEvent(conversationId, sent.encodedMessageEvent);
        if (sequenceId) {
          this.store.rememberChatMessage(dmEventId, conversationId, sequenceId);
        }
        return {
          dmEventId,
          dmConversationId: conversationId,
          ...(sequenceId ? { sequenceId } : {}),
        };
      } catch (error) {
        const lighter: ReplyQuote | undefined =
          quoting && isChatMessageTooLarge(error) ? nextReplyQuote(quote) : undefined;
        if (!lighter) throw error;
        if (!warned) {
          warned = true;
          log.warn(
            `Chat reply was too large for X; resending without the embedded quote. conversation=${conversationId}`,
          );
        }
        quote = lighter;
      }
    }
  }

  /**
   * `encryptReply` when the caption names a Chat message. Otherwise
   * `encryptMessage`. A mention entity is the `@handle` byte range.
   * `bounded` omits `replyToEvent` once the raw event exceeds
   * {@link chatReplyEventMaxBytes}. `preview` keeps the sequence id and
   * preview text only. `none` is a normal message.
   */
  private encryptOutbound(
    conversationId: string,
    text: string,
    caption?: MediaCaption,
    extra?: EncryptMessageOptions,
    quote: ReplyQuote = "bounded",
  ): ReturnType<ChatCipher["encryptMessage"]> {
    const mention = caption?.mention;
    const entities = mention
      ? ([[mention.start, mention.end, "mention"]] as EncryptReplyOptions["entities"])
      : undefined;
    const saved = this.savedOutboundKey(conversationId, extra);
    const options: EncryptReplyOptions = {
      ...saved,
      ...extra,
      ...(entities ? { entities } : {}),
    };
    const reply = quote === "none" ? undefined : caption?.replyTo;
    if (reply && (reply.rawEvent || reply.sequenceId)) {
      if (quote === "preview") {
        if (reply.sequenceId) {
          return this.cipher.encryptReply(conversationId, text, {
            ...options,
            replyToSequenceId: reply.sequenceId,
            ...(reply.previewText ? { replyToText: reply.previewText } : {}),
          });
        }
      } else {
        const rawEvent =
          reply.rawEvent && reply.rawEvent.length <= chatReplyEventMaxBytes()
            ? reply.rawEvent
            : undefined;
        if (rawEvent || reply.sequenceId) {
          return this.cipher.encryptReply(conversationId, text, {
            ...options,
            ...(rawEvent ? { replyToEvent: rawEvent } : {}),
            ...(reply.sequenceId ? { replyToSequenceId: reply.sequenceId } : {}),
            ...(reply.senderId ? { replyToSenderId: reply.senderId } : {}),
            ...(reply.previewText ? { replyToText: reply.previewText } : {}),
          });
        }
      }
    }
    const hasOptions = Boolean(extra || entities || saved.conversationKey);
    return this.cipher.encryptMessage(conversationId, text, hasOptions ? options : undefined);
  }

  /**
   * encryptStream, upload the ciphertext, then send an inline media attachment.
   * `mediaType` omitted means an image. Video passes `CHAT_MEDIA_TYPE_VIDEO`.
   * Audio passes `CHAT_MEDIA_TYPE_AUDIO`.
   */
  private async sendChatMedia(
    conversationId: string,
    bytes: Uint8Array,
    attachment: Pick<
      ChatMediaAttachment,
      "width" | "height" | "filename" | "mediaType" | "durationMillis"
    >,
    caption?: MediaCaption,
  ): Promise<SendMessageResult> {
    const latest = this.latestConversationKey(conversationId);
    if (!latest) {
      throw new Error(
        `No conversation key cached for ${conversationId}. The bot must decrypt a KeyChange before sending Chat media.`,
      );
    }
    const ciphertext = this.cipher.encryptStream(bytes, latest.key);
    if (ciphertext.byteLength === 0) {
      throw new Error("Chat media encryption produced empty ciphertext.");
    }
    const mediaHashKey = await this.http.uploadChatMedia(conversationId, ciphertext);
    const label = mediaLabel(attachment.mediaType);
    return this.postOutbound(
      conversationId,
      caption?.text ?? "",
      caption,
      {
        conversationKey: latest.key,
        conversationKeyVersion: latest.version,
        attachments: [
          {
            mediaHashKey,
            width: attachment.width,
            height: attachment.height,
            filesizeBytes: bytes.byteLength,
            filename: attachment.filename,
            ...(attachment.mediaType !== undefined ? { mediaType: attachment.mediaType } : {}),
            ...(attachment.durationMillis !== undefined ? { durationMillis: attachment.durationMillis } : {}),
          },
        ],
      },
      (error) => {
        const message = error instanceof Error ? error.message : String(error);
        return new Error(`Cannot encrypt a Chat ${label} in ${conversationId}: ${message}`);
      },
    );
  }

  async deleteEvent(eventId: string, hint?: DeleteHint): Promise<DeleteResult> {
    const indexed = this.store.lookupChatMessage(eventId);
    const conversationId = hint?.conversationId || indexed?.conversationId;
    if (!conversationId || !isChatGroupId(conversationId)) {
      return {
        deleted: false,
        error: "Not an encrypted Chat message this process has indexed.",
      };
    }
    const batch = await this.deleteMessages(conversationId, [
      { eventId, sequenceId: hint?.sequenceId || indexed?.sequenceId },
    ]);
    return deleteResultFromBatch(eventId, batch);
  }

  /**
   * Delete every target that has a sequence id, in as few requests as possible.
   * One action signature covers each chunk of {@link CHAT_DELETE_BATCH_LIMIT}.
   * A 429 or 402 stops the rest of the list and arms {@link deleteBackoffMs}.
   * A later call inside that window does not hit X.
   * Any other 4xx (and a 200 that reports `deleted: false`) splits the chunk
   * in half down to one id, so one undeletable message does not sink the rest.
   * A 429 at any split level stops immediately.
   */
  async deleteMessages(
    conversationId: string,
    targets: readonly DeleteTarget[],
  ): Promise<DeleteBatchResult> {
    const result = emptyDeleteBatch();
    const ready: { eventId: string; sequenceId: string }[] = [];
    for (const target of targets) {
      const eventId = target.eventId?.trim();
      if (!eventId) continue;
      const sequenceId =
        target.sequenceId?.trim() || this.store.lookupChatMessage(eventId)?.sequenceId?.trim();
      if (!sequenceId) {
        result.missingSequenceIds.push(eventId);
        continue;
      }
      ready.push({ eventId, sequenceId });
    }
    if (ready.length === 0) return result;

    const blockedFor = this.deleteBlockedUntil - this.now();
    if (blockedFor > 0) {
      result.blocked = { retryAfterMs: blockedFor };
      result.rateLimited = {
        retryAfterMs: blockedFor,
        skippedIds: ready.map((target) => target.eventId),
      };
      log.info(
        `Chat delete skipped in ${conversationId}; backoff has ${blockedFor}ms left`,
      );
      return result;
    }

    for (let offset = 0; offset < ready.length; offset += CHAT_DELETE_BATCH_LIMIT) {
      const chunk = ready.slice(offset, offset + CHAT_DELETE_BATCH_LIMIT);
      const outcome = await this.deleteChunk(conversationId, chunk, result);
      if (outcome === "stop") {
        const rest = ready.slice(offset + chunk.length);
        this.addSkipped(result, rest);
        break;
      }
    }
    return result;
  }

  /**
   * Sequence id from a send, when X put one on the JSON or inside
   * `encoded_message_event`. The documented send body only requires
   * `encoded_message_event` and does not include `sequence_id`. Decrypt
   * yields a sequence only when that blob actually carries one.
   */
  private sequenceIdFromEncodedEvent(
    conversationId: string,
    encoded: string | undefined,
  ): string | undefined {
    const blob = encoded?.trim();
    if (!blob) return undefined;
    try {
      const signingKeys = this.currentSigningKeys();
      const decrypted = this.cipher.decryptEvents(
        [blob],
        signingKeys.length > 0 ? signingKeys : undefined,
        this.conversationKeySet(conversationId),
      );
      const sequence = decrypted.messages[0]?.event.sequenceId;
      return typeof sequence === "string" && sequence.trim() ? sequence.trim() : undefined;
    } catch (error) {
      log.warn("Chat send response could not be decrypted for a sequence id", error);
      return undefined;
    }
  }

  private async deleteChunk(
    conversationId: string,
    targets: readonly { eventId: string; sequenceId: string }[],
    result: DeleteBatchResult,
  ): Promise<"ok" | "stop"> {
    if (targets.length === 0) return "ok";
    const blockedFor = this.deleteBlockedUntil - this.now();
    if (blockedFor > 0) {
      this.addSkipped(result, targets, blockedFor);
      if (!result.blocked) result.blocked = { retryAfterMs: blockedFor };
      return "stop";
    }
    const sequenceIds = targets.map((target) => target.sequenceId);
    try {
      const signature = this.cipher.prepareMessageDelete(conversationId, sequenceIds, true);
      const body = deleteMessagesBody(signature, this.cipher.signingPublicKey(), sequenceIds, true);
      const response = await this.http.deleteChatMessages(conversationId, body);
      if (!response.deleted) {
        return this.failChunk(conversationId, targets, result, {
          message: "X did not delete those messages.",
          splittable: true,
        });
      }
      for (const target of targets) result.deletedIds.push(target.eventId);
      return "ok";
    } catch (error) {
      const wait = deleteRetryAfterMs(error);
      if (wait !== undefined) {
        this.deleteBlockedUntil = this.now() + wait;
        this.addSkipped(result, targets, wait);
        log.warn(
          `Chat delete rate limited in ${conversationId}; retry after ${wait}ms (${targets.length} sequence id(s) not retried)`,
        );
        return "stop";
      }
      const status = deleteErrorStatus(error);
      const message = error instanceof Error ? error.message : String(error);
      const splittable = status !== undefined && status >= 400 && status < 500;
      return this.failChunk(conversationId, targets, result, { status, message, splittable });
    }
  }

  private failChunk(
    conversationId: string,
    targets: readonly { eventId: string; sequenceId: string }[],
    result: DeleteBatchResult,
    failure: { status?: number; message: string; splittable: boolean },
  ): Promise<"ok" | "stop"> {
    if (failure.splittable && targets.length > 1) {
      const mid = Math.floor(targets.length / 2);
      return this.splitChunk(conversationId, targets, mid, result);
    }
    for (const target of targets) result.rejectedIds.push(target.eventId);
    if (isDeletePermissionError(failure.status, failure.message)) result.permissionDenied = true;
    const ids = targets.map((target) => target.eventId).join(", ");
    log.warn(
      `Chat delete failed in ${conversationId} for ${ids}: ${failure.message}`,
    );
    return Promise.resolve("ok");
  }

  private async splitChunk(
    conversationId: string,
    targets: readonly { eventId: string; sequenceId: string }[],
    mid: number,
    result: DeleteBatchResult,
  ): Promise<"ok" | "stop"> {
    const left = await this.deleteChunk(conversationId, targets.slice(0, mid), result);
    if (left === "stop") {
      this.addSkipped(result, targets.slice(mid));
      return "stop";
    }
    return this.deleteChunk(conversationId, targets.slice(mid), result);
  }

  private addSkipped(
    result: DeleteBatchResult,
    targets: readonly { eventId: string }[],
    retryAfterMs?: number,
  ): void {
    if (targets.length === 0) return;
    const ids = targets.map((target) => target.eventId);
    const wait = retryAfterMs ?? result.rateLimited?.retryAfterMs ?? this.deleteBackoffMs();
    if (!result.rateLimited) {
      result.rateLimited = { retryAfterMs: wait, skippedIds: [...ids] };
      return;
    }
    if (retryAfterMs !== undefined) result.rateLimited.retryAfterMs = retryAfterMs;
    for (const id of ids) {
      if (!result.rateLimited.skippedIds.includes(id)) result.rateLimited.skippedIds.push(id);
    }
  }

  knows(eventId: string): boolean {
    return Boolean(this.store.lookupChatMessage(eventId));
  }

  /**
   * Rotate the conversation key and wrap it for every member we can see.
   * The chat-xdk keeps only the highest version per user, so this process's
   * loaded identity is the only key submitted for the bot. Other members get
   * every registered version (the SDK wraps their newest). Aborts without
   * posting when that loaded key is older than the account's latest key,
   * unless `force` is set.
   */
  async rotateConversationKey(
    conversationId: string,
    options?: { force?: boolean },
  ): Promise<void> {
    const memberIds = await this.http.getMemberIds(conversationId);
    if (memberIds.length === 0) {
      throw new Error(
        `GET /2/chat/conversations/${conversationId} returned no member ids, so a key rotation would lock people out. Aborting.`,
      );
    }
    const identity = this.cipher.loadedIdentity();
    const publicKeys: { userId: string; publicKey: string; keyVersion: string }[] = [];
    for (const userId of memberIds) {
      const keys = await this.loadRemoteKeys(userId, { refresh: true });
      if (identity && userId === identity.userId) {
        const loaded = selectLoadedKey(keys, identity, (publicKey) =>
          this.cipher.matchesRegisteredKey(publicKey),
        );
        if (!loaded) {
          throw new Error(
            `Loaded Chat identity version ${identity.version} is not on this account. Register that key (\`npm run chat:register\`) or unlock the account's current key with CHAT_PIN (Juicebox) before rotating ${conversationId}.`,
          );
        }
        const latest = latestPublicKey(keys);
        if (
          latest &&
          latest.publicKeyVersion !== loaded.publicKeyVersion &&
          !options?.force
        ) {
          throw new Error(
            `Refusing to rotate ${conversationId}: this process holds public key version ${loaded.publicKeyVersion}, but the account's latest key is ${latest.publicKeyVersion}. chat-xdk wraps only the newest key it is given, so a rotate aimed at the browser/Juicebox key cannot be decrypted by the file this process loaded. Unlock Juicebox with CHAT_PIN so the process matches that newer key, or re-run with --force to wrap version ${loaded.publicKeyVersion} (the newer key will not read messages under the rotated conversation key).`,
          );
        }
        publicKeys.push({
          userId,
          publicKey: loaded.publicKey,
          keyVersion: loaded.publicKeyVersion,
        });
        continue;
      }
      if (keys.length === 0) {
        throw new Error(
          `No public key for member ${userId}. Aborting rotation so that member is not locked out of ${conversationId}.`,
        );
      }
      for (const key of keys) {
        publicKeys.push({
          userId,
          publicKey: key.publicKey,
          keyVersion: key.publicKeyVersion,
        });
      }
    }
    const prepared = this.cipher.prepareConversationKeyChange({
      conversationId,
      publicKeys,
    });
    await this.http.addConversationKeys(
      conversationId,
      addConversationKeysBody(prepared, this.cipher.signingPublicKey()),
    );
    const versions = publicKeys.map((key) => `${key.userId}:${key.keyVersion}`).join(", ");
    log.info(
      `Posted a Chat key rotation for ${conversationId} covering ${publicKeys.length} public key(s) [${versions}] (conversation key ${prepared.conversationKeyVersion}).`,
    );
  }

  private async loadPages(
    conversationId: string,
    watermarkId: string | undefined,
    maxResults: number,
  ): Promise<RawChatEventsPage[]> {
    const pages: RawChatEventsPage[] = [];
    let token: string | undefined;
    for (let pageIndex = 0; pageIndex < MAX_CATCHUP_PAGES; pageIndex += 1) {
      const page = normalizeChatPage(
        await this.http.getConversationEvents(conversationId, {
          maxResults,
          paginationToken: token,
        }),
      );
      pages.push(page);
      if (watermarkId === undefined) break;
      const ids = (page.data ?? []).map((event) => event.id).filter((id): id is string => Boolean(id));
      const found = watermarkId === "empty" || ids.includes(watermarkId);
      token = page.meta?.next_token;
      if (found || !token) break;
    }
    return pages;
  }

  private async decryptPages(
    conversationId: string,
    pages: RawChatEventsPage[],
    options?: { onlyEncoded?: ReadonlySet<string> },
  ): Promise<DmEvent[]> {
    return (await this.decryptPageBatch(conversationId, pages, options)).events;
  }

  private async decryptPageBatch(
    conversationId: string,
    pages: RawChatEventsPage[],
    options?: {
      onlyEncoded?: ReadonlySet<string>;
      logErrors?: boolean;
      /** Key-change blobs to include even when they were already seen. */
      forceKeyEvents?: readonly string[];
    },
  ): Promise<DecryptBatch> {
    const membersReady = await this.ensureMemberKeys(conversationId);
    const normalized = pages.map((page) => normalizeChatPage(page));
    const includeEncoded = (raw: RawChatEvent): boolean => {
      if (!options?.onlyEncoded) return true;
      return Boolean(raw.encoded_event && options.onlyEncoded.has(raw.encoded_event));
    };

    const senderIds = new Set<string>();
    let newestToken: string | undefined;
    for (const page of normalized) {
      for (const raw of page.data ?? []) {
        if (!includeEncoded(raw)) continue;
        if (raw.sender_id) senderIds.add(raw.sender_id);
      }
    }
    for (const page of normalized) {
      for (const raw of page.data ?? []) {
        if (!newestToken && raw.conversation_token) newestToken = raw.conversation_token;
      }
    }
    if (newestToken) this.tokens.set(conversationId, newestToken);
    await this.ensureSigningKeys([...senderIds]);

    const encoded: string[] = [];
    const freshKeys: string[] = [];
    const pushKey = (keyEvent: string) => {
      if (!keyEvent || encoded.includes(keyEvent)) return;
      freshKeys.push(keyEvent);
      encoded.push(keyEvent);
    };
    for (const page of normalized) {
      for (const keyEvent of page.meta?.conversation_key_events ?? []) {
        if (!keyEvent || this.seenKeyEvents.has(keyEvent)) continue;
        pushKey(keyEvent);
      }
    }
    for (const keyEvent of options?.forceKeyEvents ?? []) pushKey(keyEvent);
    const raws: RawChatEvent[] = [];
    for (const page of normalized) {
      for (const raw of page.data ?? []) {
        if (!includeEncoded(raw)) continue;
        raws.push(raw);
        if (raw.encoded_event && !encoded.includes(raw.encoded_event)) encoded.push(raw.encoded_event);
      }
    }

    const empty: DecryptBatch = { events: [], errors: {}, errorsByBlob: new Map(), raws };
    if (encoded.length === 0) return empty;
    const signingKeys = this.currentSigningKeys();
    const prior = this.conversationKeySet(conversationId);
    const result = this.cipher.decryptEvents(
      encoded,
      signingKeys.length > 0 ? signingKeys : undefined,
      prior,
    );
    this.rememberConversationKeys(conversationId, result.conversationKeys);
    if (decryptErrorsNeedKeyRefresh(result.errors)) {
      this.noteDecryptKeyFailure(conversationId, senderIds);
    }
    const errorsByBlob = errorsByEncodedBlob(encoded, result.errors);
    if (options?.logErrors !== false) {
      this.reportDecryptErrors(conversationId, { errors: result.errors, errorsByBlob, events: [], raws });
    }
    if (membersReady) {
      const failed = failedDecryptBlobs(encoded, result.errors);
      for (const keyEvent of freshKeys) {
        if (!failed.has(keyEvent)) this.seenKeyEvents.add(keyEvent);
      }
    }
    const byB64 = new Map<string, (typeof result.messages)[number]["event"]>();
    for (const message of result.messages) {
      if (message.originalB64) byB64.set(message.originalB64, message.event);
    }

    const events: DmEvent[] = [];
    for (const raw of raws) {
      const decrypted = raw.encoded_event ? byB64.get(raw.encoded_event) : undefined;
      const dm = chatEventToDm(conversationId, raw, decrypted);
      if (!dm) continue;
      this.store.rememberChatMessage(dm.id, dm.conversationId, dm.sequenceId, dm.createdAt);
      const sentId = decrypted?.id?.trim();
      if (sentId && sentId !== dm.id) {
        this.store.rememberChatMessage(sentId, dm.conversationId, dm.sequenceId, dm.createdAt);
      }
      events.push(dm);
    }
    return { events, errors: result.errors, errorsByBlob, raws };
  }

  /**
   * One extra events page when a ciphertext names a key version we have not
   * unwrapped. KeyChange blobs from that page are decrypted, then the caller
   * retries the messages. A 429/402 propagates so the poller applies its backoff.
   * Returns the blobs that were fed to decrypt, including ones still pending
   * from an earlier page.
   */
  private async huntMissingConversationKeys(
    conversationId: string,
    pages: RawChatEventsPage[],
    maxResults: number,
  ): Promise<{ blobs: string[]; didFetch: boolean }> {
    const state = this.keyHunt.get(conversationId) ?? { exhausted: false, fetched: false };
    const pending = this.pendingKeyBlobs.get(conversationId) ?? [];
    let fetched: RawChatEventsPage | undefined;
    let didFetch = false;
    if (!state.exhausted && !this.publicKeyBackoffActive()) {
      const token = state.nextToken ?? pages.at(-1)?.meta?.next_token;
      if (token) {
        fetched = normalizeChatPage(
          await this.http.getConversationEvents(conversationId, {
            maxResults,
            paginationToken: token,
          }),
        );
        didFetch = true;
        const next = fetched.meta?.next_token;
        this.keyHunt.set(conversationId, {
          nextToken: next,
          exhausted: !next,
          fetched: true,
        });
      }
    }

    const metaKeys = (fetched?.meta?.conversation_key_events ?? []).filter((blob): blob is string => Boolean(blob));
    const timeline = (fetched?.data ?? [])
      .map((raw) => raw.encoded_event)
      .filter((blob): blob is string => Boolean(blob));
    const blobs = uniqueStrings([...pending, ...metaKeys, ...timeline]);
    if (blobs.length === 0) return { blobs: pending, didFetch };

    const absorbed = await this.decryptPageBatch(
      conversationId,
      [{ data: [], meta: { conversation_key_events: blobs } }],
      { logErrors: false },
    );
    const retain = new Set<string>([...pending, ...metaKeys]);
    for (const blob of timeline) {
      const error = absorbed.errorsByBlob.get(blob);
      if (!error) continue;
      if (missingConversationKeyVersion(error)) continue;
      retain.add(blob);
    }
    const stillPending = [...retain].filter((blob) => !this.seenKeyEvents.has(blob)).slice(-MAX_PENDING_KEY_BLOBS);
    if (stillPending.length > 0) this.pendingKeyBlobs.set(conversationId, stillPending);
    else this.pendingKeyBlobs.delete(conversationId);
    return { blobs, didFetch };
  }

  private publicKeyBackoffActive(): boolean {
    return this.publicKeyBlockedUntil > this.now();
  }

  private missingKeyFetchCoolingDown(conversationId: string, version: string): boolean {
    const record = this.missingKeyFetches.get(conversationId)?.get(version);
    if (!record) return false;
    return this.now() < record.retryAt;
  }

  /**
   * One recorded fetch for each version still missing after the events page
   * came back. Versions unwrapped by that page are cleared instead.
   */
  private noteMissingKeyFetches(
    conversationId: string,
    versions: readonly string[],
    outcome: MissingKeyFetchRecord["outcome"],
  ): void {
    let changed = false;
    for (const version of versions) {
      if (this.hasConversationKey(conversationId, version)) {
        if (this.clearMissingKeyFetch(conversationId, version)) changed = true;
        continue;
      }
      let byVersion = this.missingKeyFetches.get(conversationId);
      if (!byVersion) {
        byVersion = new Map();
        this.missingKeyFetches.set(conversationId, byVersion);
      }
      const attempts = (byVersion.get(version)?.attempts ?? 0) + 1;
      byVersion.set(version, {
        attempts,
        retryAt: this.now() + missingKeyFetchCooldownMs(attempts),
        outcome,
      });
      changed = true;
    }
    if (changed) this.persistRemoteKeyCache();
  }

  private clearMissingKeyFetch(conversationId: string, version: string): boolean {
    const byVersion = this.missingKeyFetches.get(conversationId);
    if (!byVersion?.delete(version)) return false;
    if (byVersion.size === 0) this.missingKeyFetches.delete(conversationId);
    return true;
  }

  private noteMissingKeyAttempt(conversationId: string, version: string): void {
    const id = missingKeyAttemptId(conversationId, version);
    if (this.gaveUpKeyVersions.has(id) || this.hasConversationKey(conversationId, version)) return;
    const next = (this.missingKeyAttempts.get(id) ?? 0) + 1;
    this.missingKeyAttempts.set(id, next);
    const hunt = this.keyHunt.get(conversationId);
    const pending = this.pendingKeyBlobs.get(conversationId) ?? [];
    const confirmedUnavailable = Boolean(hunt?.exhausted && hunt.fetched && pending.length === 0);
    if (next >= this.missingKeyAttemptLimit || confirmedUnavailable) {
      this.gaveUpKeyVersions.add(id);
    }
  }

  private warnSkippedCiphertext(conversationId: string, raw: RawChatEvent, version: string): void {
    const eventId = raw.id ?? "unknown";
    const mark = `${conversationId}\0${eventId}\0${version}`;
    if (this.skippedDecryptLogged.has(mark)) return;
    this.skippedDecryptLogged.add(mark);
    const senderId = raw.sender_id?.trim() || "unknown";
    const createdAt = raw.created_at?.trim() || "unknown";
    log.warn(
      `Skipped undecryptable Chat event ${eventId} in ${conversationId} from sender ${senderId} created at ${createdAt} (key version ${version}).`,
    );
  }

  private reportDecryptErrors(conversationId: string, batch: DecryptBatch): void {
    const messageFailed = batch.raws.some(
      (raw) => Boolean(raw.encoded_event && batch.errorsByBlob.has(raw.encoded_event)),
    );
    const firstSight =
      messageFailed && this.store.getWatermark(watermarkKey(conversationId)) === undefined;
    logDecryptErrors(conversationId, batch.errors, Date.now(), { firstSight });
  }

  private savedOutboundKey(
    conversationId: string,
    extra?: EncryptMessageOptions,
  ): Pick<EncryptMessageOptions, "conversationKey" | "conversationKeyVersion"> {
    if (extra?.conversationKey) return {};
    const latest = this.latestConversationKey(conversationId);
    if (!latest) return {};
    return { conversationKey: latest.key, conversationKeyVersion: latest.version };
  }

  private latestConversationKey(conversationId: string): { version: string; key: Uint8Array } | undefined {
    const ring = this.conversationKeys.get(conversationId);
    if (!ring || ring.size === 0) return undefined;
    const version = latestKeyVersion(ring.keys());
    if (!version) return undefined;
    const key = ring.get(version);
    if (!key || key.byteLength === 0) return undefined;
    return { version, key };
  }

  private conversationKeySet(conversationId: string): ConversationKeySet | undefined {
    const ring = this.conversationKeys.get(conversationId);
    if (!ring || ring.size === 0) return undefined;
    const keys: Record<string, Uint8Array> = {};
    for (const [version, key] of ring) keys[version] = key;
    return mergeConversationKeySets({ keys, latestVersion: null });
  }

  private hasConversationKey(conversationId: string, version: string): boolean {
    return this.conversationKeys.get(conversationId)?.has(version) === true;
  }

  private async ensureMemberKeys(conversationId: string): Promise<boolean> {
    let ids = this.membersByConversation.get(conversationId);
    if (!ids) {
      try {
        ids = await this.http.getMemberIds(conversationId);
      } catch (error) {
        if (rateLimitWaitMs(error) !== undefined) throw error;
        log.warn(`Could not list members of ${conversationId} before decrypt`, error);
        return false;
      }
      this.membersByConversation.set(conversationId, ids);
    }
    if (this.membersLoaded.has(conversationId) && ids.every((id) => !this.remoteKeysDue(id))) {
      return true;
    }
    const loaded = await this.ensureSigningKeys(ids);
    if (!loaded) return false;
    this.membersLoaded.add(conversationId);
    return true;
  }

  private async ensureSigningKeys(userIds: string[]): Promise<boolean> {
    let ok = true;
    for (const userId of userIds) {
      if (!userId) continue;
      if (this.remoteByUser.has(userId) && !this.remoteKeysDue(userId)) continue;
      try {
        await this.loadRemoteKeys(userId);
      } catch (error) {
        ok = false;
        if (rateLimitWaitMs(error) !== undefined) {
          log.warn(
            `GET /2/users/${userId}/public_keys rate limited; not caching an empty signing-key list`,
            error,
          );
          throw error;
        }
        log.warn(`GET /2/users/${userId}/public_keys failed`, error);
      }
    }
    return ok;
  }

  private async loadRemoteKeys(userId: string, options?: { refresh?: boolean }): Promise<RemotePublicKey[]> {
    const cached = this.remoteByUser.get(userId);
    const refresh = options?.refresh === true;
    if (cached && !refresh && !this.remoteKeysDue(userId)) return cached;
    const blockedFor = this.publicKeyBlockedUntil - this.now();
    if (blockedFor > 0) {
      if (cached && (!refresh || cached.length > 0)) return cached;
      throw Object.assign(
        new Error(`GET /2/users/${userId}/public_keys is in backoff for ${blockedFor}ms`),
        { status: 429, retryAfterMs: blockedFor },
      );
    }
    try {
      const keys = await this.http.getUserPublicKeys(userId);
      this.recordPublicKeyFetch(true);
      this.rememberRemoteKeys(userId, keys);
      return keys;
    } catch (error) {
      this.recordPublicKeyFetch(false);
      const wait = rateLimitWaitMs(error);
      if (wait !== undefined) this.publicKeyBlockedUntil = this.now() + wait;
      if (cached && (!refresh || cached.length > 0)) {
        if (this.forceRefreshAfter.has(userId)) {
          this.forceRefreshAfter.set(userId, this.now() + this.decryptRefreshMinMs);
        }
        log.warn(`GET /2/users/${userId}/public_keys failed; using cached keys`, error);
        return cached;
      }
      throw error;
    }
  }

  private remoteKeysDue(userId: string): boolean {
    if (!userId || !this.remoteByUser.has(userId)) return true;
    const fetchedAt = this.remoteFetchedAt.get(userId);
    if (fetchedAt === undefined) return true;
    const keys = this.remoteByUser.get(userId) ?? [];
    const ttl = keys.length === 0 ? this.emptyRemoteKeyTtlMs : this.remoteKeyTtlMs;
    if (this.now() - fetchedAt >= ttl) return true;
    const forceAt = this.forceRefreshAfter.get(userId);
    return forceAt !== undefined && this.now() >= forceAt;
  }

  private noteDecryptKeyFailure(conversationId: string, senderIds: Iterable<string>): void {
    const ids = new Set<string>();
    for (const id of this.membersByConversation.get(conversationId) ?? []) {
      if (id) ids.add(id);
    }
    for (const id of senderIds) {
      if (id) ids.add(id);
    }
    for (const userId of ids) {
      if (!this.remoteByUser.has(userId) || this.forceRefreshAfter.has(userId)) continue;
      const fetchedAt = this.remoteFetchedAt.get(userId);
      if (fetchedAt === undefined || this.decryptRefreshedAt.get(userId) === fetchedAt) continue;
      this.forceRefreshAfter.set(userId, fetchedAt + this.decryptRefreshMinMs);
    }
  }

  private rememberRemoteKeys(userId: string, keys: RemotePublicKey[]): void {
    const wasForced = this.forceRefreshAfter.has(userId);
    this.remoteByUser.set(userId, keys);
    const fetchedAt = this.now();
    this.remoteFetchedAt.set(userId, fetchedAt);
    this.forceRefreshAfter.delete(userId);
    if (wasForced) this.decryptRefreshedAt.set(userId, fetchedAt);
    else this.decryptRefreshedAt.delete(userId);
    this.signingByUser.set(userId, this.bindRemoteKeys(userId, keys));
    this.cipher.setSigningKeys(this.currentSigningKeys());
    this.persistRemoteKeyCache();
  }

  private bindRemoteKeys(userId: string, keys: RemotePublicKey[]): SigningKeyEntry[] {
    const { entries, unboundVersions } = boundSigningEntries(keys, (identity, signing, signature) =>
      this.cipher.verifyKeyBinding(identity, signing, signature),
    );
    for (const version of unboundVersions) {
      const mark = `${userId}:${version}`;
      if (this.bindingWarned.has(mark)) continue;
      this.bindingWarned.add(mark);
      log.warn(
        `Chat public key version ${version} for user ${userId} failed identity-binding verification. The SDK will not use it for KeyChange signatures until the identity key encoding matches the signature (SPKI bytes, standard base64).`,
      );
    }
    return entries;
  }

  /**
   * Count one real `GET /2/users/{id}/public_keys`. Cache hits and backoff
   * skips never get here. The summary names counts and a timestamp only.
   */
  private recordPublicKeyFetch(ok: boolean): void {
    if (ok) {
      this.publicKeyFetchesOk += 1;
      this.publicKeyWindowOk += 1;
      this.lastPublicKeySuccessAt = this.now();
    } else {
      this.publicKeyFetchesFailed += 1;
      this.publicKeyWindowFailed += 1;
    }
    this.flushPublicKeySummary();
  }

  /** Log the open window once the interval has elapsed and it contained a fetch. */
  private flushPublicKeySummary(): void {
    const interval = this.publicKeySummaryIntervalMs;
    if (!(interval > 0)) return;
    const now = this.now();
    if (now < this.nextPublicKeySummaryAt) return;
    const ok = this.publicKeyWindowOk;
    const failed = this.publicKeyWindowFailed;
    this.publicKeyWindowOk = 0;
    this.publicKeyWindowFailed = 0;
    const overdue = now - this.nextPublicKeySummaryAt;
    const steps = Math.floor(overdue / interval) + 1;
    this.nextPublicKeySummaryAt += steps * interval;
    if (ok + failed <= 0) return;
    const minutes = Math.max(1, Math.round(interval / 60_000));
    const success =
      this.lastPublicKeySuccessAt === undefined
        ? "no success yet"
        : `last success ${formatPublicKeyFetchedAt(this.lastPublicKeySuccessAt)}`;
    const cached = this.remoteByUser.size;
    const users = cached === 1 ? "1 user cached" : `${cached} users cached`;
    log.info(`public_keys: ${ok} ok, ${failed} failed in the last ${minutes}m; ${success}; ${users}`);
  }

  private armPublicKeySummary(): void {
    const delay = Math.min(Math.floor(this.publicKeySummaryIntervalMs), MAX_TIMER_DELAY_MS);
    const timer = setInterval(() => {
      this.flushPublicKeySummary();
    }, delay);
    if (typeof timer === "object" && timer !== null && "unref" in timer) {
      const unref = (timer as { unref?: unknown }).unref;
      if (typeof unref === "function") unref.call(timer);
    }
  }

  private seedLastPublicKeySuccess(users: Iterable<CachedRemoteUser>): void {
    let newest: number | undefined;
    for (const user of users) {
      if (!Number.isFinite(user.fetchedAt) || user.fetchedAt < 0) continue;
      if (newest === undefined || user.fetchedAt > newest) newest = user.fetchedAt;
    }
    if (newest !== undefined) this.lastPublicKeySuccessAt = newest;
  }

  private logPublicKeyCacheStartup(userCount: number): void {
    const when =
      this.lastPublicKeySuccessAt === undefined
        ? "none"
        : formatPublicKeyFetchedAt(this.lastPublicKeySuccessAt);
    const users = userCount === 1 ? "1 user" : `${userCount} users`;
    log.info(`public_keys cache: ${users}, newest fetched_at ${when}`);
  }

  private hydrateRemoteKeyCache(): void {
    if (!this.remoteKeyCachePath) return;
    const loaded = loadRemoteKeyCache(this.remoteKeyCachePath);
    if (loaded.invalid) {
      log.warn(
        `Chat remote key cache ${this.remoteKeyCachePath} is unusable (${loaded.invalid}). Public keys will be fetched when needed.`,
      );
    } else if (loaded.skippedUsers > 0) {
      log.warn(
        `Chat remote key cache ${this.remoteKeyCachePath} skipped ${loaded.skippedUsers} invalid user entry(s). Those users will be fetched again.`,
      );
    }
    for (const [userId, user] of loaded.users) {
      this.remoteByUser.set(userId, user.keys);
      this.remoteFetchedAt.set(userId, user.fetchedAt);
      // Prefer entries derived from the stored public keys. The persisted
      // signing list covers a file that has signatures but no re-bindable keys.
      const entries = user.keys.length > 0 ? this.bindRemoteKeys(userId, user.keys) : user.signing;
      this.signingByUser.set(userId, entries);
    }
    for (const [conversationId, saved] of loaded.conversations) {
      const ring = new Map<string, Uint8Array>();
      const versions = saved.keys.length > 0 ? saved.keys : [{ version: saved.version, key: saved.key }];
      for (const item of versions) {
        if (!item.version || item.key.byteLength === 0) continue;
        ring.set(item.version, item.key);
      }
      if (ring.size > 0) this.conversationKeys.set(conversationId, ring);
    }
    let fetchRecords = 0;
    for (const [conversationId, byVersion] of loaded.missingKeyFetches) {
      const ring = this.conversationKeys.get(conversationId);
      const kept = new Map<string, MissingKeyFetchRecord>();
      for (const [version, record] of byVersion) {
        if (ring?.has(version)) continue;
        kept.set(version, record);
        fetchRecords += 1;
      }
      if (kept.size > 0) this.missingKeyFetches.set(conversationId, kept);
    }
    if (this.signingByUser.size > 0) this.cipher.setSigningKeys(this.currentSigningKeys());
    this.seedLastPublicKeySuccess(loaded.users.values());
    this.logPublicKeyCacheStartup(loaded.users.size);
    if (!loaded.invalid && (loaded.users.size > 0 || loaded.conversations.size > 0 || fetchRecords > 0)) {
      let versions = 0;
      for (const saved of loaded.conversations.values()) versions += Math.max(saved.keys.length, 1);
      const cooldowns = fetchRecords > 0 ? `, ${fetchRecords} missing-key fetch cooldown(s)` : "";
      log.info(
        `Loaded Chat remote key cache from ${this.remoteKeyCachePath} (${loaded.users.size} user(s), ${loaded.conversations.size} conversation(s), ${versions} conversation key version(s)${cooldowns}).`,
      );
    }
  }

  private persistRemoteKeyCache(): void {
    if (!this.remoteKeyCachePath) return;
    const users = new Map<string, CachedRemoteUser>();
    for (const [userId, keys] of this.remoteByUser) {
      const fetchedAt = this.remoteFetchedAt.get(userId);
      if (fetchedAt === undefined) continue;
      users.set(userId, {
        fetchedAt,
        keys,
        signing: this.signingByUser.get(userId) ?? [],
      });
    }
    const conversations = new Map<string, CachedConversationKey>();
    for (const [conversationId, ring] of this.conversationKeys) {
      const latest = this.latestConversationKey(conversationId);
      if (!latest) continue;
      const keys = [...ring.entries()].map(([version, key]) => ({ version, key }));
      conversations.set(conversationId, { version: latest.version, key: latest.key, keys });
    }
    try {
      saveRemoteKeyCache(this.remoteKeyCachePath, {
        users,
        conversations,
        missingKeyFetches: this.missingKeyFetches,
      });
    } catch (error) {
      log.warn(`Could not write Chat remote key cache ${this.remoteKeyCachePath}`, error);
    }
  }

  private currentSigningKeys(): SigningKeyEntry[] {
    const flat: SigningKeyEntry[] = [];
    for (const entries of this.signingByUser.values()) flat.push(...entries);
    return flat;
  }

  private rememberConversationKeys(
    conversationId: string,
    conversationKeys: ConversationKeySet | undefined,
  ): void {
    if (!conversationKeys?.keys) return;
    let ring = this.conversationKeys.get(conversationId);
    let changed = false;
    for (const [version, key] of Object.entries(conversationKeys.keys)) {
      if (!version || !(key instanceof Uint8Array) || key.byteLength === 0) continue;
      if (!ring) {
        ring = new Map();
        this.conversationKeys.set(conversationId, ring);
      }
      const next = Uint8Array.from(key);
      const existing = ring.get(version);
      if (existing) continue;
      ring.set(version, next);
      changed = true;
      const attemptId = missingKeyAttemptId(conversationId, version);
      this.missingKeyAttempts.delete(attemptId);
      this.gaveUpKeyVersions.delete(attemptId);
      this.clearMissingKeyFetch(conversationId, version);
    }
    if (changed) this.persistRemoteKeyCache();
  }
}

async function inspectChatImage(
  bytes: Uint8Array,
  fallbackMime: string | undefined,
): Promise<{ width: number; height: number; filename: string }> {
  let width = 1024;
  let height = 1024;
  let mime = fallbackMime ?? "image/jpeg";
  try {
    const wasm = await loadWasmModule();
    const detected = wasm.detectImageDimensions(bytes);
    if (detected && detected.width > 0 && detected.height > 0) {
      width = detected.width;
      height = detected.height;
    }
    const detectedMime = wasm.detectMimeType(bytes);
    if (detectedMime) mime = detectedMime;
  } catch {
    // Dimensions are optional. Upload still proceeds with the caller mime.
  }
  return { width, height, filename: `image.${extensionForMime(mime)}` };
}

function mediaLabel(mediaType: number | undefined): string {
  if (mediaType === CHAT_MEDIA_TYPE_VIDEO) return "video";
  if (mediaType === CHAT_MEDIA_TYPE_AUDIO) return "audio";
  return "image";
}

function positiveDuration(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return undefined;
  return Math.round(value);
}

function positiveEven(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 2) return undefined;
  const rounded = Math.round(value);
  return rounded % 2 === 0 ? rounded : rounded + 1;
}

function extensionForMime(mime: string): string {
  const normalized = mime.toLowerCase();
  if (normalized.includes("png")) return "png";
  if (normalized.includes("webp")) return "webp";
  if (normalized.includes("gif")) return "gif";
  return "jpg";
}

/** `image.png` → `image-1.png`. Receivers key their decrypted-file cache on the name. */
function numberedChatFilename(filename: string, index: number): string {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0) return `${filename}-${index}`;
  return `${filename.slice(0, dot)}-${index}${filename.slice(dot)}`;
}

function selectLoadedKey(
  keys: RemotePublicKey[],
  identity: { version: string; publicKey: string },
  matches: (publicKey: string) => boolean,
): RemotePublicKey | undefined {
  const byVersion = keys.find((key) => key.publicKeyVersion === identity.version);
  if (byVersion) return byVersion;
  const byMaterial = keys.find((key) => {
    try {
      return matches(key.publicKey) || key.publicKey === identity.publicKey;
    } catch {
      return key.publicKey === identity.publicKey;
    }
  });
  return byMaterial;
}

function decryptErrorsNeedKeyRefresh(errors: Record<string, string>): boolean {
  for (const message of Object.values(errors)) {
    if (/signing key|public key|no matching|not in available versions/i.test(message)) return true;
  }
  return false;
}

function missingKeyAttemptId(conversationId: string, version: string): string {
  return `${conversationId}\0${version}`;
}

function missingVersionsOn(raws: RawChatEvent[], errorsByBlob: Map<string, string>): string[] {
  const versions: string[] = [];
  for (const raw of raws) {
    if (!raw.encoded_event) continue;
    const message = errorsByBlob.get(raw.encoded_event);
    if (!message) continue;
    const version = missingConversationKeyVersion(message);
    if (version && !versions.includes(version)) versions.push(version);
  }
  return versions;
}

function errorsByEncodedBlob(encoded: string[], errors: Record<string, string>): Map<string, string> {
  const byBlob = new Map<string, string>();
  for (const [key, message] of Object.entries(errors)) {
    const index = Number(key);
    if (Number.isInteger(index) && encoded[index]) byBlob.set(encoded[index]!, message);
    else if (encoded.includes(key)) byBlob.set(key, message);
  }
  return byBlob;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    unique.push(value);
  }
  return unique;
}

function failedDecryptBlobs(encoded: string[], errors: Record<string, string>): Set<string> {
  const failed = new Set<string>();
  for (const key of Object.keys(errors)) {
    const index = Number(key);
    if (Number.isInteger(index) && encoded[index]) failed.add(encoded[index]);
    else if (encoded.includes(key)) failed.add(key);
  }
  return failed;
}

function nextReplyQuote(quote: ReplyQuote): ReplyQuote | undefined {
  if (quote === "bounded") return "preview";
  if (quote === "preview") return "none";
  return undefined;
}

function deleteResultFromBatch(eventId: string, batch: DeleteBatchResult): DeleteResult {
  if (batch.deletedIds.includes(eventId)) return { deleted: true };
  if (batch.missingSequenceIds.includes(eventId)) {
    return { deleted: false, error: "Missing X Chat sequence id." };
  }
  const wait = batch.blocked?.retryAfterMs ?? batch.rateLimited?.retryAfterMs;
  if (
    wait !== undefined &&
    (batch.blocked || batch.rateLimited?.skippedIds.includes(eventId))
  ) {
    return { deleted: false, error: `Rate limited; retry after ${wait}ms` };
  }
  if (batch.permissionDenied) {
    return {
      deleted: false,
      error:
        "This account can delete its own messages, and other people's messages only when it is a group admin.",
    };
  }
  return { deleted: false, error: "X Chat did not delete that message." };
}

function resolvePublicKeySummaryIntervalMs(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_PUBLIC_KEY_SUMMARY_INTERVAL_MS;
  if (value < MIN_PUBLIC_KEY_SUMMARY_INTERVAL_MS) return MIN_PUBLIC_KEY_SUMMARY_INTERVAL_MS;
  return value;
}

function rateLimitWaitMs(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const status = (error as { status?: number }).status;
  if (status !== 429 && status !== 402) return undefined;
  const retry = (error as { retryAfterMs?: number }).retryAfterMs;
  return typeof retry === "number" && retry > 0 ? retry : 15_000;
}

export type { RemotePublicKey };
