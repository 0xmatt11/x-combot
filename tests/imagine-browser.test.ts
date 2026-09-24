import { afterEach, describe, expect, it, vi } from "vitest";
import { ADULT_IMAGE_RETRY_MESSAGE } from "../src/bot/adult-filter.js";
import { ModerationEngine } from "../src/bot/engine.js";
import {
  assertBrowserMediaUrl,
  BrowserImagineError,
  classifyImaginePage,
  createUserFacingImagine,
  IMAGINE_BROWSER_LOGIN_MESSAGE,
  IMAGINE_BROWSER_NOT_CONFIGURED_MESSAGE,
  isChromeProfileLockError,
  pageLooksModerated,
  pageLooksTooLong,
  pickNewMediaUrl,
  textLooksLoggedOut,
  type BrowserImagineRequest,
} from "../src/bot/imagine-backend.js";
import { createPlaywrightImagineWorker } from "../src/bot/imagine-browser.js";
import {
  ImagineError,
  IMAGINE_MODERATED_INTRO,
  isImagineGenerationApiUrl,
  isShareableMediaUrl,
  resolveAdultImageProvider,
  resolveImagineBackend,
} from "../src/bot/imagine.js";
import { loadDefaults } from "../src/config.js";
import { loadEnv } from "../src/env.js";
import { Store } from "../src/store.js";
import type { BotRuntimeConfig, DefaultsConfig, DmEvent, XUser } from "../src/types.js";
import { MockXClient } from "../src/x/mock-client.js";
import { fetchGeneratedVideo, VIDEO_STARTED_MESSAGE } from "../src/bot/video.js";

const alice: XUser = { id: "u-alice", username: "alice", name: "Alice" };
const groupId = "1578398451921985538";
const chatGroupId = "g2029561975647150382";
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0x00, 0xd9]);
const mp4 = Uint8Array.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);

const defaults: DefaultsConfig = {
  welcome: { enabled: false, text: "Welcome @{username}!" },
  rules: "Be nice.",
  help: "Type !rules",
  flood: { max_messages: 5, window_ms: 10_000, mute_ms: 60_000, warn_on_flood: false },
  warns: { limit: 3, auto_mute_ms: 60_000, notify_admins: false },
  filters: [],
  poll: { interval_ms: 1000, max_results: 50 },
  delete: { attempt_on_filter: false, attempt_on_flood: false, attempt_on_mute: false },
  boobs: {
    enabled: true,
    vision: false,
    rate_limit_per_user: 0,
    rate_limit_per_conversation: 0,
    rate_limit_window_ms: 0,
  },
};

function runtime(): BotRuntimeConfig {
  return {
    botUserId: "bot-1",
    ownerId: "u-owner",
    globalAdminIds: [],
    defaults,
  };
}

function message(partial: Partial<DmEvent> & Pick<DmEvent, "id" | "text">): DmEvent {
  return {
    eventType: "MessageCreate",
    conversationId: groupId,
    senderId: alice.id,
    participantIds: [],
    participants: [],
    mentions: [],
    sender: alice,
    ...partial,
  };
}

