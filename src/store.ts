import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { ensureChatHistorySchema, restrictSqlitePermissions } from "./bot/chat-history.js";
import { CHAT_WATERMARK_PREFIX, isChatGroupId } from "./chat/ids.js";
import type { ConversationSettings } from "./types.js";

/** Set once, after existing Chat watermarks are copied into `chat_authorizations`. */
export const CHAT_AUTH_GRANDFATHER_KEY = "chat_auth_grandfathered";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS warns (
  conversation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  last_reason TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS warn_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  admin_id TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notes (
  conversation_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, key)
);

CREATE TABLE IF NOT EXISTS mutes (
  conversation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  until_ms INTEGER NOT NULL,
  reason TEXT,
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS conversation_settings (
  conversation_id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_admins (
  conversation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS flood_events (
  conversation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  ts_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_flood_lookup
  ON flood_events (conversation_id, user_id, ts_ms);

CREATE TABLE IF NOT EXISTS processed_events (
  event_id TEXT PRIMARY KEY,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS watermarks (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS last_messages (
  conversation_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  sender_id TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS llm_rate (
  conversation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  ts_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_llm_rate
  ON llm_rate (conversation_id, user_id, ts_ms);

CREATE TABLE IF NOT EXISTS boobs_rate (
  conversation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  ts_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_boobs_rate
  ON boobs_rate (conversation_id, user_id, ts_ms);

CREATE TABLE IF NOT EXISTS chat_message_index (
  event_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  sequence_id TEXT,
  created_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_chat_sequence
  ON chat_message_index (sequence_id);

CREATE TABLE IF NOT EXISTS user_xp (
  conversation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  xp INTEGER NOT NULL DEFAULT 0,
  username TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_user_xp_rank
  ON user_xp (conversation_id, xp DESC, user_id);

CREATE TABLE IF NOT EXISTS xp_action_cooldown (
  conversation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  last_ms INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, user_id, kind)
);

CREATE TABLE IF NOT EXISTS xp_level_grants (
  conversation_id TEXT NOT NULL,
  giver_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  last_ms INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, giver_id, target_id)
);

CREATE TABLE IF NOT EXISTS message_authors (
  conversation_id TEXT NOT NULL,
  message_key TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  PRIMARY KEY (conversation_id, message_key)
);

CREATE TABLE IF NOT EXISTS troll_targets (
  conversation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  username TEXT,
  last_ms INTEGER NOT NULL DEFAULT 0,
  roast_next INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS troll_all (
  conversation_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS troll_all_cooldown (
  conversation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  username TEXT,
  last_ms INTEGER NOT NULL DEFAULT 0,
  roast_next INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS linkroast (
  conversation_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS linkroast_cooldown (
  conversation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  last_ms INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS chat_authorizations (
  conversation_id TEXT PRIMARY KEY,
  authorized_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS feature_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  requester_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS llm_retry_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  UNIQUE(conversation_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_llm_retry_due
  ON llm_retry_jobs (next_attempt_ms);

CREATE TABLE IF NOT EXISTS grow_sizes (
  conversation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  label TEXT NOT NULL,
  length INTEGER NOT NULL,
  grown_at_ms INTEGER NOT NULL,
  first_played_ms INTEGER NOT NULL,
  streak INTEGER NOT NULL DEFAULT 0,
  streak_max INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS grow_dod (
  conversation_id TEXT NOT NULL,
  day TEXT NOT NULL,
  user_id TEXT NOT NULL,
  label TEXT NOT NULL,
  bonus INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, day)
);

CREATE TABLE IF NOT EXISTS grow_fights (
  conversation_id TEXT PRIMARY KEY,
  challenger_id TEXT NOT NULL,
  challenger_label TEXT NOT NULL,
  bet INTEGER NOT NULL,
  message_id TEXT,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS grow_pvp_stats (
  conversation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  label TEXT NOT NULL,
  battles INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  win_streak INTEGER NOT NULL DEFAULT 0,
  win_streak_max INTEGER NOT NULL DEFAULT 0,
  acquired INTEGER NOT NULL DEFAULT 0,
  lost INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS grow_loans (
  conversation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  debt INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, user_id)
);
`;

export class Store {
  readonly db: Database.Database;
  /** `:memory:` or the path passed to the constructor. Used to chmod the file. */
  readonly filename: string;

  constructor(filename: string) {
    this.filename = filename;
    if (filename !== ":memory:") {
      fs.mkdirSync(path.dirname(filename), { recursive: true });
    }
    this.db = new Database(filename);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
    this.dropRemovedAlertTable();
    this.migrateTrollTargets();
    this.grandfatherChatAuthorizations();
    ensureChatHistorySchema(this.db);
    this.restrictFilePermissions();
  }

  /** `0600` on `bot.sqlite`, `-wal`, and `-shm`. No-op for `:memory:`. */
  restrictFilePermissions(): void {
    restrictSqlitePermissions(this.filename);
  }

  /**
   * Older databases still have the timeline-alert table from a removed command.
   * Drop it so leftover rows are not an active mode.
   */
  private dropRemovedAlertTable(): void {
    this.db.exec("DROP TABLE IF EXISTS noor_alerts");
  }

  /**
   * Older databases stored one `troll_targets` row per conversation
   * (`conversation_id` primary key). Rebuild that table so each person is
   * their own row, and keep the existing target, cooldown, and roast turn.
   */
  private migrateTrollTargets(): void {
    const cols = this.db.prepare("PRAGMA table_info(troll_targets)").all() as {
      name: string;
      pk: number;
    }[];
    const pk = cols.filter((col) => col.pk > 0).sort((a, b) => a.pk - b.pk);
    const composite =
      pk.length === 2 && pk[0]?.name === "conversation_id" && pk[1]?.name === "user_id";
    if (composite || cols.length === 0) return;
    const single =
      pk.length === 1 &&
      pk[0]?.name === "conversation_id" &&
      cols.some((col) => col.name === "user_id");
    if (!single) return;
    const migrate = this.db.transaction(() => {
      this.db.exec(`
        DROP TABLE IF EXISTS troll_targets_next;
        CREATE TABLE troll_targets_next (
          conversation_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          username TEXT,
          last_ms INTEGER NOT NULL DEFAULT 0,
          roast_next INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (conversation_id, user_id)
        );
        INSERT INTO troll_targets_next (conversation_id, user_id, username, last_ms, roast_next)
          SELECT conversation_id, user_id, username, last_ms, roast_next
          FROM troll_targets;
        DROP TABLE troll_targets;
        ALTER TABLE troll_targets_next RENAME TO troll_targets;
      `);
    });
    migrate();
  }

  close(): void {
    this.db.close();
  }

  hasProcessed(eventId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM processed_events WHERE event_id = ?")
      .get(eventId);
    return Boolean(row);
  }

  /**
   * True when this Chat sequence was already handled under a different raw id.
   * Covers rows written before sequence keys were stored in `processed_events`:
   * Activity indexed `activity-uuid` / sequence N, and the catch-up poll later
   * presents the events-list id for that same sequence.
   */
  hasProcessedChatSequence(
    conversationId: string,
    sequenceId: string,
    exceptEventId: string,
  ): boolean {
    if (!conversationId || !sequenceId) return false;
    const row = this.db
      .prepare(
        `SELECT 1
         FROM chat_message_index AS seen
         INNER JOIN processed_events AS done ON done.event_id = seen.event_id
         WHERE seen.conversation_id = ?
           AND seen.sequence_id = ?
           AND seen.event_id != ?
         LIMIT 1`,
      )
      .get(conversationId, sequenceId, exceptEventId);
    return Boolean(row);
  }

  markProcessed(eventId: string, createdAt?: string): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO processed_events (event_id, created_at) VALUES (?, ?)",
      )
      .run(eventId, createdAt ?? null);
  }

  getWatermark(key: string): string | undefined {
    const row = this.db
      .prepare("SELECT value FROM watermarks WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value;
  }

  setWatermark(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO watermarks (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  /**
   * Encrypted Chat groups (`g…`) the owner has authorized with `!auth`,
   * plus groups that already had a Chat watermark the first time this
   * database was opened after the gate was added.
   */
  isChatAuthorized(conversationId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM chat_authorizations WHERE conversation_id = ?")
      .get(conversationId);
    return Boolean(row);
  }

  /**
   * Record that this conversation may be moderated. Returns true when the
   * row was new.
   */
  authorizeChat(conversationId: string, at: string = new Date().toISOString()): boolean {
    const result = this.db
      .prepare(
        "INSERT OR IGNORE INTO chat_authorizations (conversation_id, authorized_at) VALUES (?, ?)",
      )
      .run(conversationId, at);
    return result.changes > 0;
  }

  /**
   * One-time copy of `chat_events:<g…>` watermarks into `chat_authorizations`.
   * Runs before this process writes any new watermark, so a group first seen
   * after the upgrade stays unauthorized. Later startups see the flag and
   * do not authorize watermarks created since.
   */
  private grandfatherChatAuthorizations(): void {
    if (this.getWatermark(CHAT_AUTH_GRANDFATHER_KEY)) return;
    const now = new Date().toISOString();
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO chat_authorizations (conversation_id, authorized_at) VALUES (?, ?)",
    );
    const ids = this.listWatermarkKeys(CHAT_WATERMARK_PREFIX).filter((id) => isChatGroupId(id));
    const write = this.db.transaction((conversationIds: string[]) => {
      for (const id of conversationIds) insert.run(id, now);
    });
    write(ids);
    this.setWatermark(CHAT_AUTH_GRANDFATHER_KEY, "1");
  }

  /** Suffixes of watermark keys that start with `prefix`. `_` and `%` in the prefix are escaped. */
  listWatermarkKeys(prefix: string): string[] {
    const escaped = prefix.replace(/[\\%_]/g, (char) => `\\${char}`);
    const rows = this.db
      .prepare("SELECT key FROM watermarks WHERE key LIKE ? ESCAPE '\\' ORDER BY key")
      .all(`${escaped}%`) as { key: string }[];
    return rows.map((row) => row.key.slice(prefix.length));
  }

  addWarn(
    conversationId: string,
    userId: string,
    adminId: string,
    reason?: string,
  ): number {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO warns (conversation_id, user_id, count, last_reason, updated_at)
         VALUES (?, ?, 1, ?, ?)
         ON CONFLICT(conversation_id, user_id) DO UPDATE SET
           count = count + 1,
           last_reason = excluded.last_reason,
           updated_at = excluded.updated_at`,
      )
      .run(conversationId, userId, reason ?? null, now);
    this.db
      .prepare(
        `INSERT INTO warn_history (conversation_id, user_id, admin_id, reason, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(conversationId, userId, adminId, reason ?? null, now);
    return this.getWarnCount(conversationId, userId);
  }

  removeWarn(conversationId: string, userId: string): number {
    const current = this.getWarnCount(conversationId, userId);
    const next = Math.max(0, current - 1);
    this.db
      .prepare(
        `INSERT INTO warns (conversation_id, user_id, count, last_reason, updated_at)
         VALUES (?, ?, ?, NULL, ?)
         ON CONFLICT(conversation_id, user_id) DO UPDATE SET
           count = excluded.count,
           updated_at = excluded.updated_at`,
      )
      .run(conversationId, userId, next, new Date().toISOString());
    return next;
  }

  getWarnCount(conversationId: string, userId: string): number {
    const row = this.db
      .prepare(
        "SELECT count FROM warns WHERE conversation_id = ? AND user_id = ?",
      )
      .get(conversationId, userId) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  setNote(
    conversationId: string,
    key: string,
    value: string,
    updatedBy: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO notes (conversation_id, key, value, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(conversation_id, key) DO UPDATE SET
           value = excluded.value,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`,
      )
      .run(conversationId, key, value, updatedBy, new Date().toISOString());
  }

  getNote(conversationId: string, key: string): string | undefined {
    const row = this.db
      .prepare("SELECT value FROM notes WHERE conversation_id = ? AND key = ?")
      .get(conversationId, key) as { value: string } | undefined;
    return row?.value;
  }

  listNotes(conversationId: string): { key: string; value: string }[] {
    return this.db
      .prepare(
        "SELECT key, value FROM notes WHERE conversation_id = ? ORDER BY key",
      )
      .all(conversationId) as { key: string; value: string }[];
  }

  mute(
    conversationId: string,
    userId: string,
    untilMs: number,
    reason?: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO mutes (conversation_id, user_id, until_ms, reason)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(conversation_id, user_id) DO UPDATE SET
           until_ms = excluded.until_ms,
           reason = excluded.reason`,
      )
      .run(conversationId, userId, untilMs, reason ?? null);
  }

  unmute(conversationId: string, userId: string): void {
    this.db
      .prepare("DELETE FROM mutes WHERE conversation_id = ? AND user_id = ?")
      .run(conversationId, userId);
  }

  isMuted(conversationId: string, userId: string, nowMs = Date.now()): boolean {
    const row = this.db
      .prepare(
        "SELECT until_ms FROM mutes WHERE conversation_id = ? AND user_id = ?",
      )
      .get(conversationId, userId) as { until_ms: number } | undefined;
    if (!row) return false;
    if (row.until_ms <= nowMs) {
      this.unmute(conversationId, userId);
      return false;
    }
    return true;
  }

  getSettings(conversationId: string): ConversationSettings | undefined {
    const row = this.db
      .prepare("SELECT json FROM conversation_settings WHERE conversation_id = ?")
      .get(conversationId) as { json: string } | undefined;
    if (!row) return undefined;
    return JSON.parse(row.json) as ConversationSettings;
  }

  patchSettings(
    conversationId: string,
    patch: ConversationSettings,
  ): ConversationSettings {
    const current = this.getSettings(conversationId) ?? {};
    const next = { ...current, ...patch };
    this.db
      .prepare(
        `INSERT INTO conversation_settings (conversation_id, json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(conversation_id) DO UPDATE SET
           json = excluded.json,
           updated_at = excluded.updated_at`,
      )
      .run(conversationId, JSON.stringify(next), new Date().toISOString());
    return next;
  }

  listConversationAdmins(conversationId: string): string[] {
    const rows = this.db
      .prepare(
        "SELECT user_id FROM conversation_admins WHERE conversation_id = ?",
      )
      .all(conversationId) as { user_id: string }[];
    return rows.map((row) => row.user_id);
  }

  addConversationAdmin(conversationId: string, userId: string): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO conversation_admins (conversation_id, user_id) VALUES (?, ?)",
      )
      .run(conversationId, userId);
  }

  removeConversationAdmin(conversationId: string, userId: string): void {
    this.db
      .prepare(
        "DELETE FROM conversation_admins WHERE conversation_id = ? AND user_id = ?",
      )
      .run(conversationId, userId);
  }

  recordFloodEvent(
    conversationId: string,
    userId: string,
    eventId: string,
    tsMs: number,
    windowMs: number,
  ): number {
    this.db
      .prepare(
        "INSERT INTO flood_events (conversation_id, user_id, event_id, ts_ms) VALUES (?, ?, ?, ?)",
      )
      .run(conversationId, userId, eventId, tsMs);
    this.db
      .prepare(
        "DELETE FROM flood_events WHERE conversation_id = ? AND user_id = ? AND ts_ms < ?",
      )
      .run(conversationId, userId, tsMs - windowMs);
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM flood_events WHERE conversation_id = ? AND user_id = ? AND ts_ms >= ?",
      )
      .get(conversationId, userId, tsMs - windowMs) as { count: number };
    return row.count;
  }

  setLastUserMessage(
    conversationId: string,
    eventId: string,
    senderId?: string,
    createdAt?: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO last_messages (conversation_id, event_id, sender_id, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(conversation_id) DO UPDATE SET
           event_id = excluded.event_id,
           sender_id = excluded.sender_id,
           created_at = excluded.created_at`,
      )
      .run(conversationId, eventId, senderId ?? null, createdAt ?? null);
  }

  getLastUserMessage(
    conversationId: string,
  ): { eventId: string; senderId?: string } | undefined {
    const row = this.db
      .prepare(
        "SELECT event_id, sender_id FROM last_messages WHERE conversation_id = ?",
      )
      .get(conversationId) as
      | { event_id: string; sender_id: string | null }
      | undefined;
    if (!row) return undefined;
    return { eventId: row.event_id, senderId: row.sender_id ?? undefined };
  }

  rememberChatMessage(
    eventId: string,
    conversationId: string,
    sequenceId: string | undefined,
    createdAt?: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO chat_message_index (event_id, conversation_id, sequence_id, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(event_id) DO UPDATE SET
           conversation_id = excluded.conversation_id,
           sequence_id = COALESCE(excluded.sequence_id, chat_message_index.sequence_id),
           created_at = COALESCE(excluded.created_at, chat_message_index.created_at)`,
      )
      .run(eventId, conversationId, sequenceId ?? null, createdAt ?? null);
  }

  lookupChatMessage(
    id: string,
  ): { eventId: string; conversationId: string; sequenceId?: string } | undefined {
    const row = this.db
      .prepare(
        `SELECT event_id, conversation_id, sequence_id
         FROM chat_message_index
         WHERE event_id = ? OR sequence_id = ?
         LIMIT 1`,
      )
      .get(id, id) as
      | { event_id: string; conversation_id: string; sequence_id: string | null }
      | undefined;
    if (!row) return undefined;
    return {
      eventId: row.event_id,
      conversationId: row.conversation_id,
      sequenceId: row.sequence_id ?? undefined,
    };
  }

  recordLlmUse(
    conversationId: string,
    userId: string,
    tsMs: number,
    windowMs: number,
  ): number {
    this.db
      .prepare(
        "INSERT INTO llm_rate (conversation_id, user_id, ts_ms) VALUES (?, ?, ?)",
      )
      .run(conversationId, userId, tsMs);
    this.db
      .prepare(
        "DELETE FROM llm_rate WHERE conversation_id = ? AND user_id = ? AND ts_ms < ?",
      )
      .run(conversationId, userId, tsMs - windowMs);
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM llm_rate WHERE conversation_id = ? AND user_id = ? AND ts_ms >= ?",
      )
      .get(conversationId, userId, tsMs - windowMs) as { count: number };
    return row.count;
  }

  /**
   * Count a `!boobs` attempt for this user and this conversation.
   * Old rows outside the window are dropped. The returned counts include this call.
   */
  recordBoobsUse(
    conversationId: string,
    userId: string,
    tsMs: number,
    windowMs: number,
  ): { userUses: number; conversationUses: number } {
    this.db
      .prepare(
        "INSERT INTO boobs_rate (conversation_id, user_id, ts_ms) VALUES (?, ?, ?)",
      )
      .run(conversationId, userId, tsMs);
    this.db
      .prepare("DELETE FROM boobs_rate WHERE ts_ms < ?")
      .run(tsMs - windowMs);
    const since = tsMs - windowMs;
    const userRow = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM boobs_rate
         WHERE conversation_id = ? AND user_id = ? AND ts_ms >= ?`,
      )
      .get(conversationId, userId, since) as { count: number };
    const convoRow = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM boobs_rate
         WHERE conversation_id = ? AND ts_ms >= ?`,
      )
      .get(conversationId, since) as { count: number };
    return { userUses: userRow.count, conversationUses: convoRow.count };
  }

  rememberMessageAuthor(conversationId: string, messageKey: string, senderId: string): void {
    if (!messageKey || !senderId) return;
    this.db
      .prepare(
        `INSERT INTO message_authors (conversation_id, message_key, sender_id)
         VALUES (?, ?, ?)
         ON CONFLICT(conversation_id, message_key) DO UPDATE SET
           sender_id = excluded.sender_id`,
      )
      .run(conversationId, messageKey, senderId);
  }

  lookupMessageAuthor(conversationId: string, messageKey: string): string | undefined {
    if (!messageKey) return undefined;
    const row = this.db
      .prepare(
        `SELECT sender_id FROM message_authors
         WHERE conversation_id = ? AND message_key = ?`,
      )
      .get(conversationId, messageKey) as { sender_id: string } | undefined;
    return row?.sender_id;
  }

  getUserXp(
    conversationId: string,
    userId: string,
  ): { xp: number; username?: string } {
    const row = this.db
      .prepare(
        `SELECT xp, username FROM user_xp
         WHERE conversation_id = ? AND user_id = ?`,
      )
      .get(conversationId, userId) as
      | { xp: number; username: string | null }
      | undefined;
    if (!row) return { xp: 0 };
    return { xp: row.xp, username: row.username ?? undefined };
  }

  setUserXp(
    conversationId: string,
    userId: string,
    xp: number,
    username?: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO user_xp (conversation_id, user_id, xp, username, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(conversation_id, user_id) DO UPDATE SET
           xp = excluded.xp,
           username = COALESCE(excluded.username, user_xp.username),
           updated_at = excluded.updated_at`,
      )
      .run(
        conversationId,
        userId,
        xp,
        username ?? null,
        new Date().toISOString(),
      );
  }

  /**
   * 1-based rank among members with XP > 0. Ties break by user id ascending.
   * A member with no positive XP is unranked.
   */
  xpRank(conversationId: string, userId: string): number | undefined {
    const self = this.getUserXp(conversationId, userId);
    if (self.xp <= 0) return undefined;
    const row = this.db
      .prepare(
        `SELECT 1 + COUNT(*) AS rank FROM user_xp
         WHERE conversation_id = ?
           AND xp > 0
           AND (xp > ? OR (xp = ? AND user_id < ?))`,
      )
      .get(conversationId, self.xp, self.xp, userId) as { rank: number };
    return row.rank;
  }

  listXpLeaders(
    conversationId: string,
    limit: number,
  ): { userId: string; xp: number; username?: string }[] {
    const rows = this.db
      .prepare(
        `SELECT user_id, xp, username FROM user_xp
         WHERE conversation_id = ? AND xp > 0
         ORDER BY xp DESC, user_id ASC
         LIMIT ?`,
      )
      .all(conversationId, limit) as {
      user_id: string;
      xp: number;
      username: string | null;
    }[];
    return rows.map((row) => ({
      userId: row.user_id,
      xp: row.xp,
      username: row.username ?? undefined,
    }));
  }

  getXpActionAt(
    conversationId: string,
    userId: string,
    kind: "message" | "reaction",
  ): number | undefined {
    const row = this.db
      .prepare(
        `SELECT last_ms FROM xp_action_cooldown
         WHERE conversation_id = ? AND user_id = ? AND kind = ?`,
      )
      .get(conversationId, userId, kind) as { last_ms: number } | undefined;
    return row?.last_ms;
  }

  setXpActionAt(
    conversationId: string,
    userId: string,
    kind: "message" | "reaction",
    tsMs: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO xp_action_cooldown (conversation_id, user_id, kind, last_ms)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(conversation_id, user_id, kind) DO UPDATE SET
           last_ms = excluded.last_ms`,
      )
      .run(conversationId, userId, kind, tsMs);
  }

  getLevelGrantAt(
    conversationId: string,
    giverId: string,
    targetId: string,
  ): number | undefined {
    const row = this.db
      .prepare(
        `SELECT last_ms FROM xp_level_grants
         WHERE conversation_id = ? AND giver_id = ? AND target_id = ?`,
      )
      .get(conversationId, giverId, targetId) as { last_ms: number } | undefined;
    return row?.last_ms;
  }

  setLevelGrantAt(
    conversationId: string,
    giverId: string,
    targetId: string,
    tsMs: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO xp_level_grants (conversation_id, giver_id, target_id, last_ms)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(conversation_id, giver_id, target_id) DO UPDATE SET
           last_ms = excluded.last_ms`,
      )
      .run(conversationId, giverId, targetId, tsMs);
  }

  /**
   * Everyone `!troll` is aimed at in this conversation, oldest first.
   * `lastMs` is that person's previous roast. `roastNext` is 1 when their
   * next reply should be a timeline roast.
   */
  listTrollTargets(conversationId: string): TrollTarget[] {
    const rows = this.db
      .prepare(
        `SELECT user_id, username, last_ms, roast_next
         FROM troll_targets
         WHERE conversation_id = ?
         ORDER BY rowid ASC`,
      )
      .all(conversationId) as {
      user_id: string;
      username: string | null;
      last_ms: number;
      roast_next: number;
    }[];
    return rows.map((row) => this.trollTargetFromRow(row));
  }

  /** One enabled person in this conversation, if they are on the list. */
  getTrollTarget(conversationId: string, userId: string): TrollTarget | undefined {
    const row = this.db
      .prepare(
        `SELECT user_id, username, last_ms, roast_next
         FROM troll_targets
         WHERE conversation_id = ? AND user_id = ?`,
      )
      .get(conversationId, userId) as
      | {
          user_id: string;
          username: string | null;
          last_ms: number;
          roast_next: number;
        }
      | undefined;
    if (!row) return undefined;
    return this.trollTargetFromRow(row);
  }

  /**
   * Add someone to this conversation's list. A person already on it keeps
   * their cooldown and roast turn. Other people on the list stay. A person
   * who was only covered by troll-all keeps that cooldown on the new row.
   */
  addTrollTarget(conversationId: string, userId: string, username?: string): void {
    const handle = username?.replace(/^@/, "").trim();
    const safe = handle && !/^\d+$/.test(handle) ? handle : null;
    const prior = this.getTrollAllState(conversationId, userId);
    this.db
      .prepare(
        `INSERT INTO troll_targets (conversation_id, user_id, username, last_ms, roast_next)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(conversation_id, user_id) DO UPDATE SET
           username = COALESCE(excluded.username, troll_targets.username)`,
      )
      .run(conversationId, userId, safe, prior?.lastMs ?? 0, prior?.roastNext ?? 0);
  }

  /** Remove one person. Everyone else in the conversation stays enabled. */
  removeTrollTarget(conversationId: string, userId: string): void {
    this.db
      .prepare("DELETE FROM troll_targets WHERE conversation_id = ? AND user_id = ?")
      .run(conversationId, userId);
  }

  /** Remove every person on this conversation's list. Other conversations stay. */
  clearTrollTargets(conversationId: string): void {
    this.db.prepare("DELETE FROM troll_targets WHERE conversation_id = ?").run(conversationId);
  }

  /** Whether `!troll all` is on for this conversation. The flag covers every speaker. */
  isTrollAllEnabled(conversationId: string): boolean {
    const row = this.db
      .prepare("SELECT enabled FROM troll_all WHERE conversation_id = ?")
      .get(conversationId) as { enabled: number } | undefined;
    return row?.enabled === 1;
  }

  /** Turn troll-all on or off. Off deletes the flag. Cooldown rows stay. */
  setTrollAllEnabled(conversationId: string, enabled: boolean): void {
    if (!enabled) {
      this.db.prepare("DELETE FROM troll_all WHERE conversation_id = ?").run(conversationId);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO troll_all (conversation_id, enabled) VALUES (?, 1)
         ON CONFLICT(conversation_id) DO UPDATE SET enabled = 1`,
      )
      .run(conversationId);
  }

  /**
   * Cooldown for someone roasted because troll-all is on, when they are not
   * on the named list. Missing means they have not been roasted that way yet.
   */
  getTrollAllState(conversationId: string, userId: string): TrollTarget | undefined {
    const row = this.db
      .prepare(
        `SELECT user_id, username, last_ms, roast_next
         FROM troll_all_cooldown
         WHERE conversation_id = ? AND user_id = ?`,
      )
      .get(conversationId, userId) as
      | {
          user_id: string;
          username: string | null;
          last_ms: number;
          roast_next: number;
        }
      | undefined;
    if (!row) return undefined;
    return this.trollTargetFromRow(row);
  }

  /** Record a troll-all roast and which style comes next (0 mom joke, 1 roast). */
  markTrollAllSent(
    conversationId: string,
    userId: string,
    username: string | undefined,
    nowMs: number,
    roastNext: 0 | 1,
  ): void {
    const handle = username?.replace(/^@/, "").trim();
    const safe = handle && !/^\d+$/.test(handle) ? handle : null;
    this.db
      .prepare(
        `INSERT INTO troll_all_cooldown (conversation_id, user_id, username, last_ms, roast_next)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(conversation_id, user_id) DO UPDATE SET
           last_ms = excluded.last_ms,
           roast_next = excluded.roast_next,
           username = COALESCE(excluded.username, troll_all_cooldown.username)`,
      )
      .run(conversationId, userId, safe, nowMs, roastNext);
  }

  /** Record a posted troll and which style comes next (0 mom joke, 1 roast). */
  markTrollSent(conversationId: string, userId: string, nowMs: number, roastNext: 0 | 1): void {
    this.db
      .prepare(
        `UPDATE troll_targets SET last_ms = ?, roast_next = ?
         WHERE conversation_id = ? AND user_id = ?`,
      )
      .run(nowMs, roastNext, conversationId, userId);
  }

  private trollTargetFromRow(row: {
    user_id: string;
    username: string | null;
    last_ms: number;
    roast_next: number;
  }): TrollTarget {
    return {
      userId: row.user_id,
      username: row.username ?? undefined,
      lastMs: row.last_ms,
      roastNext: row.roast_next === 1 ? 1 : 0,
    };
  }

  /** Whether `!linkroast` is on for this conversation. */
  isLinkroastEnabled(conversationId: string): boolean {
    const row = this.db
      .prepare("SELECT enabled FROM linkroast WHERE conversation_id = ?")
      .get(conversationId) as { enabled: number } | undefined;
    return row?.enabled === 1;
  }

  /** Turn link roast on or off. Off deletes the row. Cooldowns stay. */
  setLinkroastEnabled(conversationId: string, enabled: boolean): void {
    if (!enabled) {
      this.db.prepare("DELETE FROM linkroast WHERE conversation_id = ?").run(conversationId);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO linkroast (conversation_id, enabled) VALUES (?, 1)
         ON CONFLICT(conversation_id) DO UPDATE SET enabled = 1`,
      )
      .run(conversationId);
  }

  /** Previous roast time for this sender in this conversation, if any. */
  getLinkroastLastMs(conversationId: string, userId: string): number | undefined {
    const row = this.db
      .prepare(
        `SELECT last_ms FROM linkroast_cooldown
         WHERE conversation_id = ? AND user_id = ?`,
      )
      .get(conversationId, userId) as { last_ms: number } | undefined;
    return row?.last_ms;
  }

  /** Persist a filed `!request` payload. Kept when the webhook is unset or the POST fails. */
  addFeatureRequest(
    conversationId: string,
    requesterId: string,
    payload: string,
    createdAt: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO feature_requests (conversation_id, requester_id, payload, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(conversationId, requesterId, payload, createdAt);
  }

  /** Filed feature requests for this conversation, oldest first. */
  listFeatureRequests(
    conversationId: string,
  ): { requesterId: string; payload: string; createdAt: string }[] {
    const rows = this.db
      .prepare(
        `SELECT requester_id, payload, created_at
         FROM feature_requests
         WHERE conversation_id = ?
         ORDER BY id ASC`,
      )
      .all(conversationId) as { requester_id: string; payload: string; created_at: string }[];
    return rows.map((row) => ({
      requesterId: row.requester_id,
      payload: row.payload,
      createdAt: row.created_at,
    }));
  }

  /**
   * Queue or replace a freeform LLM ask that Chat rate-limited.
   * `created_at_ms` stays on conflict so the age cap does not reset.
   */
  upsertLlmRetry(row: {
    conversationId: string;
    eventId: string;
    payload: string;
    attempts: number;
    nextAttemptMs: number;
    createdAtMs: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO llm_retry_jobs (
           conversation_id, event_id, payload, attempts, next_attempt_ms, created_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(conversation_id, event_id) DO UPDATE SET
           payload = excluded.payload,
           attempts = excluded.attempts,
           next_attempt_ms = excluded.next_attempt_ms`,
      )
      .run(
        row.conversationId,
        row.eventId,
        row.payload,
        row.attempts,
        row.nextAttemptMs,
        row.createdAtMs,
      );
  }

  getLlmRetry(conversationId: string, eventId: string): LlmRetryJob | undefined {
    const row = this.db
      .prepare(
        `SELECT id, conversation_id, event_id, payload, attempts, next_attempt_ms, created_at_ms
         FROM llm_retry_jobs
         WHERE conversation_id = ? AND event_id = ?`,
      )
      .get(conversationId, eventId) as LlmRetryRow | undefined;
    return row ? llmRetryFromRow(row) : undefined;
  }

  /** Due jobs, soonest first. */
  listDueLlmRetries(nowMs: number, limit: number): LlmRetryJob[] {
    const rows = this.db
      .prepare(
        `SELECT id, conversation_id, event_id, payload, attempts, next_attempt_ms, created_at_ms
         FROM llm_retry_jobs
         WHERE next_attempt_ms <= ?
         ORDER BY next_attempt_ms ASC, id ASC
         LIMIT ?`,
      )
      .all(nowMs, limit) as LlmRetryRow[];
    return rows.map(llmRetryFromRow);
  }

  listLlmRetries(): LlmRetryJob[] {
    const rows = this.db
      .prepare(
        `SELECT id, conversation_id, event_id, payload, attempts, next_attempt_ms, created_at_ms
         FROM llm_retry_jobs
         ORDER BY id ASC`,
      )
      .all() as LlmRetryRow[];
    return rows.map(llmRetryFromRow);
  }

  deleteLlmRetry(id: number): void {
    this.db.prepare("DELETE FROM llm_retry_jobs WHERE id = ?").run(id);
  }

  /** Record a posted link roast for this sender. */
  markLinkroastSent(conversationId: string, userId: string, nowMs: number): void {
    this.db
      .prepare(
        `INSERT INTO linkroast_cooldown (conversation_id, user_id, last_ms)
         VALUES (?, ?, ?)
         ON CONFLICT(conversation_id, user_id) DO UPDATE SET last_ms = excluded.last_ms`,
      )
      .run(conversationId, userId, nowMs);
  }

  /** Run several grow writes as one SQLite transaction. */
  inTransaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  getGrowSize(conversationId: string, userId: string): GrowSizeRow | undefined {
    const row = this.db
      .prepare(
        `SELECT user_id, label, length, grown_at_ms, first_played_ms, streak, streak_max
         FROM grow_sizes WHERE conversation_id = ? AND user_id = ?`,
      )
      .get(conversationId, userId) as GrowSizeSql | undefined;
    return row ? growSizeFrom(row) : undefined;
  }

  /** Longest first. Same length: more recent grow, then label. */
  listGrowSizes(conversationId: string): GrowSizeRow[] {
    const rows = this.db
      .prepare(
        `SELECT user_id, label, length, grown_at_ms, first_played_ms, streak, streak_max
         FROM grow_sizes
         WHERE conversation_id = ?
         ORDER BY length DESC, grown_at_ms DESC, label ASC`,
      )
      .all(conversationId) as GrowSizeSql[];
    return rows.map(growSizeFrom);
  }

  saveGrowSize(row: GrowSizeRow & { conversationId: string }): void {
    this.db
      .prepare(
        `INSERT INTO grow_sizes (
           conversation_id, user_id, label, length, grown_at_ms, first_played_ms, streak, streak_max
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(conversation_id, user_id) DO UPDATE SET
           label = excluded.label,
           length = excluded.length,
           grown_at_ms = excluded.grown_at_ms,
           first_played_ms = excluded.first_played_ms,
           streak = excluded.streak,
           streak_max = excluded.streak_max`,
      )
      .run(
        row.conversationId,
        row.userId,
        row.label,
        row.length,
        row.grownAtMs,
        row.firstPlayedMs,
        row.streak,
        row.streakMax,
      );
  }

  getGrowLoan(conversationId: string, userId: string): number {
    const row = this.db
      .prepare(`SELECT debt FROM grow_loans WHERE conversation_id = ? AND user_id = ?`)
      .get(conversationId, userId) as { debt: number } | undefined;
    return row?.debt ?? 0;
  }

  setGrowLoan(conversationId: string, userId: string, debt: number): void {
    if (debt <= 0) {
      this.db
        .prepare(`DELETE FROM grow_loans WHERE conversation_id = ? AND user_id = ?`)
        .run(conversationId, userId);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO grow_loans (conversation_id, user_id, debt) VALUES (?, ?, ?)
         ON CONFLICT(conversation_id, user_id) DO UPDATE SET debt = excluded.debt`,
      )
      .run(conversationId, userId, debt);
  }

  getGrowDod(conversationId: string, day: string): GrowDodRow | undefined {
    const row = this.db
      .prepare(
        `SELECT user_id, label, bonus FROM grow_dod WHERE conversation_id = ? AND day = ?`,
      )
      .get(conversationId, day) as GrowDodSql | undefined;
    if (!row) return undefined;
    return { userId: row.user_id, label: row.label, bonus: row.bonus };
  }

  saveGrowDod(row: GrowDodRow & { conversationId: string; day: string }): void {
    this.db
      .prepare(
        `INSERT INTO grow_dod (conversation_id, day, user_id, label, bonus)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(row.conversationId, row.day, row.userId, row.label, row.bonus);
  }

  getGrowFight(conversationId: string): GrowFightRow | undefined {
    const row = this.db
      .prepare(
        `SELECT challenger_id, challenger_label, bet, message_id, created_at_ms
         FROM grow_fights WHERE conversation_id = ?`,
      )
      .get(conversationId) as GrowFightSql | undefined;
    if (!row) return undefined;
    return {
      challengerId: row.challenger_id,
      challengerLabel: row.challenger_label,
      bet: row.bet,
      messageId: row.message_id,
      createdAtMs: row.created_at_ms,
    };
  }

  saveGrowFight(row: GrowFightRow & { conversationId: string }): void {
    this.db
      .prepare(
        `INSERT INTO grow_fights (
           conversation_id, challenger_id, challenger_label, bet, message_id, created_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(conversation_id) DO UPDATE SET
           challenger_id = excluded.challenger_id,
           challenger_label = excluded.challenger_label,
           bet = excluded.bet,
           message_id = excluded.message_id,
           created_at_ms = excluded.created_at_ms`,
      )
      .run(
        row.conversationId,
        row.challengerId,
        row.challengerLabel,
        row.bet,
        row.messageId,
        row.createdAtMs,
      );
  }

  attachGrowFightMessage(conversationId: string, messageId: string): void {
    this.db
      .prepare(`UPDATE grow_fights SET message_id = ? WHERE conversation_id = ?`)
      .run(messageId, conversationId);
  }

  clearGrowFight(conversationId: string): void {
    this.db.prepare(`DELETE FROM grow_fights WHERE conversation_id = ?`).run(conversationId);
  }

  getGrowPvpStats(conversationId: string, userId: string): GrowPvpStatsRow {
    const row = this.db
      .prepare(
        `SELECT user_id, label, battles, wins, win_streak, win_streak_max, acquired, lost
         FROM grow_pvp_stats WHERE conversation_id = ? AND user_id = ?`,
      )
      .get(conversationId, userId) as GrowPvpSql | undefined;
    if (!row) {
      return {
        userId,
        label: "",
        battles: 0,
        wins: 0,
        winStreak: 0,
        winStreakMax: 0,
        acquired: 0,
        lost: 0,
      };
    }
    return {
      userId: row.user_id,
      label: row.label,
      battles: row.battles,
      wins: row.wins,
      winStreak: row.win_streak,
      winStreakMax: row.win_streak_max,
      acquired: row.acquired,
      lost: row.lost,
    };
  }

  saveGrowPvpStats(row: GrowPvpStatsRow & { conversationId: string }): void {
    this.db
      .prepare(
        `INSERT INTO grow_pvp_stats (
           conversation_id, user_id, label, battles, wins, win_streak, win_streak_max, acquired, lost
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(conversation_id, user_id) DO UPDATE SET
           label = excluded.label,
           battles = excluded.battles,
           wins = excluded.wins,
           win_streak = excluded.win_streak,
           win_streak_max = excluded.win_streak_max,
           acquired = excluded.acquired,
           lost = excluded.lost`,
      )
      .run(
        row.conversationId,
        row.userId,
        row.label,
        row.battles,
        row.wins,
        row.winStreak,
        row.winStreakMax,
        row.acquired,
        row.lost,
      );
  }
}

export interface GrowSizeRow {
  userId: string;
  label: string;
  length: number;
  grownAtMs: number;
  firstPlayedMs: number;
  streak: number;
  streakMax: number;
}

export interface GrowDodRow {
  userId: string;
  label: string;
  bonus: number;
}

export interface GrowFightRow {
  challengerId: string;
  challengerLabel: string;
  bet: number;
  messageId: string | null;
  createdAtMs: number;
}

export interface GrowPvpStatsRow {
  userId: string;
  label: string;
  battles: number;
  wins: number;
  winStreak: number;
  winStreakMax: number;
  acquired: number;
  lost: number;
}

interface GrowSizeSql {
  user_id: string;
  label: string;
  length: number;
  grown_at_ms: number;
  first_played_ms: number;
  streak: number;
  streak_max: number;
}

interface GrowDodSql {
  user_id: string;
  label: string;
  bonus: number;
}

interface GrowFightSql {
  challenger_id: string;
  challenger_label: string;
  bet: number;
  message_id: string | null;
  created_at_ms: number;
}

interface GrowPvpSql {
  user_id: string;
  label: string;
  battles: number;
  wins: number;
  win_streak: number;
  win_streak_max: number;
  acquired: number;
  lost: number;
}

function growSizeFrom(row: GrowSizeSql): GrowSizeRow {
  return {
    userId: row.user_id,
    label: row.label,
    length: row.length,
    grownAtMs: row.grown_at_ms,
    firstPlayedMs: row.first_played_ms,
    streak: row.streak,
    streakMax: row.streak_max,
  };
}

interface LlmRetryRow {
  id: number;
  conversation_id: string;
  event_id: string;
  payload: string;
  attempts: number;
  next_attempt_ms: number;
  created_at_ms: number;
}

function llmRetryFromRow(row: LlmRetryRow): LlmRetryJob {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    eventId: row.event_id,
    payload: row.payload,
    attempts: row.attempts,
    nextAttemptMs: row.next_attempt_ms,
    createdAtMs: row.created_at_ms,
  };
}

export interface LlmRetryJob {
  id: number;
  conversationId: string;
  eventId: string;
  payload: string;
  attempts: number;
  nextAttemptMs: number;
  createdAtMs: number;
}

export interface TrollTarget {
  userId: string;
  username?: string;
  lastMs: number;
  /** 1 when the next reply should use the chat and timeline roast. */
  roastNext: 0 | 1;
}
