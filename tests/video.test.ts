import { afterEach, describe, expect, it, vi } from "vitest";
import { ModerationEngine } from "../src/bot/engine.js";
import {
  IMAGINE_REFUSED_MESSAGE,
  IMAGINE_SUGGESTION_COUNT,
} from "../src/bot/imagine.js";
import { loadDefaults } from "../src/config.js";
import { loadEnv } from "../src/env.js";
import { MockLlmClient } from "../src/llm/mock.js";
import { Store } from "../src/store.js";
import type { BotRuntimeConfig, DefaultsConfig, DmEvent, XUser } from "../src/types.js";
import { MockXClient } from "../src/x/mock-client.js";
import {
  createVideoClient,
  DEFAULT_VIDEO_ASPECT_RATIO,
  DEFAULT_VIDEO_DURATION,
  DEFAULT_VIDEO_MODEL,
  DEFAULT_VIDEO_RESOLUTION,
  fetchGeneratedVideo,
  formatVideoReadyMessage,
  VIDEO_EMPTY_MESSAGE,
  VIDEO_EXPIRED_MESSAGE,
  VIDEO_FAILED_MESSAGE,
  VIDEO_MODERATED_INTRO,
  VIDEO_STARTED_MESSAGE,
  VIDEO_TIMEOUT_MESSAGE,
  VIDEO_TOO_LONG_MESSAGE,
  VIDEO_UNAVAILABLE_MESSAGE,
  VideoError,
  videoFrameSize,
  normalizeVideoPrompt,
} from "../src/bot/video.js";

const alice: XUser = { id: "u-alice", username: "alice", name: "Alice" };
const classicGroupId = "1578398451921985538";
const chatGroupId = "g2029561975647150382";
const VIDEO_URL = "https://vidgen.x.ai/clip.mp4";
const REQUEST_ID = "d97415a1-5796-b7ec-379f-4e6819e08fdf";

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
    enabled: false,
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
    conversationId: classicGroupId,
    senderId: alice.id,
    participantIds: [],
    participants: [],
    mentions: [],
    sender: alice,
    ...partial,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function doneBody(over: Record<string, unknown> = {}) {
  return {
    status: "done",
    video: {
      url: VIDEO_URL,
      duration: 5,
      respect_moderation: true,
    },
    model: DEFAULT_VIDEO_MODEL,
    ...over,
  };
}

describe("video prompt checks", () => {
  it("trims a prompt, keeps long text, and refuses minor wording", () => {
    const longPrompt = "a".repeat(2000);
    expect(normalizeVideoPrompt("  a paper boat  ")).toEqual({
      ok: true,
      prompt: "a paper boat",
    });
    expect(normalizeVideoPrompt("   ")).toEqual({ ok: false, reason: "empty" });
    expect(normalizeVideoPrompt(longPrompt)).toEqual({ ok: true, prompt: longPrompt });
    expect(normalizeVideoPrompt("teen portrait")).toEqual({ ok: false, reason: "refused" });
    expect(VIDEO_EMPTY_MESSAGE).toMatch(/!video a paper boat/);
  });

  it("maps resolution and aspect ratio onto an even frame", () => {
    expect(videoFrameSize("16:9", "720p")).toEqual({ width: 1280, height: 720 });
    expect(videoFrameSize("9:16", "720p")).toEqual({ width: 720, height: 1280 });
    expect(videoFrameSize("1:1", "1080p")).toEqual({ width: 1080, height: 1080 });
    expect(videoFrameSize("4:3", "480p")).toEqual({ width: 640, height: 480 });
  });
});

