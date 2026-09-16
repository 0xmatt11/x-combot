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
}
