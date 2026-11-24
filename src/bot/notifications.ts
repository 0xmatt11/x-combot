import fs from "node:fs/promises";
import path from "node:path";
import { isChatGroupId } from "../chat/ids.js";
import { log } from "../log.js";
import type { MediaCaption } from "../types.js";
import { parseCommand } from "./parser.js";

/** How often the live process checks `pending/`. */
export const NOTIFICATION_POLL_INTERVAL_MS = 5_000;

/** Files claimed per tick, so a backlog cannot stall the process. */
export const NOTIFICATION_BATCH = 20;

const TEXT_MAX = 500;
const RAW_MAX = 2_000;
const REASON_MAX = 300;
const CONVERSATION_LIST_MAX = 100;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/;
const COMMAND_NAME = /^!?[A-Za-z][A-Za-z0-9_]{0,31}$/;
const USER_ID = /^\d{1,25}$/;
const HANDLE = /^[A-Za-z0-9_]{1,15}$/;

/** A conversation send returned this when the bot is no longer in the group. */
export const NOT_IN_GROUP_REASON = "Bot is not in that group (404).";

export const NOT_AUTHORIZED_REASON = "Conversation is not authorized.";

/**
 * Commands a queue file may execute. Owner and admin commands (`!auth`,
 * `!purge`, `!warn`, `!kick`, `!mute`, `!admin`, `!set`, and the rest of
 * that set) are not included, so a file cannot run them even when `userId`
 * is the owner. Add a name here to allow it.
 */
export const QUEUE_RUN_COMMANDS: ReadonlySet<string> = new Set(["milady"]);

/**
 * JSON Chief of Staff writes into `pending/`.
 * `text`, when set, is the body after the @handle and replaces the default line.
 * `command` is the bang that shipped, used when `text` is omitted.
 * One of `text` or `command` is required, unless `run` is set: then `command`
 * is the line to execute (`!milady`, `!milady 3`).
 * `conversationId` may be `"all"`. `conversationIds` fans out to those groups.
 * Extra fields are ignored on read.
 */
