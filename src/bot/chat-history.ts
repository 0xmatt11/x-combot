import fs from "node:fs";
import type Database from "better-sqlite3";
import { log } from "../log.js";
import type { ChatTurn } from "../llm/context.js";
import { displayName } from "../x/client.js";
import type { DmEvent, XUser } from "../types.js";

/** Ask-mode `recent` window when the prompt is filled from this store. */
export const LOCAL_ASK_RECENT_MESSAGES = 100;

export const DEFAULT_CHAT_HISTORY_MAX_MESSAGES = 50_000;
export const DEFAULT_CHAT_HISTORY_MAX_DAYS = 365;

/** How often a running process drops rows past the retention caps. */
export const CHAT_HISTORY_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/** One backfill page. Matches the events-list page cap. */
export const CHAT_HISTORY_BACKFILL_PAGE_SIZE = 100;

/** Search hits appended to an LLM prompt. */
export const CHAT_HISTORY_SEARCH_LIMIT = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ChatHistoryOptions {
  /** Default true. When false, nothing is written and asks keep using X. */
  enabled?: boolean;
  maxMessages?: number;
  maxDays?: number;
  /**
   * When false, rows with `deleted_in_x_at` are left out of LLM context and search.
   * Default true: purged and X-deleted rows still count as history.
   */
  includeDeleted?: boolean;
  /** Tests use this to exercise the LIKE search when FTS5 is compiled in. */
  forceLike?: boolean;
}

export interface ChatHistoryMessageRow {
  id: number;
  conversation_id: string;
  message_id: string;
  sequence_id: string | null;
  sender_id: string | null;
  sender_label: string | null;
  ts: string | null;
  ts_ms: number | null;
  text: string;
  original_text: string | null;
  reply_to_id: string | null;
  media: string | null;
  deleted_in_x_at: string | null;
  deleted_by: string | null;
  edited: number;
}

export interface ChatHistoryMembershipRow {
  id: number;
  conversation_id: string;
  event_id: string;
  sequence_id: string | null;
  kind: string;
  actor_id: string | null;
  actor_label: string | null;
  subject_id: string | null;
  subject_label: string | null;
  ts: string | null;
  ts_ms: number | null;
}

export interface BackfillRow {
  conversationId: string;
  cursor: string | null;
  done: boolean;
  pages: number;
  stored: number;
}

interface ObserveCounts {
  messages: number;
  membership: number;
}

/**
 * Mode 0600 on the SQLite file and its WAL/SHM siblings.
 * The database now holds decrypted chat text.
 */
export function restrictSqlitePermissions(filename: string): void {
  if (!filename || filename === ":memory:") return;
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = `${filename}${suffix}`;
    try {
      fs.chmodSync(file, 0o600);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      log.warn(`Could not set mode 0600 on ${file.endsWith(".sqlite") ? "the database file" : "a database sidecar"}`);
    }
  }
}

let schemaReady = new WeakSet<Database.Database>();

export function ensureChatHistorySchema(db: Database.Database): { fts: boolean } {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_history_messages (
      id INTEGER PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      sequence_id TEXT,
      sender_id TEXT,
      sender_label TEXT,
      ts TEXT,
      ts_ms INTEGER,
      text TEXT NOT NULL DEFAULT '',
      original_text TEXT,
      reply_to_id TEXT,
      media TEXT,
      deleted_in_x_at TEXT,
      deleted_by TEXT,
      edited INTEGER NOT NULL DEFAULT 0
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_history_message
      ON chat_history_messages (conversation_id, message_id);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_history_sequence
      ON chat_history_messages (conversation_id, sequence_id)
      WHERE sequence_id IS NOT NULL AND length(sequence_id) > 0;

    CREATE INDEX IF NOT EXISTS idx_chat_history_ts
      ON chat_history_messages (conversation_id, ts_ms);

    CREATE INDEX IF NOT EXISTS idx_chat_history_sender
      ON chat_history_messages (conversation_id, sender_id);

    CREATE TABLE IF NOT EXISTS chat_history_aliases (
      conversation_id TEXT NOT NULL,
      alias TEXT NOT NULL,
      message_row INTEGER NOT NULL,
      PRIMARY KEY (conversation_id, alias)
    );

    CREATE INDEX IF NOT EXISTS idx_chat_history_alias_row
      ON chat_history_aliases (message_row);

    CREATE TABLE IF NOT EXISTS chat_history_tombstones (
      conversation_id TEXT NOT NULL,
      target_key TEXT NOT NULL,
      deleted_at TEXT NOT NULL,
      deleted_by TEXT NOT NULL,
      PRIMARY KEY (conversation_id, target_key)
    );

    CREATE TABLE IF NOT EXISTS chat_history_membership (
      id INTEGER PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      sequence_id TEXT,
      kind TEXT NOT NULL,
      actor_id TEXT,
      actor_label TEXT,
      subject_id TEXT,
      subject_label TEXT,
      ts TEXT,
      ts_ms INTEGER,
      UNIQUE (conversation_id, event_id, subject_id)
    );

    CREATE INDEX IF NOT EXISTS idx_chat_history_membership_ts
      ON chat_history_membership (conversation_id, ts_ms);

    CREATE INDEX IF NOT EXISTS idx_chat_history_membership_subject
      ON chat_history_membership (conversation_id, subject_id);

    CREATE TABLE IF NOT EXISTS chat_history_backfill (
      conversation_id TEXT PRIMARY KEY,
      cursor TEXT,
      done INTEGER NOT NULL DEFAULT 0,
      pages INTEGER NOT NULL DEFAULT 0,
      stored INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
  `);
  const fts = ensureFts(db);
  schemaReady.add(db);
  return { fts };
}

function ensureFts(db: Database.Database): boolean {
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chat_history_fts USING fts5(
        text,
        sender_label,
        tokenize = 'unicode61'
      );
    `);
    return true;
  } catch {
    return false;
  }
}