describe("Imagine backend config", () => {
  const previous = {
    backend: process.env.IMAGINE_BACKEND,
    useBrowser: process.env.IMAGINE_USE_BROWSER,
    profile: process.env.IMAGINE_CHROME_PROFILE,
    cdp: process.env.IMAGINE_BROWSER_CDP_URL,
    headless: process.env.IMAGINE_BROWSER_HEADLESS,
    channel: process.env.IMAGINE_BROWSER_CHANNEL,
    timeout: process.env.IMAGINE_BROWSER_TIMEOUT_MS,
  };

  afterEach(() => {
    restore("IMAGINE_BACKEND", previous.backend);
    restore("IMAGINE_USE_BROWSER", previous.useBrowser);
    restore("IMAGINE_CHROME_PROFILE", previous.profile);
    restore("IMAGINE_BROWSER_CDP_URL", previous.cdp);
    restore("IMAGINE_BROWSER_HEADLESS", previous.headless);
    restore("IMAGINE_BROWSER_CHANNEL", previous.channel);
    restore("IMAGINE_BROWSER_TIMEOUT_MS", previous.timeout);
  });

  it("defaults to browser and lets an explicit backend win", () => {
    expect(resolveImagineBackend({})).toBe("browser");
    expect(resolveImagineBackend({ imagineUseBrowser: true })).toBe("browser");
    expect(resolveImagineBackend({ imagineUseBrowser: false })).toBe("api");
    expect(resolveImagineBackend({ imagineBackend: "api", imagineUseBrowser: true })).toBe("api");
    expect(resolveImagineBackend({ imagineBackend: "browser", imagineUseBrowser: false })).toBe("browser");
    expect(resolveImagineBackend({ imagineBackend: "gui" })).toBe("browser");
    expect(resolveImagineBackend({ imagineBackend: "web" })).toBe("browser");
    expect(() => resolveImagineBackend({ imagineBackend: "gpu" })).toThrow(/IMAGINE_BACKEND must be browser or api/);
  });

  it("parses IMAGINE_BACKEND and the Chrome session env", () => {
    process.env.BOT_OWNER_ID = process.env.BOT_OWNER_ID ?? "1";
    delete process.env.IMAGINE_BACKEND;
    delete process.env.IMAGINE_USE_BROWSER;
    delete process.env.IMAGINE_CHROME_PROFILE;
    delete process.env.IMAGINE_BROWSER_CDP_URL;
    delete process.env.IMAGINE_BROWSER_HEADLESS;
    delete process.env.IMAGINE_BROWSER_CHANNEL;
    delete process.env.IMAGINE_BROWSER_TIMEOUT_MS;
    expect(loadEnv(true).imagineBackend).toBe("browser");
    expect(loadEnv(true).imagineChromeProfile).toBeUndefined();
    expect(loadEnv(true).imagineBrowserCdpUrl).toBeUndefined();
    expect(loadEnv(true).imagineBrowserHeadless).toBeUndefined();

    process.env.IMAGINE_USE_BROWSER = "false";
    expect(loadEnv(true).imagineBackend).toBe("api");
    process.env.IMAGINE_BACKEND = "browser";
    expect(loadEnv(true).imagineBackend).toBe("browser");
    process.env.IMAGINE_BACKEND = "api";
    expect(loadEnv(true).imagineBackend).toBe("api");
    process.env.IMAGINE_BACKEND = "nope";
    expect(() => loadEnv(true)).toThrow(/IMAGINE_BACKEND/);

    delete process.env.IMAGINE_BACKEND;
    delete process.env.IMAGINE_USE_BROWSER;
    process.env.IMAGINE_CHROME_PROFILE = "chrome-grok";
    process.env.IMAGINE_BROWSER_CDP_URL = "http://127.0.0.1:9222";
    process.env.IMAGINE_BROWSER_HEADLESS = "true";
    process.env.IMAGINE_BROWSER_CHANNEL = "chrome";
    process.env.IMAGINE_BROWSER_TIMEOUT_MS = "15000";
    const loaded = loadEnv(true);
    expect(loaded.imagineChromeProfile).toMatch(/chrome-grok$/);
    expect(loaded.imagineChromeProfile?.startsWith("/")).toBe(true);
    expect(loaded.imagineBrowserCdpUrl).toBe("http://127.0.0.1:9222/");
    expect(loaded.imagineBrowserHeadless).toBe(true);
    expect(loaded.imagineBrowserChannel).toBe("chrome");
    expect(loaded.imagineBrowserTimeoutMs).toBe(15_000);

    process.env.IMAGINE_BROWSER_CDP_URL = "not a url";
    expect(() => loadEnv(true)).toThrow(/IMAGINE_BROWSER_CDP_URL/);
    delete process.env.IMAGINE_BROWSER_CDP_URL;
    process.env.IMAGINE_BROWSER_TIMEOUT_MS = "50";
    expect(() => loadEnv(true)).toThrow(/IMAGINE_BROWSER_TIMEOUT_MS/);
    process.env.IMAGINE_USE_BROWSER = "maybe";
    expect(() => loadEnv(true)).toThrow(/IMAGINE_USE_BROWSER/);
  });

  it("uses Imagine without an API key when the backend is browser", () => {
    expect(resolveAdultImageProvider({ backend: "browser" })).toEqual({
      provider: "imagine",
      imagineKeyMissing: false,
    });
    expect(resolveAdultImageProvider({ backend: "browser", provider: "search", apiKey: "xai" })).toEqual({
      provider: "search",
      imagineKeyMissing: false,
    });
    expect(resolveAdultImageProvider({ backend: "api" })).toEqual({
      provider: "search",
      imagineKeyMissing: false,
    });
  });

  it("mentions the browser session in the default help text", () => {
    const help = loadDefaults("config/default.yaml").help;
    expect(help).toMatch(/!imagine/);
    expect(help).toMatch(/!video/);
    expect(help).toMatch(/grok\.com\/imagine/);
    expect(help).not.toMatch(/needs an xAI key/);
  });
});