export interface ReadyNotification {
  /** Encrypted group id, or `"all"` for every authorized group. */
  conversationId?: string;
  /** Explicit groups. Not combined with `conversationId`. */
  conversationIds?: string[];
  userId: string;
  command?: string;
  text?: string;
  /** Execute `command` through the chat engine instead of posting a mention. */
  run?: boolean;
  /** Used when X has no @handle for `userId`. */
  handle?: string;
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
export interface NotificationRunRequest {
  conversationId: string;
  userId: string;
  handle: string;
  /** Full command line, such as `!milady` or `!milady 3`. */
  command: string;
  /** Synthetic inbound id. Not a real Chat message. */
  messageId: string;
}

export interface NotificationRunResult {
  messageIds: string[];
}

export interface NotificationTargetResult {
  conversationId: string;
  status: "sent" | "failed" | "skipped";
  messageIds?: string[];
  reason?: string;
}

export interface NotificationTransport {
  chatAvailable(): boolean;
  getUserById(userId: string): Promise<NotificationUser | undefined>;
  sendMessage(
    conversationId: string,
    text: string,
    caption?: MediaCaption,
  ): Promise<unknown>;
  /** Newest `sender_label` for this user in `chat_history_messages`. */
  lookupSenderLabel?(userId: string): string | undefined;
  /** True when `conversationId` is in `chat_authorizations`. */
  isAuthorized?(conversationId: string): boolean;
  /** Every authorized group, used when `conversationId` is `"all"`. */
  listAuthorized?(): readonly string[];
  /**
   * Dispatch `command` through the same engine path as an inbound chat message.
   * Absent means a `run` file fails closed.
   */
  runCommand?(request: NotificationRunRequest): Promise<NotificationRunResult>;
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
  const audience = readAudience(record);
  if (!audience.ok) return audience;
  const userId = readRequiredString(record.userId);
  if (!userId) return { ok: false, reason: "userId is required." };
  if (!USER_ID.test(userId)) {
    return { ok: false, reason: "userId must be a numeric X user id." };
  }
  const runFlag = readOptionalBoolean(record.run, "run");
  if (!runFlag.ok) return runFlag;
  const mode = readOptionalString(record.mode, "mode");
  if (!mode.ok) return mode;
  if (mode.value !== undefined && mode.value !== "run") {
    return { ok: false, reason: 'mode must be "run".' };
  }
  if (runFlag.value === false && mode.value === "run") {
    return { ok: false, reason: "run and mode disagree." };
  }
  const wantsRun = runFlag.value === true || mode.value === "run";
  const command = readOptionalString(record.command, "command");
  if (!command.ok) return command;
  const text = readOptionalString(record.text, "text");
  if (!text.ok) return text;
  if (text.value !== undefined && text.value.length > TEXT_MAX) {
    return { ok: false, reason: "text is too long." };
  }
  const handle = readOptionalString(record.handle, "handle");
  if (!handle.ok) return handle;
  const normalizedHandle = handle.value ? normalizeHandle(handle.value) : undefined;
  if (handle.value !== undefined && !normalizedHandle) {
    return { ok: false, reason: "handle must be an @handle." };
  }
  if (wantsRun) {
    if (!command.value) return { ok: false, reason: "A queue run needs command." };
    if (command.value.length > TEXT_MAX) return { ok: false, reason: "command is too long." };
    if (!/^[!/]/.test(command.value)) {
      return { ok: false, reason: "command must be a bang such as !milady." };
    }
  } else if (command.value !== undefined && !COMMAND_NAME.test(command.value)) {
    return { ok: false, reason: "command must be a bang name such as !undertow." };
  } else if (!command.value && !text.value) {
    return { ok: false, reason: "Notification needs text or command." };
  }
  return {
    ok: true,
    value: {
      ...audience.value,
      userId,
      ...(command.value ? { command: command.value } : {}),
      ...(text.value ? { text: text.value } : {}),
      ...(wantsRun ? { run: true } : {}),
      ...(normalizedHandle ? { handle: normalizedHandle } : {}),
    },
  };
}

/**
 * Why this command line cannot be queue-run.
 * Undefined means `parseCommand` accepts it and the name is allowlisted.
 */
export function queueRunBlockReason(command: string): string | undefined {
  const parsed = parseCommand(command);
  if (parsed && QUEUE_RUN_COMMANDS.has(parsed.name)) return undefined;
  const head = command.trim().split(/\s+/)[0] ?? command;
  return `${spokenCommand(head)} cannot be run from the notification queue.`;
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

  if (notice.value.run) {
    if (!transport.runCommand) {
      await writeFailed(dirs, name, parsed, "Queue run is unavailable.", now, raw);
      return "failed";
    }
    const blocked = queueRunBlockReason(notice.value.command ?? "");
    if (blocked) {
      await writeFailed(dirs, name, parsed, blocked, now, raw);
      log.warn(`Notification blocked file=${name} reason=${blocked}`);
      return "failed";
    }
  }

  const targets = resolveTargets(notice.value, transport);
  if (!targets.ok) {
    await writeFailed(dirs, name, parsed, targets.reason, now, raw);
    log.warn(`Notification blocked file=${name} reason=${targets.reason}`);
    return "failed";
  }

  const handle = await resolveHandle(notice.value, transport);
  if (!handle.ok) {
    await writeFailed(dirs, name, parsed, handle.reason, now, raw);
    return "failed";
  }

  const results: NotificationTargetResult[] = [];
  for (let index = 0; index < targets.ids.length; index += 1) {
    const conversationId = targets.ids[index]!;
    results.push(
      await deliverTarget(transport, notice.value, {
        name,
        conversationId,
        handle: handle.handle,
        fanout: targets.fanout,
        index,
      }),
    );
  }
  logOutcomes(name, notice.value, results);

  if (results.some((row) => row.status === "sent")) {
    if (!notice.value.run && !targets.fanout) {
      await fs.rm(path.join(dirs.done, name), { force: true });
      await fs.rename(processingPath, path.join(dirs.done, name));
    } else {
      await writeDone(dirs, name, parsed, results, now);
    }
    return "sent";
  }

  await writeFailed(
    dirs,
    name,
    parsed,
    failureReason(results),
    now,
    raw,
    notice.value.run || targets.fanout ? results : undefined,
  );
  return "failed";
}

async function deliverTarget(
  transport: NotificationTransport,
  notice: ReadyNotification,
  target: {
    name: string;
    conversationId: string;
    handle: string;
    fanout: boolean;
    index: number;
  },
): Promise<NotificationTargetResult> {
  const { conversationId } = target;
  if (transport.isAuthorized && !transport.isAuthorized(conversationId)) {
    return { conversationId, status: "failed", reason: NOT_AUTHORIZED_REASON };
  }

  try {
    if (notice.run) {
      const ran = await transport.runCommand!({
        conversationId,
        userId: notice.userId,
        handle: target.handle,
        command: notice.command ?? "",
        messageId: queueMessageId(target.name, conversationId, target.index),
      });
      const messageIds = (ran.messageIds ?? []).map((id) => id.trim()).filter(Boolean);
      return {
        conversationId,
        status: "sent",
        ...(messageIds.length > 0 ? { messageIds } : {}),
      };
    }

    const message = formatReadyNotification(target.handle, notice);
    const sent = await transport.sendMessage(conversationId, message.text, message.caption);
    const messageId = messageIdOf(sent);
    return {
      conversationId,
      status: "sent",
      ...(messageId ? { messageIds: [messageId] } : {}),
    };
  } catch (error) {
    if (isMissingGroup(error)) {
      return {
        conversationId,
        status: target.fanout ? "skipped" : "failed",
        reason: NOT_IN_GROUP_REASON,
      };
    }
    const verb = notice.run ? "Command" : "Send";
    return {
      conversationId,
      status: "failed",
      reason: clipReason(`${verb} failed: ${errorText(error)}`),
    };
  }
}

/**
 * `getUserById`, then the file's `handle`, then the newest stored
 * `sender_label`. A lookup that throws still fails the file.
 */
async function resolveHandle(
  notice: ReadyNotification,
  transport: NotificationTransport,
): Promise<{ ok: true; handle: string } | { ok: false; reason: string }> {
  let user: NotificationUser | undefined;
  try {
    user = await transport.getUserById(notice.userId);
  } catch (error) {
    return { ok: false, reason: clipReason(`Could not look up that user: ${errorText(error)}`) };
  }
  const fromApi = normalizeHandle(user?.username);
  if (fromApi) return { ok: true, handle: fromApi };
  const fromJob = normalizeHandle(notice.handle);
  if (fromJob) return { ok: true, handle: fromJob };
  let stored: string | undefined;
  try {
    stored = transport.lookupSenderLabel?.(notice.userId);
  } catch (error) {
    return {
      ok: false,
      reason: clipReason(`Could not read that user's handle from history: ${errorText(error)}`),
    };
  }
  const fromHistory = normalizeHandle(stored);
  if (fromHistory) return { ok: true, handle: fromHistory };
  return { ok: false, reason: "No @handle for that userId." };
}

function resolveTargets(
  notice: ReadyNotification,
  transport: NotificationTransport,
): { ok: true; ids: string[]; fanout: boolean } | { ok: false; reason: string } {
  if (notice.conversationId === "all") {
    if (!transport.listAuthorized) {
      return { ok: false, reason: 'conversationId "all" needs the authorization list.' };
    }
    let listed: readonly string[];
    try {
      listed = transport.listAuthorized();
    } catch (error) {
      return { ok: false, reason: clipReason(`Could not list authorized groups: ${errorText(error)}`) };
    }
    const ids = uniqueGroupIds(listed).sort();
    if (ids.length === 0) return { ok: false, reason: "No authorized groups." };
    return { ok: true, ids, fanout: true };
  }
  if (notice.conversationIds && notice.conversationIds.length > 0) {
    return { ok: true, ids: notice.conversationIds, fanout: true };
  }
  if (notice.conversationId && isChatGroupId(notice.conversationId)) {
    return { ok: true, ids: [notice.conversationId], fanout: false };
  }
  return { ok: false, reason: "conversationId is required." };
}

function logOutcomes(name: string, notice: ReadyNotification, results: NotificationTargetResult[]): void {
  const sent = results.filter((row) => row.status === "sent").length;
  const failed = results.filter((row) => row.status === "failed").length;
  const skipped = results.filter((row) => row.status === "skipped").length;
  const mode = notice.run ? "run" : "post";
  log.info(`Notification file=${name} mode=${mode} sent=${sent} failed=${failed} skipped=${skipped}`);
  for (const row of results) {
    if (row.status === "sent") {
      const ids = row.messageIds?.join(",") || "none";
      log.info(`Notification sent file=${name} conversation=${row.conversationId} messages=${ids}`);
      continue;
    }
    const level = row.status === "failed" ? "warn" : "info";
    log[level](
      `Notification ${row.status} file=${name} conversation=${row.conversationId} reason=${row.reason ?? ""}`,
    );
  }
}

function failureReason(results: NotificationTargetResult[]): string {
  if (results.length === 1) return results[0]?.reason ?? "Notification failed.";
  const failed = results.filter((row) => row.status === "failed");
  if (failed.length === 0) return "Bot is not in those groups (404).";
  const first = failed[0]?.reason;
  if (failed.length === results.length && failed.every((row) => row.reason === first) && first) return first;
  const skipped = results.length - failed.length;
  return `No group was posted. ${failed.length} failed, ${skipped} skipped.`;
}

async function writeDone(
  dirs: NotificationDirs,
  name: string,
  parsed: unknown,
  results: NotificationTargetResult[],
  now: () => Date,
): Promise<void> {
  const base =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? { ...(parsed as Record<string, unknown>) }
      : {};
  const record = { ...base, results, completedAt: now().toISOString() };
  const finalPath = path.join(dirs.done, name);
  const tmpPath = path.join(dirs.done, `.${name}.tmp`);
  await fs.writeFile(tmpPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await fs.rm(finalPath, { force: true });
  await fs.rename(tmpPath, finalPath);
  await fs.rm(path.join(dirs.processing, name), { force: true });
}

async function writeFailed(
  dirs: NotificationDirs,
  name: string,
  parsed: unknown,
  reason: string,
  now: () => Date,
  raw?: string,
  results?: NotificationTargetResult[],
): Promise<void> {
  const failedAt = now().toISOString();
  const base =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? { ...(parsed as Record<string, unknown>) }
      : { raw: clipRaw(raw ?? "") };
  const record = {
    ...base,
    reason,
    failedAt,
    ...(results && results.length > 0 ? { results } : {}),
  };
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

function readAudience(
  record: Record<string, unknown>,
): { ok: true; value: Pick<ReadyNotification, "conversationId" | "conversationIds"> } | { ok: false; reason: string } {
  const idField = readOptionalString(record.conversationId, "conversationId");
  if (!idField.ok) return idField;
  const listField = readConversationIds(record.conversationIds);
  if (!listField.ok) return listField;
  const id = idField.value;
  const list = listField.value;
  if (id === "all") {
    if (list) return { ok: false, reason: 'Use conversationId "all" or conversationIds, not both.' };
    return { ok: true, value: { conversationId: "all" } };
  }
  if (list) {
    if (id) return { ok: false, reason: 'Use conversationId "all" or conversationIds, not both.' };
    return { ok: true, value: { conversationIds: list } };
  }
  if (!id) return { ok: false, reason: "conversationId is required." };
  if (!isChatGroupId(id)) {
    return { ok: false, reason: "conversationId must be an encrypted Chat group id." };
  }
  return { ok: true, value: { conversationId: id } };
}

function readConversationIds(
  value: unknown,
): { ok: true; value?: string[] } | { ok: false; reason: string } {
  if (value === undefined || value === null) return { ok: true };
  if (!Array.isArray(value)) return { ok: false, reason: "conversationIds must be an array of group ids." };
  if (value.length === 0) return { ok: false, reason: "conversationIds must list at least one group." };
  if (value.length > CONVERSATION_LIST_MAX) {
    return { ok: false, reason: "conversationIds lists too many groups." };
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") {
      return { ok: false, reason: "conversationIds must be an array of group ids." };
    }
    const trimmed = entry.trim();
    if (!isChatGroupId(trimmed)) {
      return { ok: false, reason: "conversationIds must be encrypted Chat group ids." };
    }
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    ids.push(trimmed);
  }
  if (ids.length === 0) return { ok: false, reason: "conversationIds must list at least one group." };
  return { ok: true, value: ids };
}

function readOptionalBoolean(
  value: unknown,
  field: string,
): { ok: true; value?: boolean } | { ok: false; reason: string } {
  if (value === undefined || value === null) return { ok: true };
  if (typeof value !== "boolean") return { ok: false, reason: `${field} must be a boolean.` };
  return { ok: true, value };
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

function uniqueGroupIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed) || !isChatGroupId(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function queueMessageId(fileName: string, conversationId: string, index: number): string {
  const nonce = Math.random().toString(36).slice(2, 10);
  const stem = fileName.replace(/\.json$/i, "").replace(/[^A-Za-z0-9._-]/g, "");
  return `queue-${stem || "job"}-${index}-${nonce}-${conversationId}`;
}

function messageIdOf(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const id = (result as { dmEventId?: unknown }).dmEventId;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

function isMissingGroup(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const status = (error as { status?: unknown }).status;
  return status === 404 || status === 410;
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
