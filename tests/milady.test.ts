import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { ModerationEngine } from "../src/bot/engine.js";
import { fetchAdultImage } from "../src/bot/image-fetch.js";
import { loadEnv } from "../src/env.js";
import {
  MILADY_BANK_EMPTY,
  MILADY_CAPPED,
  MILADY_MAX,
  MILADY_UNAVAILABLE,
  MILADY_USAGE,
  MiladyBankError,
  MiladyLookupError,
  canonicalMiladyImageUrl,
  createMiladyLookup,
  defaultMiladyBankPath,
  isSafeMiladyImageUrl,
  loadMiladyMemeBank,
  parseMiladyBankText,
  type MiladyLookup,
} from "../src/bot/milady.js";
import { loadDefaults } from "../src/config.js";
import { Store } from "../src/store.js";
import type { BotRuntimeConfig, DefaultsConfig, DmEvent, XUser } from "../src/types.js";
import { MockXClient } from "../src/x/mock-client.js";
import { RoutedXClient } from "../src/x/routed-client.js";

const alice: XUser = { id: "u-alice", username: "alice", name: "Alice" };
const groupId = "1578398451921985538";
const chatGroupId = "g2029561975647150382";

const IMAGE =
  "https://memedepot.com/cdn-cgi/imagedelivery/naCPMwxXX46-hrE49eZovw/57b85cf0-f015-4285-ad1c-8a3ea4eda400/public";
const OTHER =
  "https://memedepot.com/cdn-cgi/imagedelivery/naCPMwxXX46-hrE49eZovw/a505b1d5-3cbf-475f-9af8-428ff4c60d00/public";
const LAST =
  "https://memedepot.com/cdn-cgi/imagedelivery/naCPMwxXX46-hrE49eZovw/b232c637-05ca-461f-d721-46645fda9000/public";

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

describe("milady meme urls", () => {
  it("allows memedepot imagedelivery stills and rejects OpenSea, SeaDN, and Imagine hosts", () => {
    expect(isSafeMiladyImageUrl(IMAGE)).toBe(true);
    expect(canonicalMiladyImageUrl(`  ${IMAGE}  `)).toBe(IMAGE);
    expect(isSafeMiladyImageUrl("https://memedepot.com/d/milady")).toBe(false);
    expect(isSafeMiladyImageUrl("https://opensea.io/collection/milady")).toBe(false);
    expect(isSafeMiladyImageUrl("https://i2c.seadn.io/ethereum/milady-42.png")).toBe(false);
    expect(isSafeMiladyImageUrl("https://api.x.ai/v1/images/generations")).toBe(false);
    expect(isSafeMiladyImageUrl("https://grok.com/imagine/milady.png")).toBe(false);
    expect(isSafeMiladyImageUrl("https://imagine-public.x.ai/imagine-public/images/milady.jpg")).toBe(false);
    expect(isSafeMiladyImageUrl("ipfs://bafy/milady.png")).toBe(false);
    expect(isSafeMiladyImageUrl("http://memedepot.com/cdn-cgi/imagedelivery/naCPMwxXX46-hrE49eZovw/57b85cf0-f015-4285-ad1c-8a3ea4eda400/public")).toBe(false);
    expect(isSafeMiladyImageUrl(`${IMAGE}?size=public`)).toBe(false);
    expect(isSafeMiladyImageUrl(`https://user:pass@memedepot.com/cdn-cgi/imagedelivery/naCPMwxXX46-hrE49eZovw/57b85cf0-f015-4285-ad1c-8a3ea4eda400/public`)).toBe(false);
  });

  it("skips comments and drops duplicate stills", () => {
    const parsed = parseMiladyBankText(`# comment\n\n${IMAGE}\n${IMAGE}\n${OTHER}, ${LAST}`);
    expect(parsed.invalid).toEqual([]);
    expect(parsed.urls).toEqual([IMAGE, OTHER, LAST]);
    expect(parseMiladyBankText("https://api.x.ai/v1/images/milady.png").invalid).toEqual([
      "https://api.x.ai/v1/images/milady.png",
    ]);
  });
});