describe("browser mode never calls the generations API", () => {
  it("drops api.x.ai image and video generation URLs and keeps other hosts", () => {
    expect(isImagineGenerationApiUrl("https://api.x.ai/v1/images/generations")).toBe(true);
    expect(isImagineGenerationApiUrl("https://api.x.ai/v1/images/generations?n=1")).toBe(true);
    expect(isImagineGenerationApiUrl("https://api.x.ai/v1/videos/generations")).toBe(true);
    expect(isImagineGenerationApiUrl("https://api.x.ai/v1/videos/req_123")).toBe(true);
    expect(isImagineGenerationApiUrl("http://api.x.ai/v1/videos/req_123")).toBe(true);
    expect(isImagineGenerationApiUrl("https://api.x.ai/v1/chat/completions")).toBe(false);
    expect(isImagineGenerationApiUrl("https://api.x.ai/v1/tts")).toBe(false);
    expect(isImagineGenerationApiUrl("https://imagine-public.x.ai/imagine-public/images/x.jpg")).toBe(false);
    expect(isImagineGenerationApiUrl("https://grok.com/imagine")).toBe(false);
    expect(isShareableMediaUrl("https://grok.com/imagine")).toBe(false);
    expect(isShareableMediaUrl("https://assets.grok.com/clip.mp4")).toBe(true);
    expect(() => assertBrowserMediaUrl("https://api.x.ai/v1/images/generations")).toThrow(BrowserImagineError);
    expect(() => assertBrowserMediaUrl("https://assets.grok.com/cat.jpg")).not.toThrow();
  });

  it("does not download a generation route", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("generation HTTP client was called");
    });
    await expect(fetchGeneratedVideo("https://api.x.ai/v1/videos/generations", fetchImpl)).resolves.toBeUndefined();
    await expect(fetchGeneratedVideo("https://api.x.ai/v1/videos/abc", fetchImpl)).resolves.toBeUndefined();
    await expect(fetchGeneratedVideo("https://api.x.ai/v1/images/generations", fetchImpl)).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("serves image and video from the mock worker and never calls fetch", async () => {
    const calls: BrowserImagineRequest[] = [];
    const fetchImpl = vi.fn(async () => {
      throw new Error("api.x.ai generation client was called");
    });
    const worker = {
      async generate(request: BrowserImagineRequest) {
        calls.push(request);
        if (request.mode === "video") {
          return { bytes: mp4, mimeType: "video/mp4", url: "https://api.x.ai/v1/videos/generations" };
        }
        return { bytes: jpeg, mimeType: "image/jpeg", url: "https://api.x.ai/v1/images/generations" };
      },
    };
    const facing = createUserFacingImagine({
      backend: "browser",
      apiKey: "should-not-be-sent",
      aspectRatio: "3:4",
      videoDuration: 5,
      videoAspectRatio: "16:9",
      videoResolution: "720p",
      fetchImpl,
      worker,
    });
    const image = await facing.imagine!.generate("a neon cat");
    const video = await facing.video!.generate("a paper boat");
    expect(calls.map((call) => call.mode)).toEqual(["image", "video"]);
    expect(calls[0]).toMatchObject({ prompt: "a neon cat", aspectRatio: "3:4" });
    expect(calls[1]).toMatchObject({ prompt: "a paper boat", durationSeconds: 5, aspectRatio: "16:9" });
    expect(image.bytes).toBe(jpeg);
    expect(image.url).toBeUndefined();
    expect(video.bytes).toBe(mp4);
    expect(video.url).toBe("");
    expect(video.width).toBe(1280);
    expect(video.height).toBe(720);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps the API client only when the backend is api", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const target = String(url);
      if (target.endsWith("/images/generations")) {
        return new Response(JSON.stringify({ data: [{ url: "https://imgen.x.ai/cat.jpg" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ request_id: "abcdefghij" }), { status: 200 });
    });
    const browserFetch = vi.fn(async () => {
      throw new Error("browser mode must not build the API client");
    });
    const api = createUserFacingImagine({
      backend: "api",
      apiKey: "test-key",
      fetchImpl,
    });
    await expect(api.imagine!.generate("a neon cat")).resolves.toEqual({ url: "https://imgen.x.ai/cat.jpg" });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("https://api.x.ai/v1/images/generations");

    const blocked = createUserFacingImagine({
      backend: "browser",
      apiKey: "test-key",
      fetchImpl: browserFetch,
      worker: {
        async generate() {
          return { bytes: jpeg, mimeType: "image/jpeg" };
        },
      },
    });
    await blocked.imagine!.generate("a neon cat");
    expect(browserFetch).not.toHaveBeenCalled();
    expect(createUserFacingImagine({ backend: "api" }).imagine).toBeUndefined();
  });

  it("fails closed when the Chrome session is not configured", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("api.x.ai generation client was called");
    });
    const facing = createUserFacingImagine({
      backend: "browser",
      apiKey: "should-not-be-sent",
      fetchImpl,
    });
    await expect(facing.imagine!.generate("a neon cat")).rejects.toMatchObject({
      kind: "session",
      userMessage: IMAGINE_BROWSER_NOT_CONFIGURED_MESSAGE,
    });
    await expect(facing.video!.generate("a paper boat")).rejects.toMatchObject({
      kind: "session",
    });
    expect(fetchImpl).not.toHaveBeenCalled();

    const direct = createPlaywrightImagineWorker({});
    await expect(direct.generate({ mode: "image", prompt: "a neon cat" })).rejects.toMatchObject({
      kind: "session",
      userMessage: IMAGINE_BROWSER_NOT_CONFIGURED_MESSAGE,
    });
  });
});

