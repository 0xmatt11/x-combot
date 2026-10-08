import type { DmEvent } from "../types.js";

/**
 * How many recent MessageCreate events to keep per conversation.
 * `!purge` caps at 100, so 200 leaves room for the command line itself
 * and for messages that are not delete targets.
 */
export const PURGE_MEMORY_LIMIT = 200;

export interface PurgeMemory {
  /** Remember one inbound event. Non-messages and rows without an id are ignored. */
  remember(event: DmEvent): void;
  /** Newest first. Empty when this conversation has not been seen. */
  list(conversationId: string): readonly DmEvent[];
}

/**
 * In-process ring of decrypted MessageCreate events, newest first.
 * Activity push and the catch-up poller both enter through `processEvent`,
 * which is what fills this. The snapshot keeps the ids `!purge` needs to
 * delete and leaves out message text and `encodedEvent` ciphertext.
 */
export function createPurgeMemory(limit = PURGE_MEMORY_LIMIT): PurgeMemory {
  const cap = Math.max(1, Math.floor(limit));
  const byConversation = new Map<string, DmEvent[]>();

  return {
    remember(event) {
      if (event.eventType !== "MessageCreate") return;
      if (!event.id || !event.conversationId) return;
      const snapshot = snapshotPurgeEvent(event);
      const existing = byConversation.get(event.conversationId) ?? [];
      const kept = existing.filter((row) => !samePurgeMessage(row, snapshot));
      kept.unshift(snapshot);
      if (kept.length > cap) kept.length = cap;
      byConversation.set(event.conversationId, kept);
    },
    list(conversationId) {
      return byConversation.get(conversationId) ?? [];
    },
  };
}

/**
 * Delete needs the event id and, for encrypted Chat, the sequence id.
 * Text and ciphertext stay on the live event only — they are not copied here.
 */
function snapshotPurgeEvent(event: DmEvent): DmEvent {
  const aliasIds = (event.aliasIds ?? []).filter((alias) => alias.length > 0);
  return {
    id: event.id,
    eventType: "MessageCreate",
    conversationId: event.conversationId,
    participantIds: [],
    participants: [],
    mentions: [],
    ...(event.createdAt ? { createdAt: event.createdAt } : {}),
    ...(event.senderId ? { senderId: event.senderId } : {}),
    ...(event.sequenceId ? { sequenceId: event.sequenceId } : {}),
    ...(aliasIds.length > 0 ? { aliasIds: [...aliasIds] } : {}),
  };
}

/** Activity and the poller decrypt one message under different raw ids. */
function samePurgeMessage(a: DmEvent, b: DmEvent): boolean {
  if (a.id && a.id === b.id) return true;
  if (
    a.sequenceId &&
    b.sequenceId &&
    a.sequenceId === b.sequenceId &&
    a.conversationId === b.conversationId
  ) {
    return true;
  }
  const bAliases = new Set(b.aliasIds ?? []);
  if (a.id && bAliases.has(a.id)) return true;
  for (const alias of a.aliasIds ?? []) {
    if (!alias) continue;
    if (alias === b.id || bAliases.has(alias)) return true;
  }
  return false;
}
