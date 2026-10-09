import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { isNumericUserId } from "../x/client.js";

/** Wall times in the transcript are New York time, labeled ET all year. */
export const HISTORY_EXPORT_TIMEZONE = "America/New_York";

const USAGE = `Export local chat history from the bot's SQLite file. Not a chat command.

Usage:
  npm run history:export -- [options]

The database is DATABASE_PATH (default data/bot.sqlite). It is opened read-only
and is not checkpointed or migrated, so this can run while the bot is up.
Message text is written to the output file only. The terminal prints one
summary line unless --stdout is passed.

Options:
  --list                     Conversation id, message count, first and last time,
                             backfill done or in-progress, and a group name if known
  --chat <id>                Repeatable. Default: every chat
  --since <when>             ISO date, ISO timestamp, New York wall time, or 7d
  --until <when>             Same forms as --since
  --from <@handle or id>     Sender handle or user id
  --search <text>            FTS5 when this SQLite build has it, otherwise LIKE
  --include-deleted          Include rows deleted in X (default)
  --no-include-deleted       Leave those rows out
  --members                  Join and leave events inline, in time order
  --format txt|md|csv|json   Default txt
  --out <path>               Default exports/<chat-or-all>-<timestamp>.<ext>
  --limit <n>                Newest n messages, written oldest first
  --stdout                   Print the transcript after the summary line
  --help

A calendar date is that day in America/New_York. --until 2026-10-09 includes
the whole day. Relative ages: 30m, 12h, 7d, 2w. Text lines look like
2026-10-09 13:54 ET  @handle: text
Replies are "↳ reply to @handle". Deleted rows are tagged [deleted]. Edits are
tagged [edited] and keep the previous body as (was: …).
`;

export type HistoryExportFormat = "txt" | "md" | "csv" | "json";
export type HistorySearchMode = "fts" | "like" | "none";

export class HistoryExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HistoryExportError";
  }
}

export interface HistoryExportArgs {
  list: boolean;
  chats: string[];
  sinceMs?: number;
  /** Messages with ts_ms < this are excluded. */
  untilExclusiveMs?: number;
  from?: string;
  search?: string;
  includeDeleted: boolean;
  members: boolean;
  format: HistoryExportFormat;
  out?: string;
  limit?: number;
  stdout: boolean;
  help: boolean;
}

export interface HistoryExportResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  outPath?: string;
  messageCount: number;
  searchMode: HistorySearchMode;
}

interface MessageRow {
  id: number;
  conversation_id: string;
  message_id: string;
  sequence_id: string | null;
  sender_id: string | null;
  sender_label: string | null;
  ts_ms: number | null;
  text: string;
  original_text: string | null;
  reply_to_id: string | null;
  media: string | null;
  deleted_in_x_at: string | null;
  edited: number;
}

interface MembershipRow {
  id: number;
  conversation_id: string;
  kind: string;
  actor_id: string | null;
  actor_label: string | null;
  subject_id: string | null;
  subject_label: string | null;
  ts_ms: number | null;
}

interface RenderedRow {
  conversationId: string;
  tsMs: number | null;
  tsEt: string;
  kind: "message" | "membership";
  membershipKind: string | null;
  sender: string;
  actor: string | null;
  text: string;
  originalText: string | null;
  deleted: boolean;
  edited: boolean;
  replyTo: string | null;
  media: string | null;
  messageId: string | null;
  sort: number;
}

interface PersonChoice {
  label: string;
  rank: number;
}

/**
 * Read-only connection. `query_only` refuses writes even if the file mode
 * would allow them. WAL commits from the live bot stay visible; this process
 * does not checkpoint.
 */
export function openHistoryReadOnly(filename: string): Database.Database {
  const db = new Database(filename, { readonly: true, fileMustExist: true });
  db.pragma("busy_timeout = 5000");
  db.pragma("query_only = ON");
  return db;
}

export function resolveHistoryDatabasePath(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): string {
  const configured = env.DATABASE_PATH?.trim();
  return path.resolve(cwd, configured ? configured : path.join("data", "bot.sqlite"));
}

