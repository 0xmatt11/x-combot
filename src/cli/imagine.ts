import {
  defaultImagineTogglePath,
  formatImagineToggleIso,
  formatImagineToggleStatus,
  loadImagineToggleForEdit,
  readImagineToggle,
  writeImagineToggle,
  type StoredImagineToggle,
} from "../bot/imagine-toggle.js";

/**
 * Operator CLI for the Imagine on/off file. Not a chat command.
 *
 *   npm run imagine -- status
 *   npm run imagine -- on|off [image|video|all] [--for 7d|--until <date>]
 */

export class ImagineCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImagineCliError";
  }
}

export type ImagineCliAction = "status" | "on" | "off";
export type ImagineCliTarget = "image" | "video" | "all";

export interface ImagineCliRequest {
  help: boolean;
  action?: ImagineCliAction;
  target: ImagineCliTarget;
  /** Set only for `off --for` / `off --until`. ISO with a New York offset. */
  until?: string;
}

export interface ImagineCliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export const IMAGINE_CLI_USAGE = `Turn !imagine and !video on or off without restarting the bot.
The file is data/imagine-toggle.json (mode 0600), next to the database.
A missing or invalid file leaves both commands on. The bot rereads it
when someone uses !imagine, !video, !help, or !status.

Usage:
  npm run imagine -- status
  npm run imagine -- on [image|video|all]
  npm run imagine -- off [image|video|all] [--for 7d|--until <date>]

status prints image, video, and expiry in America/New_York.
The target defaults to all. on clears until. off --for 7d sets until to
now plus 7 days (also 30m, 12h, 2w). --until accepts an ISO time with a
zone, or a New York wall time (2026-10-19 or 2026-10-19 10:00).
`;

const DAY_MS = 86_400_000;

export function executeImagineCli(
  argv: string[],
  options: { filePath?: string; nowMs?: number; databasePath?: string } = {},
): ImagineCliResult {
  const nowMs = options.nowMs ?? Date.now();
  const filePath =
    options.filePath ?? defaultImagineTogglePath(options.databasePath ?? process.env.DATABASE_PATH);
  try {
    const request = parseImagineCliArgs(argv, nowMs);
    if (request.help) return { exitCode: 0, stdout: IMAGINE_CLI_USAGE, stderr: "" };
    if (!request.action) return fail(IMAGINE_CLI_USAGE.trim());
    if (request.action === "status") {
      const state = readImagineToggle(filePath, nowMs);
      return { exitCode: 0, stdout: formatImagineToggleStatus(state, filePath), stderr: "" };
    }
    const current = loadImagineToggleForEdit(filePath);
    const next = applyImagineCli(current, request, nowMs);
    writeImagineToggle(filePath, next);
    const state = readImagineToggle(filePath, nowMs);
    return { exitCode: 0, stdout: formatImagineToggleStatus(state, filePath), stderr: "" };
  } catch (error) {
    if (error instanceof ImagineCliError) return fail(error.message);
    return fail(error instanceof Error ? error.message : String(error));
  }
}

export function parseImagineCliArgs(argv: string[], nowMs: number): ImagineCliRequest {
  let action: ImagineCliAction | undefined;
  let target: ImagineCliTarget | undefined;
  let help = false;
  let forValue: string | undefined;
  let untilValue: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--for" || arg.startsWith("--for=")) {
      const taken = takeValue(argv, index, arg, "--for");
      if (forValue !== undefined) throw new ImagineCliError("--for was given twice");
      forValue = taken.value;
      index = taken.next;
      continue;
    }
    if (arg === "--until" || arg.startsWith("--until=")) {
      const taken = takeValue(argv, index, arg, "--until");
      if (untilValue !== undefined) throw new ImagineCliError("--until was given twice");
      untilValue = taken.value;
      index = taken.next;
      continue;
    }
    if (arg.startsWith("-")) throw new ImagineCliError(`Unknown argument ${arg}`);
    if (!action) {
      if (arg === "status" || arg === "on" || arg === "off") {
        action = arg;
        continue;
      }
      throw new ImagineCliError(`Unknown command ${arg}. Use status, on, or off.`);
    }
    if (!target) {
      if (arg === "image" || arg === "video" || arg === "all") {
        target = arg;
        continue;
      }
      throw new ImagineCliError(`Unknown target ${arg}. Use image, video, or all.`);
    }
    throw new ImagineCliError(`Unexpected argument ${arg}`);
  }

  if (help) return { help: true, target: target ?? "all" };
  if (!action) throw new ImagineCliError(IMAGINE_CLI_USAGE.trim());
  if (forValue !== undefined && untilValue !== undefined) {
    throw new ImagineCliError("Use either --for or --until, not both");
  }
  if ((forValue !== undefined || untilValue !== undefined) && action !== "off") {
    throw new ImagineCliError("--for and --until are only used with off");
  }

  let until: string | undefined;
  if (forValue !== undefined) {
    until = formatImagineToggleIso(nowMs + parseImagineDuration(forValue));
  } else if (untilValue !== undefined) {
    const untilMs = parseImagineUntil(untilValue);
    if (untilMs <= nowMs) throw new ImagineCliError("--until is already past");
    until = formatImagineToggleIso(untilMs);
  }

  return { help: false, action, target: target ?? "all", ...(until ? { until } : {}) };
}

