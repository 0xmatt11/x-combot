import { log } from "../log.js";
import { imageHost, redactSecrets } from "./adult-filter.js";
import { IMAGINE_TOO_LONG_MESSAGE } from "./imagine.js";
import {
  assertBrowserMediaUrl,
  BrowserImagineError,
  classifyImaginePage,
  GROK_IMAGINE_URL,
  IMAGINE_BROWSER_CHROME_MISSING_MESSAGE,
  IMAGINE_BROWSER_FAILED_MESSAGE,
  IMAGINE_BROWSER_LOGIN_MESSAGE,
  IMAGINE_BROWSER_NOT_CONFIGURED_MESSAGE,
  IMAGINE_BROWSER_NOT_READY_MESSAGE,
  IMAGINE_BROWSER_PROFILE_LOCKED_MESSAGE,
  IMAGINE_BROWSER_TIMEOUT_MESSAGE,
  isChromeMissingError,
  isChromeProfileLockError,
  isFetchableBrowserUrl,
  isMissingPlaywrightError,
  pageLooksModerated,
  pageLooksTooLong,
  pickNewMediaUrl,
  textLooksLoggedOut,
  VIDEO_BROWSER_FAILED_MESSAGE,
  VIDEO_BROWSER_TIMEOUT_MESSAGE,
  type BrowserImagineAsset,
  type BrowserImagineRequest,
  type BrowserImagineWorker,
  type PlaywrightImagineOptions,
} from "./imagine-backend.js";
import { VIDEO_TOO_LONG_MESSAGE } from "./video.js";

/**
 * Drives https://grok.com/imagine in Chrome signed in as @0xMatt66.
 * The bot calls this in-process. `scripts/imagine-browser.ts` is the same worker
 * for a manual check. Neither path calls api.x.ai image or video generations.
 */

const IMAGE_TIMEOUT_MS = 180_000;
const VIDEO_TIMEOUT_MS = 10 * 60 * 1000;
const NAVIGATION_TIMEOUT_MS = 45_000;
const PROMPT_WAIT_MS = 20_000;
const POLL_MS = 1_500;
const MIN_IMAGE_BYTES = 8_000;
const MIN_VIDEO_BYTES = 20_000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_VIDEO_BYTES = 32 * 1024 * 1024;
const MIN_EDGE = 256;

let openSession: PlaywrightImagineSession | undefined;

export function createPlaywrightImagineWorker(options: PlaywrightImagineOptions = {}): BrowserImagineWorker {
  const session = new PlaywrightImagineSession(options);
  openSession = session;
  return {
    generate: (request) => session.generate(request),
  };
}

/** Closes a Chrome this process launched. A CDP attach leaves that Chrome running. */
export async function closeImagineBrowser(): Promise<void> {
  const session = openSession;
  openSession = undefined;
  await session?.close();
}

class PlaywrightImagineSession {
  private readonly chromeProfile?: string;
  private readonly cdpUrl?: string;
  private readonly headless: boolean;
  private readonly channel: string;
  private readonly timeoutMs?: number;
  private readonly imagineUrl: string;
  private tail: Promise<void> = Promise.resolve();
  private context: import("playwright-core").BrowserContext | undefined;
  private page: import("playwright-core").Page | undefined;
  private connectedOverCdp = false;

  constructor(options: PlaywrightImagineOptions) {
    this.chromeProfile = options.chromeProfile;
    this.cdpUrl = options.cdpUrl;
    this.headless = options.headless === true;
    this.channel = options.channel?.trim() || "chrome";
    this.timeoutMs = options.timeoutMs;
    this.imagineUrl = options.imagineUrl ?? GROK_IMAGINE_URL;
  }