export function formatEt(ms: number): string {
  const parts = etParts(ms);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ET`;
}

/** Inclusive instant. Calendar dates start at midnight in America/New_York. */
export function parseSince(value: string, nowMs: number): number {
  return parseBound(value, nowMs, "since");
}

/** Exclusive instant. A calendar date runs through the end of that New York day. */
export function parseUntilExclusive(value: string, nowMs: number): number {
  return parseBound(value, nowMs, "until");
}

export function parseHistoryExportArgs(argv: string[], nowMs: number): HistoryExportArgs {
  const args: HistoryExportArgs = {
    list: false,
    chats: [],
    includeDeleted: true,
    members: false,
    format: "txt",
    stdout: false,
    help: false,
  };
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    if (arg === "--list") {
      args.list = true;
      continue;
    }
    if (arg === "--members") {
      args.members = true;
      continue;
    }
    if (arg === "--stdout") {
      args.stdout = true;
      continue;
    }
    if (arg === "--include-deleted") {
      args.includeDeleted = true;
      continue;
    }
    if (arg === "--no-include-deleted") {
      args.includeDeleted = false;
      continue;
    }
    if (!arg.startsWith("--")) {
      throw new HistoryExportError(`Unexpected argument ${arg}`);
    }
    const eq = arg.indexOf("=");
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    if (flag === "--include-deleted") {
      args.includeDeleted = parseBoolFlag(flag, eq === -1 ? "" : arg.slice(eq + 1));
      continue;
    }
    const once = flag !== "--chat";
    if (once && seen.has(flag)) throw new HistoryExportError(`${flag} was passed more than once`);
    seen.add(flag);
    const { value, next } = takeValue(argv, index, eq, flag);
    index = next;
    switch (flag) {
      case "--chat":
        if (!value.trim()) throw new HistoryExportError("--chat needs a conversation id");
        if (!args.chats.includes(value.trim())) args.chats.push(value.trim());
        break;
      case "--since":
        args.sinceMs = parseSince(value, nowMs);
        break;
      case "--until":
        args.untilExclusiveMs = parseUntilExclusive(value, nowMs);
        break;
      case "--from":
        if (!value.trim()) throw new HistoryExportError("--from needs a handle or user id");
        args.from = value.trim();
        break;
      case "--search":
        if (!value.trim()) throw new HistoryExportError("--search needs text");
        args.search = value;
        break;
      case "--format": {
        const format = value.trim().toLowerCase();
        if (format !== "txt" && format !== "md" && format !== "csv" && format !== "json") {
          throw new HistoryExportError("--format must be txt, md, csv, or json");
        }
        args.format = format;
        break;
      }
      case "--out":
        if (!value.trim()) throw new HistoryExportError("--out needs a path");
        args.out = value;
        break;
      case "--limit": {
        if (!/^[1-9]\d*$/.test(value.trim())) {
          throw new HistoryExportError("--limit must be a positive whole number");
        }
        const parsed = Number(value.trim());
        if (!Number.isSafeInteger(parsed)) {
          throw new HistoryExportError("--limit must be a positive whole number");
        }
        args.limit = parsed;
        break;
      }
      default:
        throw new HistoryExportError(`Unknown option ${flag}`);
    }
  }
  return args;
}

export function executeHistoryExport(
  argv: string[],
  io: { dbPath: string; nowMs?: number; cwd?: string },
): HistoryExportResult {
  const nowMs = io.nowMs ?? Date.now();
  const cwd = io.cwd ?? process.cwd();
  let args: HistoryExportArgs;
  try {
    args = parseHistoryExportArgs(argv, nowMs);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  if (args.help) return { exitCode: 0, stdout: USAGE, stderr: "", messageCount: 0, searchMode: "none" };

  let db: Database.Database | undefined;
  try {
    db = openHistoryReadOnly(io.dbPath);
    requireHistoryTables(db);
    if (args.list) {
      const stdout = `${formatList(listConversations(db, args.chats)).join("\n")}\n`;
      return { exitCode: 0, stdout, stderr: "", messageCount: 0, searchMode: "none" };
    }
    const loaded = loadTranscript(db, args);
    const body = renderTranscript(loaded.rows, loaded.names, args);
    const outPath = outputPath(args, cwd, nowMs);
    writePrivateFile(outPath, body);
    const shown = displayPath(outPath, cwd);
    const range = rangeText(loaded.rows);
    const summary = `${shown}  messages=${loaded.messageCount}  ${range}\n`;
    const stdout = args.stdout ? `${summary}${body}` : summary;
    return {
      exitCode: 0,
      stdout,
      stderr: "",
      outPath,
      messageCount: loaded.messageCount,
      searchMode: loaded.searchMode,
    };
  } catch (error) {
    if (error instanceof HistoryExportError) return fail(error.message);
    if (isMissingDatabase(error)) return fail(`No database at ${io.dbPath}`);
    return fail(error instanceof Error ? error.message : String(error));
  } finally {
    db?.close();
  }
}

/** Mode 0600 no matter what the process umask is. */
export function writePrivateFile(filePath: string, body: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    fs.writeFileSync(fd, body);
    fs.closeSync(fd);
    fd = undefined;
    fs.chmodSync(tmp, 0o600);
    let existing: fs.Stats | undefined;
    try {
      existing = fs.lstatSync(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (existing?.isSymbolicLink()) {
      throw new HistoryExportError(`Refusing to replace a symlink at ${filePath}`);
    }
    fs.renameSync(tmp, filePath);
    fs.chmodSync(filePath, 0o600);
  } catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // The descriptor is already closed.
      }
    }
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // The temp file was already renamed, or it was never created.
    }
    throw error;
  }
}

export function utcFileStamp(ms: number): string {
  const date = new Date(ms);
  const part = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}${part(date.getUTCMonth() + 1)}${part(date.getUTCDate())}T${part(date.getUTCHours())}${part(date.getUTCMinutes())}${part(date.getUTCSeconds())}Z`;
}

interface EtParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
}

function etParts(ms: number): EtParts {
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone: HISTORY_EXPORT_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const map: Record<string, string> = {};
  for (const part of formatted) {
    if (part.type !== "literal") map[part.type] = part.value;
  }
  let hour = map.hour ?? "00";
  if (hour === "24") hour = "00";
  return {
    year: map.year ?? "0000",
    month: map.month ?? "01",
    day: map.day ?? "01",
    hour,
    minute: map.minute ?? "00",
    second: map.second ?? "00",
  };
}