describe("!milady meme bank", () => {
  it("loads 399 stills from the committed file", () => {
    const urls = loadMiladyMemeBank();
    expect(defaultMiladyBankPath()).toMatch(/config\/milady-bank\.txt$/);
    expect(urls).toHaveLength(399);
    expect(new Set(urls).size).toBe(399);
    expect(urls.every((url) => isSafeMiladyImageUrl(url))).toBe(true);
    expect(urls[0]).toBe(IMAGE);
    const raw = fs.readFileSync("config/milady-bank.txt", "utf8");
    expect(raw).toMatch(/memedepot\.com\/d\/milady/);
    expect(raw).not.toMatch(/grok\.com|api\.x\.ai|opensea\.io/i);
  });

  it("picks a random still from the bank and does not call OpenSea or Imagine", async () => {
    let draws = 0;
    const lookup = createMiladyLookup({
      urls: [IMAGE, OTHER, LAST],
      random: () => {
        draws += 1;
        return draws === 1 ? 0 : 1;
      },
    });
    await expect(lookup.randomImage()).resolves.toEqual({ url: IMAGE });
    await expect(lookup.randomImage()).resolves.toEqual({ url: LAST });
    expect(draws).toBe(2);
  });

  it("picks distinct stills and avoids back-to-back repeats", async () => {
    const lookup = createMiladyLookup({
      urls: [IMAGE, OTHER, LAST],
      random: () => 0,
    });
    const burst = await lookup.randomImages!(3);
    const urls = burst.map((image) => image.url);
    expect(urls).toHaveLength(3);
    expect(new Set(urls).size).toBe(3);

    const wrapped = await createMiladyLookup({
      urls: [IMAGE, OTHER],
      random: () => 0,
    }).randomImages!(5);
    const repeated = wrapped.map((image) => image.url);
    expect(repeated).toHaveLength(5);
    expect(new Set(repeated).size).toBe(2);
    for (let i = 1; i < repeated.length; i += 1) {
      expect(repeated[i]).not.toBe(repeated[i - 1]);
    }

    const only = await createMiladyLookup({ urls: [IMAGE], random: () => 0 }).randomImages!(3);
    expect(only.map((image) => image.url)).toEqual([IMAGE, IMAGE, IMAGE]);
  });

  it("merges extra stills and says the bank is empty when nothing is loaded", async () => {
    const lookup = createMiladyLookup({
      bankText: `# only a comment\n${IMAGE}`,
      extraUrls: [OTHER],
      random: () => 0.9,
    });
    await expect(lookup.randomImage()).resolves.toEqual({ url: OTHER });

    const empty = createMiladyLookup({ urls: [] });
    await expect(empty.randomImage()).rejects.toMatchObject({
      name: "MiladyLookupError",
      userMessage: MILADY_BANK_EMPTY,
    });
    expect(() => createMiladyLookup({ bankText: "https://grok.com/imagine/milady.png" })).toThrow(MiladyBankError);
  });

  it("downloads a sample still through the same image fetch !milady uses", async () => {
    const urls = loadMiladyMemeBank();
    const sample = urls[0];
    expect(sample).toBeDefined();
    const fetched = await fetchAdultImage(sample!);
    expect(fetched).toBeDefined();
    expect(fetched!.bytes.byteLength).toBeGreaterThan(1000);
    expect(fetched!.mimeType).toMatch(/^image\/(png|jpeg|gif|webp)$/);
  }, 20_000);
});

