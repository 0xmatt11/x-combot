import fs from "node:fs";
import path from "node:path";
import { log } from "../log.js";
import type { DmEvent } from "../types.js";

/**
 * How many recent MessageCreate events to keep per conversation.
 * `!purge` caps at 100, so 200 leaves room for the command line itself
 * and for messages that are not delete targets.
 */
export const PURGE_MEMORY_LIMIT = 200;

/** Default debounce before the on-disk window is replaced. */
export const PURGE_MEMORY_WRITE_DELAY_MS = 1_000;

export const PURGE_MEMORY_SCHEMA = 1;

export interface PurgeMemoryOptions {
  limit?: number;
  /** Absent keeps the window in memory only. */
  filePath?: string;
  /**
   * How long to wait after an update before replacing the file.
   * `0` writes during `remember`. Default is one second.
   */
  writeDelayMs?: number;
}

export interface PurgeSequenceNote {
  conversationId: string;
  sequenceId: string;
  /** Client message id first, then any other id for the same send. */
  ids: readonly string[];
  senderId?: string;
  createdAt?: string;
}

export interface PurgeMemory {
  /** Remember one inbound or outbound event. Non-messages and rows without an id are ignored. */
  remember(event: DmEvent): void;
  /**
   * Attach a sequence id to the row that already uses one of `ids`.
   * Does not move that row. A new row is inserted only when none of the ids match.
   */
  attachSequence(note: PurgeSequenceNote): void;
  /** Newest first. Empty when this conversation has not been seen. */
  list(conversationId: string): readonly DmEvent[];
  /** Write the window now. No-op when there is no file. */
  flush(): void;
}

/**
 * File beside `chat-remote-keys.json`. Restarts load it before the next purge.
 * `CHAT_RECENT_MESSAGES_PATH` moves it. The directory follows `CHAT_KEYS_PATH`.
 */
export function recentMessagesPathBeside(chatKeysPath: string): string {
  return path.join(path.dirname(chatKeysPath), "chat-recent-messages.json");
}

/**
 * In-process ring of MessageCreate events, newest first, optionally mirrored
 * to disk. Activity, the poller, and the bot's own sends all call `remember`.
 * The snapshot and the file keep only the ids `!purge` needs. Message text
 * and ciphertext are not copied.
 */
export function createPurgeMemory(limitOrOptions: number | PurgeMemoryOptions = {}): PurgeMemory {
  const options: PurgeMemoryOptions =
    typeof limitOrOptions === "number" ? { limit: limitOrOptions } : limitOrOptions;
  const cap = Math.max(1, Math.floor(options.limit ?? PURGE_MEMORY_LIMIT));
  const filePath = options.filePath?.trim() || undefined;
  const writeDelayMs =
    options.writeDelayMs === undefined
      ? PURGE_MEMORY_WRITE_DELAY_MS
      : Math.max(0, options.writeDelayMs);
  const byConversation = new Map<string, DmEvent[]>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  if (filePath) {
    for (const [conversationId, events] of loadRecentMessages(filePath, cap)) {
      byConversation.set(conversationId, events);
    }
  }

  function writeNow(): void {
    if (!filePath) return;
    try {
      writeRecentMessages(filePath, byConversation);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      log.warn(
        `Could not save the recent-message window${message ? `: ${message.slice(0, 160)}` : ""}`,
      );
    }
  }

  function scheduleWrite(): void {
    if (!filePath) return;
    if (writeDelayMs <= 0) {
      writeNow();
      return;
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      writeNow();
    }, writeDelayMs);
    timer.unref?.();
  }

  return {
    remember(event) {
      if (event.eventType !== "MessageCreate") return;
      if (!event.id || !event.conversationId) return;
      const snapshot = snapshotPurgeEvent(event);
      const existing = byConversation.get(event.conversationId) ?? [];
      const previous = existing.find((row) => samePurgeMessage(row, snapshot));
      const kept = existing.filter((row) => !samePurgeMessage(row, snapshot));
      kept.unshift(mergePurgeSnapshot(snapshot, previous));
      if (kept.length > cap) kept.length = cap;
      byConversation.set(event.conversationId, kept);
      scheduleWrite();
    },
    attachSequence(note) {
      const conversationId = note.conversationId.trim();
      const sequenceId = note.sequenceId.trim();
      const ids = uniqueIds(note.ids);
      if (!conversationId || !sequenceId || ids.length === 0) return;
      const probe = snapshotPurgeEvent({
        id: ids[0] ?? "",
        eventType: "MessageCreate",
        conversationId,
        sequenceId,
        participantIds: [],
        participants: [],
        mentions: [],
        ...(ids.length > 1 ? { aliasIds: ids.slice(1) } : {}),
        ...(note.senderId ? { senderId: note.senderId } : {}),
        ...(note.createdAt ? { createdAt: note.createdAt } : {}),
      });
      const existing = byConversation.get(conversationId) ?? [];
      const index = existing.findIndex((row) => samePurgeMessage(row, probe));
      if (index === -1) {
        this.remember(probe);
        return;
      }
      const row = existing[index];
      if (!row) return;
      const aliasIds = uniqueIds([
        ...(row.aliasIds ?? []),
        ...ids.filter((id) => id !== row.id),
      ]);
      existing[index] = {
        ...row,
        sequenceId,
        ...(aliasIds.length > 0 ? { aliasIds } : {}),
      };
      scheduleWrite();
    },
    list(conversationId) {
      return byConversation.get(conversationId) ?? [];
    },
    flush() {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      writeNow();
    },
  };
}