  async generate(request: BrowserImagineRequest): Promise<BrowserImagineAsset> {
    const run = this.tail.then(() => this.run(request));
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async close(): Promise<void> {
    const page = this.page;
    this.page = undefined;
    await page?.close().catch(() => undefined);
    if (this.connectedOverCdp) {
      this.context = undefined;
      return;
    }
    const context = this.context;
    this.context = undefined;
    await context?.close().catch(() => undefined);
  }

  private async run(request: BrowserImagineRequest): Promise<BrowserImagineAsset> {
    if (!this.cdpUrl && !this.chromeProfile) {
      throw new BrowserImagineError(
        "Imagine browser session is not configured",
        IMAGINE_BROWSER_NOT_CONFIGURED_MESSAGE,
        "session",
      );
    }
    const timeoutMs = this.timeoutMs ?? (request.mode === "video" ? VIDEO_TIMEOUT_MS : IMAGE_TIMEOUT_MS);
    try {
      const page = await this.pageFor(request);
      await openImagine(page, this.imagineUrl);
      await selectMode(page, request.mode);
      await applyOptionalControls(page, request);
      const known = await collectMediaUrls(page);
      const found: string[] = [];
      const onResponse = (response: import("playwright-core").Response) => {
        const url = response.url();
        if (!isFetchableBrowserUrl(url)) return;
        const mime = header(response, "content-type");
        const length = Number(header(response, "content-length") || "0");
        if (Number.isFinite(length) && length > 0) {
          const min = request.mode === "video" ? MIN_VIDEO_BYTES : MIN_IMAGE_BYTES;
          if (length < min) return;
        }
        if (request.mode === "image") {
          if (!mime.startsWith("image/") || mime === "image/svg+xml" || mime === "image/gif") return;
        } else if (!(mime.startsWith("video/") || /\.mp4(?:$|\?)/i.test(url) || /\.webm(?:$|\?)/i.test(url))) {
          return;
        }
        found.push(url);
      };
      page.on("response", onResponse);
      try {
        await submitPrompt(page, request.prompt);
        const deadline = Date.now() + timeoutMs;
        const seen = new Set(known);
        while (Date.now() < deadline) {
          const dom = await collectMediaUrls(page);
          const candidate = pickNewMediaUrl([...seen], [...found, ...dom]);
          if (candidate) {
            const asset = await downloadAsset(page, candidate, request.mode);
            if (asset) return asset;
            seen.add(candidate);
          }
          const text = await bodyText(page);
          if (pageLooksModerated(text, request.prompt)) {
            throw new BrowserImagineError("Imagine page blocked the prompt", IMAGINE_BROWSER_FAILED_MESSAGE, "moderated");
          }
          if (pageLooksTooLong(text, request.prompt)) {
            throw new BrowserImagineError(
              "Imagine page said the prompt is too long",
              request.mode === "video" ? VIDEO_TOO_LONG_MESSAGE : IMAGINE_TOO_LONG_MESSAGE,
            );
          }
          await page.waitForTimeout(POLL_MS);
        }
        throw new BrowserImagineError(
          `Imagine browser timed out after ${timeoutMs}ms`,
          request.mode === "video" ? VIDEO_BROWSER_TIMEOUT_MESSAGE : IMAGINE_BROWSER_TIMEOUT_MESSAGE,
        );
      } finally {
        page.off("response", onResponse);
      }
    } catch (error) {
      throw mapLaunchError(error, request.mode);
    }
  }

  private async pageFor(_request: BrowserImagineRequest): Promise<import("playwright-core").Page> {
    const context = await this.ensureContext();
    if (this.page && !this.page.isClosed()) return this.page;
    this.page = await context.newPage();
    return this.page;
  }

  private async ensureContext(): Promise<import("playwright-core").BrowserContext> {
    if (this.context) return this.context;
    let chromium: import("playwright-core").BrowserType;
    try {
      const mod = await import("playwright-core");
      chromium = mod.chromium;
    } catch (error) {
      if (isMissingPlaywrightError(error)) {
        throw new BrowserImagineError(
          "playwright-core is not installed",
          IMAGINE_BROWSER_CHROME_MISSING_MESSAGE,
          "session",
        );
      }
      throw error;
    }
    try {
      if (this.cdpUrl) {
        const browser = await chromium.connectOverCDP(this.cdpUrl);
        const existing = browser.contexts()[0];
        if (!existing) {
          throw new BrowserImagineError(
            "CDP Chrome has no browser context",
            IMAGINE_BROWSER_NOT_READY_MESSAGE,
            "session",
          );
        }
        this.connectedOverCdp = true;
        this.context = existing;
        return existing;
      }
      const profile = this.chromeProfile;
      if (!profile) {
        throw new BrowserImagineError(
          "Imagine browser session is not configured",
          IMAGINE_BROWSER_NOT_CONFIGURED_MESSAGE,
          "session",
        );
      }
      this.context = await chromium.launchPersistentContext(profile, {
        channel: this.channel as "chrome",
        headless: this.headless,
        viewport: { width: 1280, height: 900 },
        acceptDownloads: true,
        args: ["--disable-blink-features=AutomationControlled", "--disable-dev-shm-usage"],
      });
      return this.context;
    } catch (error) {
      this.context = undefined;
      throw mapLaunchError(error, "image");
    }
  }
}

async function openImagine(page: import("playwright-core").Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
  const deadline = Date.now() + PROMPT_WAIT_MS;
  let state = classifyImaginePage({ url: page.url(), hasPrompt: await hasPrompt(page) });
  while (state === "unknown" && Date.now() < deadline) {
    await page.waitForTimeout(500);
    state = classifyImaginePage({ url: page.url(), hasPrompt: await hasPrompt(page) });
  }
  if (state === "login" || (state !== "ready" && textLooksLoggedOut(await bodyText(page)))) {
    throw new BrowserImagineError("Imagine Chrome session is not signed in", IMAGINE_BROWSER_LOGIN_MESSAGE, "session");
  }
  if (state !== "ready") {
    throw new BrowserImagineError("Imagine page had no prompt box", IMAGINE_BROWSER_NOT_READY_MESSAGE, "session");
  }
  await dismissAgeGate(page);
}

async function hasPrompt(page: import("playwright-core").Page): Promise<boolean> {
  const box = page.locator("textarea, [contenteditable='true']");
  if ((await box.count().catch(() => 0)) === 0) return false;
  return box.last().isVisible().catch(() => false);
}

async function dismissAgeGate(page: import("playwright-core").Page): Promise<void> {
  const button = page.getByRole("button", {
    name: /i am (?:over )?18|i'm (?:over )?18|yes,? i am|enter imagine|confirm age/i,
  });
  if (await button.first().isVisible().catch(() => false)) {
    await button.first().click().catch(() => undefined);
  }
}

async function selectMode(page: import("playwright-core").Page, mode: "image" | "video"): Promise<void> {
  const name = mode === "image" ? /^image$/i : /^video$/i;
  const direct = page
    .getByRole("button", { name })
    .or(page.getByRole("tab", { name }))
    .or(page.getByRole("radio", { name }));
  if (await direct.first().isVisible().catch(() => false)) {
    await direct.first().click().catch(() => undefined);
    return;
  }
  const toggle = page.getByRole("button", { name: /image|video/i }).first();
  if (!(await toggle.isVisible().catch(() => false))) return;
  await toggle.click().catch(() => undefined);
  const item = page
    .getByRole("menuitem", { name })
    .or(page.getByRole("option", { name }))
    .or(page.getByRole("button", { name }));
  if (await item.first().isVisible().catch(() => false)) {
    await item.first().click().catch(() => undefined);
  }
}

async function applyOptionalControls(
  page: import("playwright-core").Page,
  request: BrowserImagineRequest,
): Promise<void> {
  if (request.aspectRatio && request.aspectRatio !== "auto") {
    const ratio = page.getByRole("button", { name: request.aspectRatio }).or(
      page.getByRole("option", { name: request.aspectRatio }),
    );
    if (await ratio.first().isVisible().catch(() => false)) {
      await ratio.first().click().catch(() => undefined);
    }
  }
  if (request.mode === "video" && request.durationSeconds) {
    const label = new RegExp(`^${request.durationSeconds}\\s*s(?:ec(?:onds)?)?$`, "i");
    const duration = page.getByRole("button", { name: label }).or(page.getByRole("option", { name: label }));
    if (await duration.first().isVisible().catch(() => false)) {
      await duration.first().click().catch(() => undefined);
    }
  }
}

async function submitPrompt(page: import("playwright-core").Page, prompt: string): Promise<void> {
  const box = page.locator("textarea, [contenteditable='true']").last();
  await box.click({ timeout: 10_000 });
  try {
    await box.fill(prompt, { timeout: 10_000 });
  } catch {
    await box.pressSequentially(prompt, { delay: 5 });
  }
  const submit = page
    .locator(
      "button[type='submit'], button[aria-label*='Generate' i], button[aria-label*='Submit' i], button[aria-label*='Send' i]",
    )
    .last();
  if ((await submit.isVisible().catch(() => false)) && (await submit.isEnabled().catch(() => false))) {
    await submit.click();
    return;
  }
  await box.press("Enter");
}

async function collectMediaUrls(page: import("playwright-core").Page): Promise<string[]> {
  return page.evaluate((minEdge: number) => {
    const doc = (globalThis as {
      document: {
        querySelectorAll(selector: string): Iterable<{
          naturalWidth?: number;
          naturalHeight?: number;
          currentSrc?: string;
          src?: string;
          querySelector?(selector: string): { src?: string } | null;
        }>;
      };
    }).document;
    const urls: string[] = [];
    for (const image of doc.querySelectorAll("img")) {
      if ((image.naturalWidth ?? 0) < minEdge || (image.naturalHeight ?? 0) < minEdge) continue;
      const src = image.currentSrc || image.src;
      if (src && !src.startsWith("data:")) urls.push(src);
    }
    for (const video of doc.querySelectorAll("video")) {
      const src = video.currentSrc || video.src;
      if (src) urls.push(src);
      const source = video.querySelector?.("source");
      if (source?.src) urls.push(source.src);
    }
    return urls;
  }, MIN_EDGE);
}

async function downloadAsset(
  page: import("playwright-core").Page,
  url: string,
  mode: "image" | "video",
): Promise<BrowserImagineAsset | undefined> {
  assertBrowserMediaUrl(url);
  let bytes: Uint8Array;
  let mime = "";
  if (url.startsWith("blob:")) {
    const packed = await page.evaluate(async (blobUrl) => {
      const response = await fetch(blobUrl);
      if (!response.ok) return undefined;
      const mimeType = response.headers.get("content-type") ?? "";
      const data = Array.from(new Uint8Array(await response.arrayBuffer()));
      return { mimeType, data };
    }, url);
    if (!packed) return undefined;
    bytes = Uint8Array.from(packed.data);
    mime = packed.mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  } else {
    const response = await page.context().request.get(url, { timeout: 60_000 });
    if (!response.ok()) return undefined;
    mime = headerFrom(response.headers(), "content-type");
    bytes = new Uint8Array(await response.body());
  }
  if (mime.includes("html") || mime.includes("json")) return undefined;
  const sniffed = sniffMedia(bytes, mode);
  const mimeType =
    sniffed ??
    (mode === "video" ? (mime.startsWith("video/") ? mime : undefined) : mime.startsWith("image/") ? mime : undefined);
  if (!mimeType) return undefined;
  const min = mode === "video" ? MIN_VIDEO_BYTES : MIN_IMAGE_BYTES;
  const max = mode === "video" ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  if (bytes.byteLength < min || bytes.byteLength > max) return undefined;
  const shareable = url.startsWith("https://") ? url : undefined;
  log.info(
    `Imagine browser ${mode} ready host=${shareable ? imageHost(shareable) : "local"} bytes=${bytes.byteLength}`,
  );
  return { bytes, mimeType, url: shareable };
}

async function bodyText(page: import("playwright-core").Page): Promise<string> {
  const text = await page
    .locator("body")
    .innerText({ timeout: 2_000 })
    .catch(() => "");
  return text.slice(0, 4_000);
}

function mapLaunchError(error: unknown, mode: "image" | "video"): unknown {
  if (error instanceof BrowserImagineError) return error;
  if (isChromeProfileLockError(error)) {
    return new BrowserImagineError(
      redactSecrets(error instanceof Error ? error.message : "profile locked"),
      IMAGINE_BROWSER_PROFILE_LOCKED_MESSAGE,
      "session",
    );
  }
  if (isChromeMissingError(error) || isMissingPlaywrightError(error)) {
    return new BrowserImagineError(
      redactSecrets(error instanceof Error ? error.message : "chrome missing"),
      IMAGINE_BROWSER_CHROME_MISSING_MESSAGE,
      "session",
    );
  }
  if (error instanceof Error && /timeout/i.test(error.message)) {
    return new BrowserImagineError(
      redactSecrets(error.message),
      mode === "video" ? VIDEO_BROWSER_TIMEOUT_MESSAGE : IMAGINE_BROWSER_TIMEOUT_MESSAGE,
    );
  }
  return new BrowserImagineError(
    redactSecrets(error instanceof Error ? error.message : "imagine browser failed"),
    mode === "video" ? VIDEO_BROWSER_FAILED_MESSAGE : IMAGINE_BROWSER_FAILED_MESSAGE,
  );
}

function header(response: import("playwright-core").Response, name: string): string {
  return headerFrom(response.headers(), name);
}

function headerFrom(headers: Record<string, string>, name: string): string {
  return (headers[name] ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

function sniffMedia(bytes: Uint8Array, mode: "image" | "video"): string | undefined {
  if (mode === "image") {
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
    if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
      return "image/png";
    }
    if (
      bytes.length >= 12 &&
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50
    ) {
      return "image/webp";
    }
    return undefined;
  }
  if (bytes.length >= 8 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    return "video/mp4";
  }
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return "video/webm";
  }
  return undefined;
}
