import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { containsBannedAgeTerm, containsGenitalTerm, type AdultImageCandidate } from "../src/bot/adult-filter.js";
import { selectAdultImage } from "../src/bot/adult-vision.js";
import { ModerationEngine } from "../src/bot/engine.js";
import {
  adultImaginePrompt,
  createImagineClient,
  DEFAULT_IMAGINE_MODEL,
  formatImagineModerationReply,
  heuristicSofterImaginePrompts,
  IMAGINE_EMPTY_MESSAGE,
  IMAGINE_FAILED_MESSAGE,
  IMAGINE_MODERATED_INTRO,
  IMAGINE_SUGGESTION_COUNT,
  IMAGINE_TOO_LONG_MESSAGE,
  IMAGINE_SUGGESTION_TIMEOUT_MS,
  ImagineError,
  isImagineModerationError,
  normalizeAdultImageProvider,
  normalizeImaginePrompt,
  resolveAdultImageProvider,
  resolveImagineApiKey,
  suggestSofterImaginePrompts,
} from "../src/bot/imagine.js";
import { MockLlmClient } from "../src/llm/mock.js";
import { createRecentImageMemory, imageContentHash } from "../src/bot/recent-images.js";
import { loadDefaults } from "../src/config.js";
import { loadEnv } from "../src/env.js";
import { Store } from "../src/store.js";
import type { BotRuntimeConfig, DefaultsConfig, DmEvent, XUser } from "../src/types.js";
import { MockXClient } from "../src/x/mock-client.js";

const alice: XUser = { id: "u-alice", username: "alice", name: "Alice" };
const groupId = "1578398451921985538";
const otherGroupId = "1578398451921985599";
const URL_A = "https://cdn.example/a.jpg";
const URL_B = "https://cdn.example/b.jpg";

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