describe("video env", () => {
  it("reads video env flags and rejects unknown values", () => {
    process.env.BOT_OWNER_ID = process.env.BOT_OWNER_ID ?? "1";
    const previous = {
      model: process.env.VIDEO_IMAGINE_MODEL,
      duration: process.env.VIDEO_IMAGINE_DURATION,
      ratio: process.env.VIDEO_IMAGINE_ASPECT_RATIO,
      resolution: process.env.VIDEO_IMAGINE_RESOLUTION,
    };
    try {
      delete process.env.VIDEO_IMAGINE_MODEL;
      delete process.env.VIDEO_IMAGINE_DURATION;
      delete process.env.VIDEO_IMAGINE_ASPECT_RATIO;
      delete process.env.VIDEO_IMAGINE_RESOLUTION;
      expect(loadEnv(true).videoImagineModel).toBeUndefined();
      expect(loadEnv(true).videoImagineDuration).toBeUndefined();
      expect(loadEnv(true).videoImagineAspectRatio).toBeUndefined();
      expect(loadEnv(true).videoImagineResolution).toBeUndefined();

      process.env.VIDEO_IMAGINE_MODEL = "grok-imagine-video-1.5";
      expect(loadEnv(true).videoImagineModel).toBe("grok-imagine-video-1.5");
      process.env.VIDEO_IMAGINE_MODEL = "grok-imagine-video";
      expect(loadEnv(true).videoImagineModel).toBe("grok-imagine-video");
      process.env.VIDEO_IMAGINE_MODEL = "grok-imagine-image-quality";
      expect(() => loadEnv(true)).toThrow(/VIDEO_IMAGINE_MODEL/);
      delete process.env.VIDEO_IMAGINE_MODEL;

      process.env.VIDEO_IMAGINE_DURATION = "8";
      expect(loadEnv(true).videoImagineDuration).toBe(8);
      process.env.VIDEO_IMAGINE_DURATION = "0";
      expect(() => loadEnv(true)).toThrow(/VIDEO_IMAGINE_DURATION/);
      process.env.VIDEO_IMAGINE_DURATION = "16";
      expect(() => loadEnv(true)).toThrow(/VIDEO_IMAGINE_DURATION/);
      process.env.VIDEO_IMAGINE_DURATION = "5.5";
      expect(() => loadEnv(true)).toThrow(/VIDEO_IMAGINE_DURATION/);
      delete process.env.VIDEO_IMAGINE_DURATION;

      process.env.VIDEO_IMAGINE_ASPECT_RATIO = "9:16";
      expect(loadEnv(true).videoImagineAspectRatio).toBe("9:16");
      process.env.VIDEO_IMAGINE_ASPECT_RATIO = "auto";
      expect(() => loadEnv(true)).toThrow(/VIDEO_IMAGINE_ASPECT_RATIO/);
      delete process.env.VIDEO_IMAGINE_ASPECT_RATIO;

      process.env.VIDEO_IMAGINE_RESOLUTION = "1080p";
      expect(loadEnv(true).videoImagineResolution).toBe("1080p");
      process.env.VIDEO_IMAGINE_RESOLUTION = "4k";
      expect(() => loadEnv(true)).toThrow(/VIDEO_IMAGINE_RESOLUTION/);
    } finally {
      restoreEnv("VIDEO_IMAGINE_MODEL", previous.model);
      restoreEnv("VIDEO_IMAGINE_DURATION", previous.duration);
      restoreEnv("VIDEO_IMAGINE_ASPECT_RATIO", previous.ratio);
      restoreEnv("VIDEO_IMAGINE_RESOLUTION", previous.resolution);
    }
  });
});

