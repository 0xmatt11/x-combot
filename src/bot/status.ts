import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatPublicKeyFetchedAt } from "../chat/remote-key-cache.js";
import {
  imaginePublicPoolFor,
  imaginePublicUrlsFor,
  type ImaginePublicUrls,
} from "./imagine-public.js";

/**
 * Last-known `GET /2/users/…/public_keys` cache. Filled from memory.
 * `!status` must not call the API to build this.
 */
export interface StatusKeyHealth {
  /** Users whose public-key list is cached. */
  cachedUsers: number;
  /** Signing keys held for decrypt. */
  signingKeys: number;
  /** Conversation keys recovered by decrypt. */
  conversationKeys: number;
  /** Milliseconds left on a 429/402 backoff. 0 when fetches are allowed. */
  backoffMs: number;
  /**
   * Epoch ms of the last successful public_keys GET.
   * After a restart this is the newest `fetched_at` loaded from disk.
   * Absent when this process has not seen a success and the cache had none.
   */
  lastSuccessAtMs?: number;
  /** Successful public_keys GETs since process start. Cache hits are not included. */
  fetchesOk?: number;
  /** Failed public_keys GETs since process start. A backoff skip is not a fetch. */
  fetchesFailed?: number;
}

export type PipelinePhase = "off" | "starting" | "ok" | "degraded";

export interface PipelineNote {
  phase: PipelinePhase;
  detail?: string;
}

export interface PipelineView {
  chat: PipelineNote;
  activity: PipelineNote;
}

/**
 * In-process notes for the Chat poller and Activity push.
 * Callers record outcomes they already have. Nothing here hits the network.
 */
export class RuntimeHealth {
  readonly startedAtMs = Date.now();
  private chat: PipelineNote = { phase: "off" };
  private activityEnabled = false;
  private stream: PipelineNote = { phase: "off" };
  private webhook: PipelineNote = { phase: "off" };

  /** Chat poller is running but has not finished a tick yet. */
  markChatRunning(): void {
    if (this.chat.phase === "off") this.chat = { phase: "starting" };
  }

  noteChat(state: "ok" | "degraded", detail?: string): void {
    this.chat = { phase: state, detail: cleanDetail(detail) };
  }

  markActivityEnabled(): void {
    this.activityEnabled = true;
  }

  noteActivityStream(state: "ok" | "degraded", detail?: string): void {
    this.activityEnabled = true;
    this.stream = { phase: state, detail: cleanDetail(detail) };
  }

  noteActivityWebhook(state: "ok" | "degraded", detail?: string): void {
    this.activityEnabled = true;
    this.webhook = { phase: state, detail: cleanDetail(detail) };
  }

  view(): PipelineView {
    return { chat: { ...this.chat }, activity: this.activityView() };
  }

  private activityView(): PipelineNote {
    if (!this.activityEnabled) return { phase: "off" };
    const parts: string[] = [];
    let degraded = false;
    let anyOk = false;
    if (this.stream.phase === "ok") {
      anyOk = true;
      parts.push(this.stream.detail ?? "stream");
    } else if (this.stream.phase === "degraded") {
      degraded = true;
      parts.push(joinDetail("stream", this.stream.detail));
    }
    if (this.webhook.phase === "ok") {
      anyOk = true;
      parts.push(this.webhook.detail ?? "webhook");
    } else if (this.webhook.phase === "degraded") {
      degraded = true;
      parts.push(joinDetail("webhook", this.webhook.detail));
    }
    if (degraded) return { phase: "degraded", detail: parts.join(", ") };
    if (anyOk) return { phase: "ok", detail: parts.join(", ") };
    return { phase: "starting" };
  }
}

export interface StatusSnapshot {
  username?: string;
  userId?: string;
  startedAtMs: number;
  nowMs: number;
  /** Absent when this process is not tracking the poller. */
  pipeline?: PipelineView;
  /** Absent when Chat is not loaded. */
  keys?: StatusKeyHealth;
  /** `off`, or a provider and model with no secrets. */
  llm: string;
  /** `off`, `browser`, `api`, `api, video`, or `api off`. */
  imagine: string;
  welcome: boolean;
  /** `off`, `all`, or a comma-separated list of `@handle` and `on` (no printable handle). */
  troll: string;
  linkroast: boolean;
  media?: { chest: number; booty: number; videos: number };
  version?: string;
  sha?: string;
}

/** Counts already parsed into memory. Undefined when no bank is configured. */
export function statusMediaCounts(
  source: ImaginePublicUrls | undefined,
): { chest: number; booty: number; videos: number } | undefined {
  if (!source) return undefined;
  const chest = imaginePublicUrlsFor(source, "boobs").length;
  const booty = imaginePublicUrlsFor(source, "ass").length;
  let videos = 0;
  for (const command of ["boobs", "ass", "booty"] as const) {
    for (const item of imaginePublicPoolFor(source, command)) {
      if (item.kind === "video") videos += 1;
    }
  }
  if (chest + booty + videos === 0) return undefined;
  return { chest, booty, videos };
}

/**
 * Short chat reply. One field per line. Callers pass only in-process facts.
 */
export function formatStatusReport(snapshot: StatusSnapshot): string {
  const lines = [
    botLine(snapshot),
    `Up: ${formatUptime(snapshot.nowMs - snapshot.startedAtMs)}`,
    pipelineLine("Chat", snapshot.pipeline?.chat),
    pipelineLine("Activity", snapshot.pipeline?.activity),
    keysLine(snapshot.keys),
    `LLM: ${labelOrOff(snapshot.llm)}`,
    `Imagine: ${labelOrOff(snapshot.imagine)}`,
    togglesLine(snapshot),
  ];
  if (snapshot.media) {
    lines.push(
      `Media: chest ${snapshot.media.chest} · booty ${snapshot.media.booty} · video ${snapshot.media.videos}`,
    );
  }
  const version = versionLine(snapshot);
  if (version) lines.push(version);
  return lines.join("\n");
}

