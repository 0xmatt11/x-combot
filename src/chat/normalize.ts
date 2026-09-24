import { createHash } from "node:crypto";
import type { DmEvent, Mention, ReplyTarget } from "../types.js";
import type { DecryptedEvent } from "./cipher.js";
import type { RawChatEvent } from "./http.js";

/**
 * Stable id for one ciphertext. Activity delivery ids and the Chat events-list
 * id are different strings for the same blob; the blob is not.
 */
export function cipherReplayKey(encoded: string | undefined): string | undefined {
  if (!encoded) return undefined;
  return `cipher:${createHash("sha256").update(encoded).digest("hex")}`;
}

const MENTION_RE = /@([A-Za-z0-9_]{1,15})/g;

/**
 * Map one raw Chat event plus its decrypted payload into the DM event shape
 * the moderation engine already understands. Key changes, edits, reaction
 * removals, and typing indicators are not commands and return undefined.
 * Reaction adds become `ReactionAdd` so passive XP can see them. Text
 * messages keep a reply preview when chat-xdk decrypted one.
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

  const aliases = replayAliases(raw, decrypted, id);

  if (decrypted.type === "message") {
    const reaction = readReaction(decrypted);
    if (reaction) {
      if (reaction.removed) return undefined;
      return {
        id,
        eventType: "ReactionAdd",
        conversationId: raw.conversation_id || conversationId,
        createdAt,
        senderId,
        participantIds: [],
        participants: [],
        text: reaction.emoji,
        mentions: [],
        sequenceId,
        reactionTargetSequenceId: reaction.targetId,
        ...aliases,
      };
    }
    const text = messageText(decrypted);
    if (text === undefined) return undefined;
    const replyToSenderId = trustedReplySenderId(decrypted);
    const replyTo = readReply(decrypted);
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
      ...(replyToSenderId ? { replyToSenderId } : {}),
      ...(replyTo ? { replyTo } : {}),
      ...aliases,
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
        ...aliases,
      };
    }
    // chat-xdk GroupChange `membersRemoved` (Thrift GroupMemberRemoveChange).
    // Voluntary leave and an admin remove/kick share this one variant.
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
        ...aliases,
      };
    }
  }

  return undefined;
}

/**
 * Sender of the message this Chat event replies to.
 *
 * chat-xdk puts the claim on `content.replying_to_preview.senderId` (the
 * documented alias is `replyingToPreview`). That claim is usable only when
 * `replyPreviewValidation` is `"valid"` — the SDK checked it against the
 * embedded signed original. `"invalid"` and a missing verdict are untrusted:
 * a forged preview must not choose who gets warned or kicked.
 *
 * Numeric sender ids are ignored. Snowflake user ids are not safe JavaScript
 * numbers, so only the string form is accepted.
 */
export function trustedReplySenderId(event: DecryptedEvent): string | undefined {
  const validation = readString(event, "replyPreviewValidation", "reply_preview_validation");
  if (validation?.toLowerCase() !== "valid") return undefined;
  const content = event.content;
  if (!content) return undefined;
  const preview = readRecord(content, "replyingToPreview", "replying_to_preview");
  if (!preview) return undefined;
  return readString(preview, "senderId", "sender_id");
}

function readReaction(
  event: DecryptedEvent,
): { removed: boolean; targetId?: string; emoji?: string } | undefined {
  const content = event.content;
  if (!content) return undefined;
  const kind = `${content.contentType ?? content.content_type ?? ""}`;
  if (kind !== "reaction" && kind !== "reactionRemoved" && kind !== "reaction_removed") {
    return undefined;
  }
  const targetId = readString(content, "targetMessageId", "target_message_id");
  const emoji = typeof content.emoji === "string" ? content.emoji : undefined;
  return { removed: kind !== "reaction", targetId, emoji };
}

/**
 * Reply target for `+` / `-`. The sender string is trusted only when
 * `verified` is true (same rule as `trustedReplySenderId`). Sequence and
 * message ids are kept either way so a message this process already saw
 * can still be resolved.
 */
function readReply(event: DecryptedEvent): ReplyTarget | undefined {
  const content = event.content;
  if (!content) return undefined;
  const preview = readRecord(content, "replyingToPreview", "replying_to_preview");
  if (!preview) return undefined;
  const senderId = readString(preview, "senderId", "sender_id");
  const sequenceId = readString(
    preview,
    "replyingToMessageSequenceId",
    "replying_to_message_sequence_id",
    "sequenceId",
    "sequence_id",
  );
  const eventId = readString(
    preview,
    "replyingToMessageId",
    "replying_to_message_id",
    "messageId",
    "message_id",
  );
  if (!senderId && !sequenceId && !eventId) return undefined;
  const validation = readString(event, "replyPreviewValidation", "reply_preview_validation");
  return {
    senderId,
    sequenceId,
    eventId,
    verified: validation?.toLowerCase() === "valid",
  };
}

function readString(value: object, ...keys: string[]): string | undefined {
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const field = record[key];
    if (typeof field !== "string") continue;
    const trimmed = field.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function readRecord(value: object, ...keys: string[]): object | undefined {
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const field = record[key];
    if (field && typeof field === "object") return field;
  }
  return undefined;
}

function messageText(event: DecryptedEvent): string | undefined {
  const content = event.content;
  if (!content || typeof content.text !== "string") return undefined;
  const kind = content.contentType ?? content.content_type;
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

function replayAliases(
  raw: RawChatEvent,
  decrypted: DecryptedEvent,
  id: string,
): { aliasIds: string[] } | undefined {
  const aliasIds: string[] = [];
  const decryptedId = nonempty(decrypted.id);
  if (decryptedId && decryptedId !== id) aliasIds.push(decryptedId);
  const cipher = cipherReplayKey(raw.encoded_event);
  if (cipher) aliasIds.push(cipher);
  if (aliasIds.length === 0) return undefined;
  return { aliasIds };
}

function nonempty(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  return value;
}
