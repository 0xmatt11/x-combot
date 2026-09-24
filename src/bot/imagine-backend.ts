import { redactSecrets } from "./adult-filter.js";
import {
  createImagineClient,
  IMAGINE_MODERATED_INTRO,
  ImagineError,
  isImagineGenerationApiUrl,
  isShareableMediaUrl,
  type ImagineBackend,
  type ImagineGenerator,
  type ImagineImage,
} from "./imagine.js";
import {
  createVideoClient,
  VIDEO_MODERATED_INTRO,
  VideoError,
  videoFrameSize,
  type GeneratedVideo,
  type VideoGenerator,
} from "./video.js";

/**
 * User-facing image and video generation.
 * `browser` (the default) drives https://grok.com/imagine and does not call
 * api.x.ai `/v1/images/generations` or `/v1/videos`. `api` keeps those clients.
 */

export const GROK_IMAGINE_URL = "https://grok.com/imagine";

export const IMAGINE_BROWSER_LOGIN_MESSAGE =
  "Grok Imagine is not signed in. Open https://grok.com/imagine in the shared Chrome profile as @0xMatt66, finish the age gate, then try again. API image and video generation stays off.";

export const IMAGINE_BROWSER_NOT_CONFIGURED_MESSAGE =
  "Imagine browser mode needs the signed-in Chrome session for @0xMatt66. Set IMAGINE_CHROME_PROFILE or IMAGINE_BROWSER_CDP_URL on the host that runs the bot. API image and video generation stays off.";

export const IMAGINE_BROWSER_NOT_READY_MESSAGE =
  "Grok Imagine did not show a prompt box. Sign in as @0xMatt66 at https://grok.com/imagine in the shared Chrome profile and pass the age gate. API image and video generation stays off.";

export const IMAGINE_BROWSER_PROFILE_LOCKED_MESSAGE =
  "That Chrome profile is already open. Close it, or start Chrome with --remote-debugging-port and set IMAGINE_BROWSER_CDP_URL. API image and video generation stays off.";

export const IMAGINE_BROWSER_CHROME_MISSING_MESSAGE =
  "Google Chrome was not found for Imagine. Install Chrome on this host, or set IMAGINE_BROWSER_CHANNEL. API image and video generation stays off.";

export const IMAGINE_BROWSER_FAILED_MESSAGE =
  "Image generation on grok.com/imagine failed. Try again later. API generation stays off.";

export const VIDEO_BROWSER_FAILED_MESSAGE =
  "Video generation on grok.com/imagine failed. Try again later. API generation stays off.";

export const IMAGINE_BROWSER_TIMEOUT_MESSAGE =
  "Image generation on grok.com/imagine timed out. Try again later. API generation stays off.";

export const VIDEO_BROWSER_TIMEOUT_MESSAGE =
  "Video generation on grok.com/imagine timed out. Try again later. API generation stays off.";

export type BrowserImagineMode = "image" | "video";
export type ImaginePageState = "ready" | "login" | "unknown";

export interface BrowserImagineRequest {
  mode: BrowserImagineMode;
  prompt: string;
  aspectRatio?: string;
  durationSeconds?: number;
  resolution?: string;
}

export interface BrowserImagineAsset {
  bytes: Uint8Array;
  mimeType: string;
  /** https file URL when the page exposed one. Never an api.x.ai generation route. */
  url?: string;
  width?: number;
  height?: number;
}

export interface BrowserImagineWorker {
  generate(request: BrowserImagineRequest): Promise<BrowserImagineAsset>;
}

export interface PlaywrightImagineOptions {
  chromeProfile?: string;
  cdpUrl?: string;
  /** Unset means a visible Chrome window. */
  headless?: boolean;
  /** Playwright channel. Unset means `chrome`. */
  channel?: string;
  /** Overrides the per-mode wait. Milliseconds. */
  timeoutMs?: number;
  imagineUrl?: string;
}

export class BrowserImagineError extends Error {
  readonly kind: "session" | "moderated" | "failed";

  constructor(
    message: string,
    readonly userMessage: string,
    kind: "session" | "moderated" | "failed" = "failed",
  ) {
    super(message);
    this.name = "BrowserImagineError";
    this.kind = kind;
  }
}

