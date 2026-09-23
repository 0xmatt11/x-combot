import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { ConversationSettings } from "./types.js";

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
`;

export class Store {
  readonly db: Database.Database;

  constructor(filename: string) {
    if (filename !== ":memory:") {
      fs.mkdirSync(path.dirname(filename), { recursive: true });
    }
    this.db = new Database(filename);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
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
}
