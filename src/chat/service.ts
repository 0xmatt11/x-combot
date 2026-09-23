import { log } from "../log.js";
import type { Store } from "../store.js";
import type { DeleteHint, DeleteResult, DmEvent, SendMessageResult } from "../types.js";
import { isChatGroupId } from "./ids.js";
import type { ChatCipher, SigningKeyEntry } from "./cipher.js";
import type { ChatHttp, RawChatEvent, RawChatEventsPage } from "./http.js";
import { chatEventToDm } from "./normalize.js";
import {
  addConversationKeysBody,
  deleteMessagesBody,
  latestPublicKey,
  sendMessageBody,
  toSigningEntries,
  type RemotePublicKey,
} from "./wire.js";

const MAX_CATCHUP_PAGES = 4;

export class ChatService {
  private readonly signingByUser = new Map<string, SigningKeyEntry[]>();
  private readonly membersLoaded = new Set<string>();
  private readonly tokens = new Map<string, string>();

  constructor(
    private readonly http: ChatHttp,
    private readonly cipher: ChatCipher,
    private readonly store: Store,
  ) {}

  /**
   * Fetch the newest page (and older pages until the watermark is found).
   * Decrypts even when seeding a watermark so the conversation-key cache is warm.
   * Returns moderation events that are strictly newer than `watermarkId`, oldest first.
   */
  async pullNew(
    conversationId: string,
    watermarkId: string | undefined,
    maxResults: number,
  ): Promise<{ newestId?: string; events: DmEvent[] }> {
    const pages = await this.loadPages(conversationId, watermarkId, maxResults);
    const decrypted = await this.decryptPages(conversationId, pages);
    const newestId = pages[0]?.data?.find((event) => event.id)?.id;
    // First sight of a conversation seeds the watermark in the poller.
    // Decrypt anyway so the conversation-key cache is warm for the next send.
    if (watermarkId === undefined) {
      return { newestId, events: [] };
    }

    const stopAt = watermarkId === "empty" ? undefined : watermarkId;
    const newIds = new Set<string>();
    for (const page of pages) {
      let reachedWatermark = false;
      for (const raw of page.data ?? []) {
        if (!raw.id) continue;
        if (stopAt && raw.id === stopAt) {
          reachedWatermark = true;
          break;
        }
        newIds.add(raw.id);
      }
      if (reachedWatermark) break;
    }
    const fresh = decrypted.filter((event) => newIds.has(event.id));
    return { newestId, events: fresh.reverse() };
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
  ): Promise<RawChatEventsPage[]> {
    const pages: RawChatEventsPage[] = [];
    let token: string | undefined;
    for (let pageIndex = 0; pageIndex < MAX_CATCHUP_PAGES; pageIndex += 1) {
      const page = await this.http.getConversationEvents(conversationId, {
        maxResults,
        paginationToken: token,
      });
      pages.push(page);
      if (watermarkId === undefined) break;
      const ids = (page.data ?? []).map((event) => event.id);
      const found = watermarkId === "empty" || ids.includes(watermarkId);
      token = page.meta?.next_token;
      if (found || !token) break;
    }
    return pages;
  }

  private async decryptPages(
    conversationId: string,
    pages: RawChatEventsPage[],
  ): Promise<DmEvent[]> {
    await this.ensureMemberKeys(conversationId);
    const senderIds = new Set<string>();
    let newestToken: string | undefined;
    for (const page of pages) {
      for (const raw of page.data ?? []) {
        if (raw.sender_id) senderIds.add(raw.sender_id);
        // Pages are newest-first, so the first token is the one to send with.
        if (!newestToken && raw.conversation_token) newestToken = raw.conversation_token;
      }
    }
    if (newestToken) this.tokens.set(conversationId, newestToken);
    await this.ensureSigningKeys([...senderIds]);

    const encoded: string[] = [];
    for (const page of pages) {
      for (const keyEvent of page.meta?.conversation_key_events ?? []) {
        if (keyEvent) encoded.push(keyEvent);
      }
    }
    const raws: RawChatEvent[] = [];
    for (const page of pages) {
      for (const raw of page.data ?? []) {
        raws.push(raw);
        if (raw.encoded_event) encoded.push(raw.encoded_event);
      }
    }

    if (encoded.length === 0) return [];
    const result = this.cipher.decryptEvents(encoded);
    const errors = Object.entries(result.errors);
    if (errors.length > 0) {
      log.warn(
        `Chat decrypt reported ${errors.length} error(s) in ${conversationId}: ${errors
          .slice(0, 3)
          .map(([, message]) => message)
          .join(" | ")}`,
      );
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

  private async ensureMemberKeys(conversationId: string): Promise<void> {
    if (this.membersLoaded.has(conversationId)) return;
    try {
      const ids = await this.http.getMemberIds(conversationId);
      await this.ensureSigningKeys(ids);
      this.membersLoaded.add(conversationId);
    } catch (error) {
      log.warn(
        `Could not list members of ${conversationId} before decrypt`,
        error,
      );
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
