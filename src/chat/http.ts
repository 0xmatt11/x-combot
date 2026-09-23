import type { RemotePublicKey } from "./wire.js";

export interface RawChatEvent {
  id?: string;
  sender_id?: string;
  conversation_id?: string;
  created_at?: string;
  /** Milliseconds since epoch, as returned by `created_at_msec`. */
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
}
