import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModerationEngine } from "../src/bot/engine.js";
import {
  CATAAS_KITTEN_URL,
  MEOW_RATE_LIMIT,
  MEOW_UNAVAILABLE,
  MeowLookupError,
  THE_CAT_API_SEARCH_URL,
  canonicalMeowImageUrl,
  createMeowLookup,
  isSafeMeowImageUrl,
  loadBundledKittens,
  meowImageFromCataas,
  meowImageFromCatApi,
  type MeowImage,
  type MeowLookup,
} from "../src/bot/meow.js";
import { parseCommand, parseUnknownBang } from "../src/bot/parser.js";
import { loadDefaults } from "../src/config.js";
import { Store } from "../src/store.js";
import type { BotRuntimeConfig, DefaultsConfig, DmEvent, XUser } from "../src/types.js";
import { MockXClient } from "../src/x/mock-client.js";
import { RoutedXClient } from "../src/x/routed-client.js";

const alice: XUser = { id: "u-alice", username: "alice", name: "Alice" };
const groupId = "1578398451921985538";
const chatGroupId = "g2029561975647150382";

const CATAAS = "https://cataas.com/cat/5enhMoq1fey3akP5";
const CATAPI = "https://cdn2.thecatapi.com/images/3ru.jpg";
const BUNDLED_URL = "https://cataas.com/cat/ebnOsykeZBzKUFX5";

const defaults: DefaultsConfig = {
  welcome: { enabled: false, text: "Welcome @{username}!" },
  rules: "Be nice.",
  help: "Type !rules",
  flood: { max_messages: 0, window_ms: 10_000, mute_ms: 60_000, warn_on_flood: false },
  warns: { limit: 3, auto_mute_ms: 60_000, notify_admins: false },
  filters: [],
  poll: { interval_ms: 1000, max_results: 50 },
  delete: { attempt_on_filter: false, attempt_on_flood: false, attempt_on_mute: false },
};

function runtime(): BotRuntimeConfig {
  return {
    botUserId: "bot-1",
    ownerId: "u-owner",
    globalAdminIds: [],
    defaults,
  };
}

function message(partial: Partial<DmEvent> & Pick<DmEvent, "id" | "senderId" | "text">): DmEvent {
  return {
    eventType: "MessageCreate",
    conversationId: groupId,
    participantIds: [],
    participants: [],
    mentions: [],
    sender: alice,
    ...partial,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function bundledStill(): MeowImage {
  return {
    url: BUNDLED_URL,
    bytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]),
    mimeType: "image/jpeg",
  };
}

describe("!meow command registration", () => {
  it("registers !meow and /meow and ignores extra words", () => {
    expect(parseCommand("!meow")).toEqual({ name: "meow" });
    expect(parseCommand("!Meow")).toEqual({ name: "meow" });
    expect(parseCommand("/meow")).toEqual({ name: "meow" });
    expect(parseCommand("!meow please more")).toEqual({ name: "meow", extra: "please more" });
    expect(parseUnknownBang("!meow")).toBeUndefined();
    expect(parseUnknownBang("/meow later")).toBeUndefined();
  });
});

