import { bodyIsModerated, bodyIsTooLong, IMAGINE_API_BASE, IMAGINE_REFUSED_MESSAGE } from "./imagine.js";
import { containsBannedAgeTerm, redactSecrets } from "./adult-filter.js";

/**
 * xAI Grok Imagine video. Same bearer key as `!imagine`.
 * Docs: https://docs.x.ai/developers/model-capabilities/video/generation
 * POST https://api.x.ai/v1/videos/generations  → { request_id }
 * GET  https://api.x.ai/v1/videos/{request_id} until done | failed | expired
 */

export const DEFAULT_VIDEO_MODEL = "grok-imagine-video-1.5";
export const DEFAULT_VIDEO_DURATION = 5;
export const DEFAULT_VIDEO_ASPECT_RATIO = "16:9";
export const DEFAULT_VIDEO_RESOLUTION = "720p";
/** First wait. Later polls stretch toward `VIDEO_POLL_MAX_INTERVAL_MS`. */
export const VIDEO_POLL_INTERVAL_MS = 3_000;
export const VIDEO_POLL_MAX_INTERVAL_MS = 5_000;
export const VIDEO_POLL_TIMEOUT_MS = 10 * 60 * 1000;
const VIDEO_POLL_BACKOFF_MS = 1_000;
const START_TIMEOUT_MS = 60_000;
const POLL_REQUEST_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const MAX_VIDEO_BYTES = 32 * 1024 * 1024;

export const VIDEO_EMPTY_MESSAGE =
  "Give !video a prompt. Example: !video a paper boat drifting down a rain-soaked street";
export const VIDEO_STARTED_MESSAGE =
  "Generating a short video. This usually takes a few minutes.";
export const VIDEO_TOO_LONG_MESSAGE = "That prompt is too long for video generation. Try a shorter one.";
export const VIDEO_UNAVAILABLE_MESSAGE = "Video generation needs XAI_API_KEY.";
export const VIDEO_FAILED_MESSAGE = "Video generation failed. Try again later.";
export const VIDEO_TIMEOUT_MESSAGE = "Video generation timed out. Try again later.";
export const VIDEO_EXPIRED_MESSAGE = "That video request expired before it finished. Try again.";
export const VIDEO_MODERATED_INTRO =
  "That video was blocked by content moderation. Try one of these prompts with !video:";

export const VIDEO_ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"] as const;
export const VIDEO_RESOLUTIONS = ["480p", "720p", "1080p"] as const;

export type VideoAspectRatio = (typeof VIDEO_ASPECT_RATIOS)[number];
export type VideoResolution = (typeof VIDEO_RESOLUTIONS)[number];
export type VideoErrorKind = "moderated" | "failed";

export interface GeneratedVideo {
  /** Temporary https URL. Do not log it. */
  url: string;
  duration?: number;
  width: number;
  height: number;
}

export interface VideoGenerator {
  generate(prompt: string): Promise<GeneratedVideo>;
}

export interface FetchedVideo {
  bytes: Uint8Array;
  mimeType: string;
}

export class VideoError extends Error {
  readonly kind: VideoErrorKind;

  constructor(
    message: string,
    readonly userMessage = VIDEO_FAILED_MESSAGE,
    kind: VideoErrorKind = "failed",
  ) {
    super(message);
    this.name = "VideoError";
    this.kind = kind;
  }
}

export function isVideoModerationError(error: unknown): boolean {
  return error instanceof VideoError && error.kind === "moderated";
}

const ASPECT_RATIO_SET = new Set<string>(VIDEO_ASPECT_RATIOS);
const RESOLUTION_SET = new Set<string>(VIDEO_RESOLUTIONS);