describe("browser Imagine page checks", () => {
  it("classifies a signed-in composer, a login redirect, and moderation copy", () => {
    expect(classifyImaginePage({ url: "https://grok.com/imagine", hasPrompt: true })).toBe("ready");
    expect(classifyImaginePage({ url: "https://accounts.x.ai/login", hasPrompt: false })).toBe("login");
    expect(classifyImaginePage({ url: "https://grok.com/imagine", hasPrompt: false })).toBe("unknown");
    expect(textLooksLoggedOut("Sign in to Grok")).toBe(true);
    expect(pageLooksModerated("That request was blocked by content moderation.", "a cat")).toBe(true);
    expect(pageLooksModerated("content moderation in the prompt itself please", "content moderation in the prompt itself please")).toBe(
      false,
    );
    expect(pageLooksTooLong("Prompt is too long", "short")).toBe(true);
    expect(
      isChromeProfileLockError(new Error("Failed to create a ProcessSingleton for your profile directory")),
    ).toBe(true);
    expect(pickNewMediaUrl(["https://assets.grok.com/old.jpg"], ["https://assets.grok.com/old.jpg", "https://assets.grok.com/new.jpg"])).toBe(
      "https://assets.grok.com/new.jpg",
    );
    expect(
      pickNewMediaUrl([], ["https://api.x.ai/v1/images/generations", "https://cdn.example/favicon.ico"]),
    ).toBeUndefined();
  });
});