export function classifyImaginePage(input: {
  url: string;
  hasPrompt: boolean;
}): ImaginePageState {
  if (input.hasPrompt) return "ready";
  if (loginUrl(input.url)) return "login";
  return "unknown";
}

export function textLooksLoggedOut(text: string): boolean {
  const haystack = text.toLowerCase();
  return haystack.includes("sign in") || haystack.includes("log in") || haystack.includes("sign up");
}

export function pageLooksModerated(text: string, prompt: string): boolean {
  const haystack = withoutPrompt(text, prompt);
  return (
    haystack.includes("content moderation") ||
    haystack.includes("content policy") ||
    haystack.includes("violates our") ||
    haystack.includes("unable to generate") ||
    haystack.includes("can't generate") ||
    haystack.includes("cannot generate")
  );
}

export function pageLooksTooLong(text: string, prompt: string): boolean {
  const haystack = withoutPrompt(text, prompt);
  return haystack.includes("too long") || haystack.includes("character limit") || haystack.includes("maximum length");
}

export function isChromeProfileLockError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /ProcessSingleton|profile is already in use|SingletonLock|user data directory is already in use/i.test(
    message,
  );
}

export function isChromeMissingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /executable doesn't exist|is not found at|failed to launch|channel/i.test(message) && /chrome|msedge|chromium/i.test(message);
}

export function isMissingPlaywrightError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("playwright-core");
}

/** Newest fetchable media URL that was not already on the page. Generation API routes are dropped. */
export function pickNewMediaUrl(known: readonly string[], found: readonly string[]): string | undefined {
  const seen = new Set(known);
  for (let index = found.length - 1; index >= 0; index -= 1) {
    const url = found[index];
    if (!url || seen.has(url)) continue;
    if (!isFetchableBrowserUrl(url)) continue;
    return url;
  }
  return undefined;
}