/** `grok-imagine-video`, `grok-imagine-video-1.5`, and later ids in that family. */
const VIDEO_MODEL_RE = /^grok-imagine-video(?:-[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*)*$/;
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

export function normalizeVideoModel(value: string): string | undefined {
  const folded = value.trim();
  if (!VIDEO_MODEL_RE.test(folded)) return undefined;
  return folded;
}

export function normalizeVideoDuration(value: number): number | undefined {
  if (!Number.isInteger(value) || value < 1 || value > 15) return undefined;
  return value;
}

export function normalizeVideoAspectRatio(value: string): VideoAspectRatio | undefined {
  const folded = value.trim();
  if (!ASPECT_RATIO_SET.has(folded)) return undefined;
  return folded as VideoAspectRatio;
}

export function normalizeVideoResolution(value: string): VideoResolution | undefined {
  const folded = value.trim().toLowerCase();
  if (!RESOLUTION_SET.has(folded)) return undefined;
  return folded as VideoResolution;
}

/**
 * Trim a `!video` prompt. The text is otherwise sent as written.
 * Minor-related wording is refused and is not sent to the API.
 * Length is not capped here; the video API applies its own limit.
 */
export function normalizeVideoPrompt(
  raw: string,
): { ok: true; prompt: string } | { ok: false; reason: "empty" | "refused" } {
  const prompt = raw.trim();
  if (!prompt) return { ok: false, reason: "empty" };
  if (containsBannedAgeTerm(prompt)) return { ok: false, reason: "refused" };
  return { ok: true, prompt };
}

export function videoPromptRejection(reason: "empty" | "refused"): string {
  if (reason === "empty") return VIDEO_EMPTY_MESSAGE;
  return IMAGINE_REFUSED_MESSAGE;
}

/** Temporary URL plus a note that the link will not last. */
export function formatVideoReadyMessage(url: string): string {
  return `Video ready. This link is temporary:\n${url}`;
}

export function videoGenerationsUrl(baseUrl = IMAGINE_API_BASE): string {
  return `${baseUrl.replace(/\/$/, "")}/videos/generations`;
}

export function videoStatusUrl(requestId: string, baseUrl = IMAGINE_API_BASE): string {
  return `${baseUrl.replace(/\/$/, "")}/videos/${encodeURIComponent(requestId)}`;
}

/**
 * Pixel size for a Chat video attachment. `720p` is the short side.
 * Landscape 16:9 at 720p is 1280×720. Portrait 9:16 at 720p is 720×1280.
 */
export function videoFrameSize(
  aspectRatio: string,
  resolution: string,
): { width: number; height: number } {
  const shortSide = resolution === "1080p" ? 1080 : resolution === "480p" ? 480 : 720;
  const widthRatio = Number(aspectRatio.split(":")[0]);
  const heightRatio = Number(aspectRatio.split(":")[1]);
  if (!Number.isFinite(widthRatio) || !Number.isFinite(heightRatio) || widthRatio <= 0 || heightRatio <= 0) {
    return { width: 1280, height: 720 };
  }
  if (widthRatio >= heightRatio) {
    const height = shortSide;
    const width = even(Math.round((height * widthRatio) / heightRatio));
    return { width, height };
  }
  const width = shortSide;
  const height = even(Math.round((width * heightRatio) / widthRatio));
  return { width, height };
}

export function createVideoClient(options: {
  apiKey: string;
  model?: string;
  duration?: number;
  aspectRatio?: string;
  resolution?: string;
  generateAudio?: boolean;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  pollIntervalMs?: number;
  pollMaxIntervalMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): VideoGenerator {
  const apiKey = options.apiKey.trim();
  if (!apiKey) {
    throw new VideoError("Video client requires an API key", VIDEO_UNAVAILABLE_MESSAGE);
  }
  const model = options.model?.trim() || DEFAULT_VIDEO_MODEL;
  const duration = options.duration ?? DEFAULT_VIDEO_DURATION;
  const aspectRatio = options.aspectRatio?.trim() || DEFAULT_VIDEO_ASPECT_RATIO;
  const resolution = options.resolution?.trim() || DEFAULT_VIDEO_RESOLUTION;
  const baseUrl = options.baseUrl ?? IMAGINE_API_BASE;
  const fetchImpl = options.fetchImpl ?? fetch;
  const pollIntervalMs = options.pollIntervalMs ?? VIDEO_POLL_INTERVAL_MS;
  const pollMaxIntervalMs = Math.max(pollIntervalMs, options.pollMaxIntervalMs ?? VIDEO_POLL_MAX_INTERVAL_MS);
  const timeoutMs = options.timeoutMs ?? VIDEO_POLL_TIMEOUT_MS;
  const sleep = options.sleep ?? delay;
  const frame = videoFrameSize(aspectRatio, resolution);

  return {
    async generate(prompt: string): Promise<GeneratedVideo> {
      const requestId = await startGeneration({
        fetchImpl,
        apiKey,
        baseUrl,
        body: startBody({
          model,
          prompt,
          duration,
          aspectRatio,
          resolution,
          generateAudio: options.generateAudio,
        }),
      });
      return pollUntilDone({
        fetchImpl,
        apiKey,
        baseUrl,
        requestId,
        frame,
        pollIntervalMs,
        pollMaxIntervalMs,
        timeoutMs,
        sleep,
      });
    },
  };
}

/**
 * Download a temporary https mp4 so Chat can attach it.
 * Returns undefined when the response is not a small mp4. Does not log the URL.
 */
export async function fetchGeneratedVideo(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FetchedVideo | undefined> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:") return undefined;
  if (containsBannedAgeTerm(`${parsed.hostname}${parsed.pathname}`)) return undefined;

  let response: Response;
  try {
    response = await fetchImpl(parsed.toString(), {
      redirect: "follow",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      headers: {
        Accept: "video/mp4",
        "User-Agent": "x-combot/1.0 (video command)",
      },
    });
  } catch {
    return undefined;
  }
  if (!response.ok) return undefined;
  const mime = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  const advertised = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(advertised) && advertised > MAX_VIDEO_BYTES) return undefined;
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_VIDEO_BYTES) return undefined;
  if (!isMp4Payload(mime, bytes)) return undefined;
  return { bytes, mimeType: "video/mp4" };
}