export function createChatHistory(
  db: Database.Database,
  options: ChatHistoryOptions = {},
): ChatHistory {
  return new ChatHistory(db, options);
}

/**
 * Decrypted group history in the bot's SQLite file.
 * Append-only aside from edits (text replacement plus `original_text`) and
 * delete stamps (`deleted_in_x_at`). Message text is never logged.
 */
export class ChatHistory {
  readonly enabled: boolean;
  readonly includeDeleted: boolean;
  private readonly maxMessages: number;
  private readonly maxDays: number;
  private readonly fts: boolean;
  private readonly db: Database.Database;

  constructor(db: Database.Database, options: ChatHistoryOptions = {}) {
    this.db = db;
    this.enabled = options.enabled !== false;
    this.includeDeleted = options.includeDeleted !== false;
    this.maxMessages = normalizeCap(options.maxMessages, DEFAULT_CHAT_HISTORY_MAX_MESSAGES);
    this.maxDays = normalizeCap(options.maxDays, DEFAULT_CHAT_HISTORY_MAX_DAYS);
    const ftsReady = this.enabled
      ? ensureChatHistorySchema(db).fts
      : schemaReady.has(db) && ftsPresent(db);
    this.fts = Boolean(ftsReady) && options.forceLike !== true;
  }

  observe(event: DmEvent, senderLabel?: string): ObserveCounts {
    const empty = { messages: 0, membership: 0 };
    if (!this.enabled || !event.conversationId || !event.id) return empty;
    if (event.eventType === "MessageEdit") {
      this.applyEdit(event);
      return empty;
    }
    if (event.eventType === "MessageDelete") {
      this.applyRemoteDelete(event);
      return empty;
    }
    if (event.eventType === "ParticipantsJoin" || event.eventType === "ParticipantsLeave") {
      const membership = this.insertMembership(event, senderLabel);
      this.ensureBackfill(event.conversationId);
      return { messages: 0, membership };
    }
    if (event.eventType !== "MessageCreate") return empty;
    const inserted = this.appendMessage(event, senderLabel);
    this.ensureBackfill(event.conversationId);
    return { messages: inserted ? 1 : 0, membership: 0 };
  }

  /** Remember a handle learned after the row was written. Skips "someone". */
  noteSender(userId: string, label: string): void {
    if (!this.enabled || !userId || !label || label === "someone") return;
    this.db
      .prepare(
        `UPDATE chat_history_messages
         SET sender_label = ?
         WHERE sender_id = ? AND (sender_label IS NULL OR sender_label != ?)`,
      )
      .run(label, userId, label);
    this.db
      .prepare(
        `UPDATE chat_history_membership
         SET subject_label = ?
         WHERE subject_id = ? AND (subject_label IS NULL OR subject_label = 'someone' OR subject_label != ?)`,
      )
      .run(label, userId, label);
    this.db
      .prepare(
        `UPDATE chat_history_membership
         SET actor_label = ?
         WHERE actor_id = ? AND (actor_label IS NULL OR actor_label = 'someone' OR actor_label != ?)`,
      )
      .run(label, userId, label);
  }

  /**
   * Attach a sequence id learned after send (`chat.sent` or the send body).
   * Does not change stored text.
   */
  attachSequence(conversationId: string, ids: readonly string[], sequenceId: string): void {
    if (!this.enabled || !conversationId || !sequenceId) return;
    const keys = ids.map((id) => id.trim()).filter(Boolean);
    if (keys.length === 0) return;
    const row = this.findRow(conversationId, keys);
    if (!row) return;
    this.rememberAliases(conversationId, row.id, [...keys, sequenceId]);
    if (!row.sequence_id) {
      const taken = this.findRow(conversationId, [sequenceId]);
      if (!taken || taken.id === row.id) {
        this.db
          .prepare("UPDATE chat_history_messages SET sequence_id = ? WHERE id = ?")
          .run(sequenceId, row.id);
      }
    }
  }