function etOffsetMs(utcMs: number): number {
  const parts = etParts(utcMs);
  const wall = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return wall - utcMs;
}

function wallClockToUtc(year: number, month: number, day: number, hour: number, minute: number, second: number): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  const first = wall - etOffsetMs(wall);
  return wall - etOffsetMs(first);
}

function assertWallClock(ms: number, year: number, month: number, day: number, hour: number, minute: number, second: number): void {
  const parts = etParts(ms);
  const got = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
  const want = `${pad4(year)}-${pad2(month)}-${pad2(day)} ${pad2(hour)}:${pad2(minute)}:${pad2(second)}`;
  if (got !== want) throw new HistoryExportError(`Invalid time ${want.slice(0, 10)}`);
}

function parseBound(value: string, nowMs: number, edge: "since" | "until"): number {
  const trimmed = value.trim();
  if (!trimmed) throw new HistoryExportError(`--${edge} needs a date or a relative age like 7d`);
  const relative = /^(\d+)([mhdw])$/i.exec(trimmed);
  if (relative) {
    const count = Number(relative[1]);
    const unit = relative[2]?.toLowerCase();
    const mult = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : unit === "d" ? 86_400_000 : 7 * 86_400_000;
    const delta = count * mult;
    if (!Number.isSafeInteger(delta)) {
      throw new HistoryExportError(`--${edge} is too large`);
    }
    const instant = nowMs - delta;
    return edge === "until" ? instant + 1 : instant;
  }
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    const start = wallClockToUtc(year, month, day, 0, 0, 0);
    assertWallClock(start, year, month, day, 0, 0, 0);
    if (edge === "since") return start;
    const next = nextCalendarDay(year, month, day);
    const end = wallClockToUtc(next.year, next.month, next.day, 0, 0, 0);
    assertWallClock(end, next.year, next.month, next.day, 0, 0, 0);
    return end;
  }
  if (hasExplicitZone(trimmed)) {
    const parsed = Date.parse(trimmed);
    if (!Number.isFinite(parsed)) throw new HistoryExportError(`Invalid time ${trimmed}`);
    return edge === "until" ? parsed + 1 : parsed;
  }
  const local = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec(trimmed);
  if (local) {
    const year = Number(local[1]);
    const month = Number(local[2]);
    const day = Number(local[3]);
    const hour = Number(local[4]);
    const minute = Number(local[5]);
    const second = Number(local[6] ?? "0");
    const instant = wallClockToUtc(year, month, day, hour, minute, second);
    assertWallClock(instant, year, month, day, hour, minute, second);
    return edge === "until" ? instant + 1 : instant;
  }
  throw new HistoryExportError(`Invalid time ${trimmed}. Use an ISO date or a relative age like 7d.`);
}

function hasExplicitZone(value: string): boolean {
  return /[zZ]$/.test(value) || /[+-]\d{2}:?\d{2}$/.test(value);
}

function nextCalendarDay(year: number, month: number, day: number): { year: number; month: number; day: number } {
  const utc = new Date(Date.UTC(year, month - 1, day + 1));
  return { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: utc.getUTCDate() };
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function pad4(value: number): string {
  return String(value).padStart(4, "0");
}

function takeValue(
  argv: string[],
  index: number,
  eq: number,
  flag: string,
): { value: string; next: number } {
  const arg = argv[index] ?? "";
  if (eq !== -1) return { value: arg.slice(eq + 1), next: index };
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new HistoryExportError(`${flag} needs a value`);
  }
  return { value, next: index + 1 };
}

function parseBoolFlag(flag: string, value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") return true;
  if (normalized === "false" || normalized === "0" || normalized === "no") return false;
  throw new HistoryExportError(`${flag} must be true or false`);
}

function fail(message: string): HistoryExportResult {
  const line = message.endsWith("\n") ? message : `${message}\n`;
  return { exitCode: 1, stdout: "", stderr: line, messageCount: 0, searchMode: "none" };
}

function isMissingDatabase(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
  if (code === "SQLITE_CANTOPEN" || code === "ENOENT") return true;
  const message = error instanceof Error ? error.message : "";
  return /unable to open database file/i.test(message);
}

function requireHistoryTables(db: Database.Database): void {
  if (!tableExists(db, "chat_history_messages")) {
    throw new HistoryExportError("No local chat history in this database (chat_history_messages is missing).");
  }
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  return Boolean(row);
}

interface ListedConversation {
  conversationId: string;
  messageCount: number;
  firstMs: number | null;
  lastMs: number | null;
  backfill: "done" | "in-progress";
  name?: string;
}