function runtime(over: Partial<DefaultsConfig> = {}): BotRuntimeConfig {
  return {
    botUserId: "bot-1",
    ownerId: "u-owner",
    globalAdminIds: [],
    defaults: { ...defaults, ...over, boobs: over.boobs ?? defaults.boobs },
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

function candidate(
  partial: Partial<AdultImageCandidate> & Pick<AdultImageCandidate, "url">,
): AdultImageCandidate {
  return { adult: true, title: "cleavage close-up", ...partial };
}

describe("Imagine provider selection", () => {
  it("uses Imagine when a key is present and search when it is not", () => {
    expect(resolveAdultImageProvider({ apiKey: "xai-key" })).toEqual({
      provider: "imagine",
      imagineKeyMissing: false,
    });
    expect(resolveAdultImageProvider({})).toEqual({
      provider: "search",
      imagineKeyMissing: false,
    });
    expect(resolveAdultImageProvider({ provider: "search", apiKey: "xai-key" })).toEqual({
      provider: "search",
      imagineKeyMissing: false,
    });
    expect(resolveAdultImageProvider({ provider: "imagine" })).toEqual({
      provider: "search",
      imagineKeyMissing: true,
    });
    expect(normalizeAdultImageProvider("grok")).toBe("imagine");
    expect(normalizeAdultImageProvider("Grok-Imagine")).toBe("imagine");
    expect(normalizeAdultImageProvider("search")).toBe("search");
    expect(normalizeAdultImageProvider("duckduckgo")).toBeUndefined();
  });

  it("reads the same xAI key stack as the grok LLM client", () => {
    expect(
      resolveImagineApiKey({
        xaiApiKey: "xai",
        llmApiKey: "llm",
        openaiApiKey: "openai",
        llmProvider: "openai",
      }),
    ).toBe("xai");
    expect(resolveImagineApiKey({ llmApiKey: "llm", openaiApiKey: "openai", llmProvider: "grok" })).toBe(
      "llm",
    );
    expect(resolveImagineApiKey({ openaiApiKey: "openai", llmProvider: "xai" })).toBe("openai");
    expect(resolveImagineApiKey({ llmApiKey: "llm", llmProvider: "openai" })).toBeUndefined();
    expect(resolveImagineApiKey({ llmApiKey: "llm", llmBaseUrl: "https://api.x.ai/v1" })).toBe("llm");
  });

  it("reads Imagine env flags and rejects unknown values", () => {
    process.env.BOT_OWNER_ID = process.env.BOT_OWNER_ID ?? "1";
    const previous = {
      provider: process.env.BOOBS_IMAGE_PROVIDER,
      model: process.env.BOOBS_IMAGINE_MODEL,
      ratio: process.env.BOOBS_IMAGINE_ASPECT_RATIO,
    };
    try {
      delete process.env.BOOBS_IMAGE_PROVIDER;
      delete process.env.BOOBS_IMAGINE_MODEL;
      delete process.env.BOOBS_IMAGINE_ASPECT_RATIO;
      expect(loadEnv(true).boobsImageProvider).toBeUndefined();
      expect(loadEnv(true).boobsImagineModel).toBeUndefined();
      expect(loadEnv(true).boobsImagineAspectRatio).toBeUndefined();

      process.env.BOOBS_IMAGE_PROVIDER = "imagine";
      expect(loadEnv(true).boobsImageProvider).toBe("imagine");
      process.env.BOOBS_IMAGE_PROVIDER = "grok";
      expect(loadEnv(true).boobsImageProvider).toBe("imagine");
      process.env.BOOBS_IMAGE_PROVIDER = "search";
      expect(loadEnv(true).boobsImageProvider).toBe("search");
      process.env.BOOBS_IMAGE_PROVIDER = "bing";
      expect(() => loadEnv(true)).toThrow(/BOOBS_IMAGE_PROVIDER/);
      delete process.env.BOOBS_IMAGE_PROVIDER;

      process.env.BOOBS_IMAGINE_MODEL = "grok-imagine-image-2.0";
      expect(loadEnv(true).boobsImagineModel).toBe("grok-imagine-image-2.0");
      process.env.BOOBS_IMAGINE_MODEL = "grok-imagine-image";
      expect(loadEnv(true).boobsImagineModel).toBe("grok-imagine-image");
      process.env.BOOBS_IMAGINE_MODEL = "dall-e-3";
      expect(() => loadEnv(true)).toThrow(/BOOBS_IMAGINE_MODEL/);
      delete process.env.BOOBS_IMAGINE_MODEL;

      process.env.BOOBS_IMAGINE_ASPECT_RATIO = "3:4";
      expect(loadEnv(true).boobsImagineAspectRatio).toBe("3:4");
      process.env.BOOBS_IMAGINE_ASPECT_RATIO = "square";
      expect(() => loadEnv(true)).toThrow(/BOOBS_IMAGINE_ASPECT_RATIO/);
    } finally {
      restoreEnv("BOOBS_IMAGE_PROVIDER", previous.provider);
      restoreEnv("BOOBS_IMAGINE_MODEL", previous.model);
      restoreEnv("BOOBS_IMAGINE_ASPECT_RATIO", previous.ratio);
    }
  });
});

describe("Imagine prompts", () => {
  it("builds a chest prompt for !boobs and a butt prompt for !ass and !booty", () => {
    const chest = adultImaginePrompt("boobs", () => 0);
    const ass = adultImaginePrompt("ass", () => 0);
    const booty = adultImaginePrompt("booty", () => 0);
    expect(chest).toMatch(/cleavage|chest/i);
    expect(chest).not.toMatch(/\b(butt|booty|from behind)\b/i);
    expect(ass).toMatch(/butt|from behind/i);
    expect(booty).toBe(ass);
    expect(booty).not.toMatch(/cleavage|\bchest\b/i);
    expect(chest).not.toBe(booty);

    for (const prompt of [chest, ass, adultImaginePrompt("boobs", () => 0.5), adultImaginePrompt("booty", () => 0.9)]) {
      expect(prompt).not.toMatch(/18\+/);
      expect(containsBannedAgeTerm(prompt)).toBeUndefined();
      expect(containsGenitalTerm(prompt)).toBeUndefined();
    }
    expect(adultImaginePrompt("boobs", () => 0)).not.toBe(adultImaginePrompt("boobs", () => 0.5));
  });

  it("trims a user prompt, keeps long text, and refuses minor wording", () => {
    const longPrompt = "a".repeat(2000);
    expect(normalizeImaginePrompt("  a neon cat in a cyberpunk alley  ")).toEqual({
      ok: true,
      prompt: "a neon cat in a cyberpunk alley",
    });
    expect(normalizeImaginePrompt("   ")).toEqual({ ok: false, reason: "empty" });
    expect(normalizeImaginePrompt(longPrompt)).toEqual({ ok: true, prompt: longPrompt });
    expect(normalizeImaginePrompt("teen portrait")).toEqual({ ok: false, reason: "refused" });
    expect(IMAGINE_EMPTY_MESSAGE).toMatch(/!imagine a neon cat in a cyberpunk alley/);
  });
});

describe("Imagine HTTP client", () => {
  it("POSTs the generations endpoint with the bearer token and default model", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(_url)).toBe("https://api.x.ai/v1/images/generations");
      expect(init?.method).toBe("POST");
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer test-key");
      expect(JSON.parse(String(init?.body))).toEqual({
        model: DEFAULT_IMAGINE_MODEL,
        prompt: "a neon cat in a cyberpunk alley",
        n: 1,
        response_format: "url",
      });
      return new Response(JSON.stringify({ data: [{ url: "https://imgen.x.ai/cat.jpg" }] }), {
        status: 200,
      });
    });
    const client = createImagineClient({ apiKey: "test-key", fetchImpl });
    await expect(client.generate("a neon cat in a cyberpunk alley")).resolves.toEqual({
      url: "https://imgen.x.ai/cat.jpg",
    });
  });

  it("sends the configured model and aspect ratio", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: "grok-imagine-image-2.0",
        aspect_ratio: "3:4",
        prompt: "pin-up",
      });
      return new Response(JSON.stringify({ data: [{ url: "https://imgen.x.ai/pin.jpg" }] }), {
        status: 200,
      });
    });
    const client = createImagineClient({
      apiKey: "test-key",
      model: "grok-imagine-image-2.0",
      aspectRatio: "3:4",
      fetchImpl,
    });
    const image = await client.generate("pin-up");
    expect(image.url).toBe("https://imgen.x.ai/pin.jpg");
  });

  it("decodes a jpeg payload when the API returns base64", async () => {
    const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0x00, 0xd9]);
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ data: [{ b64_json: Buffer.from(bytes).toString("base64") }] }),
        { status: 200 },
      ),
    );
    const client = createImagineClient({ apiKey: "test-key", fetchImpl });
    const image = await client.generate("cat");
    expect(image.url).toBeUndefined();
    expect(image.mimeType).toBe("image/jpeg");
    expect(image.bytes).toEqual(bytes);
  });

  it("rejects an error response without throwing the prompt away into a success", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 429 }));
    const client = createImagineClient({ apiKey: "test-key", fetchImpl });
    await expect(client.generate("cat")).rejects.toBeInstanceOf(ImagineError);
  });

  it("classifies content moderation and keeps the raw body out of the user line", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            code: "imagine:content-moderated",
            error: "Generated image rejected by content moderation.",
            cost_ticks: 9,
          }),
          { status: 400 },
        ),
    );
    const client = createImagineClient({ apiKey: "test-key", fetchImpl });
    const error = await client.generate("a nude portrait").then(
      () => {
        throw new Error("expected Imagine to fail");
      },
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ImagineError);
    const imagineError = error as ImagineError;
    expect(imagineError.kind).toBe("moderated");
    expect(isImagineModerationError(imagineError)).toBe(true);
    expect(imagineError.userMessage).toBe(IMAGINE_MODERATED_INTRO);
    expect(imagineError.userMessage).not.toMatch(/cost_ticks|imagine:content-moderated|\{/);
    expect(imagineError.message).toMatch(/HTTP 400/);
    expect(imagineError.message).toMatch(/content-moderated/);
  });

  it("treats an equivalent safety rejection as moderation and leaves other HTTP errors generic", async () => {
    const safety = createImagineClient({
      apiKey: "test-key",
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: "Rejected by the safety filter." }), { status: 400 }),
    });
    await expect(safety.generate("cat")).rejects.toMatchObject({ kind: "moderated" });

    const overloaded = createImagineClient({
      apiKey: "test-key",
      fetchImpl: async () =>
        new Response(JSON.stringify({ code: "imagine:unavailable", error: "overloaded", cost_ticks: 1 }), {
          status: 503,
        }),
    });
    const error = await overloaded.generate("cat").then(
      () => {
        throw new Error("expected Imagine to fail");
      },
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ImagineError);
    const imagineError = error as ImagineError;
    expect(imagineError.kind).toBe("failed");
    expect(imagineError.userMessage).toBe(IMAGINE_FAILED_MESSAGE);
    expect(imagineError.userMessage).not.toMatch(/cost_ticks|overloaded/);
    expect(isImagineModerationError(new Error("socket hang up"))).toBe(false);
  });

  it("reports an API length rejection without imposing a local character cap", async () => {
    const client = createImagineClient({
      apiKey: "test-key",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            code: "imagine:prompt-too-long",
            error: "Prompt exceeds the maximum length.",
            cost_ticks: 1,
          }),
          { status: 400 },
        ),
    });
    const error = await client.generate("a".repeat(2000)).then(
      () => {
        throw new Error("expected Imagine to fail");
      },
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ImagineError);
    const imagineError = error as ImagineError;
    expect(imagineError.kind).toBe("failed");
    expect(imagineError.userMessage).toBe(IMAGINE_TOO_LONG_MESSAGE);
    expect(imagineError.userMessage).not.toMatch(/800|cost_ticks/);
    expect(isImagineModerationError(imagineError)).toBe(false);
  });
});

