import type { DmEvent, Mention } from "../types.js";
import type { DecryptedEvent } from "./cipher.js";
import type { RawChatEvent } from "./http.js";

const MENTION_RE = /@([A-Za-z0-9_]{1,15})/g;

/**
 * Map one raw Chat event plus its decrypted payload into the DM event shape
 * the moderation engine already understands. Key changes, reactions, and
 * typing indicators are not commands and return undefined.
 */
export function chatEventToDm(
  conversationId: string,
  raw: RawChatEvent,
  decrypted: DecryptedEvent | undefined,
): DmEvent | undefined {
  if (!decrypted?.type) return undefined;
  const id = raw.id || nonempty(decrypted.id) || nonempty(decrypted.sequenceId);
  if (!id) return undefined;
  const createdAt =
    raw.created_at ??
    (typeof decrypted.createdAtMsec === "number"
      ? new Date(decrypted.createdAtMsec).toISOString()
      : undefined);
  const sequenceId = nonempty(decrypted.sequenceId) ?? nonempty(raw.sequence_id);
  const senderId = raw.sender_id || nonempty(decrypted.senderId);

  if (decrypted.type === "message") {
    const text = messageText(decrypted);
    if (text === undefined) return undefined;
    return {
      id,
      eventType: "MessageCreate",
      conversationId: raw.conversation_id || conversationId,
      createdAt,
      senderId,
      participantIds: [],
      participants: [],
      text,
      mentions: mentionsIn(text),
      sequenceId,
    };
  }

  if (decrypted.type === "groupChange") {
    const changeType = readChangeType(decrypted);
    const memberIds = readMemberIds(decrypted);
    if (changeType === "membersAdded" || changeType === "created") {
      return {
        id,
        eventType: "ParticipantsJoin",
        conversationId: raw.conversation_id || conversationId,
        createdAt,
        senderId,
        participantIds: memberIds,
        participants: memberIds.map((userId) => ({ id: userId })),
        mentions: [],
        sequenceId,
      };
    }
    if (changeType === "membersRemoved") {
      return {
        id,
        eventType: "ParticipantsLeave",
        conversationId: raw.conversation_id || conversationId,
        createdAt,
        senderId,
        participantIds: memberIds,
        participants: memberIds.map((userId) => ({ id: userId })),
        mentions: [],
        sequenceId,
      };
    }
  }

  return undefined;
}

function messageText(event: DecryptedEvent): string | undefined {
  const content = event.content;
  if (!content || typeof content.text !== "string") return undefined;
  const kind = content.contentType;
  if (kind && kind !== "text") return undefined;
  return content.text;
}

function readChangeType(event: DecryptedEvent): string | undefined {
  return (
    event.changeType ??
    event.change?.changeType ??
    event.groupChange?.changeType
  );
}

function readMemberIds(event: DecryptedEvent): string[] {
  const ids = event.memberIds ?? event.change?.memberIds ?? event.groupChange?.memberIds ?? [];
  return ids.filter((id) => typeof id === "string" && id.length > 0);
}

function mentionsIn(text: string): Mention[] {
  const mentions: Mention[] = [];
  for (const match of text.matchAll(MENTION_RE)) {
    const username = match[1];
    if (!username) continue;
    mentions.push({ username });
  }
  return mentions;
}

function nonempty(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  return value;
}