  /**
   * Stamp rows X actually deleted. Text stays. `deleted_by` is `purge` or `x`.
   * A later copy of the same message keeps the stamp via the tombstone table.
   */
  markDeleted(
    conversationId: string,
    keys: readonly string[],
    deletedBy: "purge" | "x",
    deletedAt: string,
  ): number {
    if (!this.enabled || !conversationId) return 0;
    const unique = [...new Set(keys.map((key) => key.trim()).filter(Boolean))];
    if (unique.length === 0) return 0;
    let marked = 0;
    const stamp = this.db.transaction(() => {
      for (const key of unique) {
        this.db
          .prepare(
            `INSERT INTO chat_history_tombstones (conversation_id, target_key, deleted_at, deleted_by)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(conversation_id, target_key) DO NOTHING`,
          )
          .run(conversationId, key, deletedAt, deletedBy);
        const row = this.findRow(conversationId, [key]);
        if (!row || row.deleted_in_x_at) continue;
        this.db
          .prepare(
            `UPDATE chat_history_messages
             SET deleted_in_x_at = ?, deleted_by = ?
             WHERE id = ? AND deleted_in_x_at IS NULL`,
          )
          .run(deletedAt, deletedBy, row.id);
        marked += 1;
      }
    });
    stamp();
    return marked;
  }

  /**
   * Oldest-first tail for the LLM. Reads `LIMIT` rows, not the whole table.
   */
  recentTurns(
    conversationId: string,
    limit: number,
    options?: { excludeEventId?: string; includeDeleted?: boolean },
  ): ChatTurn[] {
    if (!this.enabled || limit <= 0) return [];
    const includeDeleted = options?.includeDeleted ?? this.includeDeleted;
    const rows = this.db
      .prepare(
        `SELECT * FROM chat_history_messages
         WHERE conversation_id = ?
           AND (? = 1 OR deleted_in_x_at IS NULL)
         ORDER BY COALESCE(ts_ms, 0) DESC, id DESC
         LIMIT ?`,
      )
      .all(conversationId, includeDeleted ? 1 : 0, Math.max(limit + 5, limit)) as ChatHistoryMessageRow[];
    const turns: ChatTurn[] = [];
    for (const row of rows) {
      if (options?.excludeEventId && this.rowMatchesEvent(row, options.excludeEventId)) continue;
      const turn = rowToTurn(row);
      if (!turn) continue;
      turns.push(turn);
      if (turns.length >= limit) break;
    }
    return turns.reverse();
  }

  /**
   * Keyword, sender, and date search over messages and membership.
   * Empty when the question has nothing to look up.
   */
  searchContext(
    conversationId: string,
    question: string,
    nowMs: number,
    options?: { excludeEventId?: string; includeDeleted?: boolean },
  ): string | undefined {
    if (!this.enabled) return undefined;
    const plan = planHistorySearch(question, nowMs);
    if (plan.keywords.length === 0 && !plan.sender && !plan.membership) return undefined;
    const includeDeleted = options?.includeDeleted ?? this.includeDeleted;
    const lines: string[] = [];
    if (plan.keywords.length > 0 || plan.sender || plan.sinceMs !== undefined) {
      const messages = this.searchMessages(conversationId, plan, includeDeleted);
      for (const row of messages) {
        if (options?.excludeEventId && this.rowMatchesEvent(row, options.excludeEventId)) continue;
        const turn = rowToTurn(row);
        if (!turn) continue;
        const deleted = row.deleted_in_x_at ? " (deleted in X)" : "";
        lines.push(`[${turn.senderLabel}${turn.createdAt ? ` ${turn.createdAt}` : ""}] ${turn.text}${deleted}`);
        if (lines.length >= CHAT_HISTORY_SEARCH_LIMIT) break;
      }
    }
    if (plan.membership || plan.keywords.length > 0) {
      const members = this.searchMembership(conversationId, plan);
      for (const row of members) {
        if (lines.length >= CHAT_HISTORY_SEARCH_LIMIT) break;
        lines.push(formatMembershipLine(row));
      }
    }
    if (lines.length === 0) return undefined;
    return `Local history search (${lines.length} match${lines.length === 1 ? "" : "es"}):\n${lines.join("\n")}`;
  }

  ensureBackfill(conversationId: string, nowIso = new Date().toISOString()): void {
    if (!this.enabled || !conversationId) return;
    this.db
      .prepare(
        `INSERT INTO chat_history_backfill (conversation_id, cursor, done, pages, stored, updated_at)
         VALUES (?, NULL, 0, 0, 0, ?)
         ON CONFLICT(conversation_id) DO NOTHING`,
      )
      .run(conversationId, nowIso);
  }

  backfillOf(conversationId: string): BackfillRow | undefined {
    const row = this.db
      .prepare(
        `SELECT conversation_id, cursor, done, pages, stored
         FROM chat_history_backfill WHERE conversation_id = ?`,
      )
      .get(conversationId) as
      | { conversation_id: string; cursor: string | null; done: number; pages: number; stored: number }
      | undefined;
    if (!row) return undefined;
    return {
      conversationId: row.conversation_id,
      cursor: row.cursor,
      done: row.done === 1,
      pages: row.pages,
      stored: row.stored,
    };
  }