export function applyImagineCli(
  current: StoredImagineToggle,
  request: ImagineCliRequest,
  nowMs: number,
): StoredImagineToggle {
  if (request.action !== "on" && request.action !== "off") {
    throw new ImagineCliError("status does not change the file");
  }
  const touchImage = request.target === "all" || request.target === "image";
  const touchVideo = request.target === "all" || request.target === "video";
  const next: StoredImagineToggle = {
    image: current.image,
    video: current.video,
    updatedAt: new Date(nowMs).toISOString(),
  };
  if (request.action === "on") {
    if (touchImage) next.image = true;
    if (touchVideo) next.video = true;
    return next;
  }
  if (touchImage) next.image = false;
  if (touchVideo) next.video = false;
  if (request.until) next.until = request.until;
  return next;
}

export function parseImagineDuration(value: string): number {
  const match = /^(\d+)([mhdw])$/i.exec(value.trim());
  if (!match) throw new ImagineCliError("--for needs a duration like 7d (m, h, d, or w)");
  const count = Number(match[1]);
  const unit = match[2]?.toLowerCase();
  if (!Number.isInteger(count) || count < 1 || !unit) {
    throw new ImagineCliError("--for needs a duration like 7d (m, h, d, or w)");
  }
  const mult = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : unit === "d" ? DAY_MS : 7 * DAY_MS;
  const delta = count * mult;
  if (!Number.isSafeInteger(delta)) throw new ImagineCliError("--for is too large");
  return delta;
}

/** ISO with a zone, a calendar date, or a New York wall time. */
export function parseImagineUntil(value: string): number {
  const trimmed = value.trim();
  if (!trimmed) throw new ImagineCliError("--until needs a date");
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (dateOnly) {
    return wallClockToUtc(Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3]), 0, 0, 0);
  }
  if (hasExplicitZone(trimmed)) {
    const parsed = Date.parse(trimmed);
    if (!Number.isFinite(parsed)) throw new ImagineCliError(`Invalid time ${trimmed}`);
    return parsed;
  }
  const local = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec(trimmed);
  if (local) {
    return wallClockToUtc(
      Number(local[1]),
      Number(local[2]),
      Number(local[3]),
      Number(local[4]),
      Number(local[5]),
      Number(local[6] ?? "0"),
    );
  }
  throw new ImagineCliError(
    `Invalid time ${trimmed}. Use an ISO time with a zone, or a New York time like 2026-10-19 10:00.`,
  );
}

function fail(message: string): ImagineCliResult {
  const text = message.endsWith("\n") ? message : `${message}\n`;
  return { exitCode: 1, stdout: "", stderr: text };
}

function takeValue(
  argv: string[],
  index: number,
  arg: string,
  flag: string,
): { value: string; next: number } {
  const eq = arg.indexOf("=");
  if (eq !== -1) {
    const value = arg.slice(eq + 1);
    if (!value) throw new ImagineCliError(`${flag} needs a value`);
    return { value, next: index };
  }
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new ImagineCliError(`${flag} needs a value`);
  return { value, next: index + 1 };
}

function hasExplicitZone(value: string): boolean {
  return /[zZ]$/.test(value) || /[+-]\d{2}:?\d{2}$/.test(value);
}

function wallClockToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): number {
  if (
    !Number.isInteger(year) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    throw new ImagineCliError("Invalid time");
  }
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  const first = wall - nyOffsetMs(wall);
  const instant = wall - nyOffsetMs(first);
  const parts = nyParts(instant);
  const got = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
  const want = `${pad4(year)}-${pad2(month)}-${pad2(day)} ${pad2(hour)}:${pad2(minute)}:${pad2(second)}`;
  if (got !== want) throw new ImagineCliError(`Invalid time ${want.slice(0, 10)}`);
  return instant;
}

function nyOffsetMs(utcMs: number): number {
  const parts = nyParts(utcMs);
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

function nyParts(ms: number): {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
} {
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
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

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function pad4(value: number): string {
  return String(value).padStart(4, "0");
}