function listConversations(db: Database.Database, chats: string[]): ListedConversation[] {
  const ids = new Set<string>(chats);
  if (chats.length === 0) {
    for (const name of ["chat_history_messages", "chat_history_membership", "chat_history_backfill"]) {
      if (!tableExists(db, name)) continue;
      const rows = db.prepare(`SELECT DISTINCT conversation_id FROM ${name}`).all() as { conversation_id: string }[];
      for (const row of rows) ids.add(row.conversation_id);
    }
  }
  const listed: ListedConversation[] = [];
  for (const conversationId of ids) {
    const stats = db
      .prepare(
        `SELECT COUNT(*) AS message_count, MIN(ts_ms) AS first_ms, MAX(ts_ms) AS last_ms
         FROM chat_history_messages WHERE conversation_id = ?`,
      )
      .get(conversationId) as { message_count: number; first_ms: number | null; last_ms: number | null };
    const backfill = tableExists(db, "chat_history_backfill")
      ? (db.prepare("SELECT done FROM chat_history_backfill WHERE conversation_id = ?").get(conversationId) as
          | { done: number }
          | undefined)
      : undefined;
    const name = lookupGroupName(db, conversationId);
    listed.push({
      conversationId,
      messageCount: stats.message_count,
      firstMs: stats.first_ms,
      lastMs: stats.last_ms,
      backfill: backfill?.done === 1 ? "done" : "in-progress",
      ...(name ? { name } : {}),
    });
  }
  if (chats.length > 0) {
    const order = new Map(chats.map((id, index) => [id, index]));
    listed.sort((a, b) => (order.get(a.conversationId) ?? 0) - (order.get(b.conversationId) ?? 0));
    return listed;
  }
  listed.sort((a, b) => {
    const lastA = a.lastMs ?? Number.NEGATIVE_INFINITY;
    const lastB = b.lastMs ?? Number.NEGATIVE_INFINITY;
    if (lastA !== lastB) return lastB - lastA;
    return a.conversationId.localeCompare(b.conversationId);
  });
  return listed;
}

function formatList(rows: ListedConversation[]): string[] {
  if (rows.length === 0) return ["No conversations."];
  return rows.map((row) => {
    const first = row.firstMs == null ? "none" : formatEt(row.firstMs);
    const last = row.lastMs == null ? "none" : formatEt(row.lastMs);
    const name = row.name ? `  name=${oneLine(row.name)}` : "";
    return `${row.conversationId}  messages=${row.messageCount}  first=${first}  last=${last}  backfill=${row.backfill}${name}`;
  });
}

function lookupGroupName(db: Database.Database, conversationId: string): string | undefined {
  if (tableExists(db, "notes")) {
    const note = db
      .prepare("SELECT value FROM notes WHERE conversation_id = ? AND key = 'group_name'")
      .get(conversationId) as { value: string } | undefined;
    const value = note?.value?.trim();
    if (value) return value;
  }
  if (tableExists(db, "conversation_settings")) {
    const row = db
      .prepare("SELECT json FROM conversation_settings WHERE conversation_id = ?")
      .get(conversationId) as { json: string } | undefined;
    if (!row?.json) return undefined;
    try {
      const parsed = JSON.parse(row.json) as { group_name?: unknown; name?: unknown };
      const name = parsed.group_name ?? parsed.name;
      if (typeof name === "string" && name.trim()) return name.trim();
    } catch {
      return undefined;
    }
  }
  return undefined;
}

interface LoadedTranscript {
  rows: RenderedRow[];
  names: Map<string, string>;
  messageCount: number;
  searchMode: HistorySearchMode;
}

function loadTranscript(db: Database.Database, args: HistoryExportArgs): LoadedTranscript {
  const people = loadPeople(db);
  const senderIds = matchingSenderIds(people, args.from);
  const queried = queryMessages(db, args, senderIds);
  const messages = queried.rows;
  let membership: MembershipRow[] = [];
  if (args.members) {
    membership = queryMembership(db, args, senderIds);
    membership = clipMembership(membership, messages, args.limit);
  }
  const replies = loadReplyIndex(db, people);
  const rendered: RenderedRow[] = [];
  for (const row of messages) {
    const sender = senderOf(row.sender_id, row.sender_label, people);
    const original = row.original_text?.trim() ? row.original_text : null;
    rendered.push({
      conversationId: row.conversation_id,
      tsMs: row.ts_ms,
      tsEt: row.ts_ms == null ? "unknown time" : formatEt(row.ts_ms),
      kind: "message",
      membershipKind: null,
      sender,
      actor: null,
      text: row.text,
      originalText: original && oneLine(original) !== oneLine(row.text) ? original : null,
      deleted: row.deleted_in_x_at != null,
      edited: row.edited === 1,
      replyTo: row.reply_to_id ? (replies.get(`${row.conversation_id}\0${row.reply_to_id}`) ?? "someone") : null,
      media: row.media?.trim() ? row.media.trim() : null,
      messageId: row.message_id,
      sort: row.id,
    });
  }
  for (const row of membership) {
    const subject = senderOf(row.subject_id, row.subject_label, people);
    const actor = row.actor_id || row.actor_label ? senderOf(row.actor_id, row.actor_label, people) : null;
    rendered.push({
      conversationId: row.conversation_id,
      tsMs: row.ts_ms,
      tsEt: row.ts_ms == null ? "unknown time" : formatEt(row.ts_ms),
      kind: "membership",
      membershipKind: row.kind,
      sender: subject,
      actor,
      text: membershipPhrase(row.kind, subject, actor),
      originalText: null,
      deleted: false,
      edited: false,
      replyTo: null,
      media: null,
      messageId: null,
      sort: row.id,
    });
  }
  const ordered = orderRows(rendered, args.chats);
  const names = new Map<string, string>();
  for (const conversationId of new Set(ordered.map((row) => row.conversationId))) {
    const name = lookupGroupName(db, conversationId);
    if (name) names.set(conversationId, name);
  }
  return {
    rows: ordered,
    names,
    messageCount: messages.length,
    searchMode: queried.searchMode,
  };
}