export function isFetchableBrowserUrl(url: string): boolean {
  if (isImagineGenerationApiUrl(url)) return false;
  const folded = url.toLowerCase();
  if (folded.includes("favicon") || folded.includes("/sprite") || folded.includes("/emoji")) return false;
  if (url.startsWith("blob:")) return true;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

/** Throws before any network call when `url` is an image or video generation route. */
export function assertBrowserMediaUrl(url: string): void {
  if (isImagineGenerationApiUrl(url)) {
    throw new BrowserImagineError(
      "Refusing api.x.ai image or video generation URL",
      IMAGINE_BROWSER_FAILED_MESSAGE,
    );
  }
}

export function createBrowserImagineGenerator(
  worker: BrowserImagineWorker,
  options?: { aspectRatio?: string },
): ImagineGenerator {
  return {
    async generate(prompt: string): Promise<ImagineImage> {
      try {
        const asset = await worker.generate({
          mode: "image",
          prompt,
          aspectRatio: options?.aspectRatio,
        });
        if (!asset.bytes || asset.bytes.byteLength === 0) {
          throw new BrowserImagineError("browser imagine returned no bytes", IMAGINE_BROWSER_FAILED_MESSAGE);
        }
        return {
          url: shareableAssetUrl(asset.url),
          bytes: asset.bytes,
          mimeType: asset.mimeType,
        };
      } catch (error) {
        throw asImagineError(error);
      }
    },
  };
}

export function createBrowserVideoGenerator(
  worker: BrowserImagineWorker,
  options?: { duration?: number; aspectRatio?: string; resolution?: string },
): VideoGenerator {
  const aspectRatio = options?.aspectRatio ?? "16:9";
  const resolution = options?.resolution ?? "720p";
  const frame = videoFrameSize(aspectRatio, resolution);
  return {
    async generate(prompt: string): Promise<GeneratedVideo> {
      try {
        const asset = await worker.generate({
          mode: "video",
          prompt,
          aspectRatio,
          durationSeconds: options?.duration,
          resolution,
        });
        if (!asset.bytes || asset.bytes.byteLength === 0) {
          throw new BrowserImagineError("browser imagine returned no video bytes", VIDEO_BROWSER_FAILED_MESSAGE);
        }
        return {
          url: shareableAssetUrl(asset.url) ?? "",
          bytes: asset.bytes,
          mimeType: asset.mimeType || "video/mp4",
          width: asset.width ?? frame.width,
          height: asset.height ?? frame.height,
        };
      } catch (error) {
        throw asVideoError(error);
      }
    },
  };
}

export interface UserFacingImagine {
  imagine?: ImagineGenerator;
  video?: VideoGenerator;
}

/**
 * Browser mode returns generators that talk only to `worker` (the Playwright
 * session by default). `fetchImpl` is used only when `backend` is `api`.
 */
export function createUserFacingImagine(options: {
  backend: ImagineBackend;
  apiKey?: string;
  imagineModel?: string;
  aspectRatio?: string;
  videoModel?: string;
  videoDuration?: number;
  videoAspectRatio?: string;
  videoResolution?: string;
  fetchImpl?: typeof fetch;
  worker?: BrowserImagineWorker;
  browser?: PlaywrightImagineOptions;
}): UserFacingImagine {
  if (options.backend === "browser") {
    const worker = options.worker ?? sharedPlaywrightWorker(options.browser ?? {});
    return {
      imagine: createBrowserImagineGenerator(worker, { aspectRatio: options.aspectRatio }),
      video: createBrowserVideoGenerator(worker, {
        duration: options.videoDuration,
        aspectRatio: options.videoAspectRatio,
        resolution: options.videoResolution,
      }),
    };
  }
  const apiKey = options.apiKey?.trim();
  if (!apiKey) return {};
  return {
    imagine: createImagineClient({
      apiKey,
      model: options.imagineModel,
      aspectRatio: options.aspectRatio,
      fetchImpl: options.fetchImpl,
    }),
    video: createVideoClient({
      apiKey,
      model: options.videoModel,
      duration: options.videoDuration,
      aspectRatio: options.videoAspectRatio,
      resolution: options.videoResolution,
      fetchImpl: options.fetchImpl,
    }),
  };
}

function sharedPlaywrightWorker(options: PlaywrightImagineOptions): BrowserImagineWorker {
  let real: BrowserImagineWorker | undefined;
  let loading: Promise<BrowserImagineWorker> | undefined;
  const ready = (): Promise<BrowserImagineWorker> => {
    if (real) return Promise.resolve(real);
    if (!loading) {
      loading = import("./imagine-browser.js").then((mod) => {
        real = mod.createPlaywrightImagineWorker(options);
        return real;
      });
    }
    return loading;
  };
  return {
    async generate(request: BrowserImagineRequest): Promise<BrowserImagineAsset> {
      const worker = await ready();
      return worker.generate(request);
    },
  };
}

function shareableAssetUrl(url: string | undefined): string | undefined {
  if (!url || !isShareableMediaUrl(url)) return undefined;
  return url;
}

function asImagineError(error: unknown): ImagineError {
  if (error instanceof ImagineError) return error;
  if (error instanceof BrowserImagineError) {
    const userMessage = error.kind === "moderated" ? IMAGINE_MODERATED_INTRO : error.userMessage;
    return new ImagineError(clip(error.message), userMessage, error.kind);
  }
  const detail = error instanceof Error ? error.message : "browser imagine failed";
  return new ImagineError(clip(detail), IMAGINE_BROWSER_FAILED_MESSAGE);
}

function asVideoError(error: unknown): VideoError {
  if (error instanceof VideoError) return error;
  if (error instanceof BrowserImagineError) {
    const userMessage = error.kind === "moderated" ? VIDEO_MODERATED_INTRO : error.userMessage;
    return new VideoError(clip(error.message), userMessage, error.kind);
  }
  const detail = error instanceof Error ? error.message : "browser video failed";
  return new VideoError(clip(detail), VIDEO_BROWSER_FAILED_MESSAGE);
}

function clip(message: string): string {
  return redactSecrets(message).slice(0, 300);
}

function loginUrl(raw: string): boolean {
  const url = raw.toLowerCase();
  return (
    url.includes("accounts.x.ai") ||
    url.includes("accounts.google.com") ||
    url.includes("/sign-in") ||
    url.includes("/signin") ||
    url.includes("/login") ||
    url.includes("x.com/i/flow") ||
    url.includes("x.com/i/oauth")
  );
}

function withoutPrompt(text: string, prompt: string): string {
  const haystack = text.toLowerCase();
  const needle = prompt.trim().toLowerCase();
  if (needle.length < 12) return haystack;
  return haystack.replaceAll(needle, "");
}
