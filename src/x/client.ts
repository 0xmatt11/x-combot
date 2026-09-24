import type {
  DeleteHint,
  DeleteResult,
  DmEvent,
  OutboundAudio,
  OutboundImage,
  OutboundVideo,
  SendMessageResult,
  XUser,
} from "../types.js";

export interface XClient {
  getMe(): Promise<XUser>;
  getUserByUsername(username: string): Promise<XUser | undefined>;
  getUserById(id: string): Promise<XUser | undefined>;
  /**
   * Recent public posts for a roast. `GET /2/users/:id/tweets`.
   * Throws when the token or access tier cannot read that timeline.
   */
  listRecentPosts(userId: string): Promise<string[]>;
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
  /**
   * Attach an image. Classic group DMs use media upload plus `attachments.media_id`.
   * Encrypted Chat (`g…`) uses `encryptStream`, `POST /2/chat/media/upload`, and an
   * inline media attachment. Callers post `image.url` as text when this throws.
   */
  sendImage(conversationId: string, image: OutboundImage): Promise<SendMessageResult>;
  /**
   * Attach an mp4. Encrypted Chat (`g…`) reuses `encryptStream` and
   * `POST /2/chat/media/upload`, then sets `media_type` 3. Classic group DMs
   * throw so the caller can post the temporary URL.
   */
  sendVideo(conversationId: string, video: OutboundVideo): Promise<SendMessageResult>;
  /**
   * Attach an mp3. Encrypted Chat (`g…`) reuses `encryptStream` and
   * `POST /2/chat/media/upload`, then sets `media_type` 4 (audio).
   * Classic group DMs throw; TTS has no temporary URL to post instead.
   */
  sendAudio(conversationId: string, audio: OutboundAudio): Promise<SendMessageResult>;
  sendDirectMessage(participantId: string, text: string): Promise<SendMessageResult>;
  deleteEvent(eventId: string, hint?: DeleteHint): Promise<DeleteResult>;
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

/** Decimal X user ids (snowflakes). These identify an account; they are not a chat label. */
export function isNumericUserId(value: string | undefined): boolean {
  return typeof value === "string" && /^\d+$/.test(value);
}

/**
 * Label for a person in chat: `@handle`, then display name, then "someone".
 * A numeric API user id is never returned, including when it is the only fallback.
 */
export function displayName(user: XUser | undefined, fallbackId?: string): string {
  if (user?.username && !isNumericUserId(user.username)) return `@${user.username}`;
  if (user?.name && !isNumericUserId(user.name)) return user.name;
  if (
    fallbackId &&
    !isNumericUserId(fallbackId) &&
    fallbackId !== user?.id
  ) {
    return fallbackId;
  }
  return "someone";
}