describe("!milady engine", () => {
  const stores: Store[] = [];

  afterEach(() => {
    for (const store of stores) store.close();
    stores.length = 0;
  });

  function setup(options?: {
    image?: { url: string };
    fail?: Error;
    failSendImage?: boolean;
    fetchImage?: boolean;
    miladyUrls?: readonly string[];
    useDefaultLookup?: boolean;
  }): {
    engine: ModerationEngine;
    client: MockXClient;
    lookupCalls: number;
    imagineCalls: number;
    fetchedUrls: string[];
  } {
    const store = new Store(":memory:");
    stores.push(store);
    const client = new MockXClient();
    client.failSendImage = options?.failSendImage ?? false;
    let lookupCalls = 0;
    const lookup: MiladyLookup = {
      async randomImage() {
        lookupCalls += 1;
        if (options?.fail) throw options.fail;
        return options?.image ?? { url: IMAGE };
      },
    };
    let imagineCalls = 0;
    const fetchedUrls: string[] = [];
    const engine = new ModerationEngine(store, client, runtime(), undefined, {
      ...(options?.useDefaultLookup ? { miladyUrls: options.miladyUrls ?? [IMAGE, OTHER] } : { milady: lookup }),
      fetchImage:
        options?.fetchImage === false
          ? undefined
          : async (url) => {
              fetchedUrls.push(url);
              return { bytes: Uint8Array.from([1, 2, 3]), mimeType: "image/png" };
            },
      imagine: {
        async generate() {
          imagineCalls += 1;
          throw new Error("!milady must not call Imagine");
        },
      },
    });
    return {
      engine,
      client,
      fetchedUrls,
      get lookupCalls() {
        return lookupCalls;
      },
      get imagineCalls() {
        return imagineCalls;
      },
    };
  }

  it("posts one image and mentions the requester", async () => {
    const rig = setup();
    const actions = await rig.engine.processEvent(
      message({ id: "m1", senderId: alice.id, text: "!Milady" }),
    );
    expect(rig.lookupCalls).toBe(1);
    expect(rig.imagineCalls).toBe(0);
    expect(rig.client.images).toHaveLength(1);
    expect(rig.client.images[0]).toMatchObject({
      url: IMAGE,
      caption: "@alice",
      mention: "alice",
      mimeType: "image/png",
    });
    expect(rig.client.sent).toHaveLength(0);
    expect(actions.replies).toEqual([]);
    const posted = JSON.stringify(rig.client.images);
    expect(posted).not.toMatch(/opensea\.io|api\.x\.ai|grok\.com|seadn\.io/i);
    expect(posted).not.toMatch(/collection/i);
  });

  it("picks from the startup bank when no lookup is injected", async () => {
    const rig = setup({ useDefaultLookup: true, miladyUrls: [OTHER, IMAGE] });
    await rig.engine.processEvent(message({ id: "bank", senderId: alice.id, text: "!milady" }));
    expect(rig.lookupCalls).toBe(0);
    expect(rig.imagineCalls).toBe(0);
    expect(rig.fetchedUrls).toHaveLength(1);
    expect([IMAGE, OTHER]).toContain(rig.fetchedUrls[0]);
    expect(rig.client.images).toHaveLength(1);
    expect(rig.client.sent).toHaveLength(0);
  });

  it("rejects a non-integer, zero, or negative count with a usage hint", async () => {
    const rig = setup();
    for (const text of ["!milady background red please", "!milady 0", "!milady -3", "!milady 1.5", "!milady 5 please"]) {
      await rig.engine.processEvent(message({ id: text, senderId: alice.id, text }));
    }
    expect(rig.lookupCalls).toBe(0);
    expect(rig.imagineCalls).toBe(0);
    expect(rig.client.images).toHaveLength(0);
    expect(rig.client.sent.map((row) => row.text)).toEqual([
      `@alice ${MILADY_USAGE}`,
      `@alice ${MILADY_USAGE}`,
      `@alice ${MILADY_USAGE}`,
      `@alice ${MILADY_USAGE}`,
      `@alice ${MILADY_USAGE}`,
    ]);
    const posted = rig.client.sent.map((row) => row.text).join("\n");
    expect(posted).not.toMatch(/background|please|red|memedepot/i);
    expect(MILADY_USAGE).toContain(String(MILADY_MAX));
  });

  it("refuses a banned age term and does not read the bank", async () => {
    const rig = setup();
    await rig.engine.processEvent(message({ id: "m3", senderId: alice.id, text: "!milady teen" }));
    await rig.engine.processEvent(message({ id: "m3b", senderId: alice.id, text: "!milady 5 teen" }));
    expect(rig.lookupCalls).toBe(0);
    expect(rig.imagineCalls).toBe(0);
    expect(rig.client.images).toHaveLength(0);
    const text = rig.client.sent.map((row) => row.text).join("\n");
    expect(text).toMatch(/Refused/);
    expect(text).toMatch(/does not search custom text/);
    expect(text).not.toMatch(/teen/);
    expect(text.startsWith("@alice ")).toBe(true);
    expect(rig.client.sent).toHaveLength(2);
  });

  it("replies that the bank is empty and posts no link", async () => {
    const rig = setup({
      fail: new MiladyLookupError("milady meme bank is empty", MILADY_BANK_EMPTY),
    });
    await rig.engine.processEvent(message({ id: "m4", senderId: alice.id, text: "!milady" }));
    expect(rig.client.images).toHaveLength(0);
    expect(rig.client.sent.map((row) => row.text)).toEqual([`@alice ${MILADY_BANK_EMPTY}`]);
    expect(rig.client.sent[0]?.text).not.toMatch(/https?:|opensea\.io|memedepot\.com/i);
  });

  it("does not post the image URL when the download or upload fails", async () => {
    const missing = setup({ fetchImage: false });
    await missing.engine.processEvent(message({ id: "m5", senderId: alice.id, text: "!milady" }));
    expect(missing.client.images).toHaveLength(0);
    expect(missing.client.sent.map((row) => row.text)).toEqual([`@alice ${MILADY_UNAVAILABLE}`]);
    expect(missing.client.sent[0]?.text).not.toContain(IMAGE);
    expect(missing.client.sent[0]?.text).not.toMatch(/opensea\.io|memedepot\.com/i);

    const failed = setup({ failSendImage: true });
    await failed.engine.processEvent(message({ id: "m6", senderId: alice.id, text: "!milady" }));
    expect(failed.client.images).toHaveLength(0);
    expect(failed.client.sent.map((row) => row.text)).toEqual([`@alice ${MILADY_UNAVAILABLE}`]);
    expect(failed.client.sent[0]?.text).not.toContain(IMAGE);
  });

  it("reply-threads the image in encrypted Chat", async () => {
    const store = new Store(":memory:");
    stores.push(store);
    store.authorizeChat(chatGroupId);
    const images: { url?: string; caption?: import("../src/types.js").MediaCaption }[] = [];
    const texts: { text: string; caption?: import("../src/types.js").MediaCaption }[] = [];
    const chat = {
      sendImage: async (
        _conversationId: string,
        image: { url?: string; caption?: import("../src/types.js").MediaCaption },
      ) => {
        images.push(image);
        return { dmEventId: "img-1", dmConversationId: chatGroupId };
      },
      sendText: async (
        conversationId: string,
        text: string,
        caption?: import("../src/types.js").MediaCaption,
      ) => {
        texts.push({ text, caption });
        return { dmEventId: "text-1", dmConversationId: conversationId };
      },
    } as unknown as import("../src/chat/service.js").ChatService;
    const engine = new ModerationEngine(store, new RoutedXClient(new MockXClient(), chat), runtime(), undefined, {
      milady: {
        async randomImage() {
          return { url: IMAGE };
        },
      },
      fetchImage: async () => ({ bytes: Uint8Array.from([9, 9, 9]), mimeType: "image/png" }),
      imagine: {
        async generate() {
          throw new Error("!milady must not call Imagine");
        },
      },
    });
    await engine.processEvent(
      message({
        id: "chat-milady",
        senderId: alice.id,
        text: "!milady",
        conversationId: chatGroupId,
        sequenceId: "77",
        encodedEvent: "blob-milady",
      }),
    );
    expect(texts).toEqual([]);
    expect(images).toHaveLength(1);
    expect(images[0]?.url).toBe(IMAGE);
    expect(images[0]?.caption).toEqual({
      text: "@alice",
      mention: { username: "alice", start: 0, end: 6 },
      replyTo: {
        sequenceId: "77",
        senderId: alice.id,
        previewText: "!milady",
        rawEvent: "blob-milady",
      },
    });
  });

  it("posts a count from a lookup that only implements randomImage", async () => {
    const rig = setup();
    await rig.engine.processEvent(message({ id: "fallback", senderId: alice.id, text: "!milady 2" }));
    expect(rig.lookupCalls).toBe(2);
    expect(rig.imagineCalls).toBe(0);
    expect(rig.client.imageBatches).toHaveLength(1);
    expect(rig.client.imageBatches[0]?.urls).toEqual([IMAGE, IMAGE]);
    expect(rig.client.images).toHaveLength(2);
    expect(rig.client.sent).toHaveLength(0);
    expect(rig.client.images.every((image) => image.url === IMAGE && image.caption === "@alice")).toBe(true);
  });

  it("keeps a count of one on the single-image send", async () => {
    const rig = setup();
    await rig.engine.processEvent(message({ id: "one", senderId: alice.id, text: "!milady 1" }));
    expect(rig.client.images).toHaveLength(1);
    expect(rig.client.imageBatches).toHaveLength(0);
    expect(rig.client.sent).toHaveLength(0);
  });

  it("posts that many distinct stills and clamps above the max", async () => {
    const rig = setup({ useDefaultLookup: true, miladyUrls: [IMAGE, OTHER, LAST] });
    await rig.engine.processEvent(message({ id: "three", senderId: alice.id, text: "!milady 3" }));
    expect(rig.imagineCalls).toBe(0);
    expect(rig.client.sent).toHaveLength(0);
    expect(rig.client.imageBatches).toHaveLength(1);
    expect(rig.client.images).toHaveLength(3);
    expect(rig.client.imageBatches[0]?.urls).toEqual(rig.client.images.map((image) => image.url));
    expect(new Set(rig.client.images.map((image) => image.url)).size).toBe(3);
    expect(rig.client.images.every((image) => image.caption === "@alice" && image.mention === "alice")).toBe(true);

    const capped = setup({ useDefaultLookup: true, miladyUrls: [IMAGE, OTHER] });
    await capped.engine.processEvent(message({ id: "too-many", senderId: alice.id, text: "!milady 101" }));
    expect(capped.imagineCalls).toBe(0);
    expect(capped.client.sent.map((row) => row.text)).toEqual([`@alice ${MILADY_CAPPED}`]);
    expect(capped.client.imageBatches).toHaveLength(1);
    expect(capped.client.images).toHaveLength(MILADY_MAX);
    const urls = capped.client.images.map((image) => image.url);
    expect(urls.every((url) => url === IMAGE || url === OTHER)).toBe(true);
    for (let i = 1; i < urls.length; i += 1) expect(urls[i]).not.toBe(urls[i - 1]);
    expect(JSON.stringify(capped.client.images)).not.toMatch(/opensea\.io|api\.x\.ai|grok\.com/i);
  });

  it("skips a failed still in a burst and posts no link", async () => {
    const store = new Store(":memory:");
    stores.push(store);
    const client = new MockXClient();
    const engine = new ModerationEngine(store, client, runtime(), undefined, {
      milady: {
        async randomImage() {
          return { url: IMAGE };
        },
        async randomImages(count: number) {
          return [IMAGE, OTHER, LAST].slice(0, count).map((url) => ({ url }));
        },
      },
      fetchImage: async (url) => {
        if (url === OTHER) return undefined;
        return { bytes: Uint8Array.from([1, 2, 3]), mimeType: "image/png" };
      },
    });
    await engine.processEvent(message({ id: "partial", senderId: alice.id, text: "!milady 3" }));
    expect(client.imageBatches).toHaveLength(1);
    expect(client.imageBatches[0]?.urls).toEqual([IMAGE, LAST]);
    expect(client.images.map((image) => image.url)).toEqual([IMAGE, LAST]);
    expect(client.sent).toHaveLength(0);
    expect(JSON.stringify(client.images)).not.toContain(OTHER);

    const failedStore = new Store(":memory:");
    stores.push(failedStore);
    const failed = new MockXClient();
    const failedEngine = new ModerationEngine(failedStore, failed, runtime(), undefined, {
      milady: {
        async randomImage() {
          return { url: IMAGE };
        },
        async randomImages() {
          return [{ url: IMAGE }, { url: OTHER }];
        },
      },
      fetchImage: async () => undefined,
    });
    await failedEngine.processEvent(message({ id: "none", senderId: alice.id, text: "!milady 2" }));
    expect(failed.images).toHaveLength(0);
    expect(failed.sent.map((row) => row.text)).toEqual([`@alice ${MILADY_UNAVAILABLE}`]);
    expect(failed.sent[0]?.text).not.toMatch(/memedepot|https?:/i);
  });

  it("does not post links when a counted send fails, and stops on a 429", async () => {
    const failed = setup({ failSendImage: true });
    await failed.engine.processEvent(message({ id: "burst-fail", senderId: alice.id, text: "!milady 3" }));
    expect(failed.client.images).toHaveLength(0);
    expect(failed.client.imageBatches).toHaveLength(0);
    expect(failed.client.sent.map((row) => row.text)).toEqual([`@alice ${MILADY_UNAVAILABLE}`]);
    expect(failed.client.sent[0]?.text).not.toMatch(/memedepot|https?:/i);

    const limited = setup();
    limited.client.rateLimitSendImages = true;
    await limited.engine.processEvent(message({ id: "burst-429", senderId: alice.id, text: "!milady 4" }));
    expect(limited.client.images).toHaveLength(0);
    expect(limited.client.imageBatches).toHaveLength(0);
    expect(limited.client.sent.map((row) => row.text)).toEqual([`@alice ${MILADY_UNAVAILABLE}`]);
  });

  it("sends a count as one encrypted Chat message", async () => {
    const store = new Store(":memory:");
    stores.push(store);
    store.authorizeChat(chatGroupId);
    const batches: { url?: string; caption?: import("../src/types.js").MediaCaption }[][] = [];
    const chat = {
      sendImage: async () => {
        throw new Error("a count must not call sendImage");
      },
      sendImages: async (
        _conversationId: string,
        images: { url?: string; caption?: import("../src/types.js").MediaCaption }[],
      ) => {
        batches.push(images);
        return {
          messages: [{ dmEventId: "img-batch-1", dmConversationId: chatGroupId }],
          attached: images.length,
        };
      },
      sendText: async (conversationId: string, text: string) => {
        return { dmEventId: "text-1", dmConversationId: conversationId, text };
      },
    } as unknown as import("../src/chat/service.js").ChatService;
    const engine = new ModerationEngine(store, new RoutedXClient(new MockXClient(), chat), runtime(), undefined, {
      milady: {
        async randomImage() {
          return { url: IMAGE };
        },
        async randomImages(count: number) {
          return [IMAGE, OTHER, LAST].slice(0, count).map((url) => ({ url }));
        },
      },
      fetchImage: async () => ({ bytes: Uint8Array.from([9, 9, 9]), mimeType: "image/png" }),
    });
    await engine.processEvent(
      message({
        id: "chat-milady-3",
        senderId: alice.id,
        text: "!milady 3",
        conversationId: chatGroupId,
        sequenceId: "77",
        encodedEvent: "blob-milady",
      }),
    );
    expect(batches).toHaveLength(1);
    expect(batches[0]?.map((image) => image.url)).toEqual([IMAGE, OTHER, LAST]);
    expect(batches[0]?.[0]?.caption).toEqual({
      text: "@alice",
      mention: { username: "alice", start: 0, end: 6 },
      replyTo: {
        sequenceId: "77",
        senderId: alice.id,
        previewText: "!milady 3",
        rawEvent: "blob-milady",
      },
    });
  });

  it("mentions !milady in the default !help text and the README", () => {
    const help = loadDefaults("config/default.yaml").help;
    expect(help).toMatch(/!milady \[n\]/);
    expect(help).toMatch(/memedepot bank/);
    expect(help).toMatch(new RegExp(`max ${MILADY_MAX}`));
    expect(help).toMatch(/Bare !milady posts one/);
    expect(help).toMatch(/one message/);
    expect(help).toMatch(/Image only/);
    const media = help.split("Games:")[0] ?? "";
    expect(media).toMatch(/!milady/);
    const readme = fs.readFileSync("README.md", "utf8");
    const section = readme.split("## Milady memes")[1]?.split("## Undertow")[0] ?? "";
    expect(section).toMatch(/`!milady`/);
    expect(section).toMatch(/`!milady 5`/);
    expect(section).toMatch(/Capped at 100/);
    expect(section).toMatch(/Usage: !milady \[n\]/);
    expect(section).toMatch(/in one message/);
    expect(section).toMatch(/distinct stills/);
    expect(section).toMatch(/Only one attachment per message is supported/);
    expect(section).toMatch(/Message is too large/);
    expect(section).toMatch(/config\/milady-bank\.txt/);
    expect(section).toMatch(/memedepot\.com\/d\/milady/);
    expect(section).toMatch(/399/);
    expect(section).toMatch(/MILADY_EXTRA_URLS/);
    expect(section).toMatch(/does not post the image URL/i);
    expect(section).not.toMatch(/gql\.opensea\.io|itemsByQuery|OPENSEA_API_KEY/i);
    const overview = readme.split("## What X will not do")[0] ?? "";
    expect(overview).toMatch(/`!milady 5`/);
    expect(overview).toMatch(/max 100/);
  });
});