  /** One not-done conversation, oldest update first, so chats take turns. */
  nextBackfill(): BackfillRow | undefined {
    if (!this.enabled) return undefined;
    const row = this.db
      .prepare(
        `SELECT conversation_id, cursor, done, pages, stored
         FROM chat_history_backfill
         WHERE done = 0
         ORDER BY updated_at ASC, conversation_id ASC
         LIMIT 1`,
      )
      .get() as
      | { conversation_id: string; cursor: string | null; done: number; pages: number; stored: number }
      | undefined;
    if (!row) return undefined;
    return {
      conversationId: row.conversation_id,
      cursor: row.cursor,
      done: false,
      pages: row.pages,
      stored: row.stored,
    };
  }

  saveBackfillPage(input: {
    conversationId: string;
    cursor: string | null;
    done: boolean;
    added: number;
    nowIso?: string;
  }): BackfillRow {
    const nowIso = input.nowIso ?? new Date().toISOString();
    this.db
      .prepare(
        `UPDATE chat_history_backfill
         SET cursor = ?, done = ?, pages = pages + 1, stored = stored + ?, updated_at = ?
         WHERE conversation_id = ?`,
      )
      .run(input.cursor, input.done ? 1 : 0, input.added, nowIso, input.conversationId);
    return this.backfillOf(input.conversationId)!;
  }

  /** Bump the clock so a failed page does not block every other chat. */
  touchBackfill(conversationId: string, nowIso = new Date().toISOString()): void {
    this.db
      .prepare("UPDATE chat_history_backfill SET updated_at = ? WHERE conversation_id = ?")
      .run(nowIso, conversationId);
  }

  prune(nowMs = Date.now()): { messages: number; membership: number } {
    if (!this.enabled) return { messages: 0, membership: 0 };
    const cutoff = this.maxDays > 0 ? nowMs - this.maxDays * DAY_MS : nowMs;
    const removeMessages = this.db.prepare(
      "DELETE FROM chat_history_messages WHERE conversation_id = ? AND ts_ms IS NOT NULL AND ts_ms < ?",
    );
    const removeMembership = this.db.prepare(
      "DELETE FROM chat_history_membership WHERE conversation_id = ? AND ts_ms IS NOT NULL AND ts_ms < ?",
    );
    const trimMessages = this.db.prepare(
      `DELETE FROM chat_history_messages
       WHERE id IN (
         SELECT id FROM chat_history_messages
         WHERE conversation_id = ?
         ORDER BY COALESCE(ts_ms, 0) DESC, id DESC
         LIMIT -1 OFFSET ?
       )`,
    );
    const trimMembership = this.db.prepare(
      `DELETE FROM chat_history_membership
       WHERE id IN (
         SELECT id FROM chat_history_membership
         WHERE conversation_id = ?
         ORDER BY COALESCE(ts_ms, 0) DESC, id DESC
         LIMIT -1 OFFSET ?
       )`,
    );
    const conversations = this.db
      .prepare(
        `SELECT conversation_id FROM chat_history_messages
         UNION
         SELECT conversation_id FROM chat_history_membership`,
      )
      .all() as { conversation_id: string }[];
    let messages = 0;
    let membership = 0;
    const run = this.db.transaction(() => {
      for (const row of conversations) {
        if (this.maxDays > 0) {
          messages += removeMessages.run(row.conversation_id, cutoff).changes;
          membership += removeMembership.run(row.conversation_id, cutoff).changes;
        }
        if (this.maxMessages >= 0) {
          messages += trimMessages.run(row.conversation_id, this.maxMessages).changes;
          membership += trimMembership.run(row.conversation_id, this.maxMessages).changes;
        }
      }
      this.db
        .prepare(
          `DELETE FROM chat_history_aliases
           WHERE message_row NOT IN (SELECT id FROM chat_history_messages)`,
        )
        .run();
    });
    run();
    if (this.fts && (messages > 0 || membership > 0)) this.rebuildFts();
    return { messages, membership };
  }

  usesFts(): boolean {
    return this.fts;
  }

  listMessages(conversationId: string): ChatHistoryMessageRow[] {
    return this.db
      .prepare(
        `SELECT * FROM chat_history_messages
         WHERE conversation_id = ?
         ORDER BY COALESCE(ts_ms, 0) ASC, id ASC`,
      )
      .all(conversationId) as ChatHistoryMessageRow[];
  }

  listMembership(conversationId: string): ChatHistoryMembershipRow[] {
    return this.db
      .prepare(
        `SELECT * FROM chat_history_membership
         WHERE conversation_id = ?
         ORDER BY COALESCE(ts_ms, 0) ASC, id ASC`,
      )
      .all(conversationId) as ChatHistoryMembershipRow[];
  }

