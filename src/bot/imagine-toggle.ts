import fs from "node:fs";
import path from "node:path";
import { log } from "../log.js";

/**
 * Operator switch for `!imagine` and `!video`.
 * The bot rereads `data/imagine-toggle.json` at command time (mtime cache).
 * A missing or invalid file leaves both commands on.
 * `until` in the past turns both back on and is logged once per process.
 */

export const IMAGINE_TOGGLE_FILENAME = "imagine-toggle.json";
export const IMAGINE_OFF_MESSAGE = "Image generation is turned off for now.";
export const VIDEO_OFF_MESSAGE = "Video generation is turned off for now.";
export const IMAGINE_TOGGLE_TIMEZONE = "America/New_York";

const FILE_MODE = 0o600;

export interface StoredImagineToggle {
  image: boolean;
  video: boolean;
  /** ISO instant. Absent means the off switch does not expire. */
  until?: string;
  updatedAt?: string;
}

export interface ImagineToggleState {
  /** Effective. True when generation is allowed. */
  image: boolean;
  video: boolean;
  /** ISO instant still in the future. */
  until?: string;
  /** Set when a stored `until` is already past. Both channels are on. */
  expiredUntil?: string;
  updatedAt?: string;
  source: "file" | "missing" | "invalid" | "expired";
}

interface CacheEntry {
  path: string;
  mtimeMs: number;
  size: number;
  ino: number;
  kind: "invalid" | "stored";
  stored?: StoredImagineToggle;
}

let cache: CacheEntry | undefined;
const loggedExpiry = new Set<string>();
const loggedInvalid = new Set<string>();

/** `data/imagine-toggle.json`, or beside a custom `DATABASE_PATH`. */
export function defaultImagineTogglePath(databasePath?: string): string {
  const dataDir = databasePath ? path.dirname(path.resolve(databasePath)) : path.resolve("data");
  return path.join(dataDir, IMAGINE_TOGGLE_FILENAME);
}

export function resetImagineToggleCacheForTests(): void {
  cache = undefined;
  loggedExpiry.clear();
  loggedInvalid.clear();
}

/**
 * Effective switch. Stats every call and rereads when mtime, size, or inode changes.
 * Does not throw. Missing or invalid means both enabled.
 */
export function readImagineToggle(filePath: string, nowMs = Date.now()): ImagineToggleState {
  const resolved = path.resolve(filePath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      if (cache?.path === resolved) cache = undefined;
      return enabled("missing");
    }
    noteInvalid(resolved, `unreadable:${code ?? "error"}`);
    return enabled("invalid");
  }
  if (!stat.isFile()) {
    noteInvalid(resolved, "not-a-file");
    return enabled("invalid");
  }
  const fresh =
    cache &&
    cache.path === resolved &&
    cache.mtimeMs === stat.mtimeMs &&
    cache.size === stat.size &&
    cache.ino === stat.ino;
  if (!fresh) {
    let raw: string;
    try {
      raw = fs.readFileSync(resolved, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      noteInvalid(resolved, `read:${code ?? "error"}`);
      return enabled("invalid");
    }
    const stored = parseImagineToggleJson(raw);
    cache = stored
      ? {
          path: resolved,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          ino: stat.ino,
          kind: "stored",
          stored,
        }
      : {
          path: resolved,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          ino: stat.ino,
          kind: "invalid",
        };
    if (!stored) noteInvalid(resolved, `${stat.mtimeMs}:${stat.size}`);
  }
  if (!cache || cache.kind === "invalid" || !cache.stored) return enabled("invalid");
  return effectOf(cache.stored, nowMs, resolved);
}

/** Stored flags for the CLI. Missing or invalid starts from both on. */
export function loadImagineToggleForEdit(filePath: string): StoredImagineToggle {
  const resolved = path.resolve(filePath);
  let raw: string;
  try {
    raw = fs.readFileSync(resolved, "utf8");
  } catch {
    return { image: true, video: true };
  }
  return parseImagineToggleJson(raw) ?? { image: true, video: true };
}

