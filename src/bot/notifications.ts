import fs from "node:fs/promises";
import path from "node:path";
import { isChatGroupId } from "../chat/ids.js";
import { log } from "../log.js";
import type { MediaCaption } from "../types.js";

/** How often the live process checks `pending/`. */
export const NOTIFICATION_POLL_INTERVAL_MS = 5_000;

/** Files claimed per tick, so a backlog cannot stall the process. */
export const NOTIFICATION_BATCH = 20;

const TEXT_MAX = 500;
const RAW_MAX = 2_000;
const REASON_MAX = 300;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/;
const COMMAND_NAME = /^!?[A-Za-z][A-Za-z0-9_]{0,31}$/;
const USER_ID = /^\d{1,25}$/;
const HANDLE = /^[A-Za-z0-9_]{1,15}$/;

/**
 * JSON Chief of Staff writes into `pending/`.
 * `text`, when set, is the body after the @handle and replaces the default line.
 * `command` is the bang that shipped, used when `text` is omitted.
 * One of `text` or `command` is required. Extra fields are ignored on read.
 */
export interface ReadyNotification {
  conversationId: string;
  userId: string;
  command?: string;
  text?: string;
}

export interface NotificationDirs {
  root: string;
  pending: string;
  processing: string;
  done: string;
  failed: string;
}

export interface NotificationUser {
  id: string;
  username?: string;
  name?: string;
}

/**
 * Chat send plus the user lookup the mention needs.
 * `chatAvailable` is false when the Chat identity is not open.
 */
export interface NotificationTransport {
  chatAvailable(): boolean;
  getUserById(userId: string): Promise<NotificationUser | undefined>;
  sendMessage(
    conversationId: string,
    text: string,
    caption?: MediaCaption,
  ): Promise<unknown>;
}

export interface NotificationPollResult {
  /**
   * True when at least one readable file was not sent because Chat is not open.
   * Those files are in `failed/` with a reason. Pending files are not left behind.
   */
  skipped: boolean;
  sent: number;
  failed: number;
}

export interface ReadyNotificationMessage {
  /** Full chat line, starting with `@handle`. */
  text: string;
  /** `@handle` label plus a mention entity covering that handle. */
  caption: MediaCaption;
}

export type ParsedReadyNotification =
  | { ok: true; value: ReadyNotification }
  | { ok: false; reason: string };

/**
 * Folder beside the SQLite file. Default database `data/bot.sqlite` means
 * `data/notifications/`.
 */
export function defaultNotificationRoot(databasePath?: string): string {
  const dataDir = databasePath ? path.dirname(path.resolve(databasePath)) : path.resolve("data");
  return path.join(dataDir, "notifications");
}

export function notificationDirs(root: string): NotificationDirs {
  return {
    root,
    pending: path.join(root, "pending"),
    processing: path.join(root, "processing"),
    done: path.join(root, "done"),
    failed: path.join(root, "failed"),
  };
}

/** `name.json` only. Dotfiles and `*.tmp` are a writer's half-finished drop. */
export function isNotificationFileName(name: string): boolean {
  return FILE_NAME.test(name);
}

/**
 * Drop one notification into `pending/`. A temp file is renamed into place
 * so a poll does not read a half-written body.
 */