  private appendMessage(event: DmEvent, senderLabel?: string): boolean {
    const conversationId = event.conversationId;
    const messageId = event.id;
    const sequenceId = nonempty(event.sequenceId);
    const keys = aliasKeys(event);
    const existing = this.findRow(conversationId, keys);
    const text = event.text ?? "";
    const label = senderLabel ?? labelOf(event.sender, event.senderId);
    const ts = event.createdAt ?? null;
    const tsMs = millisOf(event.createdAt);
    const replyTo = event.replyTo?.eventId ?? event.replyTo?.sequenceId ?? null;
    const media = nonempty(event.media) ?? null;
    if (existing) {
      this.mergeCreate(existing, {
        conversationId,
        keys,
        sequenceId,
        senderId: event.senderId,
        label,
        text,
        ts,
        tsMs,
        replyTo,
        media,
      });
      return false;
    }
    const insert = this.db.transaction(() => {
      const info = this.db
        .prepare(
          `INSERT INTO chat_history_messages (
             conversation_id, message_id, sequence_id, sender_id, sender_label,
             ts, ts_ms, text, reply_to_id, media, edited
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        )
        .run(
          conversationId,
          messageId,
          sequenceId ?? null,
          event.senderId ?? null,
          label,
          ts,
          tsMs,
          text,
          replyTo,
          media,
        );
      const rowId = Number(info.lastInsertRowid);
      this.rememberAliases(conversationId, rowId, keys);
      this.applyTombstone(conversationId, rowId, keys);
      this.indexFts(rowId, text, label);
    });
    insert();
    return true;
  }

  private mergeCreate(
    existing: ChatHistoryMessageRow,
    incoming: {
      conversationId: string;
      keys: string[];
      sequenceId?: string;
      senderId?: string;
      label: string;
      text: string;
      ts: string | null;
      tsMs: number | null;
      replyTo: string | null;
      media: string | null;
    },
  ): void {
    this.rememberAliases(incoming.conversationId, existing.id, incoming.keys);
    const sequenceId =
      existing.sequence_id ||
      (incoming.sequenceId && !this.sequenceTaken(incoming.conversationId, incoming.sequenceId, existing.id)
        ? incoming.sequenceId
        : existing.sequence_id);
    let text = existing.text;
    let original = existing.original_text;
    if (existing.edited && !original && incoming.text && incoming.text !== existing.text) {
      original = incoming.text;
    }
    const label =
      existing.sender_label && existing.sender_label !== "someone"
        ? existing.sender_label
        : incoming.label || existing.sender_label;
    this.db
      .prepare(
        `UPDATE chat_history_messages
         SET sequence_id = COALESCE(?, sequence_id),
             sender_id = COALESCE(sender_id, ?),
             sender_label = ?,
             ts = COALESCE(ts, ?),
             ts_ms = COALESCE(ts_ms, ?),
             text = ?,
             original_text = ?,
             reply_to_id = COALESCE(reply_to_id, ?),
             media = COALESCE(media, ?)
         WHERE id = ?`,
      )
      .run(
        sequenceId ?? null,
        incoming.senderId ?? null,
        label,
        incoming.ts,
        incoming.tsMs,
        text,
        original,
        incoming.replyTo,
        incoming.media,
        existing.id,
      );
    this.applyTombstone(incoming.conversationId, existing.id, incoming.keys);
  }

  private applyEdit(event: DmEvent): void {
    const conversationId = event.conversationId;
    const next = event.text ?? "";
    const targetKeys = [
      event.targetSequenceId,
      event.targetEventId,
      event.replyTo?.sequenceId,
      event.replyTo?.eventId,
    ].filter((key): key is string => Boolean(key));
    const row = targetKeys.length > 0 ? this.findRow(conversationId, targetKeys) : undefined;
    if (!row) {
      this.appendMessage(
        {
          ...event,
          eventType: "MessageCreate",
          id: event.targetEventId || event.id,
          sequenceId: event.targetSequenceId,
          text: next,
        },
        labelOf(event.sender, event.senderId),
      );
      if (next) {
        const created = this.findRow(conversationId, [event.targetEventId || event.id, event.targetSequenceId ?? ""]);
        if (created) {
          this.db.prepare("UPDATE chat_history_messages SET edited = 1 WHERE id = ?").run(created.id);
        }
      }
      return;
    }
    if (row.text === next) return;
    const original = row.original_text ?? row.text;
    this.db
      .prepare(
        `UPDATE chat_history_messages
         SET text = ?, original_text = ?, edited = 1
         WHERE id = ?`,
      )
      .run(next, original, row.id);
    this.reindexFts(row.id, next, row.original_text ? `${original}\n${next}` : `${row.text}\n${next}`, row.sender_label);
  }

  private applyRemoteDelete(event: DmEvent): void {
    const keys = [
      ...(event.targetSequenceIds ?? []),
      ...(event.targetEventIds ?? []),
      event.targetSequenceId,
      event.targetEventId,
    ].filter((key): key is string => Boolean(key && key.trim()));
    const at = event.createdAt ?? new Date().toISOString();
    this.markDeleted(event.conversationId, keys, "x", at);
  }

  private insertMembership(event: DmEvent, actorLabel?: string): number {
    const kind =
      event.membershipKind ??
      (event.eventType === "ParticipantsLeave" ? "leave" : "add");
    const people =
      event.participants.length > 0
        ? event.participants
        : event.participantIds.map((id) => ({ id }));
    const subjects = people.length > 0 ? people : [{ id: event.senderId ?? event.id }];
    const ts = event.createdAt ?? null;
    const tsMs = millisOf(event.createdAt);
    const actor = labelOf(event.sender, event.senderId, actorLabel);
    let inserted = 0;
    const write = this.db.transaction(() => {
      for (const subject of subjects) {
        const subjectId = subject.id || event.id;
        const info = this.db
          .prepare(
            `INSERT OR IGNORE INTO chat_history_membership (
               conversation_id, event_id, sequence_id, kind,
               actor_id, actor_label, subject_id, subject_label, ts, ts_ms
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            event.conversationId,
            event.id,
            nonempty(event.sequenceId) ?? null,
            kind,
            event.senderId ?? null,
            actor,
            subjectId,
            labelOf(subject, subject.id),
            ts,
            tsMs,
          );
        inserted += info.changes;
      }
    });
    write();
    return inserted;
  }