describe("Grok Imagine video client", () => {
  it("starts a generation and polls until the video url is ready", async () => {
    const sleeps: number[] = [];
    const calls: { url: string; method: string; body?: unknown; authorization?: string }[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const headers = init?.headers as Record<string, string> | undefined;
      calls.push({
        url: String(url),
        method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        authorization: headers?.Authorization,
      });
      if (method === "POST") return jsonResponse({ request_id: REQUEST_ID });
      if (calls.filter((call) => call.method === "GET").length === 1) {
        return jsonResponse({ status: "pending" });
      }
      return jsonResponse(doneBody());
    });
    const client = createVideoClient({
      apiKey: "test-key",
      fetchImpl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      pollIntervalMs: 3_000,
      pollMaxIntervalMs: 5_000,
      timeoutMs: 60_000,
    });
    const video = await client.generate("a paper boat drifting down a rain-soaked street");
    expect(video).toEqual({
      url: VIDEO_URL,
      duration: 5,
      width: 1280,
      height: 720,
    });
    expect(calls.map((call) => call.authorization)).toEqual([
      "Bearer test-key",
      "Bearer test-key",
      "Bearer test-key",
    ]);
    expect(calls[0]).toMatchObject({
      url: "https://api.x.ai/v1/videos/generations",
      method: "POST",
      body: {
        model: DEFAULT_VIDEO_MODEL,
        prompt: "a paper boat drifting down a rain-soaked street",
        duration: DEFAULT_VIDEO_DURATION,
        aspect_ratio: DEFAULT_VIDEO_ASPECT_RATIO,
        resolution: DEFAULT_VIDEO_RESOLUTION,
      },
    });
    expect(calls[0]?.body).not.toHaveProperty("generate_audio");
    expect(calls[1]?.url).toBe(`https://api.x.ai/v1/videos/${REQUEST_ID}`);
    expect(calls[2]?.url).toBe(`https://api.x.ai/v1/videos/${REQUEST_ID}`);
    expect(sleeps).toEqual([3_000]);
  });

  it("sends duration, aspect ratio, resolution, and silence when configured", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({
          model: "grok-imagine-video",
          prompt: "rain",
          duration: 8,
          aspect_ratio: "9:16",
          resolution: "1080p",
          generate_audio: false,
        });
        return jsonResponse({ request_id: REQUEST_ID });
      }
      return jsonResponse(doneBody({ video: { url: VIDEO_URL, duration: 8, respect_moderation: true } }));
    });
    const client = createVideoClient({
      apiKey: "test-key",
      model: "grok-imagine-video",
      duration: 8,
      aspectRatio: "9:16",
      resolution: "1080p",
      generateAudio: false,
      fetchImpl,
      sleep: async () => {},
    });
    await expect(client.generate("rain")).resolves.toMatchObject({
      url: VIDEO_URL,
      duration: 8,
      width: 1080,
      height: 1920,
    });
  });

  it("treats respect_moderation false as a moderation failure and hides the raw body", async () => {
    const client = createVideoClient({
      apiKey: "test-key",
      fetchImpl: async (_url, init) => {
        if (init?.method === "POST") return jsonResponse({ request_id: REQUEST_ID });
        return jsonResponse({
          status: "done",
          video: { url: VIDEO_URL, duration: 5, respect_moderation: false },
          cost_ticks: 9,
        });
      },
      sleep: async () => {},
    });
    const error = await client.generate("a nude scene").then(
      () => {
        throw new Error("expected video to fail");
      },
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(VideoError);
    const videoError = error as VideoError;
    expect(videoError.kind).toBe("moderated");
    expect(videoError.userMessage).toBe(VIDEO_MODERATED_INTRO);
    expect(videoError.userMessage).not.toMatch(/cost_ticks|\{|https:\/\//);
  });

  it("classifies a moderation HTTP error and a length rejection without a local cap", async () => {
    const moderated = createVideoClient({
      apiKey: "test-key",
      fetchImpl: async () =>
        jsonResponse(
          {
            code: "imagine:content-moderated",
            error: "Generated video rejected by content moderation.",
            cost_ticks: 4,
          },
          400,
        ),
    });
    await expect(moderated.generate("cat")).rejects.toMatchObject({
      kind: "moderated",
      userMessage: VIDEO_MODERATED_INTRO,
    });

    const tooLong = createVideoClient({
      apiKey: "test-key",
      fetchImpl: async () =>
        jsonResponse(
          {
            code: "imagine:prompt-too-long",
            error: "Prompt exceeds the maximum length.",
            cost_ticks: 1,
          },
          400,
        ),
    });
    const error = await tooLong.generate("a".repeat(2000)).then(
      () => {
        throw new Error("expected video to fail");
      },
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(VideoError);
    const videoError = error as VideoError;
    expect(videoError.kind).toBe("failed");
    expect(videoError.userMessage).toBe(VIDEO_TOO_LONG_MESSAGE);
    expect(videoError.userMessage).not.toMatch(/cost_ticks|800/);
  });

  it("uses a short line for failed, expired, and other HTTP errors", async () => {
    const failed = createVideoClient({
      apiKey: "test-key",
      fetchImpl: async (_url, init) => {
        if (init?.method === "POST") return jsonResponse({ request_id: REQUEST_ID });
        return jsonResponse({ status: "failed", error: "overloaded", cost_ticks: 2 });
      },
      sleep: async () => {},
    });
    await expect(failed.generate("cat")).rejects.toMatchObject({
      kind: "failed",
      userMessage: VIDEO_FAILED_MESSAGE,
    });

    const expired = createVideoClient({
      apiKey: "test-key",
      fetchImpl: async (_url, init) => {
        if (init?.method === "POST") return jsonResponse({ request_id: REQUEST_ID });
        return jsonResponse({ status: "expired" });
      },
      sleep: async () => {},
    });
    await expect(expired.generate("cat")).rejects.toMatchObject({ userMessage: VIDEO_EXPIRED_MESSAGE });

    const overloaded = createVideoClient({
      apiKey: "test-key",
      fetchImpl: async () => jsonResponse({ code: "unavailable", error: "overloaded", cost_ticks: 1 }, 503),
    });
    const error = await overloaded.generate("cat").then(
      () => {
        throw new Error("expected video to fail");
      },
      (caught: unknown) => caught,
    );
    expect((error as VideoError).userMessage).toBe(VIDEO_FAILED_MESSAGE);
    expect((error as VideoError).userMessage).not.toMatch(/cost_ticks|overloaded/);
  });

  it("backs off from 3s toward 5s and times out", async () => {
    const sleeps: number[] = [];
    const client = createVideoClient({
      apiKey: "test-key",
      fetchImpl: async (_url, init) => {
        if (init?.method === "POST") return jsonResponse({ request_id: REQUEST_ID });
        return jsonResponse({ status: "pending" });
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      pollIntervalMs: 3_000,
      pollMaxIntervalMs: 5_000,
      timeoutMs: 7_000,
    });
    await expect(client.generate("cat")).rejects.toMatchObject({ userMessage: VIDEO_TIMEOUT_MESSAGE });
    expect(sleeps).toEqual([3_000, 4_000]);
  });
});

describe("fetchGeneratedVideo", () => {
  it("downloads an https mp4 and skips other payloads", async () => {
    const mp4 = Uint8Array.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 1, 2]);
    const fetched = await fetchGeneratedVideo(VIDEO_URL, async () => {
      return new Response(mp4, { status: 200, headers: { "content-type": "video/mp4" } });
    });
    expect(fetched).toEqual({ bytes: mp4, mimeType: "video/mp4" });

    const image = await fetchGeneratedVideo(VIDEO_URL, async () => {
      return new Response(Uint8Array.from([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    });
    expect(image).toBeUndefined();
    await expect(fetchGeneratedVideo("http://vidgen.x.ai/clip.mp4", async () => new Response())).resolves.toBeUndefined();
  });
});

describe("!video command", () => {
  const stores: Store[] = [];

  afterEach(() => {
    for (const store of stores) store.close();
    stores.length = 0;
  });

  function setup(options?: {
    video?: boolean;
    failSendVideo?: boolean;
    generateError?: Error;
    llm?: MockLlmClient;
    conversationId?: string;
    fetchVideo?: boolean;
  }) {
    const store = new Store(":memory:");
    stores.push(store);
    store.authorizeChat(chatGroupId);
    const client = new MockXClient();
    client.failSendVideo = options?.failSendVideo ?? false;
    const video = {
      prompts: [] as string[],
      async generate(prompt: string) {
        video.prompts.push(prompt);
        if (options?.generateError) throw options.generateError;
        return { url: VIDEO_URL, duration: 5, width: 1280, height: 720 };
      },
    };
    const fetches: string[] = [];
    const engine = new ModerationEngine(store, client, runtime(), options?.llm, {
      video: options?.video === false ? undefined : video,
      fetchVideo:
        options?.fetchVideo === false
          ? undefined
          : async (url) => {
              fetches.push(url);
              return { bytes: Uint8Array.from([9, 8, 7, 6]), mimeType: "video/mp4" };
            },
    });
    return { engine, client, video, fetches };
  }

  async function run(engine: ModerationEngine, event: DmEvent) {
    const actions = await engine.processEvent(event);
    await engine.waitForBackgroundWork();
    return actions;
  }

  it("acks, then posts a native Chat video after start and poll", async () => {
    const sleeps: number[] = [];
    let posts = 0;
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts += 1;
        return jsonResponse({ request_id: REQUEST_ID });
      }
      if (posts === 1 && sleeps.length === 0) return jsonResponse({ status: "pending" });
      return jsonResponse(doneBody());
    });
    let releaseSleep = () => {};
    const sleepGate = new Promise<void>((resolve) => {
      releaseSleep = resolve;
    });
    const store = new Store(":memory:");
    stores.push(store);
    store.authorizeChat(chatGroupId);
    const client = new MockXClient();
    const engine = new ModerationEngine(store, client, runtime(), undefined, {
      video: createVideoClient({
        apiKey: "test-key",
        fetchImpl,
        sleep: async (ms) => {
          sleeps.push(ms);
          await sleepGate;
        },
        pollIntervalMs: 3_000,
        timeoutMs: 60_000,
      }),
      fetchVideo: async () => ({ bytes: Uint8Array.from([1, 2, 3, 4]), mimeType: "video/mp4" }),
    });
    const pending = engine.processEvent(
      message({
        id: "live-1",
        conversationId: chatGroupId,
        text: "!video a paper boat drifting down a rain-soaked street",
      }),
    );
    const started = await pending;
    await vi.waitUntil(() => sleeps.length === 1);
    expect(started.replies).toEqual([VIDEO_STARTED_MESSAGE]);
    expect(client.sent.map((row) => row.text)).toEqual([VIDEO_STARTED_MESSAGE]);
    expect(client.videos).toHaveLength(0);
    releaseSleep();
    await engine.waitForBackgroundWork();
    expect(sleeps).toEqual([3_000]);
    expect(client.videos).toEqual([
      {
        conversationId: chatGroupId,
        url: VIDEO_URL,
        mimeType: "video/mp4",
        bytes: 4,
        width: 1280,
        height: 720,
      },
    ]);
    expect(client.sent.map((row) => row.text)).toEqual([VIDEO_STARTED_MESSAGE]);
    expect(started.replies).toEqual([VIDEO_STARTED_MESSAGE]);
  });

  it("posts the temporary url with a note in a classic group DM", async () => {
    const { engine, client, video, fetches } = setup();
    const actions = await run(
      engine,
      message({ id: "dm-1", text: "!video   a paper boat drifting  " }),
    );
    expect(video.prompts).toEqual(["a paper boat drifting"]);
    expect(fetches).toHaveLength(0);
    expect(client.videos).toHaveLength(0);
    expect(actions.replies).toEqual([
      VIDEO_STARTED_MESSAGE,
      formatVideoReadyMessage(VIDEO_URL),
    ]);
    expect(actions.replies[1]).toMatch(/temporary/);
    expect(actions.replies[1]).toContain(VIDEO_URL);
  });

  it("posts the temporary url when Chat upload fails", async () => {
    const { engine, client } = setup({ failSendVideo: true });
    const actions = await run(
      engine,
      message({ id: "chat-fail", conversationId: chatGroupId, text: "!video a paper boat" }),
    );
    expect(client.videos).toHaveLength(0);
    expect(actions.replies[0]).toBe(VIDEO_STARTED_MESSAGE);
    expect(actions.replies[1]).toBe(formatVideoReadyMessage(VIDEO_URL));
  });

  it("rejects an empty prompt and minor wording, and sends a long prompt", async () => {
    const longPrompt = "b".repeat(2000);
    const { engine, client, video } = setup();
    await run(engine, message({ id: "empty", text: "!video" }));
    await run(engine, message({ id: "blank", text: "!video   " }));
    await run(engine, message({ id: "long", text: `!video ${longPrompt}` }));
    await run(engine, message({ id: "teen", text: "!video teen portrait" }));
    expect(video.prompts).toEqual([longPrompt]);
    const text = client.sent.map((row) => row.text).join("\n");
    expect(text).toMatch(/!video a paper boat/);
    expect(text).not.toMatch(/too long/i);
    expect(text).toMatch(/not allowed/);
    expect(text).toContain(IMAGINE_REFUSED_MESSAGE);
    expect(text).not.toMatch(/teen/);
    expect(client.sent.filter((row) => row.text === VIDEO_STARTED_MESSAGE)).toHaveLength(1);

    const missing = setup({ video: false });
    await run(missing.engine, message({ id: "nokey", text: "!video a paper boat" }));
    expect(missing.client.sent[0]?.text).toBe(VIDEO_UNAVAILABLE_MESSAGE);
    expect(missing.client.sent[0]?.text).toMatch(/XAI_API_KEY/);
  });

  it("is listed in the default help text", () => {
    const loaded = loadDefaults("config/default.yaml");
    expect(loaded.help).toMatch(/!video/);
  });

  it("posts a moderation reply with five prompts and no raw API payload", async () => {
    const { engine, client, video } = setup({
      generateError: new VideoError(
        'Video moderation: {"cost_ticks":4,"error":"content moderation"}',
        VIDEO_MODERATED_INTRO,
        "moderated",
      ),
    });
    const actions = await run(
      engine,
      message({ id: "mod-1", text: "!video a nude woman on a beach at sunset" }),
    );
    expect(video.prompts).toEqual(["a nude woman on a beach at sunset"]);
    expect(client.videos).toHaveLength(0);
    const text = client.sent.map((row) => row.text).join("\n");
    expect(client.sent[0]?.text).toBe(VIDEO_STARTED_MESSAGE);
    expect(client.sent[1]?.text.startsWith(VIDEO_MODERATED_INTRO)).toBe(true);
    expect(numberedPrompts(client.sent[1]?.text ?? "")).toHaveLength(IMAGINE_SUGGESTION_COUNT);
    expect(text).not.toMatch(/cost_ticks|\{/);
    expect(text).not.toMatch(/\b(nude|naked|cleavage|porn)\b/i);
    expect(client.sent[1]?.text).toMatch(/beach|sunset|woman/i);
    expect(actions.replies[1]).toBe(client.sent[1]?.text);
  });

  it("uses the chat model for the five prompts when one is configured", async () => {
    const llm = new MockLlmClient(
      [
        "1. a woman in a linen dress on a beach at sunset",
        "2. a watercolor of waves at sunset",
        "3. a fashion photograph of a summer coat by the shore",
        "4. a wide landscape of a quiet beach",
        "5. an illustration of seashells at dusk",
      ].join("\n"),
    );
    const { engine, client } = setup({
      generateError: new VideoError("moderated", VIDEO_MODERATED_INTRO, "moderated"),
      llm,
    });
    await run(engine, message({ id: "mod-llm", text: "!video a nude woman on a beach at sunset" }));
    expect(numberedPrompts(client.sent[1]?.text ?? "")).toEqual([
      "a woman in a linen dress on a beach at sunset",
      "a watercolor of waves at sunset",
      "a fashion photograph of a summer coat by the shore",
      "a wide landscape of a quiet beach",
      "an illustration of seashells at dusk",
    ]);
    expect(llm.calls).toHaveLength(1);
  });

  it("posts a short friendly line for other failures and timeouts", async () => {
    const failed = setup({
      generateError: new VideoError(
        'Video failed: {"code":"unavailable","error":"overloaded","cost_ticks":2}',
        VIDEO_FAILED_MESSAGE,
      ),
    });
    await run(failed.engine, message({ id: "down", text: "!video a paper boat" }));
    expect(failed.client.sent.map((row) => row.text)).toEqual([
      VIDEO_STARTED_MESSAGE,
      VIDEO_FAILED_MESSAGE,
    ]);

    const timedOut = setup({
      generateError: new VideoError("Video poll timed out after 600000ms", VIDEO_TIMEOUT_MESSAGE),
    });
    await run(timedOut.engine, message({ id: "slow", text: "!video a paper boat" }));
    expect(timedOut.client.sent.map((row) => row.text)).toEqual([
      VIDEO_STARTED_MESSAGE,
      VIDEO_TIMEOUT_MESSAGE,
    ]);
  });

  it("says the prompt is too long when the API rejects it", async () => {
    const { engine, client, video } = setup({
      generateError: new VideoError(
        'Video HTTP 400: {"code":"imagine:prompt-too-long","cost_ticks":1}',
        VIDEO_TOO_LONG_MESSAGE,
      ),
    });
    await run(engine, message({ id: "api-long", text: `!video ${"c".repeat(2000)}` }));
    expect(video.prompts[0]).toHaveLength(2000);
    expect(client.sent.map((row) => row.text)).toEqual([VIDEO_STARTED_MESSAGE, VIDEO_TOO_LONG_MESSAGE]);
  });
});

function numberedPrompts(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => /^\d+\. /.test(line))
    .map((line) => line.replace(/^\d+\. /, ""));
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