describe("milady env", () => {
  it("reads optional extra stills and still reads OPENSEA_API_KEY for other commands", () => {
    process.env.BOT_OWNER_ID = process.env.BOT_OWNER_ID ?? "1";
    const previousKey = process.env.OPENSEA_API_KEY;
    const previousExtra = process.env.MILADY_EXTRA_URLS;
    try {
      delete process.env.OPENSEA_API_KEY;
      delete process.env.MILADY_EXTRA_URLS;
      expect(loadEnv(true).openseaApiKey).toBeUndefined();
      expect(loadEnv(true).miladyExtraUrls).toBeUndefined();
      process.env.OPENSEA_API_KEY = "  os-test-key  ";
      process.env.MILADY_EXTRA_URLS = ` ${OTHER} `;
      expect(loadEnv(true).openseaApiKey).toBe("os-test-key");
      expect(loadEnv(true).miladyExtraUrls).toEqual([OTHER]);
      process.env.MILADY_EXTRA_URLS = "https://api.x.ai/v1/images/milady.png";
      expect(() => loadEnv(true)).toThrow(/MILADY_EXTRA_URLS/);
      process.env.MILADY_EXTRA_URLS = "https://grok.com/imagine/milady.png";
      expect(() => loadEnv(true)).toThrow(/MILADY_EXTRA_URLS/);
    } finally {
      if (previousKey === undefined) delete process.env.OPENSEA_API_KEY;
      else process.env.OPENSEA_API_KEY = previousKey;
      if (previousExtra === undefined) delete process.env.MILADY_EXTRA_URLS;
      else process.env.MILADY_EXTRA_URLS = previousExtra;
    }
  });
});