  private searchMessages(
    conversationId: string,
    plan: HistorySearchPlan,
    includeDeleted: boolean,
  ): ChatHistoryMessageRow[] {
    const sender = plan.sender?.replace(/^@/, "").toLowerCase();
    const since = plan.sinceMs ?? null;
    const until = plan.untilMs ?? null;
    if (this.fts && plan.keywords.length > 0) {
      const match = plan.keywords.map((word) => `"${word.replace(/"/g, "")}"`).join(" AND ");
      try {
        return this.db
          .prepare(
            `SELECT m.* FROM chat_history_messages m
             JOIN chat_history_fts ON chat_history_fts.rowid = m.id
             WHERE chat_history_fts MATCH ?
               AND m.conversation_id = ?
               AND (? = 1 OR m.deleted_in_x_at IS NULL)
               AND (? IS NULL OR lower(replace(ifnull(m.sender_label, ''), '@', '')) = ?
                    OR m.sender_id = ?)
               AND (? IS NULL OR m.ts_ms >= ?)
               AND (? IS NULL OR m.ts_ms < ?)
             ORDER BY COALESCE(m.ts_ms, 0) DESC, m.id DESC
             LIMIT ?`,
          )
          .all(
            match,
            conversationId,
            includeDeleted ? 1 : 0,
            sender ?? null,
            sender ?? null,
            sender ?? null,
            since,
            since,
            until,
            until,
            CHAT_HISTORY_SEARCH_LIMIT,
          ) as ChatHistoryMessageRow[];
      } catch (error) {
        log.warn(
          `Chat history search failed closed for conversation=${conversationId}: ${error instanceof Error ? error.name : "error"}`,
        );
        return [];
      }
    }
    const clauses = ["conversation_id = ?", "(? = 1 OR deleted_in_x_at IS NULL)"];
    const params: (string | number | null)[] = [conversationId, includeDeleted ? 1 : 0];
    if (sender) {
      clauses.push(
        "(lower(replace(ifnull(sender_label, ''), '@', '')) = ? OR sender_id = ?)",
      );
      params.push(sender, sender);
    }
    if (since !== null) {
      clauses.push("ts_ms >= ?");
      params.push(since);
    }
    if (until !== null) {
      clauses.push("ts_ms < ?");
      params.push(until);
    }
    for (const word of plan.keywords) {
      const like = `%${escapeLike(word)}%`;
      clauses.push("(lower(text) LIKE ? ESCAPE '\\' OR lower(ifnull(original_text, '')) LIKE ? ESCAPE '\\')");
      params.push(like, like);
    }
    params.push(CHAT_HISTORY_SEARCH_LIMIT);
    return this.db
      .prepare(
        `SELECT * FROM chat_history_messages
         WHERE ${clauses.join(" AND ")}
         ORDER BY COALESCE(ts_ms, 0) DESC, id DESC
         LIMIT ?`,
      )
      .all(...params) as ChatHistoryMessageRow[];
  }

  private searchMembership(conversationId: string, plan: HistorySearchPlan): ChatHistoryMembershipRow[] {
    const sender = plan.sender?.replace(/^@/, "").toLowerCase();
    const words = plan.keywords.map((word) => word.toLowerCase());
    const rows = this.db
      .prepare(
        `SELECT * FROM chat_history_membership
         WHERE conversation_id = ?
           AND (? IS NULL OR ts_ms >= ?)
           AND (? IS NULL OR ts_ms < ?)
         ORDER BY COALESCE(ts_ms, 0) DESC, id DESC
         LIMIT 200`,
      )
      .all(
        conversationId,
        plan.sinceMs ?? null,
        plan.sinceMs ?? null,
        plan.untilMs ?? null,
        plan.untilMs ?? null,
      ) as ChatHistoryMembershipRow[];
    return rows
      .filter((row) => membershipMatches(row, sender, words, plan.membership))
      .slice(0, CHAT_HISTORY_SEARCH_LIMIT);
  }

  private findRow(conversationId: string, keys: readonly (string | undefined)[]): ChatHistoryMessageRow | undefined {
    for (const key of keys) {
      const alias = key?.trim();
      if (!alias) continue;
      const byAlias = this.db
        .prepare(
          `SELECT m.* FROM chat_history_aliases a
           JOIN chat_history_messages m ON m.id = a.message_row
           WHERE a.conversation_id = ? AND a.alias = ?`,
        )
        .get(conversationId, alias) as ChatHistoryMessageRow | undefined;
      if (byAlias) return byAlias;
      const byId = this.db
        .prepare(
          `SELECT * FROM chat_history_messages
           WHERE conversation_id = ? AND (message_id = ? OR sequence_id = ?)
           LIMIT 1`,
        )
        .get(conversationId, alias, alias) as ChatHistoryMessageRow | undefined;
      if (byId) return byId;
    }
    return undefined;
  }