export interface BuildVersion {
  version?: string;
  sha?: string;
}

let cachedVersion: BuildVersion | undefined;

/** Package version and a short git sha. Missing files are omitted, not fatal. */
export function readBuildVersion(): BuildVersion {
  if (cachedVersion) return cachedVersion;
  cachedVersion = loadBuildVersion();
  return cachedVersion;
}

function loadBuildVersion(): BuildVersion {
  try {
    const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
    const raw = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      version?: unknown;
    };
    const version = typeof raw.version === "string" ? raw.version : undefined;
    return { version, sha: readGitShortSha(root) };
  } catch {
    return {};
  }
}

function readGitShortSha(root: string): string | undefined {
  try {
    const gitDir = join(root, ".git");
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    const sha = head.startsWith("ref: ")
      ? readFileSync(join(gitDir, head.slice(5).trim()), "utf8").trim()
      : head;
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) return undefined;
    return sha.slice(0, 7);
  } catch {
    return undefined;
  }
}

function botLine(snapshot: StatusSnapshot): string {
  const name = snapshot.username?.replace(/^@/, "").trim();
  if (name && /^[A-Za-z0-9_]{1,15}$/.test(name)) return `Bot: @${name}`;
  if (snapshot.userId && /^[0-9]{1,20}$/.test(snapshot.userId)) return `Bot: ${snapshot.userId}`;
  return "Bot: unknown";
}

function pipelineLine(label: string, note: PipelineNote | undefined): string {
  if (!note) return `${label}: n/a`;
  if (note.phase === "off") return `${label}: off`;
  if (note.phase === "starting") return `${label}: starting`;
  if (note.phase === "ok") return note.detail ? `${label}: ok (${note.detail})` : `${label}: ok`;
  return note.detail ? `${label}: degraded (${note.detail})` : `${label}: degraded`;
}

function keysLine(keys: StatusKeyHealth | undefined): string {
  if (!keys) return "Keys: n/a (Chat not loaded)";
  const counts = `${countLabel(keys.cachedUsers, "user", "users")} cached, ${countLabel(keys.signingKeys, "signing key", "signing keys")}, ${countLabel(keys.conversationKeys, "chat key", "chat keys")}`;
  if (keys.backoffMs > 0) {
    const sec = Math.max(1, Math.ceil(keys.backoffMs / 1000));
    return withPublicKeyFetchNote(
      `Keys: BACKOFF ${sec}s — GET /2/users/…/public_keys rate-limited. ${counts}. Decrypt stalls until this clears.`,
      keys,
    );
  }
  if (keys.signingKeys === 0) return withPublicKeyFetchNote(`Keys: no signing keys cached (${counts})`, keys);
  return withPublicKeyFetchNote(`Keys: ok — ${counts}`, keys);
}

function withPublicKeyFetchNote(sentence: string, keys: StatusKeyHealth): string {
  const note = publicKeyFetchNote(keys);
  if (!note) return sentence;
  const body = sentence.endsWith(".") ? sentence : `${sentence}.`;
  return `${body}${note}`;
}

function publicKeyFetchNote(keys: StatusKeyHealth): string {
  if (keys.lastSuccessAtMs === undefined && keys.fetchesOk === undefined && keys.fetchesFailed === undefined) {
    return "";
  }
  const tally = `${wholeCount(keys.fetchesOk)} ok, ${wholeCount(keys.fetchesFailed)} failed since startup`;
  if (typeof keys.lastSuccessAtMs === "number" && Number.isFinite(keys.lastSuccessAtMs) && keys.lastSuccessAtMs >= 0) {
    return ` Last success ${formatPublicKeyFetchedAt(keys.lastSuccessAtMs)} (${tally}).`;
  }
  return ` No public_keys success yet (${tally}).`;
}

function wholeCount(count: number | undefined): number {
  if (typeof count !== "number" || !Number.isFinite(count)) return 0;
  return Math.max(0, Math.floor(count));
}

function togglesLine(snapshot: StatusSnapshot): string {
  return [
    `This chat: welcome ${onOff(snapshot.welcome)}`,
    `troll ${snapshot.troll}`,
    `linkroast ${onOff(snapshot.linkroast)}`,
  ].join(" · ");
}

function versionLine(snapshot: StatusSnapshot): string | undefined {
  const version = cleanDetail(snapshot.version);
  const sha = cleanDetail(snapshot.sha);
  if (version && sha) return `Version: ${version} ${sha}`;
  if (version) return `Version: ${version}`;
  if (sha) return `Version: ${sha}`;
  return undefined;
}

function labelOrOff(value: string): string {
  const cleaned = cleanDetail(value);
  if (!cleaned || cleaned.toLowerCase() === "off") return "off";
  return cleaned;
}

function countLabel(count: number, singular: string, plural: string): string {
  const n = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  return `${n} ${n === 1 ? singular : plural}`;
}

function onOff(value: boolean): "on" | "off" {
  return value ? "on" : "off";
}

function formatUptime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const mins = Math.floor((total % 3_600) / 60);
  const secs = total % 60;
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

function joinDetail(label: string, detail: string | undefined): string {
  if (!detail || detail === label) return label;
  return `${label} ${detail}`;
}

function cleanDetail(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  return cleaned || undefined;
}