function orderRows(rows: RenderedRow[], chats: string[]): RenderedRow[] {
  const byId = new Map<string, RenderedRow[]>();
  for (const row of rows) {
    const group = byId.get(row.conversationId);
    if (group) group.push(row);
    else byId.set(row.conversationId, [row]);
  }
  for (const group of byId.values()) group.sort(compareRows);
  const ids =
    chats.length > 0
      ? chats.filter((id) => byId.has(id))
      : [...byId.keys()].sort((a, b) => {
          const aTs = minTs(byId.get(a) ?? []);
          const bTs = minTs(byId.get(b) ?? []);
          if (aTs !== bTs) return aTs - bTs;
          return a.localeCompare(b);
        });
  const ordered: RenderedRow[] = [];
  for (const id of ids) {
    const group = byId.get(id);
    if (group) ordered.push(...group);
  }
  return ordered;
}

function minTs(rows: RenderedRow[]): number {
  let min = Number.MAX_SAFE_INTEGER;
  for (const row of rows) {
    if (row.tsMs != null && row.tsMs < min) min = row.tsMs;
  }
  return min;
}

function compareRows(a: RenderedRow, b: RenderedRow): number {
  const tsA = a.tsMs ?? Number.MAX_SAFE_INTEGER;
  const tsB = b.tsMs ?? Number.MAX_SAFE_INTEGER;
  if (tsA !== tsB) return tsA - tsB;
  if (a.kind !== b.kind) return a.kind === "membership" ? -1 : 1;
  return a.sort - b.sort;
}

function clipMembership(events: MembershipRow[], messages: MessageRow[], limit: number | undefined): MembershipRow[] {
  if (limit == null) return events;
  const span = new Map<string, { min: number; max: number }>();
  for (const row of messages) {
    if (row.ts_ms == null) continue;
    const current = span.get(row.conversation_id);
    if (!current) {
      span.set(row.conversation_id, { min: row.ts_ms, max: row.ts_ms });
      continue;
    }
    current.min = Math.min(current.min, row.ts_ms);
    current.max = Math.max(current.max, row.ts_ms);
  }
  return events.filter((row) => {
    const window = span.get(row.conversation_id);
    return window != null && row.ts_ms != null && row.ts_ms >= window.min && row.ts_ms <= window.max;
  });
}

function loadPeople(db: Database.Database): Map<string, string> {
  const ranked = new Map<string, PersonChoice>();
  const consider = (id: string | null, label: string | null, rank: number) => {
    if (!id) return;
    const usable = usablePersonLabel(label);
    if (!usable) return;
    const current = ranked.get(id);
    if (!current) {
      ranked.set(id, { label: usable, rank });
      return;
    }
    const incomingHandle = usable.startsWith("@");
    const currentHandle = current.label.startsWith("@");
    if (incomingHandle && !currentHandle) {
      ranked.set(id, { label: usable, rank });
      return;
    }
    if (incomingHandle === currentHandle && rank >= current.rank) {
      ranked.set(id, { label: usable, rank });
    }
  };
  const messages = db
    .prepare("SELECT id, sender_id, sender_label FROM chat_history_messages")
    .all() as { id: number; sender_id: string | null; sender_label: string | null }[];
  for (const row of messages) consider(row.sender_id, row.sender_label, row.id);
  if (tableExists(db, "chat_history_membership")) {
    const members = db
      .prepare("SELECT id, subject_id, subject_label, actor_id, actor_label FROM chat_history_membership")
      .all() as {
      id: number;
      subject_id: string | null;
      subject_label: string | null;
      actor_id: string | null;
      actor_label: string | null;
    }[];
    for (const row of members) {
      consider(row.subject_id, row.subject_label, row.id);
      consider(row.actor_id, row.actor_label, row.id);
    }
  }
  considerUsernames(db, "user_xp", "user_id", "username", consider);
  considerUsernames(db, "troll_targets", "user_id", "username", consider);
  considerUsernames(db, "troll_all_cooldown", "user_id", "username", consider);
  return new Map([...ranked].map(([id, choice]) => [id, choice.label]));
}

function considerUsernames(
  db: Database.Database,
  table: string,
  idColumn: string,
  nameColumn: string,
  consider: (id: string | null, label: string | null, rank: number) => void,
): void {
  if (!tableExists(db, table)) return;
  const rows = db.prepare(`SELECT ${idColumn} AS id, ${nameColumn} AS username FROM ${table}`).all() as {
    id: string | null;
    username: string | null;
  }[];
  for (const row of rows) consider(row.id, labelFromUsername(row.username), 0);
}