  private rememberAliases(conversationId: string, messageRow: number, keys: readonly string[]): void {
    const insert = this.db.prepare(
      `INSERT INTO chat_history_aliases (conversation_id, alias, message_row)
       VALUES (?, ?, ?)
       ON CONFLICT(conversation_id, alias) DO NOTHING`,
    );
    for (const key of keys) {
      const alias = key.trim();
      if (!alias) continue;
      insert.run(conversationId, alias, messageRow);
    }
  }

  private applyTombstone(conversationId: string, messageRow: number, keys: readonly string[]): void {
    for (const key of keys) {
      const tomb = this.db
        .prepare(
          `SELECT deleted_at, deleted_by FROM chat_history_tombstones
           WHERE conversation_id = ? AND target_key = ?`,
        )
        .get(conversationId, key) as { deleted_at: string; deleted_by: string } | undefined;
      if (!tomb) continue;
      this.db
        .prepare(
          `UPDATE chat_history_messages
           SET deleted_in_x_at = COALESCE(deleted_in_x_at, ?),
               deleted_by = COALESCE(deleted_by, ?)
           WHERE id = ?`,
        )
        .run(tomb.deleted_at, tomb.deleted_by, messageRow);
      return;
    }
  }

  private sequenceTaken(conversationId: string, sequenceId: string, exceptRow: number): boolean {
    const row = this.db
      .prepare(
        `SELECT id FROM chat_history_messages
         WHERE conversation_id = ? AND sequence_id = ? AND id != ?`,
      )
      .get(conversationId, sequenceId, exceptRow);
    return Boolean(row);
  }

  private rowMatchesEvent(row: ChatHistoryMessageRow, eventId: string): boolean {
    if (row.message_id === eventId || row.sequence_id === eventId) return true;
    const alias = this.db
      .prepare(
        `SELECT 1 FROM chat_history_aliases
         WHERE conversation_id = ? AND alias = ? AND message_row = ?`,
      )
      .get(row.conversation_id, eventId, row.id);
    return Boolean(alias);
  }

  private indexFts(rowId: number, text: string, label: string | null): void {
    if (!this.fts) return;
    this.db
      .prepare("INSERT INTO chat_history_fts(rowid, text, sender_label) VALUES (?, ?, ?)")
      .run(rowId, text, label ?? "");
  }

  private reindexFts(rowId: number, text: string, indexed: string, label: string | null): void {
    if (!this.fts) return;
    this.db.prepare("DELETE FROM chat_history_fts WHERE rowid = ?").run(rowId);
    this.db
      .prepare("INSERT INTO chat_history_fts(rowid, text, sender_label) VALUES (?, ?, ?)")
      .run(rowId, indexed || text, label ?? "");
  }

  private rebuildFts(): void {
    if (!this.fts) return;
    try {
      this.db.exec("INSERT INTO chat_history_fts(chat_history_fts) VALUES('rebuild')");
    } catch {
      this.db.exec("DELETE FROM chat_history_fts");
      const rows = this.db
        .prepare("SELECT id, text, original_text, sender_label FROM chat_history_messages")
        .all() as { id: number; text: string; original_text: string | null; sender_label: string | null }[];
      const insert = this.db.prepare(
        "INSERT INTO chat_history_fts(rowid, text, sender_label) VALUES (?, ?, ?)",
      );
      for (const row of rows) {
        const text = row.original_text ? `${row.original_text}\n${row.text}` : row.text;
        insert.run(row.id, text, row.sender_label ?? "");
      }
    }
  }
}

export interface HistorySearchPlan {
  keywords: string[];
  sender?: string;
  sinceMs?: number;
  untilMs?: number;
  membership: boolean;
}

const SEARCH_STOP = new Set([
  "when",
  "was",
  "what",
  "did",
  "say",
  "said",
  "about",
  "the",
  "and",
  "for",
  "you",
  "your",
  "last",
  "week",
  "yesterday",
  "today",
  "who",
  "how",
  "why",
  "does",
  "are",
  "this",
  "that",
  "chat",
  "added",
  "add",
  "joined",
  "left",
  "leave",
  "removed",
  "with",
  "from",
  "have",
  "has",
  "been",
  "were",
  "into",
  "here",
]);