describe("recent posted images", () => {
  it("forgets URLs and hashes older than the last N in that conversation", () => {
    const memory = createRecentImageMemory(2);
    memory.remember("c1", { url: "https://cdn.example/a.jpg", hash: "h1" });
    memory.remember("c1", { url: "https://cdn.example/b.jpg", hash: "h2" });
    expect(memory.hasUrl("c1", "https://cdn.example/a.jpg")).toBe(true);
    memory.remember("c1", { url: "https://cdn.example/c.jpg", hash: "h3" });
    expect(memory.hasUrl("c1", "https://cdn.example/a.jpg")).toBe(false);
    expect(memory.hasHash("c1", "h1")).toBe(false);
    expect(memory.hasUrl("c1", "https://cdn.example/b.jpg")).toBe(true);
    expect(memory.hasHash("c1", "h2")).toBe(true);
    expect(memory.hasUrl("c2", "https://cdn.example/b.jpg")).toBe(false);
  });

  it("skips a recent URL before downloading and a recent byte hash after", async () => {
    const skipped = await selectAdultImage({
      candidates: [
        candidate({ url: URL_A, title: "cleavage close-up" }),
        candidate({ url: URL_B, title: "breasts close-up" }),
      ],
      topic: "chest",
      random: () => 0,
      excludeUrls: new Set([URL_A]),
    });
    expect(skipped.image?.url).toBe(URL_B);
    expect(skipped.fetched).toBeUndefined();

    const repeated = imageContentHash(Uint8Array.from([1]));
    const hashed = await selectAdultImage({
      candidates: [
        candidate({ url: URL_A, title: "cleavage close-up" }),
        candidate({ url: URL_B, title: "breasts close-up" }),
      ],
      topic: "chest",
      random: () => 0,
      excludeHashes: new Set([repeated]),
      fetchImage: async (url) => ({
        bytes: Uint8Array.from([url === URL_A ? 1 : 2]),
        mimeType: "image/jpeg",
      }),
    });
    expect(hashed.image?.url).toBe(URL_B);
    expect(hashed.fetched?.bytes).toEqual(Uint8Array.from([2]));
  });
});