/**
 * Delete needs the event id and, for encrypted Chat, the sequence id.
 * Text and ciphertext stay on the live event only — they are not copied here
 * and they are not written to disk.
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

/**
 * A later delivery of the same message must not drop a sequence id we already
 * learned, and must keep the earlier id as an alias.
 */
function mergePurgeSnapshot(snapshot: DmEvent, previous: DmEvent | undefined): DmEvent {
  if (!previous) return snapshot;
  const sequenceId = snapshot.sequenceId || previous.sequenceId;
  const aliasIds = uniqueIds([
    ...(snapshot.aliasIds ?? []),
    ...(previous.aliasIds ?? []),
    ...(previous.id && previous.id !== snapshot.id ? [previous.id] : []),
  ]);
  return {
    ...snapshot,
    ...(sequenceId ? { sequenceId } : {}),
    ...(aliasIds.length > 0 ? { aliasIds } : {}),
  };
}

function uniqueIds(values: readonly (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const id = value?.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
  }
  return unique;
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

interface DiskPurgeEvent {
  id: string;
  event_type: "MessageCreate";
  conversation_id: string;
  sequence_id?: string;
  sender_id?: string;
  created_at?: string;
}

function toDisk(event: DmEvent): DiskPurgeEvent | undefined {
  if (!event.id || !event.conversationId || event.eventType !== "MessageCreate") return undefined;
  return {
    id: event.id,
    event_type: "MessageCreate",
    conversation_id: event.conversationId,
    ...(event.sequenceId ? { sequence_id: event.sequenceId } : {}),
    ...(event.senderId ? { sender_id: event.senderId } : {}),
    ...(event.createdAt ? { created_at: event.createdAt } : {}),
  };
}

function fromDisk(conversationId: string, value: unknown): DmEvent | undefined {
  if (!isRecord(value)) return undefined;
  if (value.event_type !== "MessageCreate") return undefined;
  if (typeof value.id !== "string" || value.id.length === 0) return undefined;
  const conversation =
    typeof value.conversation_id === "string" && value.conversation_id.length > 0
      ? value.conversation_id
      : conversationId;
  if (conversation !== conversationId) return undefined;
  return {
    id: value.id,
    eventType: "MessageCreate",
    conversationId,
    participantIds: [],
    participants: [],
    mentions: [],
    ...(typeof value.sequence_id === "string" && value.sequence_id
      ? { sequenceId: value.sequence_id }
      : {}),
    ...(typeof value.sender_id === "string" && value.sender_id ? { senderId: value.sender_id } : {}),
    ...(typeof value.created_at === "string" && value.created_at
      ? { createdAt: value.created_at }
      : {}),
  };
}

function loadRecentMessages(filePath: string, cap: number): Map<string, DmEvent[]> {
  const loaded = new Map<string, DmEvent[]>();
  if (!fs.existsSync(filePath)) return loaded;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    log.warn("Recent-message window file could not be read");
    return loaded;
  }
  if (!isRecord(parsed) || parsed.schema !== PURGE_MEMORY_SCHEMA || !isRecord(parsed.conversations)) {
    log.warn("Recent-message window file was ignored");
    return loaded;
  }
  for (const [conversationId, value] of Object.entries(parsed.conversations)) {
    if (!conversationId || !Array.isArray(value)) continue;
    const events: DmEvent[] = [];
    const seen = new Set<string>();
    for (const row of value) {
      const event = fromDisk(conversationId, row);
      if (!event || seen.has(event.id)) continue;
      if (event.sequenceId && seen.has(`seq:${event.sequenceId}`)) continue;
      seen.add(event.id);
      if (event.sequenceId) seen.add(`seq:${event.sequenceId}`);
      events.push(event);
      if (events.length >= cap) break;
    }
    if (events.length > 0) loaded.set(conversationId, events);
  }
  return loaded;
}

function writeRecentMessages(filePath: string, byConversation: Map<string, DmEvent[]>): void {
  const conversations: Record<string, DiskPurgeEvent[]> = {};
  for (const [conversationId, events] of byConversation) {
    const rows = events.map(toDisk).filter((row): row is DiskPurgeEvent => Boolean(row));
    if (rows.length > 0) conversations[conversationId] = rows;
  }
  const body = { schema: PURGE_MEMORY_SCHEMA, conversations };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  fs.chmodSync(filePath, 0o600);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