export function planHistorySearch(question: string, nowMs: number): HistorySearchPlan {
  const handles = [...question.matchAll(/@([A-Za-z0-9_]{1,15})/g)].map((match) => match[1]!.toLowerCase());
  const sender = handles[0];
  let sinceMs: number | undefined;
  let untilMs: number | undefined;
  const lower = question.toLowerCase();
  if (/\blast week\b/.test(lower)) {
    sinceMs = nowMs - 7 * DAY_MS;
  } else if (/\byesterday\b/.test(lower)) {
    const start = new Date(nowMs);
    start.setUTCHours(0, 0, 0, 0);
    untilMs = start.getTime();
    sinceMs = untilMs - DAY_MS;
  } else if (/\btoday\b/.test(lower)) {
    const start = new Date(nowMs);
    start.setUTCHours(0, 0, 0, 0);
    sinceMs = start.getTime();
  } else if (/\blast month\b/.test(lower)) {
    sinceMs = nowMs - 30 * DAY_MS;
  }
  const membership = /\b(added|joined|join|left|leave|removed|kicked)\b/i.test(question);
  const keywords = [
    ...new Set(
      question
        .replace(/@([A-Za-z0-9_]{1,15})/g, " ")
        .split(/[^A-Za-z0-9_]+/)
        .map((word) => word.toLowerCase())
        .filter((word) => word.length >= 3 && !SEARCH_STOP.has(word)),
    ),
  ].slice(0, 6);
  return { keywords, sender, sinceMs, untilMs, membership };
}

/** History-read backoff shared by backfill, purge, and classic LLM fetches. */
export class HistoryReadBackoff {
  private untilMs = 0;

  note(error: unknown, nowMs = Date.now()): number {
    if (!isHistoryEndpointBackoff(error)) return 0;
    const wait = readWaitMs(error);
    this.untilMs = Math.max(this.untilMs, nowMs + wait);
    return wait;
  }

  noteMs(waitMs: number, nowMs = Date.now()): void {
    if (waitMs <= 0) return;
    this.untilMs = Math.max(this.untilMs, nowMs + waitMs);
  }

  active(nowMs = Date.now()): boolean {
    return nowMs < this.untilMs;
  }

  remaining(nowMs = Date.now()): number {
    return Math.max(0, this.untilMs - nowMs);
  }
}

export function isHistoryEndpointBackoff(error: unknown): boolean {
  const status =
    error && typeof error === "object" && "status" in error
      ? (error as { status?: unknown }).status
      : undefined;
  if (status === 429 || status === 402) return true;
  const message = error instanceof Error ? error.message : "";
  return /rate limited; retry after \d+ms/i.test(message) || /credits depleted/i.test(message);
}

function readWaitMs(error: unknown): number {
  if (error && typeof error === "object" && "retryAfterMs" in error) {
    const value = (error as { retryAfterMs?: unknown }).retryAfterMs;
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  const message = error instanceof Error ? error.message : "";
  const match = /retry after (\d+)ms/i.exec(message);
  if (match) {
    const parsed = Number(match[1]);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  const status =
    error && typeof error === "object" && "status" in error
      ? (error as { status?: unknown }).status
      : undefined;
  return status === 402 ? 5 * 60 * 1000 : 15_000;
}

function normalizeCap(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

function ftsPresent(db: Database.Database): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'chat_history_fts'")
    .get();
  return Boolean(row);
}

function nonempty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function millisOf(value: string | undefined): number | null {
  if (!value) return null;
  if (/^[0-9]+$/.test(value)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function labelOf(user: XUser | undefined, userId?: string, explicit?: string): string {
  if (explicit && explicit !== "someone") return explicit;
  return displayName(user, userId);
}

function aliasKeys(event: DmEvent): string[] {
  const keys: string[] = [];
  const push = (value: string | undefined) => {
    const trimmed = value?.trim();
    if (trimmed && !keys.includes(trimmed)) keys.push(trimmed);
  };
  push(event.id);
  push(event.sequenceId);
  for (const alias of event.aliasIds ?? []) {
    if (alias.startsWith("cipher:")) continue;
    push(alias);
  }
  return keys;
}

function rowToTurn(row: ChatHistoryMessageRow): ChatTurn | undefined {
  const text = row.text.trim() || (row.media ? `(${row.media})` : "");
  if (!text) return undefined;
  return {
    eventId: row.message_id,
    senderLabel: row.sender_label && row.sender_label !== "someone" ? row.sender_label : row.sender_label || "someone",
    senderId: row.sender_id ?? undefined,
    text,
    createdAt: row.ts ?? undefined,
  };
}

function formatMembershipLine(row: ChatHistoryMembershipRow): string {
  const who = row.subject_label && row.subject_label !== "someone" ? row.subject_label : row.subject_id || "someone";
  const verb = row.kind === "leave" ? "left" : row.kind === "join" ? "joined" : "was added";
  const when = row.ts ? ` ${row.ts}` : "";
  return `[membership${when}] ${who} ${verb}`;
}

function membershipMatches(
  row: ChatHistoryMembershipRow,
  sender: string | undefined,
  words: string[],
  membershipAsked: boolean,
): boolean {
  const hay = `${row.subject_label ?? ""} ${row.actor_label ?? ""} ${row.subject_id ?? ""} ${row.kind}`.toLowerCase();
  if (sender && !hay.includes(sender)) return false;
  if (words.length === 0) return membershipAsked || Boolean(sender);
  return words.every((word) => hay.includes(word));
}

function escapeLike(value: string): string {
  return value.toLowerCase().replace(/[\\%_]/g, (char) => `\\${char}`);
}
