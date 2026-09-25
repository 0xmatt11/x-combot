import { afterEach, describe, expect, it } from "vitest";
import { ModerationEngine } from "../src/bot/engine.js";
import {
  CHEESE_CHEESE_PICKS,
  CHEESE_KITTEN_PICKS,
  isSafeCheeseImageUrl,
  selectCheesePhotos,
} from "../src/bot/cheese.js";
import {
  CHEESE_QUERY,
  CHEESE_SUBREDDITS,
  KITTEN_QUERY,
  KITTEN_SUBREDDITS,
  createCheeseImageSearch,
  parseSafeRedditImages,
  type CheeseImageSearch,
} from "../src/bot/cheese-search.js";
import { bingHtmlImageSearchUrl, duckDuckGoImageScriptUrl } from "../src/bot/image-search.js";
import { loadDefaults } from "../src/config.js";
import { Store } from "../src/store.js";
import type { BotRuntimeConfig, DefaultsConfig, DmEvent, XUser } from "../src/types.js";
import { MockXClient } from "../src/x/mock-client.js";
import { RoutedXClient } from "../src/x/routed-client.js";

const alice: XUser = { id: "u-alice", username: "alice", name: "Alice" };
const groupId = "1578398451921985538";
const chatGroupId = "g2029561975647150382";

const KITTENS = [
  "https://i.redd.it/kitten-a.jpg",
  "https://i.redd.it/kitten-b.jpg",
  "https://i.redd.it/kitten-c.jpg",
  "https://i.redd.it/kitten-d.jpg",
  "https://cdn.example/teen-kitten.jpg",
  "https://api.x.ai/v1/images/kitten.jpg",
];
const CHEESES = [
  "https://i.redd.it/cheese-a.jpg",
  "https://i.redd.it/cheese-b.jpg",
  "https://i.redd.it/cheese-c.jpg",
  "https://imagine-public.x.ai/imagine-public/images/cheese.jpg",
];

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

function keepOrder(): number {
  return 0.999;
}