function matchingSenderIds(people: Map<string, string>, from: string | undefined): string[] {
  if (!from) return [];
  const needle = from.replace(/^@/, "").toLowerCase();
  const ids: string[] = [];
  if (/^\d+$/.test(from) || !from.startsWith("@")) ids.push(from);
  for (const [id, label] of people) {
    const bare = label.replace(/^@/, "").toLowerCase();
    if (bare === needle || id === from) ids.push(id);
  }
  return [...new Set(ids)];
}

function loadReplyIndex(db: Database.Database, people: Map<string, string>): Map<string, string> {
  const index = new Map<string, string>();
  const rows = db
    .prepare(
      `SELECT id, conversation_id, message_id, sequence_id, sender_id, sender_label
       FROM chat_history_messages`,
    )
    .all() as {
    id: number;
    conversation_id: string;
    message_id: string;
    sequence_id: string | null;
    sender_id: string | null;
    sender_label: string | null;
  }[];
  const byRow = new Map<number, string>();
  for (const row of rows) {
    const sender = senderOf(row.sender_id, row.sender_label, people);
    byRow.set(row.id, sender);
    rememberReply(index, row.conversation_id, row.message_id, sender);
    if (row.sequence_id) rememberReply(index, row.conversation_id, row.sequence_id, sender);
  }
  if (tableExists(db, "chat_history_aliases")) {
    const aliases = db
      .prepare("SELECT conversation_id, alias, message_row FROM chat_history_aliases")
      .all() as { conversation_id: string; alias: string; message_row: number }[];
    for (const alias of aliases) {
      const sender = byRow.get(alias.message_row);
      if (sender) rememberReply(index, alias.conversation_id, alias.alias, sender);
    }
  }
  return index;
}

function rememberReply(index: Map<string, string>, conversationId: string, key: string, sender: string): void {
  const trimmed = key.trim();
  if (!trimmed) return;
  index.set(`${conversationId}\0${trimmed}`, sender);
}

function senderOf(senderId: string | null, senderLabel: string | null, people: Map<string, string>): string {
  const own = usablePersonLabel(senderLabel);
  const known = senderId ? people.get(senderId) : undefined;
  if (own?.startsWith("@")) return own;
  if (known?.startsWith("@")) return known;
  if (own) return own;
  if (known) return known;
  return "someone";
}

function usablePersonLabel(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.toLowerCase() === "someone") return undefined;
  if (trimmed.startsWith("@")) {
    const handle = trimmed.slice(1).trim();
    if (!handle || isNumericUserId(handle)) return undefined;
    return `@${handle}`;
  }
  if (isNumericUserId(trimmed)) return undefined;
  return trimmed;
}

function labelFromUsername(username: string | null): string | null {
  if (!username) return null;
  const trimmed = username.trim().replace(/^@/, "");
  if (!trimmed || isNumericUserId(trimmed)) return null;
  if (/\s/.test(trimmed)) return trimmed;
  return `@${trimmed}`;
}

function membershipPhrase(kind: string, subject: string, actor: string | null): string {
  if (kind === "leave") return `${subject} left`;
  if (kind === "join") return `${subject} joined`;
  if (kind === "add") {
    return actor && actor !== subject ? `${subject} was added by ${actor}` : `${subject} was added`;
  }
  return actor && actor !== subject ? `${subject} ${kind} (${actor})` : `${subject} ${kind}`;
}

interface QuerySpec {
  clauses: string[];
  params: Array<string | number | null>;
}

function queryMessages(
  db: Database.Database,
  args: HistoryExportArgs,
  senderIds: string[],
): { rows: MessageRow[]; searchMode: HistorySearchMode } {
  const tokens = args.search ? searchTokens(args.search) : [];
  if (args.search && tokens.length === 0) throw new HistoryExportError("--search needs text");
  if (tokens.length > 0 && ftsAvailable(db)) {
    try {
      return { rows: runMessageQuery(db, args, senderIds, tokens, "fts"), searchMode: "fts" };
    } catch (error) {
      if (!isSearchFallbackError(error)) throw error;
    }
  }
  const mode: HistorySearchMode = tokens.length > 0 ? "like" : "none";
  return { rows: runMessageQuery(db, args, senderIds, tokens, mode), searchMode: mode };
}

function runMessageQuery(
  db: Database.Database,
  args: HistoryExportArgs,
  senderIds: string[],
  tokens: string[],
  mode: HistorySearchMode,
): MessageRow[] {
  const spec: QuerySpec = { clauses: [], params: [] };
  if (mode === "fts") {
    spec.clauses.push("chat_history_fts MATCH ?");
    spec.params.push(tokens.map((token) => `text : "${token.replace(/"/g, "")}"`).join(" AND "));
  }
  appendSharedFilters(spec, args, senderIds, "m");
  if (mode === "like") appendLike(spec, tokens, "m.text", "m.original_text");
  const join = mode === "fts" ? "JOIN chat_history_fts ON chat_history_fts.rowid = m.id" : "";
  const where = spec.clauses.length ? `WHERE ${spec.clauses.join(" AND ")}` : "";
  const params = spec.params;
  let sql: string;
  if (args.limit != null) {
    sql = `SELECT * FROM (
      SELECT m.* FROM chat_history_messages m ${join}
      ${where}
      ORDER BY COALESCE(m.ts_ms, 0) DESC, m.id DESC
      LIMIT ?
    ) ORDER BY COALESCE(ts_ms, 0) ASC, id ASC`;
    params.push(args.limit);
  } else {
    sql = `SELECT m.* FROM chat_history_messages m ${join}
      ${where}
      ORDER BY COALESCE(m.ts_ms, 0) ASC, m.id ASC`;
  }
  return db.prepare(sql).all(...params) as MessageRow[];
}

