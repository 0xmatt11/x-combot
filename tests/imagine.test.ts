import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { containsBannedAgeTerm, containsGenitalTerm, type AdultImageCandidate } from "../src/bot/adult-filter.js";
import { selectAdultImage } from "../src/bot/adult-vision.js";
import { ModerationEngine } from "../src/bot/engine.js";
import {
  adultImaginePrompt,
  createImagineClient,
  DEFAULT_IMAGINE_MODEL,
  IMAGINE_EMPTY_MESSAGE,
  IMAGINE_PROMPT_MAX_CHARS,
  ImagineError,
  normalizeAdultImageProvider,
  normalizeImaginePrompt,
  resolveAdultImageProvider,
  resolveImagineApiKey,
} from "../src/bot/imagine.js";
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

  it("trims a user prompt, caps the length, and refuses minor wording", () => {
    expect(normalizeImaginePrompt("  a neon cat in a cyberpunk alley  ")).toEqual({
      ok: true,
      prompt: "a neon cat in a cyberpunk alley",
    });
    expect(normalizeImaginePrompt("   ")).toEqual({ ok: false, reason: "empty" });
    expect(normalizeImaginePrompt("a".repeat(IMAGINE_PROMPT_MAX_CHARS))).toEqual({
      ok: true,
      prompt: "a".repeat(IMAGINE_PROMPT_MAX_CHARS),
    });
    expect(normalizeImaginePrompt("a".repeat(IMAGINE_PROMPT_MAX_CHARS + 1))).toEqual({
      ok: false,
      reason: "too_long",
    });
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
    failGenerate?: boolean;
    failSendImage?: boolean;
    recentLimit?: number;
    sameBytes?: boolean;
    perUser?: number;
    windowMs?: number;
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
      fetchImage: async (url) => ({
        bytes: options?.sameBytes ? Uint8Array.from([7, 7, 7]) : bytesForUrl(url),
        mimeType: "image/jpeg",
      }),
      imagine: options?.imagine === false ? undefined : imagine,
      adultImageProvider: options?.provider,
      recentImages: createRecentImageMemory(options?.recentLimit ?? 8),
      random: () => 0,
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

  function setup(options?: { imagine?: boolean; failSendImage?: boolean; enabled?: boolean }) {
    const store = new Store(":memory:");
    stores.push(store);
    const client = new MockXClient();
    client.failSendImage = options?.failSendImage ?? false;
    const imagine = {
      prompts: [] as string[],
      async generate(prompt: string) {
        imagine.prompts.push(prompt);
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
      undefined,
      {
        imagine: options?.imagine === false ? undefined : imagine,
        fetchImage: async () => ({ bytes: Uint8Array.from([4, 5, 6]), mimeType: "image/jpeg" }),
        adultImageProvider: "search",
      },
    );
    return { engine, client, imagine };
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

  it("rejects an empty prompt, a too-long prompt, minor wording, and a missing key", async () => {
    const { engine, client, imagine } = setup();
    await engine.processEvent(message({ id: "empty", text: "!imagine" }));
    await engine.processEvent(message({ id: "blank", text: "!imagine   " }));
    await engine.processEvent(message({ id: "long", text: `!imagine ${"a".repeat(IMAGINE_PROMPT_MAX_CHARS + 1)}` }));
    await engine.processEvent(message({ id: "teen", text: "!imagine teen portrait" }));
    expect(imagine.prompts).toHaveLength(0);
    const text = client.sent.map((row) => row.text).join("\n");
    expect(text).toMatch(/!imagine a neon cat in a cyberpunk alley/);
    expect(text).toMatch(/too long/i);
    expect(text).toMatch(/not allowed/);
    expect(text).not.toMatch(/teen/);

    const missing = setup({ imagine: false });
    await missing.engine.processEvent(message({ id: "nokey", text: "!imagine a neon cat" }));
    expect(missing.client.sent[0]?.text).toMatch(/XAI_API_KEY/);
  });

  it("is listed in the default help text", () => {
    const loaded = loadDefaults("config/default.yaml");
    expect(loaded.help).toMatch(/!imagine/);
  });
});

function bytesForUrl(url: string): Uint8Array {
  let sum = 0;
  for (let i = 0; i < url.length; i += 1) sum = (sum + url.charCodeAt(i)) % 251;
  return Uint8Array.from([sum, 9]);
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