function startBody(input: {
  model: string;
  prompt: string;
  duration: number;
  aspectRatio: string;
  resolution: string;
  generateAudio?: boolean;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: input.model,
    prompt: input.prompt,
    duration: input.duration,
    aspect_ratio: input.aspectRatio,
    resolution: input.resolution,
  };
  if (input.generateAudio !== undefined) body.generate_audio = input.generateAudio;
  return body;
}

async function startGeneration(input: {
  fetchImpl: typeof fetch;
  apiKey: string;
  baseUrl: string;
  body: Record<string, unknown>;
}): Promise<string> {
  let response: Response;
  try {
    response = await input.fetchImpl(videoGenerationsUrl(input.baseUrl), {
      method: "POST",
      signal: AbortSignal.timeout(START_TIMEOUT_MS),
      headers: jsonHeaders(input.apiKey),
      body: JSON.stringify(input.body),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "request failed";
    throw new VideoError(`Video request failed: ${redactSecrets(detail)}`);
  }
  const text = await response.text();
  if (!response.ok) throw videoHttpError(response.status, text);
  let payload: unknown;
  try {
    payload = text ? (JSON.parse(text) as unknown) : undefined;
  } catch {
    throw new VideoError("Video start was not JSON");
  }
  return readRequestId(payload);
}

async function pollUntilDone(input: {
  fetchImpl: typeof fetch;
  apiKey: string;
  baseUrl: string;
  requestId: string;
  frame: { width: number; height: number };
  pollIntervalMs: number;
  pollMaxIntervalMs: number;
  timeoutMs: number;
  sleep: (ms: number) => Promise<void>;
}): Promise<GeneratedVideo> {
  let elapsed = 0;
  let interval = input.pollIntervalMs;
  for (;;) {
    let step: PollStep;
    try {
      const payload = await pollOnce(input);
      step = interpretVideoPoll(payload, input.frame);
    } catch (error) {
      if (error instanceof VideoError) throw error;
      const detail = error instanceof Error ? error.message : "poll failed";
      throw new VideoError(`Video poll failed: ${redactSecrets(detail)}`);
    }
    if (step.kind === "done") return step.video;
    if (step.kind === "error") throw step.error;
    if (elapsed >= input.timeoutMs) {
      throw new VideoError(`Video poll timed out after ${input.timeoutMs}ms`, VIDEO_TIMEOUT_MESSAGE);
    }
    const wait = Math.min(interval, input.timeoutMs - elapsed);
    await input.sleep(wait);
    elapsed += wait;
    if (wait <= 0) {
      throw new VideoError(`Video poll timed out after ${input.timeoutMs}ms`, VIDEO_TIMEOUT_MESSAGE);
    }
    interval = Math.min(input.pollMaxIntervalMs, interval + VIDEO_POLL_BACKOFF_MS);
  }
}

async function pollOnce(input: {
  fetchImpl: typeof fetch;
  apiKey: string;
  baseUrl: string;
  requestId: string;
}): Promise<unknown> {
  let response: Response;
  try {
    response = await input.fetchImpl(videoStatusUrl(input.requestId, input.baseUrl), {
      method: "GET",
      signal: AbortSignal.timeout(POLL_REQUEST_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        Accept: "application/json",
      },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "poll failed";
    throw new VideoError(`Video poll failed: ${redactSecrets(detail)}`);
  }
  const text = await response.text();
  if (response.status === 202 || response.status === 429) {
    return parsePending(text);
  }
  if (!response.ok) throw videoHttpError(response.status, text);
  if (!text.trim()) return { status: "pending" };
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new VideoError("Video status was not JSON");
  }
}

type PollStep =
  | { kind: "pending" }
  | { kind: "done"; video: GeneratedVideo }
  | { kind: "error"; error: VideoError };

function interpretVideoPoll(
  payload: unknown,
  frame: { width: number; height: number },
): PollStep {
  if (!payload || typeof payload !== "object") {
    return { kind: "error", error: new VideoError("Video status was empty") };
  }
  const record = payload as Record<string, unknown>;
  const status = typeof record.status === "string" ? record.status.trim().toLowerCase() : "";
  const video =
    record.video && typeof record.video === "object" ? (record.video as Record<string, unknown>) : undefined;
  const raw = redactSecrets(safeJson(payload)).slice(0, 300);
  if (video?.respect_moderation === false) {
    return {
      kind: "error",
      error: new VideoError(`Video moderation: ${raw}`, VIDEO_MODERATED_INTRO, "moderated"),
    };
  }
  if (status === "done") {
    const url = typeof video?.url === "string" ? video.url.trim() : "";
    if (!url.startsWith("https://")) {
      return { kind: "error", error: new VideoError(`Video done without url: ${raw}`) };
    }
    const duration = typeof video?.duration === "number" ? video.duration : undefined;
    return { kind: "done", video: { url, duration, width: frame.width, height: frame.height } };
  }
  if (status === "failed" || status === "expired") {
    if (bodyIsModerated(raw)) {
      return {
        kind: "error",
        error: new VideoError(`Video ${status}: ${raw}`, VIDEO_MODERATED_INTRO, "moderated"),
      };
    }
    if (bodyIsTooLong(raw)) {
      return { kind: "error", error: new VideoError(`Video ${status}: ${raw}`, VIDEO_TOO_LONG_MESSAGE) };
    }
    const userMessage = status === "expired" ? VIDEO_EXPIRED_MESSAGE : VIDEO_FAILED_MESSAGE;
    return { kind: "error", error: new VideoError(`Video ${status}: ${raw}`, userMessage) };
  }
  return { kind: "pending" };
}

function videoHttpError(status: number, text: string): VideoError {
  const detail = redactSecrets(text).slice(0, 300);
  const message = `Video HTTP ${status}: ${detail}`;
  if (bodyIsModerated(text)) {
    return new VideoError(message, VIDEO_MODERATED_INTRO, "moderated");
  }
  if (bodyIsTooLong(text)) {
    return new VideoError(message, VIDEO_TOO_LONG_MESSAGE);
  }
  return new VideoError(message);
}

function readRequestId(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    throw new VideoError("Video start was not JSON");
  }
  const id = (payload as { request_id?: unknown }).request_id;
  if (typeof id !== "string" || !REQUEST_ID_RE.test(id)) {
    throw new VideoError("Video start had no request id");
  }
  return id;
}

function parsePending(text: string): unknown {
  if (!text.trim()) return { status: "pending" };
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { status: "pending" };
  }
}

function jsonHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
  };
}

function isMp4Payload(mime: string, bytes: Uint8Array): boolean {
  if (mime === "video/mp4" || mime === "application/mp4") return true;
  if (mime && mime !== "application/octet-stream") return false;
  return bytes.length >= 8 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70;
}

function even(value: number): number {
  if (!Number.isFinite(value) || value < 2) return 2;
  const rounded = Math.round(value);
  return rounded % 2 === 0 ? rounded : rounded + 1;
}

function safeJson(payload: unknown): string {
  try {
    return JSON.stringify(payload);
  } catch {
    return "";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