describe("browser Imagine in the engine", () => {
  const stores: Store[] = [];

  afterEach(() => {
    for (const store of stores) store.close();
    stores.length = 0;
  });

  it("posts !imagine bytes without fetching a URL", async () => {
    const store = new Store(":memory:");
    stores.push(store);
    const client = new MockXClient();
    const fetches: string[] = [];
    const { imagine } = createUserFacingImagine({
      backend: "browser",
      worker: {
        async generate() {
          return { bytes: jpeg, mimeType: "image/jpeg" };
        },
      },
    });
    const engine = new ModerationEngine(store, client, runtime(), undefined, {
      imagine,
      fetchImage: async (url) => {
        fetches.push(url);
        throw new Error("image HTTP client was called");
      },
    });
    await engine.processEvent(message({ id: "img-1", text: "!imagine a neon cat" }));
    expect(fetches).toEqual([]);
    expect(client.images).toEqual([
      {
        conversationId: groupId,
        url: "https://grok.com/imagine",
        mimeType: "image/jpeg",
        bytes: jpeg.byteLength,
      },
    ]);
    expect(client.sent).toHaveLength(0);
  });

  it("posts !video bytes in Chat and does not download", async () => {
    const store = new Store(":memory:");
    stores.push(store);
    store.authorizeChat(chatGroupId);
    const client = new MockXClient();
    const downloads: string[] = [];
    const { video } = createUserFacingImagine({
      backend: "browser",
      videoAspectRatio: "16:9",
      videoResolution: "720p",
      worker: {
        async generate(request) {
          expect(request.mode).toBe("video");
          return { bytes: mp4, mimeType: "video/mp4" };
        },
      },
    });
    const engine = new ModerationEngine(store, client, runtime(), undefined, {
      video,
      fetchVideo: async (url) => {
        downloads.push(url);
        throw new Error("video HTTP client was called");
      },
    });
    const actions = await engine.processEvent(
      message({ id: "vid-1", conversationId: chatGroupId, text: "!video a paper boat" }),
    );
    await engine.waitForBackgroundWork();
    expect(downloads).toEqual([]);
    expect(actions.replies).toEqual([VIDEO_STARTED_MESSAGE]);
    expect(client.videos).toEqual([
      {
        conversationId: chatGroupId,
        url: "https://grok.com/imagine",
        mimeType: "video/mp4",
        bytes: mp4.byteLength,
        width: 1280,
        height: 720,
      },
    ]);
  });

  it("does not call Imagine for adult commands when the browser session is signed out", async () => {
    const store = new Store(":memory:");
    stores.push(store);
    const client = new MockXClient();
    let searches = 0;
    let generates = 0;
    const engine = new ModerationEngine(store, client, runtime(), undefined, {
      imagine: {
        async generate() {
          generates += 1;
          throw new ImagineError("Chrome session is not signed in", IMAGINE_BROWSER_LOGIN_MESSAGE, "session");
        },
      },
      imageSearch: {
        async searchAdultChestImages() {
          searches += 1;
          return [];
        },
        async searchAdultBootyImages() {
          searches += 1;
          return [];
        },
      },
      fetchImage: async () => {
        throw new Error("cdn fetch");
      },
    });
    await engine.processEvent(message({ id: "boobs-1", text: "!boobs" }));
    await engine.processEvent(message({ id: "ass-1", text: "!ass" }));
    await engine.processEvent(message({ id: "booty-1", text: "!booty" }));
    await engine.processEvent(message({ id: "img-2", text: "!imagine a neon cat" }));
    expect(generates).toBe(1);
    expect(searches).toBe(3);
    expect(client.images).toHaveLength(0);
    expect(client.sent.map((row) => row.text)).toEqual([
      ADULT_IMAGE_RETRY_MESSAGE,
      ADULT_IMAGE_RETRY_MESSAGE,
      ADULT_IMAGE_RETRY_MESSAGE,
      IMAGINE_BROWSER_LOGIN_MESSAGE,
    ]);
    expect(client.sent.map((row) => row.text).join("\n")).not.toMatch(/XAI_API_KEY/);
  });

  it("maps a browser moderation error onto the five-prompt reply", async () => {
    const store = new Store(":memory:");
    stores.push(store);
    const client = new MockXClient();
    const { imagine } = createUserFacingImagine({
      backend: "browser",
      worker: {
        async generate() {
          throw new BrowserImagineError("blocked", "ignored", "moderated");
        },
      },
    });
    const engine = new ModerationEngine(store, client, runtime(), undefined, { imagine });
    await engine.processEvent(message({ id: "mod-1", text: "!imagine a neon cat" }));
    expect(client.sent[0]?.text.startsWith(IMAGINE_MODERATED_INTRO)).toBe(true);
    expect(client.sent[0]?.text.match(/^\d\./gm)).toHaveLength(5);
  });
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
