import { log } from "../log.js";
import type { Store } from "../store.js";
import type { DeleteHint, DeleteResult, DmEvent, SendMessageResult } from "../types.js";
import { logDecryptErrors } from "./decrypt-log.js";
import { isChatGroupId } from "./ids.js";
import type { ChatCipher, SigningKeyEntry } from "./cipher.js";
import type { ChatHttp, RawChatEvent, RawChatEventsPage } from "./http.js";
import { chatEventToDm } from "./normalize.js";
import { newestRawId, normalizeChatPage, rawEventsAfterWatermark } from "./raw.js";
import {
  addConversationKeysBody,
  deleteMessagesBody,
  latestPublicKey,
  sendMessageBody,
  toSigningEntries,
  type RemotePublicKey,
} from "./wire.js";

const MAX_CATCHUP_PAGES = 4;

export interface ChatPull {
  newestId?: string;
  events: DmEvent[];
  /** True when the stored cursor was older than every page we were willing to read. */
  replacedStaleWatermark: boolean;
}

export class ChatService {
  private readonly signingByUser = new Map<string, SigningKeyEntry[]>();
  private readonly membersLoaded = new Set<string>();
  private readonly tokens = new Map<string, string>();
  /** Key-change blobs already submitted to decryptEvents. Old versions are not retried. */
  private readonly seenKeyEvents = new Set<string>();

  constructor(
    private readonly http: ChatHttp,
    private readonly cipher: ChatCipher,
    private readonly store: Store,
  ) {}

  /**
   * Fetch the newest page (and older pages until the watermark is found).
   * Ciphertext at or before the watermark is not decrypted again — pre-rotation
   * history stays on the page X returns, but it is not re-submitted every poll.
   * Key-change events are still applied so the conversation-key cache stays warm.
   * Returns moderation events strictly newer than `watermarkId`, oldest first.
   */
  async pullNew(
    conversationId: string,
    watermarkId: string | undefined,
    maxResults: number,
  ): Promise<ChatPull> {
    const { pages, watermarkFound } = await this.loadPages(
      conversationId,
      watermarkId,
      maxResults,
    );
    const newestId = newestRawId(pages[0]);
    const replacedStaleWatermark = Boolean(
      watermarkId && watermarkId !== "empty" && !watermarkFound && newestId && newestId !== watermarkId,
    );
    if (replacedStaleWatermark) {
      log.info(
        `Chat watermark for ${conversationId} was not in the latest pages; advancing to ${newestId} so undecryptable history is not fetched again.`,
      );
    }

    const newer = rawEventsAfterWatermark(pages, watermarkId);
    const onlyEncoded = new Set<string>();
    for (const raw of newer) {
      if (raw.encoded_event) onlyEncoded.add(raw.encoded_event);
    }
    const decrypted = await this.decryptPages(conversationId, pages, { onlyEncoded });
    // First sight of a conversation seeds the watermark in the poller and does not replay.
    if (watermarkId === undefined) {
      return { newestId, events: [], replacedStaleWatermark: false };
    }

    const newIds = new Set(newer.map((raw) => raw.id).filter((id): id is string => Boolean(id)));
    const fresh = decrypted.filter((event) => newIds.has(event.id));
    return { newestId, events: fresh.reverse(), replacedStaleWatermark };
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

  async sendText(conversationId: string, text: string): Promise<SendMessageResult> {
    let payload;
    try {
      payload = this.cipher.encryptMessage(conversationId, text);
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
   * Aborts without posting if any member's public key is missing.
   */
  async rotateConversationKey(conversationId: string): Promise<void> {
    const memberIds = await this.http.getMemberIds(conversationId);
    if (memberIds.length === 0) {
      throw new Error(
        `GET /2/chat/conversations/${conversationId} returned no member ids, so a key rotation would lock people out. Aborting.`,
      );
    }
    const publicKeys = [];
    for (const userId of memberIds) {
      const keys = await this.http.getUserPublicKeys(userId);
      const latest = latestPublicKey(keys);
      if (!latest) {
        throw new Error(
          `No public key for member ${userId}. Aborting rotation so that member is not locked out of ${conversationId}.`,
        );
      }
      publicKeys.push({
        userId,
        publicKey: latest.publicKey,
        keyVersion: latest.publicKeyVersion,
      });
    }
    const prepared = this.cipher.prepareConversationKeyChange({
      conversationId,
      publicKeys,
    });
    await this.http.addConversationKeys(
      conversationId,
      addConversationKeysBody(prepared, this.cipher.signingPublicKey()),
    );
    log.info(
      `Posted a Chat key rotation for ${conversationId} covering ${publicKeys.length} members (version ${prepared.conversationKeyVersion}).`,
    );
  }

  private async loadPages(
    conversationId: string,
    watermarkId: string | undefined,
    maxResults: number,
  ): Promise<{ pages: RawChatEventsPage[]; watermarkFound: boolean }> {
    const pages: RawChatEventsPage[] = [];
    let token: string | undefined;
    let watermarkFound = watermarkId === undefined || watermarkId === "empty";
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
      if (found) watermarkFound = true;
      token = page.meta?.next_token;
      if (found || !token) break;
    }
    return { pages, watermarkFound };
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
    const result = this.cipher.decryptEvents(encoded);
    logDecryptErrors(conversationId, result.errors);
    if (membersReady) {
      for (const keyEvent of freshKeys) this.seenKeyEvents.add(keyEvent);
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
    if (this.membersLoaded.has(conversationId)) return true;
    try {
      const ids = await this.http.getMemberIds(conversationId);
      await this.ensureSigningKeys(ids);
      this.membersLoaded.add(conversationId);
      return true;
    } catch (error) {
      log.warn(
        `Could not list members of ${conversationId} before decrypt`,
        error,
      );
      return false;
    }
  }

  private async ensureSigningKeys(userIds: string[]): Promise<void> {
    let changed = false;
    for (const userId of userIds) {
      if (!userId || this.signingByUser.has(userId)) continue;
      try {
        const keys = await this.http.getUserPublicKeys(userId);
        this.signingByUser.set(userId, toSigningEntries(keys));
        changed = true;
      } catch (error) {
        log.warn(`GET /2/users/${userId}/public_keys failed`, error);
        this.signingByUser.set(userId, []);
      }
    }
    if (changed) {
      const flat: SigningKeyEntry[] = [];
      for (const entries of this.signingByUser.values()) flat.push(...entries);
      this.cipher.setSigningKeys(flat);
    }
  }
}

export type { RemotePublicKey };