export function parseImagineToggleJson(raw: string): StoredImagineToggle | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.image !== "boolean" || typeof record.video !== "boolean") return undefined;
  let until: string | undefined;
  if (record.until !== undefined && record.until !== null) {
    if (typeof record.until !== "string") return undefined;
    if (!Number.isFinite(Date.parse(record.until))) return undefined;
    until = record.until;
  }
  let updatedAt: string | undefined;
  if (record.updatedAt !== undefined && record.updatedAt !== null) {
    if (typeof record.updatedAt !== "string") return undefined;
    updatedAt = record.updatedAt;
  }
  return {
    image: record.image,
    video: record.video,
    ...(until ? { until } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

/**
 * Replace the switch file. Temp file in the same directory, mode 0600, then rename.
 * A failure before rename leaves the destination untouched.
 */
export function writeImagineToggle(filePath: string, stored: StoredImagineToggle): void {
  const resolved = path.resolve(filePath);
  const body = `${JSON.stringify(toggleBody(stored), null, 2)}\n`;
  const dir = path.dirname(resolved);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(resolved)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, FILE_MODE);
    fs.writeFileSync(fd, body);
    fs.fchmodSync(fd, FILE_MODE);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    let existing: fs.Stats | undefined;
    try {
      existing = fs.lstatSync(resolved);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (existing?.isSymbolicLink()) {
      throw new Error(`Refusing to replace a symlink at ${resolved}`);
    }
    fs.renameSync(tmp, resolved);
    fs.chmodSync(resolved, FILE_MODE);
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
  if (cache?.path === resolved) cache = undefined;
}

export function formatImagineToggleStatus(state: ImagineToggleState, filePath?: string): string {
  const lines = [`image: ${state.image ? "on" : "off"}`, `video: ${state.video ? "on" : "off"}`];
  if (state.until) lines.push(`until: ${formatImagineToggleClock(state.until, { seconds: true })}`);
  else if (state.expiredUntil) {
    lines.push(`until: expired ${formatImagineToggleClock(state.expiredUntil, { seconds: true })}`);
  } else lines.push("until: none");
  if (state.updatedAt && Number.isFinite(Date.parse(state.updatedAt))) {
    lines.push(`updated: ${formatImagineToggleClock(state.updatedAt, { seconds: true })}`);
  }
  if (state.source === "missing") lines.push("file: missing (generation stays on)");
  else if (state.source === "invalid") lines.push("file: invalid (generation stays on)");
  else if (filePath) lines.push(`file: ${filePath}`);
  return `${lines.join("\n")}\n`;
}

/** Wall time in America/New_York, labeled ET all year. */
export function formatImagineToggleClock(value: string, options?: { seconds?: boolean }): string {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return value;
  const parts = nyParts(ms);
  const clock = options?.seconds
    ? `${parts.hour}:${parts.minute}:${parts.second}`
    : `${parts.hour}:${parts.minute}`;
  return `${parts.year}-${parts.month}-${parts.day} ${clock} ET`;
}

/** ISO-8601 with the America/New_York offset at that instant. */
export function formatImagineToggleIso(ms: number): string {
  const parts = nyParts(ms);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${nyOffsetLabel(ms)}`;
}

/**
 * Mark `!imagine` / `!video` lines when that command is off.
 * A future `until` is included. Enabled commands stay as written.
 * A help text that dropped the line gains one so the off state is still visible.
 */
export function annotateImagineHelp(help: string, state: Pick<ImagineToggleState, "image" | "video" | "until">): string {
  let text = markHelpLine(help, "imagine", state.image, state.until);
  text = markHelpLine(text, "video", state.video, state.until);
  return text;
}

function markHelpLine(help: string, command: "imagine" | "video", enabled: boolean, until?: string): string {
  if (enabled) return help;
  const suffix = until ? `(off until ${formatImagineToggleClock(until)})` : "(off)";
  const pattern = new RegExp(`^([ \\t]*!${command}\\b[^\\n]*)$`, "m");
  if (pattern.test(help)) return help.replace(pattern, `$1 ${suffix}`);
  const extra = `!${command} ${suffix}`;
  if (!help.trim()) return extra;
  return help.endsWith("\n") ? `${help}${extra}` : `${help}\n${extra}`;
}

function effectOf(stored: StoredImagineToggle, nowMs: number, filePath: string): ImagineToggleState {
  if (stored.until) {
    const untilMs = Date.parse(stored.until);
    if (Number.isFinite(untilMs) && untilMs <= nowMs) {
      if (!stored.image || !stored.video) noteExpiry(filePath, stored.until);
      return {
        image: true,
        video: true,
        expiredUntil: stored.until,
        ...(stored.updatedAt ? { updatedAt: stored.updatedAt } : {}),
        source: "expired",
      };
    }
  }
  return {
    image: stored.image,
    video: stored.video,
    ...(stored.until ? { until: stored.until } : {}),
    ...(stored.updatedAt ? { updatedAt: stored.updatedAt } : {}),
    source: "file",
  };
}

function enabled(source: "missing" | "invalid"): ImagineToggleState {
  return { image: true, video: true, source };
}

function noteExpiry(filePath: string, until: string): void {
  const key = `${filePath}\0${until}`;
  if (loggedExpiry.has(key)) return;
  loggedExpiry.add(key);
  log.info(`Imagine image and video generation are back on (until ${until} has passed).`);
}

function noteInvalid(filePath: string, token: string): void {
  const key = `${filePath}\0${token}`;
  if (loggedInvalid.has(key)) return;
  loggedInvalid.add(key);
  log.warn(`Imagine toggle file is invalid (${filePath}). Image and video generation stay on.`);
}

function toggleBody(stored: StoredImagineToggle): StoredImagineToggle {
  return {
    image: stored.image,
    video: stored.video,
    ...(stored.until ? { until: stored.until } : {}),
    ...(stored.updatedAt ? { updatedAt: stored.updatedAt } : {}),
  };
}

interface NyParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
}

function nyParts(ms: number): NyParts {
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone: IMAGINE_TOGGLE_TIMEZONE,
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

function nyOffsetLabel(ms: number): string {
  const minutes = Math.round(nyOffsetMs(ms) / 60_000);
  const sign = minutes >= 0 ? "+" : "-";
  const abs = Math.abs(minutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}