describe("engine Imagine and search dedupe", () => {
  const stores: Store[] = [];

  afterEach(() => {
    for (const store of stores) store.close();
    stores.length = 0;
  });

  function setup(options?: {
    enabled?: boolean;
    provider?: "imagine" | "search";
    imagine?: boolean;
    failGenerate?: boolean | "moderated";
    failSendImage?: boolean;
    recentLimit?: number;
    sameBytes?: boolean;
    perUser?: number;
    windowMs?: number;
    imaginePublic?: { chestUrl?: string; bootyUrl?: string; bootyUrls?: readonly string[] };
    random?: () => number;
    fetchImage?: (url: string) => Promise<{ bytes: Uint8Array; mimeType: string } | undefined>;
  }) {
    const store = new Store(":memory:");
    stores.push(store);
    const client = new MockXClient();
    client.failSendImage = options?.failSendImage ?? false;
    const search = {
      calls: 0,
      async searchAdultChestImages() {
        search.calls += 1;
        return [
          candidate({ url: URL_A, title: "cleavage close-up" }),
          candidate({ url: URL_B, title: "breasts close-up" }),
        ];
      },
      async searchAdultBootyImages() {
        search.calls += 1;
        return [candidate({ url: URL_B, title: "butt from behind close-up" })];
      },
    };
    const imagine = {
      prompts: [] as string[],
      async generate(prompt: string) {
        imagine.prompts.push(prompt);
        if (options?.failGenerate === "moderated") throw moderatedImagineError();
        if (options?.failGenerate) throw new ImagineError("upstream down");
        return { url: `https://imgen.x.ai/fresh-${imagine.prompts.length}.jpg` };
      },
    };
    const engine = new ModerationEngine(store, client, runtime(
      options?.enabled === false
        ? {
            boobs: {
              enabled: false,
              vision: false,
              rate_limit_per_user: 0,
              rate_limit_per_conversation: 0,
              rate_limit_window_ms: 0,
            },
          }
        : {
            boobs: {
              enabled: true,
              vision: false,
              rate_limit_per_user: options?.perUser ?? 0,
              rate_limit_per_conversation: 0,
              rate_limit_window_ms: options?.windowMs ?? 0,
            },
          },
    ), undefined, {
      imageSearch: search,
      fetchImage:
        options?.fetchImage ??
        (async (url) => ({
          bytes: options?.sameBytes ? Uint8Array.from([7, 7, 7]) : bytesForUrl(url),
          mimeType: "image/jpeg",
        })),
      imagine: options?.imagine === false ? undefined : imagine,
      imaginePublic: options?.imaginePublic,
      adultImageProvider: options?.provider,
      recentImages: createRecentImageMemory(options?.recentLimit ?? 8),
      random: options?.random ?? (() => 0),
    });
    return { engine, client, search, imagine };
  }

  it("generates a fresh chest photo and does not search or caption it", async () => {
    const { engine, client, search, imagine } = setup({ provider: "imagine" });
    const actions = await engine.processEvent(message({ id: "img-1", text: "!Boobs" }));
    expect(search.calls).toBe(0);
    expect(imagine.prompts).toHaveLength(1);
    expect(imagine.prompts[0]).toMatch(/cleavage|chest/i);
    expect(imagine.prompts[0]).not.toMatch(/18\+/);
    expect(client.images).toEqual([
      {
        conversationId: groupId,
        url: "https://imgen.x.ai/fresh-1.jpg",
        mimeType: "image/jpeg",
        bytes: 2,
      },
    ]);
    expect(client.sent).toHaveLength(0);
    expect(actions.replies).toEqual([]);
  });

  it("uses the butt prompt for !ass and !booty", async () => {
    const { engine, imagine, search } = setup({ provider: "imagine" });
    await engine.processEvent(message({ id: "ass-1", text: "!ass" }));
    await engine.processEvent(message({ id: "booty-1", text: "!booty" }));
    expect(search.calls).toBe(0);
    expect(imagine.prompts).toHaveLength(2);
    for (const prompt of imagine.prompts) {
      expect(prompt).toMatch(/butt|from behind/i);
      expect(prompt).not.toMatch(/cleavage/i);
      expect(prompt).not.toMatch(/18\+/);
    }
  });

  it("attaches a configured imagine-public JPEG when API Imagine misses, with no caption", async () => {
    const chest = "https://imagine-public.x.ai/imagine-public/images/8f99def9-25a9-4803-b281-873fd4564123.jpg";
    const booty = "https://imagine-public.x.ai/imagine-public/images/11111111-2222-4333-8444-555555555555.jpg";
    const posted = setup({
      provider: "imagine",
      failGenerate: true,
      imaginePublic: { chestUrl: chest, bootyUrl: booty },
    });
    const actions = await posted.engine.processEvent(message({ id: "pub-1", text: "!boobs" }));
    expect(posted.imagine.prompts).toHaveLength(1);
    expect(posted.search.calls).toBe(0);
    expect(posted.client.images).toEqual([
      { conversationId: groupId, url: chest, mimeType: "image/jpeg", bytes: 2 },
    ]);
    expect(posted.client.sent).toHaveLength(0);
    expect(actions.replies).toEqual([]);
    expect(JSON.stringify(actions.replies)).not.toContain("18+");

    const ass = await posted.engine.processEvent(message({ id: "pub-ass", text: "!ass" }));
    expect(posted.search.calls).toBe(0);
    expect(posted.client.images.map((row) => row.url)).toEqual([chest, booty]);
    expect(posted.client.sent).toHaveLength(0);
    expect(ass.replies).toEqual([]);
    expect(JSON.stringify(ass.replies)).not.toContain("18+");
  });

  it("keeps API Imagine ahead of a configured public JPEG and does not search", async () => {
    const chest = "https://imagine-public.x.ai/imagine-public/images/8f99def9-25a9-4803-b281-873fd4564123.jpg";
    const { engine, client, search, imagine } = setup({
      provider: "imagine",
      imaginePublic: { chestUrl: chest },
    });
    await engine.processEvent(message({ id: "api-first", text: "!boobs" }));
    expect(imagine.prompts).toHaveLength(1);
    expect(search.calls).toBe(0);
    expect(client.images.map((row) => row.url)).toEqual(["https://imgen.x.ai/fresh-1.jpg"]);
  });

  it("searches when the public JPEG is missing, already posted, or not a JPEG", async () => {
    const chest = "https://imagine-public.x.ai/imagine-public/images/8f99def9-25a9-4803-b281-873fd4564123.jpg";
    const missing = setup({ provider: "imagine", failGenerate: true, imaginePublic: {} });
    await missing.engine.processEvent(message({ id: "miss-1", text: "!boobs" }));
    expect(missing.search.calls).toBe(1);
    expect(missing.client.images.map((row) => row.url)).toEqual([URL_A]);

    const notJpeg = setup({
      provider: "imagine",
      failGenerate: true,
      imaginePublic: { chestUrl: chest },
      fetchImage: async (url) =>
        url.includes("imagine-public")
          ? { bytes: Uint8Array.from([1]), mimeType: "image/png" }
          : { bytes: bytesForUrl(url), mimeType: "image/jpeg" },
    });
    await notJpeg.engine.processEvent(message({ id: "png-1", text: "!boobs" }));
    expect(notJpeg.search.calls).toBe(1);
    expect(notJpeg.client.images.map((row) => row.url)).toEqual([URL_A]);

    const repeat = setup({
      provider: "imagine",
      failGenerate: true,
      imaginePublic: { chestUrl: chest },
    });
    await repeat.engine.processEvent(message({ id: "rep-1", text: "!boobs" }));
    await repeat.engine.processEvent(message({ id: "rep-2", text: "!boobs" }));
    expect(repeat.search.calls).toBe(1);
    expect(repeat.client.images[0]?.url).toBe(chest);
    expect(repeat.client.images[1]?.url).toMatch(/^https:\/\/cdn\.example\//);
  });

  it("does not use the public JPEG when API Imagine blocks the image", async () => {
    const chest = "https://imagine-public.x.ai/imagine-public/images/8f99def9-25a9-4803-b281-873fd4564123.jpg";
    const { engine, client, search } = setup({
      provider: "imagine",
      failGenerate: "moderated",
      imaginePublic: { chestUrl: chest },
    });
    await engine.processEvent(message({ id: "mod-public", text: "!boobs" }));
    expect(search.calls).toBe(0);
    expect(client.images).toHaveLength(0);
    expect(client.sent[0]?.text).toMatch(/blocked by content moderation/i);
    expect(client.sent.map((row) => row.text).join("\n")).not.toContain(chest);
  });

  it("uses the public JPEG before search when Imagine is not selected", async () => {
    const booty = "https://imagine-public.x.ai/imagine-public/images/11111111-2222-4333-8444-555555555555.jpg";
    const { engine, client, search, imagine } = setup({
      provider: "search",
      imaginePublic: { bootyUrl: booty },
    });
    const actions = await engine.processEvent(message({ id: "search-public", text: "!booty" }));
    expect(imagine.prompts).toHaveLength(0);
    expect(search.calls).toBe(0);
    expect(client.images.map((row) => row.url)).toEqual([booty]);
    expect(client.sent).toHaveLength(0);
    expect(actions.replies).toEqual([]);
    await engine.processEvent(message({ id: "search-chest", text: "!boobs" }));
    expect(search.calls).toBe(1);
    expect(client.images.map((row) => row.url)).toEqual([booty, URL_A]);
  });

  it("rotates a booty bank across !booty, !ass, and !booties, then searches", async () => {
    const first = "https://imagine-public.x.ai/imagine-public/images/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg";
    const second = "https://imagine-public.x.ai/imagine-public/images/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jpg";
    const third = "https://imagine-public.x.ai/imagine-public/images/cccccccc-cccc-4ccc-8ccc-cccccccccccc.jpg";
    const { engine, client, search } = setup({
      provider: "search",
      imaginePublic: { bootyUrls: [first, second, third] },
    });
    await engine.processEvent(message({ id: "bank-1", text: "!booty" }));
    await engine.processEvent(message({ id: "bank-2", text: "!ass" }));
    await engine.processEvent(message({ id: "bank-3", text: "!booties" }));
    expect(search.calls).toBe(0);
    expect(client.images.map((row) => row.url)).toEqual([first, second, third]);
    expect(client.sent).toHaveLength(0);

    await engine.processEvent(message({ id: "bank-4", text: "!booty" }));
    expect(search.calls).toBe(1);
    expect(client.images.map((row) => row.url)).toEqual([first, second, third, URL_B]);
  });

  it("picks a later booty URL when random is high, and skips a repeated hash", async () => {
    const first = "https://imagine-public.x.ai/imagine-public/images/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg";
    const second = "https://imagine-public.x.ai/imagine-public/images/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jpg";
    const shared = Uint8Array.from([4, 4, 4]);
    const high = setup({
      provider: "search",
      imaginePublic: { bootyUrls: [first, second] },
      random: () => 0.75,
    });
    await high.engine.processEvent(message({ id: "roll-1", text: "!booty" }));
    expect(high.client.images.map((row) => row.url)).toEqual([second]);
    expect(high.search.calls).toBe(0);

    const repeated = setup({
      provider: "search",
      imaginePublic: { bootyUrls: [first, second] },
      fetchImage: async (url) =>
        url === first || url === second
          ? { bytes: shared, mimeType: "image/jpeg" }
          : { bytes: bytesForUrl(url), mimeType: "image/jpeg" },
    });
    await repeated.engine.processEvent(message({ id: "hash-1", text: "!ass" }));
    await repeated.engine.processEvent(message({ id: "hash-2", text: "!booty" }));
    expect(repeated.client.images.map((row) => row.url)).toEqual([first, URL_B]);
    expect(repeated.search.calls).toBe(1);
  });

  it("tries the next booty URL when one download is not a JPEG, and leaves !boobs on the chest URL", async () => {
    const chest = "https://imagine-public.x.ai/imagine-public/images/8f99def9-25a9-4803-b281-873fd4564123.jpg";
    const first = "https://imagine-public.x.ai/imagine-public/images/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg";
    const second = "https://imagine-public.x.ai/imagine-public/images/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jpg";
    const { engine, client, search } = setup({
      provider: "search",
      imaginePublic: { chestUrl: chest, bootyUrls: [first, second] },
      fetchImage: async (url) =>
        url === first
          ? { bytes: Uint8Array.from([1]), mimeType: "image/png" }
          : { bytes: bytesForUrl(url), mimeType: "image/jpeg" },
    });
    await engine.processEvent(message({ id: "bad-1", text: "!booty" }));
    await engine.processEvent(message({ id: "chest-1", text: "!boobs" }));
    expect(search.calls).toBe(0);
    expect(client.images.map((row) => row.url)).toEqual([second, chest]);
  });

  it("falls back to search when Imagine fails and skips Imagine when search is selected", async () => {
    const failed = setup({ provider: "imagine", failGenerate: true });
    await failed.engine.processEvent(message({ id: "fall-1", text: "!boobs" }));
    expect(failed.imagine.prompts).toHaveLength(1);
    expect(failed.search.calls).toBe(1);
    expect(failed.client.images.map((row) => row.url)).toEqual([URL_A]);

    const searchOnly = setup({ provider: "search" });
    await searchOnly.engine.processEvent(message({ id: "search-1", text: "!boobs" }));
    expect(searchOnly.imagine.prompts).toHaveLength(0);
    expect(searchOnly.search.calls).toBe(1);
  });

  it("does not reuse the last N posted search URLs, then allows an older one again", async () => {
    const { engine, client, search } = setup({ provider: "search", recentLimit: 1 });
    await engine.processEvent(message({ id: "n1", text: "!boobs" }));
    await engine.processEvent(message({ id: "n2", text: "!boobs" }));
    await engine.processEvent(message({ id: "n3", text: "!boobs" }));
    expect(search.calls).toBe(3);
    expect(client.images.map((row) => row.url)).toEqual([URL_A, URL_B, URL_A]);
  });

  it("does not post a different URL when the bytes match a recent image", async () => {
    const { engine, client } = setup({ provider: "search", sameBytes: true });
    await engine.processEvent(message({ id: "h1", text: "!boobs" }));
    await engine.processEvent(message({ id: "h2", text: "!boobs" }));
    expect(client.images.map((row) => row.url)).toEqual([URL_A]);
    expect(client.sent.map((row) => row.text)).toEqual(["No matching image came back. Try again."]);
  });

  it("keeps the recent window per conversation", async () => {
    const { engine, client } = setup({ provider: "search", recentLimit: 1 });
    await engine.processEvent(message({ id: "c1", text: "!boobs" }));
    await engine.processEvent(message({ id: "c2", text: "!boobs", conversationId: otherGroupId }));
    expect(client.images.map((row) => row.url)).toEqual([URL_A, URL_A]);
  });

  it("does not call Imagine for extra text or when the adult commands are off", async () => {
    const { engine, client, imagine } = setup({ provider: "imagine" });
    await engine.processEvent(message({ id: "extra", text: "!boobs please" }));
    expect(imagine.prompts).toHaveLength(0);
    expect(client.sent[0]?.text).toMatch(/does not take extra text/);

    const disabled = setup({ provider: "imagine", enabled: false });
    await disabled.engine.processEvent(message({ id: "off", text: "!boobs" }));
    expect(disabled.imagine.prompts).toHaveLength(0);
    expect(disabled.client.sent[0]?.text).toMatch(/disabled/);
  });

  it("replies in the chat when Imagine blocks an adult image, and does not search", async () => {
    for (const command of ["boobs", "ass", "booty"] as const) {
      const { engine, client, search, imagine } = setup({ provider: "imagine", failGenerate: "moderated" });
      await engine.processEvent(message({ id: `mod-${command}`, text: `!${command}` }));
      expect(search.calls).toBe(0);
      expect(imagine.prompts).toHaveLength(1);
      expect(client.images).toHaveLength(0);
      const text = client.sent.map((row) => row.text).join("\n");
      expect(text).toMatch(/blocked by content moderation/i);
      expect(numberedPrompts(text)).toHaveLength(IMAGINE_SUGGESTION_COUNT);
      expect(text).not.toMatch(/cost_ticks|imagine:content-moderated|\{/);
      expect(text).not.toMatch(/\b(nude|naked|cleavage|lingerie|boobs|tits|butts?|booty|porn)\b/i);
      expect(text).toMatch(/woman|portrait|fashion|illustration/i);
    }
  });

  it("rate-limits before calling Imagine", async () => {
    const { engine, imagine } = setup({ provider: "imagine", perUser: 1, windowMs: 60_000 });
    const now = 5_000_000;
    await engine.processEvent(message({ id: "r1", text: "!boobs" }), now);
    await engine.processEvent(message({ id: "r2", text: "!ass" }), now + 1);
    expect(imagine.prompts).toHaveLength(1);
  });
});

describe("!imagine command", () => {
  const stores: Store[] = [];

  afterEach(() => {
    for (const store of stores) store.close();
    stores.length = 0;
  });

  function setup(options?: {
    imagine?: boolean;
    failSendImage?: boolean;
    enabled?: boolean;
    generateError?: Error;
    llm?: MockLlmClient;
  }) {
    const store = new Store(":memory:");
    stores.push(store);
    const client = new MockXClient();
    client.failSendImage = options?.failSendImage ?? false;
    const imagine = {
      prompts: [] as string[],
      async generate(prompt: string) {
        imagine.prompts.push(prompt);
        if (options?.generateError) throw options.generateError;
        return { url: "https://imgen.x.ai/user.jpg" };
      },
    };
    const engine = new ModerationEngine(
      store,
      client,
      runtime({
        boobs: {
          enabled: options?.enabled !== false,
          vision: false,
          rate_limit_per_user: 0,
          rate_limit_per_conversation: 0,
          rate_limit_window_ms: 0,
        },
      }),
      options?.llm,
      {
        imagine: options?.imagine === false ? undefined : imagine,
        fetchImage: async () => ({ bytes: Uint8Array.from([4, 5, 6]), mimeType: "image/jpeg" }),
        adultImageProvider: "search",
      },
    );
    return { engine, client, imagine, store };
  }

  it("sends the user prompt as written and posts an inline photo", async () => {
    const { engine, client, imagine } = setup({ enabled: false });
    const actions = await engine.processEvent(
      message({ id: "free-1", text: "!imagine   a neon cat in a cyberpunk alley  " }),
    );
    expect(imagine.prompts).toEqual(["a neon cat in a cyberpunk alley"]);
    expect(client.images).toEqual([
      {
        conversationId: groupId,
        url: "https://imgen.x.ai/user.jpg",
        mimeType: "image/jpeg",
        bytes: 3,
      },
    ]);
    expect(client.sent).toHaveLength(0);
    expect(actions.replies).toEqual([]);
    expect(JSON.stringify(actions)).not.toContain("18+");
  });

  it("posts the URL when native upload fails", async () => {
    const { engine, client } = setup({ failSendImage: true });
    const actions = await engine.processEvent(
      message({ id: "free-link", text: "!imagine a neon cat" }),
    );
    expect(client.images).toHaveLength(0);
    expect(actions.replies).toEqual(["https://imgen.x.ai/user.jpg"]);
  });

  it("rejects an empty prompt, minor wording, and a missing key, and sends a long prompt", async () => {
    const longPrompt = "a".repeat(2000);
    const { engine, client, imagine } = setup();
    await engine.processEvent(message({ id: "empty", text: "!imagine" }));
    await engine.processEvent(message({ id: "blank", text: "!imagine   " }));
    await engine.processEvent(message({ id: "long", text: `!imagine ${longPrompt}` }));
    await engine.processEvent(message({ id: "teen", text: "!imagine teen portrait" }));
    expect(imagine.prompts).toEqual([longPrompt]);
    const text = client.sent.map((row) => row.text).join("\n");
    expect(text).toMatch(/!imagine a neon cat in a cyberpunk alley/);
    expect(text).not.toMatch(/too long/i);
    expect(text).toMatch(/not allowed/);
    expect(text).not.toMatch(/teen/);

    const missing = setup({ imagine: false });
    await missing.engine.processEvent(message({ id: "nokey", text: "!imagine a neon cat" }));
    expect(missing.client.sent[0]?.text).toMatch(/XAI_API_KEY/);
  });

  it("tells the chat when the API rejects a prompt for length", async () => {
    const { engine, client, imagine } = setup({
      generateError: new ImagineError(
        'Imagine HTTP 400: {"code":"imagine:prompt-too-long","error":"Prompt exceeds the maximum length.","cost_ticks":1}',
        IMAGINE_TOO_LONG_MESSAGE,
      ),
    });
    await engine.processEvent(message({ id: "api-long", text: `!imagine ${"b".repeat(2000)}` }));
    expect(imagine.prompts[0]).toHaveLength(2000);
    expect(client.images).toHaveLength(0);
    expect(client.sent.map((row) => row.text)).toEqual([IMAGINE_TOO_LONG_MESSAGE]);
  });

  it("is listed in the default help text", () => {
    const loaded = loadDefaults("config/default.yaml");
    expect(loaded.help).toMatch(/!imagine/);
  });

  it("posts a moderation reply with five prompts and no raw API payload", async () => {
    const { engine, client, imagine } = setup({
      generateError: moderatedImagineError(),
    });
    const actions = await engine.processEvent(
      message({ id: "mod-1", text: "!imagine a nude woman on a beach at sunset" }),
    );
    expect(imagine.prompts).toEqual(["a nude woman on a beach at sunset"]);
    expect(client.images).toHaveLength(0);
    expect(client.sent).toHaveLength(1);
    const text = client.sent[0]?.text ?? "";
    expect(text.startsWith(IMAGINE_MODERATED_INTRO)).toBe(true);
    expect(numberedPrompts(text)).toHaveLength(IMAGINE_SUGGESTION_COUNT);
    expect(text).not.toMatch(/cost_ticks|imagine:content-moderated|\{/);
    expect(text).not.toMatch(/\b(nude|naked|cleavage|porn)\b/i);
    expect(text).toMatch(/beach|sunset|woman/i);
    expect(actions.replies).toEqual([text]);
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
      generateError: moderatedImagineError(),
      llm,
    });
    await engine.processEvent(message({ id: "mod-llm", text: "!imagine a nude woman on a beach at sunset" }));
    const text = client.sent[0]?.text ?? "";
    expect(numberedPrompts(text)).toEqual([
      "a woman in a linen dress on a beach at sunset",
      "a watercolor of waves at sunset",
      "a fashion photograph of a summer coat by the shore",
      "a wide landscape of a quiet beach",
      "an illustration of seashells at dusk",
    ]);
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]?.[1]?.content).toBe("a nude woman on a beach at sunset");
  });

  it("rewrites locally when the chat model is off", async () => {
    const llm = new MockLlmClient("1. this should not be used");
    const { engine, client, store } = setup({
      generateError: moderatedImagineError(),
      llm,
    });
    store.patchSettings(groupId, { llm_enabled: false });
    await engine.processEvent(message({ id: "mod-off", text: "!imagine a neon cat in an alley" }));
    expect(llm.calls).toHaveLength(0);
    const text = client.sent[0]?.text ?? "";
    expect(numberedPrompts(text)).toHaveLength(IMAGINE_SUGGESTION_COUNT);
    expect(text).toMatch(/neon cat|alley/i);
  });

  it("posts a short friendly line for other Imagine failures", async () => {
    const { engine, client } = setup({
      generateError: new ImagineError(
        'Imagine HTTP 503: {"code":"imagine:unavailable","error":"overloaded","cost_ticks":2}',
      ),
    });
    await engine.processEvent(message({ id: "down", text: "!imagine a neon cat" }));
    expect(client.images).toHaveLength(0);
    expect(client.sent.map((row) => row.text)).toEqual([IMAGINE_FAILED_MESSAGE]);
  });
});