function queryMembership(db: Database.Database, args: HistoryExportArgs, senderIds: string[]): MembershipRow[] {
  if (!tableExists(db, "chat_history_membership")) return [];
  const spec: QuerySpec = { clauses: [], params: [] };
  appendConversation(spec, args.chats, "conversation_id");
  appendTime(spec, args, "ts_ms");
  if (args.from) appendFrom(spec, args.from, senderIds, ["subject_id", "actor_id"], ["subject_label", "actor_label"]);
  const tokens = args.search ? searchTokens(args.search) : [];
  for (const token of tokens) {
    const like = `%${escapeLike(token.toLowerCase())}%`;
    spec.clauses.push(
      `(lower(ifnull(subject_label, '')) LIKE ? ESCAPE '\\' OR lower(ifnull(actor_label, '')) LIKE ? ESCAPE '\\' OR lower(kind) LIKE ? ESCAPE '\\')`,
    );
    spec.params.push(like, like, like);
  }
  const where = spec.clauses.length ? `WHERE ${spec.clauses.join(" AND ")}` : "";
  return db
    .prepare(
      `SELECT * FROM chat_history_membership ${where} ORDER BY COALESCE(ts_ms, 0) ASC, id ASC`,
    )
    .all(...spec.params) as MembershipRow[];
}

function appendSharedFilters(spec: QuerySpec, args: HistoryExportArgs, senderIds: string[], alias: string): void {
  appendConversation(spec, args.chats, `${alias}.conversation_id`);
  if (!args.includeDeleted) spec.clauses.push(`${alias}.deleted_in_x_at IS NULL`);
  appendTime(spec, args, `${alias}.ts_ms`);
  if (args.from) appendFrom(spec, args.from, senderIds, [`${alias}.sender_id`], [`${alias}.sender_label`]);
}

function appendConversation(spec: QuerySpec, chats: string[], column: string): void {
  if (chats.length === 0) return;
  spec.clauses.push(`${column} IN (${chats.map(() => "?").join(", ")})`);
  spec.params.push(...chats);
}

function appendTime(spec: QuerySpec, args: HistoryExportArgs, column: string): void {
  if (args.sinceMs != null) {
    spec.clauses.push(`${column} >= ?`);
    spec.params.push(args.sinceMs);
  }
  if (args.untilExclusiveMs != null) {
    spec.clauses.push(`${column} < ?`);
    spec.params.push(args.untilExclusiveMs);
  }
}

function appendFrom(spec: QuerySpec, from: string, senderIds: string[], idColumns: string[], labelColumns: string[]): void {
  const bare = from.replace(/^@/, "");
  const withAt = from.startsWith("@") ? from : `@${bare}`;
  const parts: string[] = [];
  const params: Array<string | number | null> = [];
  for (const column of idColumns) {
    parts.push(`${column} = ?`);
    params.push(from);
    if (bare !== from) {
      parts.push(`${column} = ?`);
      params.push(bare);
    }
  }
  for (const column of labelColumns) {
    parts.push(`lower(ifnull(${column}, '')) = lower(?)`);
    params.push(withAt);
    parts.push(`lower(ifnull(${column}, '')) = lower(?)`);
    params.push(bare);
    parts.push(`lower(replace(ifnull(${column}, ''), '@', '')) = lower(?)`);
    params.push(bare);
  }
  if (senderIds.length > 0) {
    const marks = senderIds.map(() => "?").join(", ");
    for (const column of idColumns) {
      parts.push(`${column} IN (${marks})`);
      params.push(...senderIds);
    }
  }
  spec.clauses.push(`(${parts.join(" OR ")})`);
  spec.params.push(...params);
}

function appendLike(spec: QuerySpec, tokens: string[], textColumn: string, originalColumn: string): void {
  for (const token of tokens) {
    const like = `%${escapeLike(token.toLowerCase())}%`;
    spec.clauses.push(
      `(lower(${textColumn}) LIKE ? ESCAPE '\\' OR lower(ifnull(${originalColumn}, '')) LIKE ? ESCAPE '\\')`,
    );
    spec.params.push(like, like);
  }
}

