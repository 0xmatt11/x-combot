import type { DeleteResult, DmEvent, SendMessageResult, XUser } from "../types.js";

export interface XClient {
  getMe(): Promise<XUser>;
  getUserByUsername(username: string): Promise<XUser | undefined>;
  getUserById(id: string): Promise<XUser | undefined>;
  listDmEvents(params: {
    maxResults?: number;
    paginationToken?: string;
  }): Promise<{ events: DmEvent[]; nextToken?: string }>;
  listConversationDmEvents(params: {
    conversationId: string;
    maxResults?: number;
    paginationToken?: string;
  }): Promise<{ events: DmEvent[]; nextToken?: string }>;
  sendMessage(
    conversationId: string,
    text: string,
  ): Promise<SendMessageResult>;
  sendDirectMessage(participantId: string, text: string): Promise<SendMessageResult>;
  deleteEvent(eventId: string): Promise<DeleteResult>;
}

export const DM_EVENT_FIELDS = [
  "id",
  "text",
  "event_type",
  "dm_conversation_id",
  "created_at",
  "sender_id",
  "participant_ids",
  "attachments",
  "entities",
].join(",");

export const DM_EXPANSIONS = "sender_id,participant_ids";
export const USER_FIELDS = "id,name,username";
export const EVENT_TYPES = "MessageCreate,ParticipantsJoin,ParticipantsLeave";

/** 1:1 conversation IDs are `{smaller_id}-{larger_id}`; group IDs are a single snowflake. */
export function isGroupConversation(conversationId: string): boolean {
  return !conversationId.includes("-");
}

export function displayName(user: XUser | undefined, fallbackId?: string): string {
  if (user?.username) return `@${user.username}`;
  if (user?.name) return user.name;
  if (fallbackId) return fallbackId;
  return "someone";
}