describe("softer Imagine prompts", () => {
  it("rewrites an explicit prompt into five related lines", () => {
    const prompts = heuristicSofterImaginePrompts(
      "a nude woman on a beach at sunset, cleavage, lingerie",
    );
    expect(prompts).toHaveLength(IMAGINE_SUGGESTION_COUNT);
    expect(new Set(prompts.map((prompt) => prompt.toLowerCase())).size).toBe(IMAGINE_SUGGESTION_COUNT);
    const joined = prompts.join("\n");
    expect(joined).toMatch(/beach|sunset|woman/i);
    expect(joined).not.toMatch(/\b(nude|naked|cleavage|lingerie|porn|boobs|ass|butt)\b/i);
    expect(containsBannedAgeTerm(joined)).toBeUndefined();
    expect(formatImagineModerationReply(prompts)).toMatch(/^That image was blocked by content moderation/);
    expect(formatImagineModerationReply(prompts).match(/^\d+\. /gm)).toHaveLength(IMAGINE_SUGGESTION_COUNT);
  });

  it("softens the adult preset prompts without escalating them", () => {
    for (const command of ["boobs", "ass", "booty"] as const) {
      const prompts = heuristicSofterImaginePrompts(adultImaginePrompt(command, () => 0));
      expect(prompts).toHaveLength(IMAGINE_SUGGESTION_COUNT);
      const joined = prompts.join("\n");
      expect(joined).toMatch(/woman|portrait|fashion|illustration/i);
      expect(joined).not.toMatch(/\b(cleavage|lingerie|boobs|tits|butts?|booty|ass|nude|porn)\b/i);
      expect(joined).not.toMatch(/unique framing/i);
    }
  });

  it("keeps a non-explicit prompt related and fills in when the model reply is short", async () => {
    const llm = new MockLlmClient("1. a paper cat in a quiet alley\n2. teen cyberpunk portrait");
    const prompts = await suggestSofterImaginePrompts("a neon cat in an alley", (messages) =>
      llm.complete(messages),
    );
    expect(prompts).toHaveLength(IMAGINE_SUGGESTION_COUNT);
    expect(prompts[0]).toBe("a paper cat in a quiet alley");
    expect(prompts.join("\n")).not.toMatch(/\bteen\b/i);
    expect(prompts.join("\n")).toMatch(/neon cat|alley/i);
  });

  it("uses the rewrite when the model throws or is too slow", async () => {
    const thrown = await suggestSofterImaginePrompts("a neon cat in an alley", async () => {
      throw new Error("llm down");
    });
    expect(thrown).toEqual(heuristicSofterImaginePrompts("a neon cat in an alley"));

    vi.useFakeTimers();
    try {
      const pending = suggestSofterImaginePrompts("a neon cat in an alley", () => new Promise(() => {}));
      await vi.advanceTimersByTimeAsync(IMAGINE_SUGGESTION_TIMEOUT_MS);
      await expect(pending).resolves.toEqual(heuristicSofterImaginePrompts("a neon cat in an alley"));
    } finally {
      vi.useRealTimers();
    }
  });
});

function moderatedImagineError(): ImagineError {
  return new ImagineError(
    'Imagine HTTP 400: {"code":"imagine:content-moderated","error":"Generated image rejected by content moderation.","cost_ticks":4}',
    IMAGINE_MODERATED_INTRO,
    "moderated",
  );
}

function numberedPrompts(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => /^\d+\. /.test(line))
    .map((line) => line.replace(/^\d+\. /, ""));
}

function bytesForUrl(url: string): Uint8Array {
  let sum = 0;
  for (let i = 0; i < url.length; i += 1) sum = (sum + url.charCodeAt(i)) % 251;
  return Uint8Array.from([sum, 9]);
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