describe("meow image urls", () => {
  it("allows cataas kitten ids and The Cat API CDN, and rejects Imagine hosts", () => {
    expect(isSafeMeowImageUrl(CATAAS)).toBe(true);
    expect(isSafeMeowImageUrl("https://www.cataas.com/cat/98qvAp6CYXZMLztN")).toBe(true);
    expect(canonicalMeowImageUrl("https://www.cataas.com/cat/98qvAp6CYXZMLztN")).toBe(
      "https://cataas.com/cat/98qvAp6CYXZMLztN",
    );
    expect(isSafeMeowImageUrl(CATAPI)).toBe(true);
    expect(isSafeMeowImageUrl("https://cdn2.thecatapi.com/images/abc.PNG")).toBe(true);
    expect(isSafeMeowImageUrl("https://api.x.ai/v1/images/generations")).toBe(false);
    expect(isSafeMeowImageUrl("https://grok.com/imagine/kitten.png")).toBe(false);
    expect(isSafeMeowImageUrl("https://images.example/kitten.jpg")).toBe(false);
    expect(isSafeMeowImageUrl("http://cataas.com/cat/5enhMoq1fey3akP5")).toBe(false);
    expect(isSafeMeowImageUrl("https://cataas.com/cat/5enhMoq1fey3akP5?json=true")).toBe(false);
    expect(isSafeMeowImageUrl("https://user:pass@cdn2.thecatapi.com/images/3ru.jpg")).toBe(false);
    expect(isSafeMeowImageUrl("https://cdn2.thecatapi.com/images/teen.jpg")).toBe(false);
    expect(isSafeMeowImageUrl("https://api.thecatapi.com/v1/images/search")).toBe(false);
  });

  it("builds a cataas url from a kitten-tagged row and ignores a returned url", () => {
    expect(
      meowImageFromCataas([
        {
          id: "5enhMoq1fey3akP5",
          tags: ["Cute", "kitten"],
          mimetype: "image/jpeg",
          url: "https://api.x.ai/v1/images/kitten.png",
        },
      ]),
    ).toBe(CATAAS);
    expect(
      meowImageFromCataas([{ id: "5enhMoq1fey3akP5", tags: ["cute"], mimetype: "image/jpeg" }]),
    ).toBeUndefined();
    expect(
      meowImageFromCataas([{ id: "5enhMoq1fey3akP5", tags: ["kitten"], mimetype: "video/mp4" }]),
    ).toBeUndefined();
  });

  it("keeps a The Cat API CDN image and skips other hosts", () => {
    expect(
      meowImageFromCatApi([
        { url: "https://grok.com/imagine/kitten.png" },
        { url: "https://api.x.ai/v1/images/kitten.jpg" },
        { url: CATAPI },
      ]),
    ).toBe(CATAPI);
    expect(meowImageFromCatApi([{ url: "https://api.thecatapi.com/v1/images/search" }])).toBeUndefined();
  });
});

describe("!meow lookup", () => {
  it("uses a cataas kitten and does not call The Cat API, Imagine, or api.x.ai", async () => {
    const calls: { url: string; authorization?: string }[] = [];
    const lookup = createMeowLookup({
      bundled: [],
      fetchImpl: async (input, init) => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        calls.push({ url, authorization: headers.get("authorization") ?? undefined });
        expect(url).not.toMatch(/api\.x\.ai|grok\.com|images\/generations/i);
        expect(url).toBe(CATAAS_KITTEN_URL);
        return jsonResponse([
          {
            id: "5enhMoq1fey3akP5",
            tags: ["cute", "kitten", "tiny"],
            mimetype: "image/jpeg",
            url: "https://grok.com/imagine/kitten.png",
          },
        ]);
      },
    });
    await expect(lookup.randomImage()).resolves.toEqual({ url: CATAAS });
    expect(calls).toEqual([{ url: CATAAS_KITTEN_URL, authorization: undefined }]);
  });

  it("falls through to The Cat API when cataas is down", async () => {
    const urls: string[] = [];
    const lookup = createMeowLookup({
      bundled: [],
      fetchImpl: async (input) => {
        const url = String(input);
        urls.push(url);
        if (url === CATAAS_KITTEN_URL) return new Response("nope", { status: 503 });
        if (url === THE_CAT_API_SEARCH_URL) return jsonResponse([{ id: "3ru", url: CATAPI }]);
        throw new Error(`unexpected ${url}`);
      },
    });
    await expect(lookup.randomImage()).resolves.toEqual({ url: CATAPI });
    expect(urls).toEqual([CATAAS_KITTEN_URL, THE_CAT_API_SEARCH_URL]);
  });

  it("uses a bundled kitten when both APIs fail", async () => {
    const local = bundledStill();
    const lookup = createMeowLookup({
      bundled: [local],
      random: () => 0,
      fetchImpl: async () => {
        throw new Error("network down");
      },
    });
    const image = await lookup.randomImage();
    expect(image.url).toBe(BUNDLED_URL);
    expect(image.bytes).toBe(local.bytes);
    expect(image.mimeType).toBe("image/jpeg");
  });

  it("says the pile is busy when both APIs are rate-limited and the bank is empty", async () => {
    const lookup = createMeowLookup({
      bundled: [],
      fetchImpl: async () => new Response("busy", { status: 429 }),
    });
    await expect(lookup.randomImage()).rejects.toMatchObject({
      name: "MeowLookupError",
      userMessage: MEOW_RATE_LIMIT,
    });
  });

  it("says a kitten is unavailable when both APIs miss and the bank is empty", async () => {
    const lookup = createMeowLookup({
      bundled: [],
      fetchImpl: async () => jsonResponse([{ tags: ["cute"], id: "not-a-kitten" }]),
    });
    await expect(lookup.randomImage()).rejects.toMatchObject({ userMessage: MEOW_UNAVAILABLE });
  });

  it("reads the shipped kitten JPEGs", () => {
    const images = loadBundledKittens();
    expect(images.length).toBeGreaterThanOrEqual(3);
    for (const image of images) {
      expect(isSafeMeowImageUrl(image.url)).toBe(true);
      expect(image.url.startsWith("https://cataas.com/cat/")).toBe(true);
      expect(image.mimeType).toBe("image/jpeg");
      expect(image.bytes?.[0]).toBe(0xff);
      expect(image.bytes?.[1]).toBe(0xd8);
      expect(image.bytes?.byteLength).toBeGreaterThan(1000);
    }
  });

  it("posts a shipped kitten when fetch cannot reach either API", async () => {
    const lookup = createMeowLookup({
      random: () => 0,
      fetchImpl: async () => {
        throw new Error("down");
      },
    });
    const image = await lookup.randomImage();
    expect(image.bytes?.byteLength).toBeGreaterThan(1000);
    expect(image.bytes?.[0]).toBe(0xff);
    expect(isSafeMeowImageUrl(image.url)).toBe(true);
  });
});