describe("selectCheesePhotos", () => {
  it("mixes separate kitten and cheese photos and drops unsafe urls", () => {
    const photos = selectCheesePhotos(KITTENS, CHEESES, keepOrder);
    expect(photos.map((photo) => photo.subject)).toEqual([
      "kitten",
      "cheese",
      "kitten",
      "cheese",
      "kitten",
    ]);
    expect(photos).toHaveLength(CHEESE_KITTEN_PICKS + CHEESE_CHEESE_PICKS);
    expect(photos.filter((photo) => photo.subject === "kitten")).toHaveLength(CHEESE_KITTEN_PICKS);
    expect(photos.filter((photo) => photo.subject === "cheese")).toHaveLength(CHEESE_CHEESE_PICKS);
    const urls = photos.map((photo) => photo.url);
    expect(urls).toEqual([
      "https://i.redd.it/kitten-a.jpg",
      "https://i.redd.it/cheese-a.jpg",
      "https://i.redd.it/kitten-b.jpg",
      "https://i.redd.it/cheese-b.jpg",
      "https://i.redd.it/kitten-c.jpg",
    ]);
    expect(urls.join(" ")).not.toMatch(/teen|api\.x\.ai|imagine-public|grok\.com/i);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it("rejects Imagine and xAI hosts", () => {
    expect(isSafeCheeseImageUrl("https://api.x.ai/v1/images/generations")).toBe(false);
    expect(isSafeCheeseImageUrl("https://grok.com/imagine/cat.jpg")).toBe(false);
    expect(isSafeCheeseImageUrl("https://i.redd.it/kitten.jpg")).toBe(true);
    expect(isSafeCheeseImageUrl("https://cdn.example/cheese.jpg", "teen cheese")).toBe(false);
  });
});

describe("!cheese search", () => {
  it("uses DuckDuckGo safesearch with the fixed queries and skips caller text", async () => {
    const urls: string[] = [];
    const search = createCheeseImageSearch({
      fetchImpl: async (url) => {
        const href = String(url);
        urls.push(href);
        if (href.includes("api.x.ai") || href.includes("grok.com")) {
          throw new Error("cheese search must not call Imagine");
        }
        if (href.startsWith("https://duckduckgo.com/i.js?")) {
          const query = new URL(href).searchParams.get("q");
          const image =
            query === KITTEN_QUERY
              ? "https://i.redd.it/kitten-a.jpg"
              : "https://i.redd.it/cheese-a.jpg";
          return new Response(
            JSON.stringify({
              results: [
                { image, title: query, source: "Example" },
                { image: "https://cdn.example/teen.jpg", title: "teen", source: "Example" },
                { image: "https://api.x.ai/v1/images/out.jpg", title: "generated", source: "xai" },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response('vqd="4-cheesetoken123456"', { status: 200 });
      },
    });
    await expect(search.searchKittens()).resolves.toEqual(["https://i.redd.it/kitten-a.jpg"]);
    await expect(search.searchCheese()).resolves.toEqual(["https://i.redd.it/cheese-a.jpg"]);
    const scripts = urls.filter((href) => href.includes("/i.js?"));
    expect(scripts).toHaveLength(2);
    expect(new URL(scripts[0]!).searchParams.get("q")).toBe(KITTEN_QUERY);
    expect(new URL(scripts[0]!).searchParams.get("p")).toBe("1");
    expect(new URL(scripts[1]!).searchParams.get("q")).toBe(CHEESE_QUERY);
    expect(urls.some((href) => href.includes("bing.com") || href.includes("reddit.com"))).toBe(false);
    expect(urls.some((href) => href.includes("api.x.ai") || href.includes("grok.com"))).toBe(false);
    expect(urls.join(" ")).not.toMatch(/please|prompt|teen/);
    expect(duckDuckGoImageScriptUrl("4-cheesetoken123456", KITTEN_QUERY, "on")).toContain("p=1");
    expect(duckDuckGoImageScriptUrl("4-token12345678")).toContain("p=-1");
  });

  it("falls back to Bing moderate, then SFW Reddit, using fixed boards", async () => {
    const bing = createCheeseImageSearch({
      fetchImpl: async (url) => {
        const href = String(url);
        if (href.includes("bing.com")) {
          const page = new URL(href);
          expect(page.searchParams.get("adlt")).toBe("moderate");
          expect(page.searchParams.get("q")).toBe(KITTEN_QUERY);
          const html =
            '<a class="iusc" m="{&quot;murl&quot;:&quot;https://i.redd.it/kitten-bing.jpg&quot;,&quot;t&quot;:&quot;cute kitten&quot;}"></a>';
          return new Response(html, { status: 200 });
        }
        if (href.includes("reddit.com")) return new Response("should not run", { status: 500 });
        return new Response("down", { status: 503 });
      },
    });
    await expect(bing.searchKittens()).resolves.toEqual(["https://i.redd.it/kitten-bing.jpg"]);
    expect(bingHtmlImageSearchUrl(CHEESE_QUERY, "moderate")).toContain("adlt=moderate");

    const seenSubs: string[] = [];
    const reddit = createCheeseImageSearch({
      random: () => 0,
      fetchImpl: async (url) => {
        const href = String(url);
        if (href.includes("reddit.com")) {
          seenSubs.push(href);
          if (href.includes("gateway.reddit.com")) return new Response("blocked", { status: 403 });
          return new Response(
            JSON.stringify({
              data: {
                children: [
                  { data: { over_18: true, title: "nsfw", url: "https://i.redd.it/skip.jpg" } },
                  { data: { title: "cheese wheel", url: "https://i.redd.it/cheese-hot.jpg" } },
                  { data: { is_video: true, title: "clip", url: "https://v.redd.it/clip" } },
                ],
              },
            }),
            { status: 200 },
          );
        }
        return new Response("down", { status: 503 });
      },
    });
    await expect(reddit.searchCheese()).resolves.toEqual(["https://i.redd.it/cheese-hot.jpg"]);
    expect(seenSubs.some((href) => href.includes("/cheese"))).toBe(true);
    expect(seenSubs.some((href) => KITTEN_SUBREDDITS.some((sub) => href.includes(`/${sub}`)))).toBe(
      false,
    );
    expect(CHEESE_SUBREDDITS).toContain("cheese");
    expect(KITTEN_SUBREDDITS).toEqual(["kittens", "cats"]);
  });

  it("reads SFW reddit images and skips nsfw posts", () => {
    expect(
      parseSafeRedditImages({
        data: {
          children: [
            { data: { title: "kitten", url: "https://i.redd.it/ok.jpg" } },
            { data: { over_18: true, title: "nope", url: "https://i.redd.it/nsfw.jpg" } },
          ],
        },
      }),
    ).toEqual(["https://i.redd.it/ok.jpg"]);
  });
});

describe("!cheese engine", () => {
  const stores: Store[] = [];

  afterEach(() => {
    for (const store of stores) store.close();
    stores.length = 0;
  });

  function setup(options?: {
    failSendImage?: boolean;
    kittens?: string[];
    cheeses?: string[];
    fetchImage?: boolean;
  }): {
    engine: ModerationEngine;
    client: MockXClient;
    search: CheeseImageSearch & { kittenCalls: number; cheeseCalls: number };
    imagine: { calls: number };
  } {
    const store = new Store(":memory:");
    stores.push(store);
    const client = new MockXClient();
    client.failSendImage = options?.failSendImage ?? false;
    const search = {
      kittenCalls: 0,
      cheeseCalls: 0,
      async searchKittens() {
        search.kittenCalls += 1;
        return options?.kittens ?? KITTENS;
      },
      async searchCheese() {
        search.cheeseCalls += 1;
        return options?.cheeses ?? CHEESES;
      },
    };
    const imagine = { calls: 0 };
    const engine = new ModerationEngine(store, client, runtime(), undefined, {
      cheeseSearch: search,
      random: keepOrder,
      fetchImage:
        options?.fetchImage === false
          ? undefined
          : async () => ({ bytes: Uint8Array.from([1, 2, 3]), mimeType: "image/jpeg" }),
      imagine: {
        async generate() {
          imagine.calls += 1;
          throw new Error("!cheese must not call Imagine");
        },
      },
    });
    return { engine, client, search, imagine };
  }

  it("posts a mixed set of kitten and cheese photos and mentions the requester", async () => {
    const { engine, client, search, imagine } = setup();
    const actions = await engine.processEvent(
      message({ id: "c1", senderId: alice.id, text: "!Cheese" }),
    );
    expect(search.kittenCalls).toBe(1);
    expect(search.cheeseCalls).toBe(1);
    expect(imagine.calls).toBe(0);
    expect(client.images.map((row) => row.url)).toEqual([
      "https://i.redd.it/kitten-a.jpg",
      "https://i.redd.it/cheese-a.jpg",
      "https://i.redd.it/kitten-b.jpg",
      "https://i.redd.it/cheese-b.jpg",
      "https://i.redd.it/kitten-c.jpg",
    ]);
    expect(client.images.every((row) => row.caption === "@alice" && row.mention === "alice")).toBe(
      true,
    );
    expect(client.sent).toHaveLength(0);
    expect(actions.replies).toEqual([]);
    expect(JSON.stringify(client.images)).not.toMatch(/teen|api\.x\.ai|grok\.com/i);
  });

  it("posts image URLs when native attach fails", async () => {
    const { engine, client } = setup({ failSendImage: true });
    await engine.processEvent(message({ id: "c2", senderId: alice.id, text: "!cheese" }));
    expect(client.images).toHaveLength(0);
    expect(client.sent.map((row) => row.text)).toEqual([
      "@alice https://i.redd.it/kitten-a.jpg",
      "@alice https://i.redd.it/cheese-a.jpg",
      "@alice https://i.redd.it/kitten-b.jpg",
      "@alice https://i.redd.it/cheese-b.jpg",
      "@alice https://i.redd.it/kitten-c.jpg",
    ]);
  });

  it("ignores extra words and does not pass them to search", async () => {
    const { engine, client, search } = setup({ failSendImage: true, fetchImage: false });
    await engine.processEvent(message({ id: "c3", senderId: alice.id, text: "!cheese please more cheddar" }));
    expect(search.kittenCalls).toBe(1);
    expect(search.cheeseCalls).toBe(1);
    expect(client.sent.map((row) => row.text).join("\n")).not.toMatch(/please|cheddar/);
    expect(client.sent.length).toBeGreaterThanOrEqual(3);
    expect(client.sent.some((row) => row.text.includes("kitten"))).toBe(true);
    expect(client.sent.some((row) => row.text.includes("cheese"))).toBe(true);
  });

  it("refuses a banned age term and does not search", async () => {
    const { engine, client, search } = setup();
    await engine.processEvent(message({ id: "c4", senderId: alice.id, text: "!cheese teen" }));
    expect(search.kittenCalls).toBe(0);
    expect(search.cheeseCalls).toBe(0);
    expect(client.images).toHaveLength(0);
    expect(client.sent.map((row) => row.text).join("\n")).toMatch(/Refused/);
    expect(client.sent.map((row) => row.text).join("\n")).toMatch(/does not search custom text/);
    expect(client.sent.map((row) => row.text).join("\n")).not.toMatch(/teen/);
  });

  it("says search is unavailable when both subjects come back empty", async () => {
    const { engine, client } = setup({ kittens: [], cheeses: [] });
    await engine.processEvent(message({ id: "c5", senderId: alice.id, text: "!cheese" }));
    expect(client.images).toHaveLength(0);
    expect(client.sent[0]?.text).toMatch(/Image search is unavailable/);
  });

  it("reply-threads the command in encrypted Chat", async () => {
    const store = new Store(":memory:");
    stores.push(store);
    store.authorizeChat(chatGroupId);
    const texts: { text: string; caption?: import("../src/types.js").MediaCaption }[] = [];
    const chat = {
      sendImage: async () => {
        throw new Error("Chat media upload failed");
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
      cheeseSearch: {
        async searchKittens() {
          return ["https://i.redd.it/kitten-a.jpg", "https://i.redd.it/kitten-b.jpg"];
        },
        async searchCheese() {
          return ["https://i.redd.it/cheese-a.jpg"];
        },
      },
      random: keepOrder,
      fetchImage: async () => ({ bytes: Uint8Array.from([9, 9, 9]), mimeType: "image/jpeg" }),
    });
    await engine.processEvent(
      message({
        id: "chat-cheese",
        senderId: alice.id,
        text: "!cheese",
        conversationId: chatGroupId,
        sequenceId: "77",
        encodedEvent: "blob-cheese",
      }),
    );
    expect(texts.length).toBeGreaterThanOrEqual(2);
    expect(texts.every((row) => row.text.startsWith("@alice https://"))).toBe(true);
    expect(texts.some((row) => row.text.includes("kitten"))).toBe(true);
    expect(texts.some((row) => row.text.includes("cheese"))).toBe(true);
    expect(texts[0]?.caption).toEqual({
      text: "@alice",
      mention: { username: "alice", start: 0, end: 6 },
      replyTo: {
        sequenceId: "77",
        senderId: alice.id,
        previewText: "!cheese",
        rawEvent: "blob-cheese",
      },
    });
  });

  it("mentions !cheese in the default !help text", () => {
    const help = loadDefaults("config/default.yaml").help;
    expect(help).toMatch(/!cheese/);
    expect(help).toMatch(/kitten/);
    expect(help).toMatch(/cheese/);
    expect(help).toMatch(/Extra words are ignored/);
    expect(help).toMatch(/does not open grok\.com\/imagine/i);
  });
});