export async function writeReadyNotificationFile(options: {
  pendingDir: string;
  id: string;
  payload: ReadyNotification;
}): Promise<string> {
  const id = safeNotificationId(options.id);
  await fs.mkdir(options.pendingDir, { recursive: true });
  const finalPath = path.join(options.pendingDir, `${id}.json`);
  const tmpPath = path.join(options.pendingDir, `.${id}.json.tmp`);
  await fs.writeFile(tmpPath, `${JSON.stringify(options.payload, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, finalPath);
  return finalPath;
}

export function parseReadyNotification(value: unknown): ParsedReadyNotification {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "Notification file must be a JSON object." };
  }
  const record = value as Record<string, unknown>;
  const conversationId = readRequiredString(record.conversationId);
  if (!conversationId) return { ok: false, reason: "conversationId is required." };
  if (!isChatGroupId(conversationId)) {
    return { ok: false, reason: "conversationId must be an encrypted Chat group id." };
  }
  const userId = readRequiredString(record.userId);
  if (!userId) return { ok: false, reason: "userId is required." };
  if (!USER_ID.test(userId)) {
    return { ok: false, reason: "userId must be a numeric X user id." };
  }
  const command = readOptionalString(record.command, "command");
  if (!command.ok) return command;
  if (command.value !== undefined && !COMMAND_NAME.test(command.value)) {
    return { ok: false, reason: "command must be a bang name such as !undertow." };
  }
  const text = readOptionalString(record.text, "text");
  if (!text.ok) return text;
  if (text.value !== undefined && text.value.length > TEXT_MAX) {
    return { ok: false, reason: "text is too long." };
  }
  if (!command.value && !text.value) {
    return { ok: false, reason: "Notification needs text or command." };
  }
  return {
    ok: true,
    value: {
      conversationId,
      userId,
      ...(command.value ? { command: command.value } : {}),
      ...(text.value ? { text: text.value } : {}),
    },
  };
}

/**
 * `@handle your !command is live`, or `@handle` plus `text` when text is set.
 * The mention entity covers the handle only, the same byte range other
 * outbound Chat mentions use.
 */
export function formatReadyNotification(
  username: string,
  notice: Pick<ReadyNotification, "command" | "text">,
): ReadyNotificationMessage {
  const handleName = normalizeHandle(username);
  if (!handleName) throw new Error("username is not an @handle");
  const handle = `@${handleName}`;
  const body = notice.text?.trim()
    ? notice.text.trim()
    : `your ${spokenCommand(notice.command ?? "")} is live`;
  const text = alreadyAddresses(body, handle) ? body : `${handle} ${body}`;
  const mention = handleMention(handle);
  if (!mention) throw new Error("username is not an @handle");
  return {
    text,
    caption: { text: handle, mention },
  };
}

/** `@handle` covering that label. Display names are not a Chat mention entity. */
export function handleMention(text: string): MediaCaption["mention"] | undefined {
  const match = /^@([A-Za-z0-9_]{1,15})$/.exec(text);
  const username = match?.[1];
  if (!username || /^\d+$/.test(username)) return undefined;
  return { username, start: 0, end: new TextEncoder().encode(text).byteLength };
}

export function normalizeHandle(username: string | undefined): string | undefined {
  if (!username) return undefined;
  const stripped = username.trim().replace(/^@+/, "");
  if (!HANDLE.test(stripped) || /^\d+$/.test(stripped)) return undefined;
  return stripped;
}

export function spokenCommand(command: string): string {
  const trimmed = command.trim();
  return trimmed.startsWith("!") ? trimmed : `!${trimmed}`;
}

/**
 * Claim `pending/*.json` into `processing/`, send, then move to `done/` or
 * `failed/`. A file already in `processing/` (a crash mid-send) is tried again.
 * When Chat is not open the file is not sent and lands in `failed/`.
 */
export async function pollReadyNotifications(
  dirs: NotificationDirs,
  transport: NotificationTransport,
  options?: { limit?: number; now?: () => Date },
): Promise<NotificationPollResult> {
  await ensureNotificationDirs(dirs);
  const limit = options?.limit ?? NOTIFICATION_BATCH;
  const now = options?.now ?? (() => new Date());
  const result: NotificationPollResult = { skipped: false, sent: 0, failed: 0 };
  const claimed = await claimBatch(dirs, limit);
  for (const name of claimed) {
    const outcome = await deliverOne(dirs, name, transport, now);
    if (outcome === "sent") result.sent += 1;
    else result.failed += 1;
    if (outcome === "skipped") result.skipped = true;
  }
  return result;
}

export class NotificationPoller {
  private stopped = false;
  private timer: NodeJS.Timeout | undefined;
  private skipLogged = false;

  constructor(
    private readonly dirs: NotificationDirs,
    private readonly transport: NotificationTransport,
    private readonly intervalMs = NOTIFICATION_POLL_INTERVAL_MS,
  ) {}

  start(): void {
    log.info(
      `Polling ready notifications in ${this.dirs.pending} every ${this.intervalMs}ms`,
    );
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  async tick(): Promise<void> {
    if (this.stopped) return;
    try {
      const result = await pollReadyNotifications(this.dirs, this.transport);
      if (result.skipped) {
        if (!this.skipLogged) {
          log.info("Notification queue skipped: Chat is unavailable. Files moved to failed/.");
          this.skipLogged = true;
        }
      } else if (result.sent > 0 || result.failed > 0) {
        this.skipLogged = false;
        log.info(`Ready notifications sent=${result.sent} failed=${result.failed}`);
      }
    } catch (error) {
      log.error("Notification poll failed", error);
    } finally {
      if (!this.stopped) {
        this.timer = setTimeout(() => void this.tick(), this.intervalMs);
      }
    }
  }
}

async function ensureNotificationDirs(dirs: NotificationDirs): Promise<void> {
  await fs.mkdir(dirs.pending, { recursive: true });
  await fs.mkdir(dirs.processing, { recursive: true });
  await fs.mkdir(dirs.done, { recursive: true });
  await fs.mkdir(dirs.failed, { recursive: true });
}

async function claimBatch(dirs: NotificationDirs, limit: number): Promise<string[]> {
  const processing = await listJson(dirs.processing);
  const room = Math.max(0, limit - processing.length);
  const claimed: string[] = [];
  if (room > 0) {
    for (const name of await listJson(dirs.pending)) {
      if (claimed.length >= room) break;
      try {
        await fs.rename(path.join(dirs.pending, name), path.join(dirs.processing, name));
        claimed.push(name);
      } catch {
        // Another poll claimed it, or it is no longer in pending.
      }
    }
  }
  return [...processing, ...claimed].slice(0, limit);
}

type DeliverOutcome = "sent" | "failed" | "skipped";

async function deliverOne(
  dirs: NotificationDirs,
  name: string,
  transport: NotificationTransport,
  now: () => Date,
): Promise<DeliverOutcome> {
  const processingPath = path.join(dirs.processing, name);
  let raw: string;
  try {
    raw = await fs.readFile(processingPath, "utf8");
  } catch (error) {
    await writeFailed(dirs, name, { raw: "" }, clipReason(`Could not read notification file: ${errorText(error)}`), now);
    return "failed";
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    await writeFailed(dirs, name, undefined, "Notification file is not JSON.", now, raw);
    return "failed";
  }

  const notice = parseReadyNotification(parsed);
  if (!notice.ok) {
    await writeFailed(dirs, name, parsed, notice.reason, now, raw);
    return "failed";
  }

  if (!transport.chatAvailable()) {
    await writeFailed(dirs, name, parsed, "Chat is unavailable.", now, raw);
    return "skipped";
  }

  let user: NotificationUser | undefined;
  try {
    user = await transport.getUserById(notice.value.userId);
  } catch (error) {
    await writeFailed(
      dirs,
      name,
      parsed,
      clipReason(`Could not look up that user: ${errorText(error)}`),
      now,
      raw,
    );
    return "failed";
  }

  const username = normalizeHandle(user?.username);
  if (!username) {
    await writeFailed(dirs, name, parsed, "No @handle for that userId.", now, raw);
    return "failed";
  }

  let message: ReadyNotificationMessage;
  try {
    message = formatReadyNotification(username, notice.value);
  } catch (error) {
    await writeFailed(dirs, name, parsed, clipReason(errorText(error)), now, raw);
    return "failed";
  }

  try {
    await transport.sendMessage(notice.value.conversationId, message.text, message.caption);
  } catch (error) {
    await writeFailed(dirs, name, parsed, clipReason(`Send failed: ${errorText(error)}`), now, raw);
    return "failed";
  }

  await fs.rm(path.join(dirs.done, name), { force: true });
  await fs.rename(processingPath, path.join(dirs.done, name));
  return "sent";
}

async function writeFailed(
  dirs: NotificationDirs,
  name: string,
  parsed: unknown,
  reason: string,
  now: () => Date,
  raw?: string,
): Promise<void> {
  const failedAt = now().toISOString();
  const base =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? { ...(parsed as Record<string, unknown>) }
      : { raw: clipRaw(raw ?? "") };
  const record = { ...base, reason, failedAt };
  const finalPath = path.join(dirs.failed, name);
  const tmpPath = path.join(dirs.failed, `.${name}.tmp`);
  await fs.writeFile(tmpPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await fs.rm(finalPath, { force: true });
  await fs.rename(tmpPath, finalPath);
  await fs.rm(path.join(dirs.processing, name), { force: true });
}

async function listJson(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return names.filter(isNotificationFileName).sort();
}

function readRequiredString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function readOptionalString(
  value: unknown,
  field: string,
): { ok: true; value?: string } | { ok: false; reason: string } {
  if (value === undefined || value === null) return { ok: true };
  if (typeof value !== "string") return { ok: false, reason: `${field} must be a string.` };
  const trimmed = value.trim();
  return trimmed ? { ok: true, value: trimmed } : { ok: true };
}

function safeNotificationId(id: string): string {
  const clean = id.replace(/[^A-Za-z0-9._-]/g, "");
  if (!clean || clean === "." || clean === ".." || clean.startsWith(".")) {
    throw new Error("notification file id is empty");
  }
  return clean;
}

function alreadyAddresses(body: string, label: string): boolean {
  if (body === label || body.startsWith(`${label} `) || body.startsWith(`${label}\n`)) return true;
  if (!body.startsWith(label)) return false;
  const next = body[label.length];
  return next !== undefined && !/^[\p{L}\p{N}_]$/u.test(next);
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function clipReason(reason: string): string {
  const trimmed = reason.replace(/\s+/g, " ").trim();
  if (trimmed.length <= REASON_MAX) return trimmed;
  return `${trimmed.slice(0, REASON_MAX - 1)}…`;
}

function clipRaw(raw: string): string {
  if (raw.length <= RAW_MAX) return raw;
  return `${raw.slice(0, RAW_MAX)}…`;
}
