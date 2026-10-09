import { createHash } from "node:crypto";
import { chatLinkSignals } from "../bot/linkroast.js";
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
 * the moderation engine already understands. Key changes, reaction
 * removals, and typing indicators are not commands and return undefined.
 * Edits and deletes are returned so local history can keep the new text
 * and a delete stamp. Reaction adds become `ReactionAdd` so passive XP
 * can see them. Text messages keep a reply preview when chat-xdk decrypted one.
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
    const edit = readHistoryEdit(decrypted);
    if (edit) {
      return {
        id,
        eventType: "MessageEdit",
        conversationId: raw.conversation_id || conversationId,
        createdAt,
        senderId,
        participantIds: [],
        participants: [],
        text: edit.text,
        mentions: mentionsIn(edit.text),
        sequenceId,
        ...(edit.targetSequenceId ? { targetSequenceId: edit.targetSequenceId } : {}),
        ...(edit.targetEventId ? { targetEventId: edit.targetEventId } : {}),
        ...aliases,
      };
    }
    const deleted = readHistoryDelete(decrypted);
    if (deleted) {
      return {
        id,
        eventType: "MessageDelete",
        conversationId: raw.conversation_id || conversationId,
        createdAt,
        senderId,
        participantIds: [],
        participants: [],
        mentions: [],
        sequenceId,
        ...(deleted.targetSequenceId ? { targetSequenceId: deleted.targetSequenceId } : {}),
        ...(deleted.targetEventId ? { targetEventId: deleted.targetEventId } : {}),
        ...(deleted.targetSequenceIds.length > 0 ? { targetSequenceIds: deleted.targetSequenceIds } : {}),
        ...(deleted.targetEventIds.length > 0 ? { targetEventIds: deleted.targetEventIds } : {}),
        ...aliases,
      };
    }
    const kind = messageKind(decrypted);
    if (kind && kind !== "text") return undefined;
    const text = typeof decrypted.content?.text === "string" ? decrypted.content.text : undefined;
    const linkSignals = chatLinkSignals(decrypted);
    const media = mediaMarker(decrypted);
    if (text === undefined && !linkSignals && !media) return undefined;
    const body = text ?? "";
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
      text: body,
      mentions: mentionsIn(body),
      sequenceId,
      ...(media ? { media } : {}),
      ...(linkSignals ? { linkSignals } : {}),
      ...(raw.encoded_event ? { encodedEvent: raw.encoded_event } : {}),
      ...(replyToSenderId ? { replyToSenderId } : {}),
      ...(replyTo ? { replyTo } : {}),
      ...aliases,
    };
  }

  if (decrypted.type === "groupChange") {
    const changeType = canonicalChangeType(readChangeType(decrypted));
    const memberIds = readMemberIds(decrypted);
    if (changeType === "membersadded" || changeType === "created") {
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
        membershipKind: changeType === "created" ? "join" : "add",
        ...aliases,
      };
    }
    // chat-xdk GroupChange `membersRemoved` (Thrift GroupMemberRemoveChange).
    // Voluntary leave and an admin remove/kick share this one variant.
    // WASM 0.5 nests the payload as `change.change_type` / `change.member_ids`.
    if (changeType === "membersremoved") {
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
        membershipKind: "leave",
        ...aliases,
      };
    }
  }

  const topKind = canonicalToken(decrypted.type);
  if (topKind === "messageedit" || topKind === "edit") {
    const edit = readHistoryEdit(decrypted);
    if (edit) {
      return {
        id,
        eventType: "MessageEdit",
        conversationId: raw.conversation_id || conversationId,
        createdAt,
        senderId,
        participantIds: [],
        participants: [],
        text: edit.text,
        mentions: mentionsIn(edit.text),
        sequenceId,
        ...(edit.targetSequenceId ? { targetSequenceId: edit.targetSequenceId } : {}),
        ...(edit.targetEventId ? { targetEventId: edit.targetEventId } : {}),
        ...aliases,
      };
    }
  }
  if (topKind === "messagedelete" || topKind === "delete") {
    const topDelete = readHistoryDelete(decrypted);
    if (topDelete) {
      return {
        id,
        eventType: "MessageDelete",
        conversationId: raw.conversation_id || conversationId,
        createdAt,
        senderId,
        participantIds: [],
        participants: [],
        mentions: [],
        sequenceId,
        ...(topDelete.targetSequenceId ? { targetSequenceId: topDelete.targetSequenceId } : {}),
        ...(topDelete.targetEventId ? { targetEventId: topDelete.targetEventId } : {}),
        ...(topDelete.targetSequenceIds.length > 0
          ? { targetSequenceIds: topDelete.targetSequenceIds }
          : {}),
        ...(topDelete.targetEventIds.length > 0 ? { targetEventIds: topDelete.targetEventIds } : {}),
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

function messageKind(event: DecryptedEvent): string {
  const content = event.content;
  if (!content) return "";
  return `${content.contentType ?? content.content_type ?? ""}`;
}

/**
 * `membersRemoved` and `members_removed` are the same change. Admin add/remove
 * stays a different token so it is not announced as a leave.
 */
function canonicalChangeType(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase().replace(/_/g, "");
  return normalized || undefined;
}

function changeRecords(event: DecryptedEvent): object[] {
  const records: object[] = [event];
  const nested = readRecord(event, "change", "groupChange", "group_change");
  if (nested && nested !== event) records.push(nested);
  return records;
}

function readChangeType(event: DecryptedEvent): string | undefined {
  for (const record of changeRecords(event)) {
    const value = readString(record, "changeType", "change_type");
    if (value) return value;
  }
  return undefined;
}

function readMemberIds(event: DecryptedEvent): string[] {
  for (const record of changeRecords(event)) {
    const ids = readIdList(record, "memberIds", "member_ids");
    if (ids.length > 0) return ids;
  }
  return [];
}

function readIdList(value: object, ...keys: string[]): string[] {
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const field = record[key];
    if (!Array.isArray(field)) continue;
    const ids = field.filter((id): id is string => typeof id === "string" && id.length > 0);
    if (ids.length > 0) return ids;
  }
  return [];
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

function canonicalToken(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/_/g, "");
}

const EDIT_KINDS = new Set(["messageedit", "edit", "editedmessage"]);
const DELETE_KINDS = new Set(["messagedelete", "messagedeleted", "delete", "deletedmessage"]);

/**
 * chat-xdk keeps an edit inside the decrypted message as `message_edit`
 * (`updated_text` plus the target sequence). Some builds use `contentType`
 * `messageEdit` on a `type: "message"` event, and some set `type` itself.
 */
function readHistoryEdit(
  event: DecryptedEvent,
): { text: string; targetSequenceId?: string; targetEventId?: string } | undefined {
  const content = event.content;
  const kind = canonicalToken(messageKind(event));
  const top = canonicalToken(event.type);
  if (!EDIT_KINDS.has(kind) && !EDIT_KINDS.has(top)) return undefined;
  const sources = [content, event].filter((value): value is object => Boolean(value));
  let text: string | undefined;
  for (const source of sources) {
    text =
      readString(source, "updatedText", "updated_text", "text", "messageText", "message_text") ??
      text;
  }
  if (text === undefined) return undefined;
  const targetSequenceId = firstString(sources, [
    "messageSequenceId",
    "message_sequence_id",
    "targetSequenceId",
    "target_sequence_id",
    "targetMessageSequenceId",
  ]);
  const targetEventId = firstString(sources, [
    "targetMessageId",
    "target_message_id",
    "targetEventId",
    "messageId",
    "message_id",
  ]);
  return { text, targetSequenceId, targetEventId };
}

/**
 * A user or moderator delete is `MessageEventDetail.messageDeleteEvent`, a
 * sibling of the encrypted create, not a content variant. chat-xdk surfaces
 * that as `type: "messageDelete"` when the decrypt path emits it. The target
 * ids live on the payload; the event's own sequence id is not the target.
 */
function readHistoryDelete(event: DecryptedEvent):
  | {
      targetSequenceId?: string;
      targetEventId?: string;
      targetSequenceIds: string[];
      targetEventIds: string[];
    }
  | undefined {
  const content = event.content;
  const kind = canonicalToken(messageKind(event));
  const top = canonicalToken(event.type);
  if (!DELETE_KINDS.has(kind) && !DELETE_KINDS.has(top)) return undefined;
  const sources = [content, event].filter((value): value is object => Boolean(value));
  const targetSequenceIds = firstIdList(sources, [
    "sequenceIds",
    "sequence_ids",
    "messageSequenceIds",
    "message_sequence_ids",
    "deletedSequenceIds",
    "deleted_sequence_ids",
  ]);
  const targetEventIds = firstIdList(sources, [
    "messageIds",
    "message_ids",
    "eventIds",
    "event_ids",
    "deletedMessageIds",
    "deleted_message_ids",
  ]);
  const targetSequenceId = firstString(sources, [
    "messageSequenceId",
    "message_sequence_id",
    "targetSequenceId",
    "target_sequence_id",
  ]);
  const targetEventId = firstString(sources, [
    "targetMessageId",
    "target_message_id",
    "messageId",
    "message_id",
  ]);
  if (targetSequenceId && !targetSequenceIds.includes(targetSequenceId)) {
    targetSequenceIds.unshift(targetSequenceId);
  }
  if (targetEventId && !targetEventIds.includes(targetEventId)) targetEventIds.unshift(targetEventId);
  if (targetSequenceIds.length === 0 && targetEventIds.length === 0) return undefined;
  return { targetSequenceId, targetEventId, targetSequenceIds, targetEventIds };
}

function firstString(sources: object[], keys: string[]): string | undefined {
  for (const source of sources) {
    const value = readString(source, ...keys);
    if (value) return value;
  }
  return undefined;
}

function firstIdList(sources: object[], keys: string[]): string[] {
  for (const source of sources) {
    const ids = readIdList(source, ...keys);
    if (ids.length > 0) return ids;
  }
  return [];
}

/** `media_type` omitted on an inline attachment is a photo. */
function mediaMarker(event: DecryptedEvent): string | undefined {
  const found = new Set<string>();
  collectMedia(event.attachments, found, 0);
  collectMedia(event.content?.attachments, found, 0);
  if (found.size === 0) return undefined;
  if (found.size === 1) return [...found][0];
  return "media";
}

function collectMedia(value: unknown, found: Set<string>, depth: number): void {
  if (depth > 4 || value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) collectMedia(item, found, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const marker = markerForAttachment(record);
  if (marker) found.add(marker);
  for (const key of ["media", "attachment", "attachments"]) {
    if (key in record) collectMedia(record[key], found, depth + 1);
  }
}

function markerForAttachment(record: Record<string, unknown>): string | undefined {
  const kind = canonicalToken(readString(record, "attachmentType", "attachment_type"));
  const mediaType = record.mediaType ?? record.media_type ?? record.type;
  const named = canonicalToken(typeof mediaType === "string" ? mediaType : undefined);
  const numeric = typeof mediaType === "number" ? mediaType : Number.NaN;
  if (named === "gif" || numeric === 2) return "gif";
  if (named === "video" || numeric === 3) return "video";
  if (named === "audio" || numeric === 4) return "audio";
  if (named === "file" || numeric === 5) return "file";
  if (named === "svg" || numeric === 6) return "image";
  if (named === "image" || numeric === 1) return "image";
  const hasMedia =
    kind === "media" ||
    typeof record.mediaHashKey === "string" ||
    typeof record.media_hash_key === "string";
  if (hasMedia) return "image";
  return undefined;
}