describe("!meow engine", () => {
  const stores: Store[] = [];

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const store of stores) store.close();
    stores.length = 0;
  });

  function setup(options?: {
    image?: MeowImage;
    fail?: Error;
    failSendImage?: boolean;
    fetchImage?: boolean | "miss";
    bundled?: MeowImage;
  }): {
    engine: ModerationEngine;
    client: MockXClient;
    lookupCalls: number;
    imagineCalls: number;
    fetchCalls: number;
  } {
    const store = new Store(":memory:");
    stores.push(store);
    const client = new MockXClient();
    client.failSendImage = options?.failSendImage ?? false;
    let lookupCalls = 0;
    const lookup: MeowLookup = {
      async randomImage() {
        lookupCalls += 1;
        if (options?.fail) throw options.fail;
        return options?.image ?? { url: CATAAS };
      },
      bundledImage() {
        return options?.bundled;
      },
    };
    let imagineCalls = 0;
    let fetchCalls = 0;
    const engine = new ModerationEngine(store, client, runtime(), undefined, {
      meow: lookup,
      fetchImage:
        options?.fetchImage === false
          ? undefined
          : async () => {
              fetchCalls += 1;
              if (options?.fetchImage === "miss") return undefined;
              return { bytes: Uint8Array.from([1, 2, 3]), mimeType: "image/jpeg" };
            },
      imagine: {
        async generate() {
          imagineCalls += 1;
          throw new Error("!meow must not call Imagine");
        },
      },
    });
    return {
      engine,
      client,
      get lookupCalls() {
        return lookupCalls;
      },
      get imagineCalls() {
        return imagineCalls;
      },
      get fetchCalls() {
        return fetchCalls;
      },
    };
  }

  it("posts one kitten and mentions the requester", async () => {
    const rig = setup();
    const actions = await rig.engine.processEvent(message({ id: "m1", senderId: alice.id, text: "!Meow" }));
    expect(rig.lookupCalls).toBe(1);
    expect(rig.imagineCalls).toBe(0);
    expect(rig.fetchCalls).toBe(1);
    expect(rig.client.images).toHaveLength(1);
    expect(rig.client.images[0]).toMatchObject({
      url: CATAAS,
      caption: "@alice",
      mention: "alice",
      mimeType: "image/jpeg",
    });
    expect(rig.client.sent).toHaveLength(0);
    expect(actions.replies).toEqual([]);
    expect(JSON.stringify(rig.client.images)).not.toMatch(/api\.x\.ai|grok\.com|images\/generations/i);
  });

  it("ignores extra words and does not search them", async () => {
    const rig = setup();
    await rig.engine.processEvent(
      message({ id: "m2", senderId: alice.id, text: "!meow orange tabby please" }),
    );
    expect(rig.lookupCalls).toBe(1);
    expect(rig.client.images).toHaveLength(1);
    expect(rig.client.sent).toHaveLength(0);
    expect(JSON.stringify(rig.client.images)).not.toMatch(/orange|tabby|please/);
  });

  it("refuses a banned age term and does not call a photo API", async () => {
    const rig = setup();
    await rig.engine.processEvent(message({ id: "m3", senderId: alice.id, text: "!meow teen" }));
    expect(rig.lookupCalls).toBe(0);
    expect(rig.imagineCalls).toBe(0);
    expect(rig.fetchCalls).toBe(0);
    expect(rig.client.images).toHaveLength(0);
    const text = rig.client.sent.map((row) => row.text).join("\n");
    expect(text).toMatch(/Refused/);
    expect(text).toMatch(/does not search custom text/);
    expect(text).not.toMatch(/teen/);
    expect(text.startsWith("@alice ")).toBe(true);
  });

  it("replies with the rate-limit line and no link", async () => {
    const rig = setup({ fail: new MeowLookupError("kitten apis rate limited", MEOW_RATE_LIMIT) });
    await rig.engine.processEvent(message({ id: "m4", senderId: alice.id, text: "!meow" }));
    expect(rig.client.images).toHaveLength(0);
    expect(rig.client.sent.map((row) => row.text)).toEqual([`@alice ${MEOW_RATE_LIMIT}`]);
    expect(rig.client.sent[0]?.text).not.toMatch(/https?:|cataas|thecatapi|api\.x\.ai/i);
  });

  it("posts the bundled still when the remote download fails", async () => {
    const rig = setup({ image: { url: CATAPI }, fetchImage: "miss", bundled: bundledStill() });
    await rig.engine.processEvent(message({ id: "m5", senderId: alice.id, text: "!meow" }));
    expect(rig.fetchCalls).toBe(1);
    expect(rig.client.images).toHaveLength(1);
    expect(rig.client.images[0]?.url).toBe(BUNDLED_URL);
    expect(rig.client.sent).toHaveLength(0);
  });

  it("uploads bundled bytes without downloading them again", async () => {
    const rig = setup({ image: bundledStill() });
    await rig.engine.processEvent(message({ id: "m6", senderId: alice.id, text: "!meow" }));
    expect(rig.fetchCalls).toBe(0);
    expect(rig.client.images).toHaveLength(1);
    expect(rig.client.images[0]?.bytes).toBe(4);
    expect(rig.client.sent).toHaveLength(0);
  });

  it("does not post the image URL when the download or upload fails", async () => {
    const missing = setup({ fetchImage: false });
    await missing.engine.processEvent(message({ id: "m7", senderId: alice.id, text: "!meow" }));
    expect(missing.client.images).toHaveLength(0);
    expect(missing.client.sent.map((row) => row.text)).toEqual([`@alice ${MEOW_UNAVAILABLE}`]);
    expect(missing.client.sent[0]?.text).not.toContain(CATAAS);

    const failed = setup({ image: bundledStill(), failSendImage: true, bundled: bundledStill() });
    await failed.engine.processEvent(message({ id: "m8", senderId: alice.id, text: "!meow" }));
    expect(failed.client.images).toHaveLength(0);
    expect(failed.client.sent.map((row) => row.text)).toEqual([`@alice ${MEOW_UNAVAILABLE}`]);
    expect(failed.client.sent[0]?.text).not.toMatch(/https?:/);
  });

  it("skips an unsafe url and posts the bundled kitten instead", async () => {
    const rig = setup({
      image: { url: "https://api.x.ai/v1/images/kitten.png" },
      bundled: bundledStill(),
    });
    await rig.engine.processEvent(message({ id: "m9", senderId: alice.id, text: "!meow" }));
    expect(rig.imagineCalls).toBe(0);
    expect(rig.fetchCalls).toBe(0);
    expect(rig.client.images).toHaveLength(1);
    expect(rig.client.images[0]?.url).toBe(BUNDLED_URL);
    expect(JSON.stringify(rig.client.sent)).not.toMatch(/api\.x\.ai|grok\.com/);
  });

  it("uses cataas through the default client and does not call Imagine", async () => {
    const store = new Store(":memory:");
    stores.push(store);
    const client = new MockXClient();
    const fetched: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        const url = String(input);
        expect(url).not.toMatch(/api\.x\.ai|grok\.com/i);
        expect(url).toBe(CATAAS_KITTEN_URL);
        return jsonResponse([
          { id: "5enhMoq1fey3akP5", tags: ["kitten", "cute"], mimetype: "image/jpeg" },
        ]);
      }),
    );
    let imagineCalls = 0;
    const engine = new ModerationEngine(store, client, runtime(), undefined, {
      fetchImage: async (url) => {
        fetched.push(url);
        return { bytes: Uint8Array.from([4, 5, 6]), mimeType: "image/jpeg" };
      },
      imagine: {
        async generate() {
          imagineCalls += 1;
          throw new Error("!meow must not call Imagine");
        },
      },
    });
    await engine.processEvent(message({ id: "live", senderId: alice.id, text: "!meow" }));
    expect(imagineCalls).toBe(0);
    expect(fetched).toEqual([CATAAS]);
    expect(client.images).toHaveLength(1);
    expect(client.images[0]?.url).toBe(CATAAS);
    expect(client.sent).toHaveLength(0);
  });

  it("posts a shipped kitten when the default client cannot reach the APIs", async () => {
    const store = new Store(":memory:");
    stores.push(store);
    const client = new MockXClient();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("down");
      }),
    );
    let fetchCalls = 0;
    const engine = new ModerationEngine(store, client, runtime(), undefined, {
      fetchImage: async () => {
        fetchCalls += 1;
        return undefined;
      },
      imagine: {
        async generate() {
          throw new Error("!meow must not call Imagine");
        },
      },
    });
    await engine.processEvent(message({ id: "bank", senderId: alice.id, text: "!meow" }));
    expect(fetchCalls).toBe(0);
    expect(client.images).toHaveLength(1);
    expect(client.images[0]?.mimeType).toBe("image/jpeg");
    expect(client.images[0]?.bytes).toBeGreaterThan(1000);
    expect(client.images[0]?.url.startsWith("https://cataas.com/cat/")).toBe(true);
    expect(client.sent).toHaveLength(0);
  });

  it("reply-threads the image in encrypted Chat", async () => {
    const store = new Store(":memory:");
    stores.push(store);
    store.authorizeChat(chatGroupId);
    const images: { url?: string; caption?: import("../src/types.js").MediaCaption }[] = [];
    const texts: { text: string }[] = [];
    const chat = {
      sendImage: async (
        _conversationId: string,
        image: { url?: string; caption?: import("../src/types.js").MediaCaption },
      ) => {
        images.push(image);
        return { dmEventId: "img-1", dmConversationId: chatGroupId };
      },
      sendText: async (conversationId: string, text: string) => {
        texts.push({ text });
        return { dmEventId: "text-1", dmConversationId: conversationId };
      },
    } as unknown as import("../src/chat/service.js").ChatService;
    const engine = new ModerationEngine(store, new RoutedXClient(new MockXClient(), chat), runtime(), undefined, {
      meow: {
        async randomImage() {
          return { url: CATAAS };
        },
        bundledImage() {
          return undefined;
        },
      },
      fetchImage: async () => ({ bytes: Uint8Array.from([9, 9, 9]), mimeType: "image/jpeg" }),
      imagine: {
        async generate() {
          throw new Error("!meow must not call Imagine");
        },
      },
    });
    await engine.processEvent(
      message({
        id: "chat-meow",
        senderId: alice.id,
        text: "!meow",
        conversationId: chatGroupId,
        sequenceId: "77",
        encodedEvent: "blob-meow",
      }),
    );
    expect(texts).toEqual([]);
    expect(images).toHaveLength(1);
    expect(images[0]?.url).toBe(CATAAS);
    expect(images[0]?.caption).toEqual({
      text: "@alice",
      mention: { username: "alice", start: 0, end: 6 },
      replyTo: {
        sequenceId: "77",
        senderId: alice.id,
        previewText: "!meow",
        rawEvent: "blob-meow",
      },
    });
  });

  it("mentions !meow in the default !help text and the README", () => {
    const loaded = loadDefaults("config/default.yaml");
    const help = loaded.help;
    expect(help).toMatch(/!meow/);
    expect(help).toMatch(/one cute kitten photo/);
    expect(help).toMatch(/Image only/);
    const media = help.split("Games:")[0] ?? "";
    expect(media).toMatch(/!meow/);
    expect(loaded.admin_help ?? "").not.toMatch(/!meow/);
    const readme = fs.readFileSync("README.md", "utf8");
    const meow = readme.split("## Meow")[1]?.split("## Adult photos")[0] ?? "";
    expect(meow).toMatch(/`!meow`/);
    expect(meow).toMatch(/cataas\.com\/api\/cats\?tags=kitten/);
    expect(meow).toMatch(/api\.thecatapi\.com\/v1\/images\/search/);
    expect(meow).toMatch(/assets\/kittens/);
    expect(meow).toMatch(/does not post the image URL/i);
    expect(meow).toMatch(/does not open https:\/\/grok\.com\/imagine/);
    expect(meow).toMatch(/api\.x\.ai\/v1\/images\/generations/);
  });
});
