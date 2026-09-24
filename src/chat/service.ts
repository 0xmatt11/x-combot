import { log } from "../log.js";
import type { Store } from "../store.js";
import type {
  DeleteHint,
  DeleteResult,
  DmEvent,
  MediaCaption,
  OutboundAudio,
  OutboundImage,
  OutboundVideo,
  SendMessageResult,
} from "../types.js";
import { logDecryptErrors } from "./decrypt-log.js";
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
  loadRemoteKeyCache,
  saveRemoteKeyCache,
  type CachedConversationKey,
  type CachedRemoteUser,
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
  /** Latest conversation key per chat, from decryptEvents — required for encryptStream. */
  private readonly conversationKeys = new Map<string, { version: string; key: Uint8Array }>();
  /** After public_keys 429/402, skip further fetches until this time. */
  private publicKeyBlockedUntil = 0;
  private readonly remoteKeyCachePath?: string;
  private readonly now: () => number;
  private readonly remoteKeyTtlMs: number;
  private readonly emptyRemoteKeyTtlMs: number;
  private readonly decryptRefreshMinMs: number;

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
  } {
    let signingKeys = 0;
    for (const entries of this.signingByUser.values()) signingKeys += entries.length;
    return {
      cachedUsers: this.remoteByUser.size,
      signingKeys,
      conversationKeys: this.conversationKeys.size,
      backoffMs: Math.max(0, this.publicKeyBlockedUntil - nowMs),
    };
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
    if (this.remoteKeyCachePath) this.hydrateRemoteKeyCache();
  }

  /**
   * Fetch the newest page (and older pages until the watermark is found).
   * Ciphertext at or before the watermark is not decrypted again. Ciphertext
   * newer than the watermark that fails to decrypt is retried next poll — the
   * cursor does not move past it. Key-change events are still applied so a
   * later successful verify can fill the conversation-key cache.
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
    const decrypted = await this.decryptPages(conversationId, pages, { onlyEncoded });
    // First sight of a conversation seeds the watermark in the poller and does not replay.
    if (watermarkId === undefined) {
      return { newestId, events: [], watermarkId: newestId ?? "empty" };
    }

    const newIds = new Set(newer.map((raw) => raw.id).filter((id): id is string => Boolean(id)));
    const fresh = decrypted.filter((event) => newIds.has(event.id));
    const decryptedIds = new Set(fresh.map((event) => event.id));
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
    let payload;
    try {
      payload = this.encryptOutbound(conversationId, text, caption);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Cannot encrypt a Chat reply in ${conversationId}: ${message}. The bot needs a verified KeyChange (meta.conversation_key_events) wrapped to its registered public key. If this account was added before \`npm run chat:register\`, run \`npm run chat:rotate -- ${conversationId} --confirm\` so a new key is wrapped for every current member.`,
      );
    }
    const body = sendMessageBody(payload, this.tokens.get(conversationId));
    const sent = await this.http.sendChatMessage(conversationId, body);
    return {
      dmEventId: sent.messageId || payload.messageId,
      dmConversationId: conversationId,
    };
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
    return this.sendChatMedia(conversationId, bytes, {
      width: 1,
      height: 1,
      filename: "voice.mp3",
      mediaType: CHAT_MEDIA_TYPE_AUDIO,
      durationMillis: duration,
    });
  }

  /**
   * `encryptReply` when the caption names a Chat message. Otherwise
   * `encryptMessage`. A mention entity is the `@handle` byte range.
   */
  private encryptOutbound(
    conversationId: string,
    text: string,
    caption?: MediaCaption,
    extra?: EncryptMessageOptions,
  ): ReturnType<ChatCipher["encryptMessage"]> {
    const mention = caption?.mention;
    const entities = mention
      ? ([[mention.start, mention.end, "mention"]] as EncryptReplyOptions["entities"])
      : undefined;
    const options: EncryptReplyOptions = {
      ...extra,
      ...(entities ? { entities } : {}),
    };
    const reply = caption?.replyTo;
    if (reply && (reply.rawEvent || reply.sequenceId)) {
      return this.cipher.encryptReply(conversationId, text, {
        ...options,
        ...(reply.rawEvent ? { replyToEvent: reply.rawEvent } : {}),
        ...(reply.sequenceId ? { replyToSequenceId: reply.sequenceId } : {}),
        ...(reply.senderId ? { replyToSenderId: reply.senderId } : {}),
        ...(reply.previewText ? { replyToText: reply.previewText } : {}),
      });
    }
    const hasOptions = Boolean(extra || entities);
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
    const latest = this.conversationKeys.get(conversationId);
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
    let payload;
    try {
      payload = this.encryptOutbound(conversationId, caption?.text ?? "", caption, {
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
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Cannot encrypt a Chat ${label} in ${conversationId}: ${message}`);
    }
    const body = sendMessageBody(payload, this.tokens.get(conversationId));
    const sent = await this.http.sendChatMessage(conversationId, body);
    return {
      dmEventId: sent.messageId || payload.messageId,
      dmConversationId: conversationId,
    };
  }

  async deleteEvent(eventId: string, hint?: DeleteHint): Promise<DeleteResult> {
    const indexed = this.store.lookupChatMessage(eventId);
    const conversationId = hint?.conversationId || indexed?.conversationId;
    const sequenceId = hint?.sequenceId || indexed?.sequenceId;
    if (!conversationId || !isChatGroupId(conversationId)) {
      return {
        deleted: false,
        error: "Not an encrypted Chat message this process has indexed.",
      };
    }
    if (!sequenceId) {
      return {
        deleted: false,
        error:
          "Missing X Chat sequence id. Delete needs a message this bot decrypted (sequence_id from the event), then POST /2/chat/conversations/:id/messages/delete.",
      };
    }
    try {
      const signature = this.cipher.prepareMessageDelete(conversationId, [sequenceId], true);
      const body = deleteMessagesBody(signature, this.cipher.signingPublicKey(), [sequenceId], true);
      const result = await this.http.deleteChatMessages(conversationId, body);
      if (!result.deleted) {
        return {
          deleted: false,
          error:
            "X Chat did not delete that message. delete_for_all works for your own messages, and for other people's messages only when this account is a group admin.",
        };
      }
      return { deleted: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn(`Chat delete failed for ${eventId}: ${message}`);
      return { deleted: false, error: message };
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
    for (const page of normalized) {
      for (const keyEvent of page.meta?.conversation_key_events ?? []) {
        if (!keyEvent || this.seenKeyEvents.has(keyEvent)) continue;
        freshKeys.push(keyEvent);
        encoded.push(keyEvent);
      }
    }
    const raws: RawChatEvent[] = [];
    for (const page of normalized) {
      for (const raw of page.data ?? []) {
        if (!includeEncoded(raw)) continue;
        raws.push(raw);
        if (raw.encoded_event) encoded.push(raw.encoded_event);
      }
    }

    if (encoded.length === 0) return [];
    const signingKeys = this.currentSigningKeys();
    const result = this.cipher.decryptEvents(encoded, signingKeys.length > 0 ? signingKeys : undefined);
    this.rememberConversationKeys(conversationId, result.conversationKeys);
    if (decryptErrorsNeedKeyRefresh(result.errors)) {
      this.noteDecryptKeyFailure(conversationId, senderIds);
    }
    const messageFailed = raws.some(
      (raw) => Boolean(raw.encoded_event && result.errors[raw.encoded_event]),
    );
    const firstSight =
      messageFailed && this.store.getWatermark(watermarkKey(conversationId)) === undefined;
    logDecryptErrors(conversationId, result.errors, Date.now(), { firstSight });
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
      events.push(dm);
    }
    return events;
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
      this.rememberRemoteKeys(userId, keys);
      return keys;
    } catch (error) {
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
      this.conversationKeys.set(conversationId, { version: saved.version, key: saved.key });
    }
    if (this.signingByUser.size > 0) this.cipher.setSigningKeys(this.currentSigningKeys());
    if (!loaded.invalid && (loaded.users.size > 0 || loaded.conversations.size > 0)) {
      log.info(
        `Loaded Chat remote key cache from ${this.remoteKeyCachePath} (${loaded.users.size} user(s), ${loaded.conversations.size} conversation key(s)).`,
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
    for (const [conversationId, saved] of this.conversationKeys) {
      conversations.set(conversationId, { version: saved.version, key: saved.key });
    }
    try {
      saveRemoteKeyCache(this.remoteKeyCachePath, { users, conversations });
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
    const version = pickConversationKeyVersion(conversationKeys.keys, conversationKeys.latestVersion);
    if (!version) return;
    const key = conversationKeys.keys[version];
    if (!key || key.byteLength === 0) return;
    const existing = this.conversationKeys.get(conversationId);
    if (existing && compareKeyVersions(version, existing.version) < 0) return;
    const next = Uint8Array.from(key);
    if (existing && existing.version === version && sameBytes(existing.key, next)) return;
    this.conversationKeys.set(conversationId, { version, key: next });
    this.persistRemoteKeyCache();
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

function pickConversationKeyVersion(
  keys: Record<string, Uint8Array>,
  latestVersion: string | null,
): string | undefined {
  if (latestVersion && keys[latestVersion]) return latestVersion;
  const versions = Object.keys(keys);
  if (versions.length === 0) return undefined;
  return versions.sort((a, b) => compareKeyVersions(a, b)).at(-1);
}

function compareKeyVersions(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return a.localeCompare(b);
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

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
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

function rateLimitWaitMs(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const status = (error as { status?: number }).status;
  if (status !== 429 && status !== 402) return undefined;
  const retry = (error as { retryAfterMs?: number }).retryAfterMs;
  return typeof retry === "number" && retry > 0 ? retry : 15_000;
}

export type { RemotePublicKey };