function searchTokens(text: string): string[] {
  return text
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/"/g, ""))
    .filter((token) => token.length > 0);
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function ftsAvailable(db: Database.Database): boolean {
  return tableExists(db, "chat_history_fts");
}

function isSearchFallbackError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /fts|malformed MATCH|readonly|no such/i.test(message);
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function messageBody(row: RenderedRow): string {
  const parts: string[] = [];
  if (row.replyTo) parts.push(`↳ reply to ${row.replyTo}`);
  if (row.deleted) parts.push("[deleted]");
  if (row.edited) parts.push("[edited]");
  const text = oneLine(row.text);
  if (text) parts.push(text);
  if (row.media) parts.push(`[${oneLine(row.media)}]`);
  if (row.originalText) parts.push(`(was: ${oneLine(row.originalText)})`);
  return parts.join(" ");
}

function renderTranscript(rows: RenderedRow[], names: Map<string, string>, args: HistoryExportArgs): string {
  if (args.format === "json") return `${JSON.stringify(jsonBody(rows, args.members), null, 2)}\n`;
  if (args.format === "csv") return renderCsv(rows);
  if (args.format === "md") return renderMarkdown(rows, names);
  return renderText(rows, names);
}

function renderText(rows: RenderedRow[], names: Map<string, string>): string {
  if (rows.length === 0) return "";
  const groups = groupRows(rows);
  const header = groups.length > 1;
  const lines: string[] = [];
  for (const [conversationId, group] of groups) {
    if (header) {
      if (lines.length > 0) lines.push("");
      const name = names.get(conversationId);
      lines.push(name ? `# ${conversationId}  ${oneLine(name)}` : `# ${conversationId}`);
    }
    for (const row of group) lines.push(textLine(row));
  }
  return `${lines.join("\n")}\n`;
}

function textLine(row: RenderedRow): string {
  if (row.kind === "membership") return `${row.tsEt}  ${row.text}`;
  return `${row.tsEt}  ${row.sender}: ${messageBody(row)}`;
}

function renderMarkdown(rows: RenderedRow[], names: Map<string, string>): string {
  if (rows.length === 0) return "No messages.\n";
  const blocks: string[] = [];
  for (const [conversationId, group] of groupRows(rows)) {
    const name = names.get(conversationId);
    const heading = name ? `# ${conversationId}\n\n${oneLine(name)}` : `# ${conversationId}`;
    const lines = group.map((row) => {
      if (row.kind === "membership") return `- \`${row.tsEt}\` ${row.text}`;
      return `- \`${row.tsEt}\` ${row.sender}: ${messageBody(row)}`;
    });
    blocks.push(`${heading}\n\n${lines.join("\n")}`);
  }
  return `${blocks.join("\n\n")}\n`;
}

function renderCsv(rows: RenderedRow[]): string {
  const header = ["ts_et", "conversation_id", "kind", "sender", "text", "tags", "original_text", "reply_to", "media"];
  const lines = [header.join(",")];
  for (const row of rows) {
    const kind = row.kind === "message" ? "message" : (row.membershipKind ?? "membership");
    const tags = [row.deleted ? "deleted" : "", row.edited ? "edited" : ""].filter(Boolean).join("|");
    lines.push(
      [row.tsEt, row.conversationId, kind, row.sender, row.text, tags, row.originalText ?? "", row.replyTo ?? "", row.media ?? ""]
        .map(csvField)
        .join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

function csvField(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function jsonBody(rows: RenderedRow[], members: boolean): Record<string, unknown> {
  const messages = rows
    .filter((row) => row.kind === "message")
    .map((row) => ({
      conversation_id: row.conversationId,
      message_id: row.messageId,
      ts: row.tsMs == null ? null : new Date(row.tsMs).toISOString(),
      ts_et: row.tsEt,
      sender: row.sender,
      text: row.text,
      original_text: row.originalText,
      deleted: row.deleted,
      edited: row.edited,
      reply_to: row.replyTo,
      media: row.media,
    }));
  if (!members) return { messages };
  const membership = rows
    .filter((row) => row.kind === "membership")
    .map((row) => ({
      conversation_id: row.conversationId,
      ts: row.tsMs == null ? null : new Date(row.tsMs).toISOString(),
      ts_et: row.tsEt,
      kind: row.membershipKind,
      actor: row.actor,
      subject: row.sender,
      text: row.text,
    }));
  return { messages, membership };
}

function groupRows(rows: RenderedRow[]): Array<[string, RenderedRow[]]> {
  const groups: Array<[string, RenderedRow[]]> = [];
  for (const row of rows) {
    const last = groups[groups.length - 1];
    if (last && last[0] === row.conversationId) {
      last[1].push(row);
      continue;
    }
    groups.push([row.conversationId, [row]]);
  }
  return groups;
}

function rangeText(rows: RenderedRow[]): string {
  const times = rows.map((row) => row.tsMs).filter((ts): ts is number => ts != null);
  if (times.length === 0) return "range=none";
  return `${formatEt(Math.min(...times))} .. ${formatEt(Math.max(...times))}`;
}

function outputPath(args: HistoryExportArgs, cwd: string, nowMs: number): string {
  if (args.out) return path.resolve(cwd, args.out);
  const slug = args.chats.length === 1 ? sanitizeId(args.chats[0] ?? "chat") : "all";
  return unusedPath(path.join(cwd, "exports", `${slug}-${utcFileStamp(nowMs)}.${args.format}`));
}

function sanitizeId(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || "chat";
}

function unusedPath(filePath: string): string {
  if (!fs.existsSync(filePath)) return filePath;
  const ext = path.extname(filePath);
  const base = filePath.slice(0, filePath.length - ext.length);
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}-${suffix}${ext}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new HistoryExportError("Could not pick an unused export path");
}

function displayPath(filePath: string, cwd: string): string {
  const relative = path.relative(cwd, filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return filePath;
  return relative;
}
