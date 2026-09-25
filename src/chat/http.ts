import type { RemotePublicKey } from "./wire.js";

export interface RawChatEvent {
  id?: string;
  sender_id?: string;
  conversation_id?: string;
  created_at?: string;
  /**
   * Optional millisecond timestamp from payloads that include one, such as
   * Activity. The Chat events list returns `created_at` and rejects
   * `created_at_msec` in `chat_message_event.fields`.
   */
  created_at_msec?: string | number;
  encoded_event?: string;
  conversation_token?: string;
  sequence_id?: string;
}

export interface RawChatEventsPage {
  data?: RawChatEvent[];
  meta?: {
    next_token?: string;
    conversation_key_events?: string[];
    has_more?: boolean;
  };
}

/** `GET /2/chat/conversations` inbox page. Shape varies; callers parse with `groupIdsFromInboxPage`. */
export interface RawChatConversationsPage {
  data?: unknown;
  meta?: {
    next_token?: string;
    has_more?: boolean;
  };
}

export interface ChatHttp {
  getConversationEvents(
    conversationId: string,
    params: { maxResults?: number; paginationToken?: string },
  ): Promise<RawChatEventsPage>;
  getMemberIds(conversationId: string): Promise<string[]>;
  getUserPublicKeys(userId: string): Promise<RemotePublicKey[]>;
  sendChatMessage(
    conversationId: string,
    body: Record<string, string>,
  ): Promise<{ messageId: string }>;
  deleteChatMessages(
    conversationId: string,
    body: Record<string, unknown>,
  ): Promise<{ deleted: boolean }>;
  addConversationKeys(
    conversationId: string,
    body: Record<string, unknown>,
  ): Promise<void>;
  addUserPublicKey(userId: string, body: Record<string, unknown>): Promise<{ version?: string }>;
  /**
   * Upload already-encrypted Chat media bytes (initialize → append → finalize).
   * Returns `media_hash_key` for an inline `attachment_type: "media"` message.
   */
  uploadChatMedia(conversationId: string, ciphertext: Uint8Array): Promise<string>;
  /**
   * Download encrypted Chat media (`GET /2/chat/media/:conversation_id/:media_hash_key`).
   * Callers `decryptStream` the bytes with the conversation key. Absent on fakes that never read inbound photos.
   */
  downloadChatMedia?(conversationId: string, mediaHashKey: string): Promise<Uint8Array>;
  /**
   * Inbox list (`GET /2/chat/conversations`). Absent on fakes that do not discover groups.
   * Callers must keep only `g…` ids and must not treat a failure as fatal.
   */
  listConversations?(params: {
    maxResults?: number;
    paginationToken?: string;
  }): Promise<RawChatConversationsPage>;
}
