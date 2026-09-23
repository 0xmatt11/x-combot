import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ADULT_CHEST_QUERY,
  ADULT_SUBREDDITS,
  containsBannedAgeTerm,
  isSafeAdultImage,
  pickAdultChestImage,
  redactSecrets,
  type AdultImageCandidate,
} from "../src/bot/adult-filter.js";
import { ModerationEngine } from "../src/bot/engine.js";
import { fetchAdultImage } from "../src/bot/image-fetch.js";
import {
  createImageSearch,
  duckDuckGoImageScriptUrl,
  extractDuckDuckGoVqd,
  ImageSearchError,
  parseDuckDuckGoImages,
  parseRedditGateway,
  parseRedditListing,
  serpApiImageSearchUrl,
  type ImageSearch,
} from "../src/bot/image-search.js";
import { loadDefaults } from "../src/config.js";
import { loadEnv } from "../src/env.js";
import { Store } from "../src/store.js";
import type { BotRuntimeConfig, DefaultsConfig, DmEvent, XUser } from "../src/types.js";
import { MockXClient } from "../src/x/mock-client.js";
import { RoutedXClient } from "../src/x/routed-client.js";

const alice: XUser = { id: "u-alice", username: "alice", name: "Alice" };
const bob: XUser = { id: "u-bob", username: "bob", name: "Bob" };
const groupId = "1578398451921985538";
const SAFE_URL = "https://i.redd.it/adult-close-up.jpg";

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
    rate_limit_per_user: 1,
    rate_limit_per_conversation: 2,
    rate_limit_window_ms: 60_000,
  },
};

function runtime(over: Partial<DefaultsConfig> = {}): BotRuntimeConfig {
  return {
    botUserId: "bot-1",
    ownerId: "u-owner",
    globalAdminIds: [],
    defaults: { ...defaults, ...over },
  };
}

function message(partial: Partial<DmEvent> & Pick<DmEvent, "id" | "senderId" | "text">): DmEvent {
  return {
    eventType: "MessageCreate",
    conversationId: groupId,
    participantIds: [],
    participants: [],
    mentions: [],
    sender: partial.senderId === bob.id ? bob : alice,
    ...partial,
  };
}

function candidate(partial: Partial<AdultImageCandidate> & Pick<AdultImageCandidate, "url">): AdultImageCandidate {
  return { adult: true, title: "adult close-up chest crop", ...partial };
}

describe("adult filter", () => {
  it("rejects minor, teen, lolita, and schoolgirl wording, including leet", () => {
    expect(containsBannedAgeTerm("totally teen")).toBe("teen");
    expect(containsBannedAgeTerm("t33n")).toBe("teen");
    expect(containsBannedAgeTerm("lolita")).toBe("lolita");
    expect(containsBannedAgeTerm("schoolgirl")).toBe("schoolgirl");
    expect(containsBannedAgeTerm("sch00lgirl")).toBe("schoolgirl");
    expect(containsBannedAgeTerm("minors only")).toBe("minor");
    expect(containsBannedAgeTerm("15yo")).toBe("underage");
    expect(containsBannedAgeTerm("18 year old adult")).toBeUndefined();
    expect(containsBannedAgeTerm(ADULT_CHEST_QUERY)).toBeUndefined();
    for (const sub of ADULT_SUBREDDITS) {
      expect(containsBannedAgeTerm(sub)).toBeUndefined();
    }
  });

  it("drops unsafe results and prefers a close-up over a full-body portrait", () => {
    const teen = candidate({
      url: "https://i.redd.it/nope.jpg",
      title: "teen schoolgirl",
    });
    const full = candidate({
      url: "https://i.redd.it/full.jpg",
      title: "full body portrait",
    });
    const close = candidate({
      url: SAFE_URL,
      title: "close-up chest crop",
    });
    expect(isSafeAdultImage(teen)).toBe(false);
    expect(isSafeAdultImage(candidate({ url: "http://i.redd.it/a.jpg" }))).toBe(false);
    expect(isSafeAdultImage({ ...close, adult: false })).toBe(false);
    expect(isSafeAdultImage(close)).toBe(true);
    expect(pickAdultChestImage([teen])).toBeUndefined();
    expect(pickAdultChestImage([teen, full, close], () => 0)?.url).toBe(SAFE_URL);
    expect(pickAdultChestImage([full], () => 0)?.url).toBe("https://i.redd.it/full.jpg");
  });

  it("redacts api keys before a log line", () => {
    expect(redactSecrets("failed ?api_key=super-secret-key&x=1")).not.toContain("super-secret-key");
  });
});

describe("image search parsers", () => {
  it("keeps over_18 image posts and drops everything else", () => {
    const parsed = parseRedditListing({
      data: {
        children: [
          { data: { over_18: true, post_hint: "image", title: "close-up", url: SAFE_URL } },
          { data: { over_18: false, title: "not adult", url: "https://i.redd.it/sfw.jpg" } },
          { data: { over_18: true, is_video: true, title: "clip", url: "https://v.redd.it/x" } },
          {
            data: {
              over_18: true,
              title: "teen",
              url: "https://cdn.example/teen/pic.jpg",
            },
          },
        ],
      },
    });
    expect(parsed.map((row) => row.url)).toEqual([
      SAFE_URL,
      "https://cdn.example/teen/pic.jpg",
    ]);
    expect(pickAdultChestImage(parsed)?.url).toBe(SAFE_URL);
  });

  it("parses a gateway.reddit.com desktop listing", () => {
    const fixture = JSON.parse(
      readFileSync(new URL("./fixtures/reddit-gateway.json", import.meta.url), "utf8"),
    ) as unknown;
    const parsed = parseRedditGateway(fixture);
    expect(parsed.map((row) => row.url)).toEqual([
      SAFE_URL,
      "https://preview.redd.it/only-preview.png",
      "https://i.imgur.com/adult.png",
      "https://i.redd.it/from-media.jpg",
      "https://i.redd.it/teen-title.jpg",
      "https://i.redd.it/snake.jpg",
    ]);
    expect(parsed.every((row) => row.adult)).toBe(true);
    expect(pickAdultChestImage(parsed)?.url).toBe(SAFE_URL);
    expect(pickAdultChestImage(parsed.map((row) => ({ ...row, title: "teen" })))).toBeUndefined();
  });

  it("reads the gateway listing when public hot.json is blocked", async () => {
    const fixture = JSON.parse(
      readFileSync(new URL("./fixtures/reddit-gateway.json", import.meta.url), "utf8"),
    ) as unknown;
    const urls: string[] = [];
    const search = createImageSearch({
      provider: "reddit",
      random: () => 0,
      fetchImpl: async (url) => {
        const href = String(url);
        urls.push(href);
        if (href.includes("gateway.reddit.com")) {
          return new Response(JSON.stringify(fixture), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("blocked", { status: 403 });
      },
    });
    const hits = await search.searchAdultChestImages();
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(
      /^https:\/\/gateway\.reddit\.com\/desktopapi\/v1\/subreddits\/(boobs|cleavage|BiggerThanYouThought)\?sort=hot&allow_over18=1$/,
    );
    expect(urls[0]).not.toMatch(/teen|lolita|schoolgirl|query/i);
    expect(hits.some((hit) => hit.url === SAFE_URL)).toBe(true);
    expect(pickAdultChestImage(hits)?.url).toBe(SAFE_URL);
  });

  it("falls back to hot.json when the gateway listing fails", async () => {
    const urls: string[] = [];
    const search = createImageSearch({
      provider: "reddit",
      random: () => 0,
      fetchImpl: async (url) => {
        const href = String(url);
        urls.push(href);
        if (href.includes("hot.json")) {
          return new Response(
            JSON.stringify({
              data: { children: [{ data: { over_18: true, title: "close-up", url: SAFE_URL } }] },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("blocked", { status: 403 });
      },
    });
    const hits = await search.searchAdultChestImages();
    expect(urls[0]).toContain("gateway.reddit.com");
    expect(urls[1]).toContain("hot.json");
    expect(hits.map((hit) => hit.url)).toEqual([SAFE_URL]);
  });

  it("does not fail the command when hot.json is 403", async () => {
    const seen: string[] = [];
    let gateways = 0;
    const search = createImageSearch({
      provider: "reddit",
      random: () => 0,
      fetchImpl: async (url) => {
        const href = String(url);
        if (href.includes("hot.json")) {
          seen.push("hot");
          return new Response("blocked", { status: 403 });
        }
        gateways += 1;
        seen.push(`gateway-${gateways}`);
        if (gateways === 1) return new Response("blocked", { status: 403 });
        return new Response(
          JSON.stringify({
            postIds: ["t3_ok"],
            posts: {
              t3_ok: {
                isNSFW: true,
                postHint: "image",
                title: "close-up",
                url: SAFE_URL,
                media: { type: "image", content: SAFE_URL },
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    await expect(search.searchAdultChestImages()).resolves.toEqual([
      expect.objectContaining({ url: SAFE_URL, adult: true }),
    ]);
    expect(seen).toEqual(["gateway-1", "hot", "gateway-2"]);
  });

  it("says Reddit blocked the host when every listing path fails", async () => {
    const search = createImageSearch({
      provider: "reddit",
      random: () => 0,
      fetchImpl: async () => new Response("blocked", { status: 403 }),
    });
    await expect(search.searchAdultChestImages()).rejects.toBeInstanceOf(ImageSearchError);
    try {
      await search.searchAdultChestImages();
    } catch (error) {
      expect(error).toBeInstanceOf(ImageSearchError);
      const failure = error as ImageSearchError;
      expect(failure.message).toMatch(/reddit listings unavailable/);
      expect(failure.userMessage).toMatch(/unavailable/);
      expect(failure.userMessage).toMatch(/blocked/i);
    }
  });

  it("does not put the SerpAPI key in a failure the bot would log", async () => {
    const search = createImageSearch({
      provider: "serpapi",
      apiKey: "super-secret-key",
      fetchImpl: async () => {
        throw new Error("network https://serpapi.com/search.json?api_key=super-secret-key");
      },
    });
    await expect(search.searchAdultChestImages()).rejects.toBeInstanceOf(ImageSearchError);
    try {
      await search.searchAdultChestImages();
    } catch (error) {
      expect(error).toBeInstanceOf(ImageSearchError);
      const failure = error as ImageSearchError;
      expect(failure.userMessage).toMatch(/unavailable/);
      expect(failure.message).not.toContain("super-secret-key");
      expect(String(error)).not.toContain("super-secret-key");
    }
    const url = serpApiImageSearchUrl("test-key");
    expect(url).toContain("adult");
    expect(url).toContain("close-up");
    expect(url).toContain("safe=off");
    expect(url.toLowerCase()).not.toContain("teen");
    expect(url.toLowerCase()).not.toContain("lolita");
    expect(url.toLowerCase()).not.toContain("schoolgirl");
  });

  it("sends the Bing key as a header, not in the URL", async () => {
    let seenUrl = "";
    let seenKey = "";
    const search = createImageSearch({
      provider: "bing",
      apiKey: "bing-secret",
      fetchImpl: async (url, init) => {
        seenUrl = String(url);
        seenKey = new Headers(init?.headers).get("Ocp-Apim-Subscription-Key") ?? "";
        return new Response(JSON.stringify({ value: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    await search.searchAdultChestImages();
    expect(seenKey).toBe("bing-secret");
    expect(seenUrl).not.toContain("bing-secret");
    expect(seenUrl).toContain("safeSearch=Off");
  });

  it("reads a DuckDuckGo vqd token from the three ddgs quote forms", () => {
    expect(extractDuckDuckGoVqd('vqd="4-quotedtoken123"')).toBe("4-quotedtoken123");
    expect(extractDuckDuckGoVqd("vqd='4-singlequotetoken'")).toBe("4-singlequotetoken");
    expect(extractDuckDuckGoVqd("before vqd=4-ampersandtoken&after")).toBe("4-ampersandtoken");
    expect(extractDuckDuckGoVqd("<html>no token</html>")).toBeUndefined();
  });

  it("keeps the direct image URL and ignores the thumbnail", () => {
    const parsed = parseDuckDuckGoImages({
      results: [
        {
          image: "https://cdn.example/adult-close-up.jpg",
          thumbnail: "https://tse.mm.bing.net/th?id=thumb",
          title: "adult close-up chest crop",
          url: "https://example.com/page",
          source: "Example",
        },
        { thumbnail: "https://cdn.example/only-thumb.jpg", title: "no direct image" },
        { image: "http://cdn.example/plain.jpg", title: "not https" },
      ],
    });
    expect(parsed).toEqual([
      {
        url: "https://cdn.example/adult-close-up.jpg",
        title: "adult close-up chest crop",
        snippet: "Example",
        adult: true,
      },
    ]);
    expect(duckDuckGoImageScriptUrl("4-token12345678")).toContain("p=-1");
    expect(new URL(duckDuckGoImageScriptUrl("4-token12345678")).searchParams.get("q")).toBe(
      ADULT_CHEST_QUERY,
    );
  });

  it("searches DuckDuckGo with vqd and safesearch off when no provider is set", async () => {
    const urls: string[] = [];
    const agents: string[] = [];
    let referer = "";
    const search = createImageSearch({
      fetchImpl: async (url, init) => {
        const href = String(url);
        urls.push(href);
        const headers = new Headers(init?.headers);
        agents.push(headers.get("user-agent") ?? "");
        if (href.includes("reddit.com")) {
          return new Response("should not run", { status: 500 });
        }
        if (href.startsWith("https://duckduckgo.com/i.js?")) {
          referer = headers.get("referer") ?? "";
          return new Response(
            JSON.stringify({
              results: [
                {
                  image: "https://cdn.example/adult-close-up.jpg",
                  thumbnail: "https://tse.mm.bing.net/th?id=thumb",
                  title: "adult close-up chest crop",
                  source: "Example",
                },
                {
                  image: "https://cdn.example/teen-crop.jpg",
                  title: "teen close-up",
                  source: "Example",
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/x-javascript" } },
          );
        }
        return new Response('<script>vqd="4-testtoken12345678";</script>', { status: 200 });
      },
    });
    const hits = await search.searchAdultChestImages();
    expect(urls).toHaveLength(2);
    const page = new URL(urls[0]!);
    expect(page.origin + page.pathname).toBe("https://duckduckgo.com/");
    expect(page.searchParams.get("q")).toBe(ADULT_CHEST_QUERY);
    expect(page.search).not.toMatch(/teen|lolita|schoolgirl/i);
    const script = new URL(urls[1]!);
    expect(script.origin + script.pathname).toBe("https://duckduckgo.com/i.js");
    expect(script.searchParams.get("o")).toBe("json");
    expect(script.searchParams.get("p")).toBe("-1");
    expect(script.searchParams.get("vqd")).toBe("4-testtoken12345678");
    expect(script.searchParams.get("q")).toBe(ADULT_CHEST_QUERY);
    expect(agents.every((agent) => agent.includes("Mozilla"))).toBe(true);
    expect(referer).toBe("https://duckduckgo.com/");
    expect(hits.map((hit) => hit.url)).toEqual([
      "https://cdn.example/adult-close-up.jpg",
      "https://cdn.example/teen-crop.jpg",
    ]);
    expect(hits.every((hit) => !hit.url.includes("bing.net"))).toBe(true);
    expect(pickAdultChestImage(hits)?.url).toBe("https://cdn.example/adult-close-up.jpg");
  });

  it("accepts ddg and ddgs aliases", async () => {
    for (const provider of ["ddg", "ddgs", "DuckDuckGo"]) {
      const urls: string[] = [];
      const search = createImageSearch({
        provider,
        fetchImpl: async (url) => {
          const href = String(url);
          urls.push(href);
          if (href.includes("/i.js?")) {
            return new Response(
              JSON.stringify({
                results: [{ image: "https://cdn.example/alias.jpg", title: "close-up chest" }],
              }),
              { status: 200 },
            );
          }
          return new Response("vqd='4-aliastoken12345'", { status: 200 });
        },
      });
      const hits = await search.searchAdultChestImages();
      expect(hits.map((hit) => hit.url)).toEqual(["https://cdn.example/alias.jpg"]);
      expect(urls.some((href) => href.includes("reddit.com"))).toBe(false);
    }
  });

  it("falls back to Reddit when the DuckDuckGo vqd page fails", async () => {
    const urls: string[] = [];
    const search = createImageSearch({
      provider: "duckduckgo",
      random: () => 0,
      fetchImpl: async (url) => {
        const href = String(url);
        urls.push(href);
        if (href.includes("duckduckgo.com")) return new Response("blocked", { status: 403 });
        if (href.includes("gateway.reddit.com")) {
          return new Response(
            JSON.stringify({
              postIds: ["t3_ok"],
              posts: {
                t3_ok: { isNSFW: true, title: "close-up chest", url: SAFE_URL },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("blocked", { status: 403 });
      },
    });
    const hits = await search.searchAdultChestImages();
    expect(hits.map((hit) => hit.url)).toEqual([SAFE_URL]);
    expect(urls[0]).toContain("duckduckgo.com");
    expect(urls.some((href) => href.includes("gateway.reddit.com"))).toBe(true);
    expect(urls.some((href) => href.includes("/i.js?"))).toBe(false);
  });

  it("falls back to Reddit when i.js returns no direct images", async () => {
    const search = createImageSearch({
      provider: "duckduckgo",
      random: () => 0,
      fetchImpl: async (url) => {
        const href = String(url);
        if (href.includes("/i.js?")) {
          return new Response(JSON.stringify({ results: [{ thumbnail: "https://cdn.example/t.jpg" }] }), {
            status: 200,
          });
        }
        if (href.includes("duckduckgo.com")) {
          return new Response('vqd="4-emptytoken123456"', { status: 200 });
        }
        if (href.includes("hot.json")) {
          return new Response(
            JSON.stringify({
              data: { children: [{ data: { over_18: true, title: "close-up", url: SAFE_URL } }] },
            }),
            { status: 200 },
          );
        }
        return new Response("blocked", { status: 403 });
      },
    });
    await expect(search.searchAdultChestImages()).resolves.toEqual([
      expect.objectContaining({ url: SAFE_URL, adult: true }),
    ]);
  });

  it("says image search is unavailable when DuckDuckGo and Reddit both fail", async () => {
    const search = createImageSearch({
      provider: "ddgs",
      random: () => 0,
      fetchImpl: async () => new Response("nope", { status: 502 }),
    });
    await expect(search.searchAdultChestImages()).rejects.toBeInstanceOf(ImageSearchError);
    try {
      await search.searchAdultChestImages();
    } catch (error) {
      expect(error).toBeInstanceOf(ImageSearchError);
      const failure = error as ImageSearchError;
      expect(failure.userMessage).toBe("Image search is unavailable right now.");
      expect(failure.message).toMatch(/duckduckgo failed/);
      expect(failure.message).toMatch(/reddit fallback failed/);
    }
  });

  it("does not call Reddit when DuckDuckGo fallback is disabled", async () => {
    const urls: string[] = [];
    const search = createImageSearch({
      provider: "duckduckgo",
      fallbackToReddit: false,
      fetchImpl: async (url) => {
        urls.push(String(url));
        return new Response("down", { status: 503 });
      },
    });
    await expect(search.searchAdultChestImages()).rejects.toMatchObject({
      userMessage: "Image search is unavailable right now.",
    });
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("duckduckgo.com");
  });
});

describe("BOOBS_SEARCH_PROVIDER", () => {
  const previousProvider = process.env.BOOBS_SEARCH_PROVIDER;
  const previousOwner = process.env.BOT_OWNER_ID;

  afterEach(() => {
    if (previousProvider === undefined) delete process.env.BOOBS_SEARCH_PROVIDER;
    else process.env.BOOBS_SEARCH_PROVIDER = previousProvider;
    if (previousOwner === undefined) delete process.env.BOT_OWNER_ID;
    else process.env.BOT_OWNER_ID = previousOwner;
  });

  it("defaults to unset and accepts duckduckgo aliases", () => {
    process.env.BOT_OWNER_ID = process.env.BOT_OWNER_ID ?? "1";
    delete process.env.BOOBS_SEARCH_PROVIDER;
    expect(loadEnv(true).boobsSearchProvider).toBeUndefined();
    process.env.BOOBS_SEARCH_PROVIDER = "ddg";
    expect(loadEnv(true).boobsSearchProvider).toBe("duckduckgo");
    process.env.BOOBS_SEARCH_PROVIDER = "ddgs";
    expect(loadEnv(true).boobsSearchProvider).toBe("duckduckgo");
    process.env.BOOBS_SEARCH_PROVIDER = "reddit";
    expect(loadEnv(true).boobsSearchProvider).toBe("reddit");
    process.env.BOOBS_SEARCH_PROVIDER = "nope";
    expect(() => loadEnv(true)).toThrow(/duckduckgo, reddit, serpapi, or bing/);
  });
});

describe("fetchAdultImage", () => {
  it("rejects non-https and banned paths and accepts a small jpeg", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(Uint8Array.from([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      }),
    );
    expect(await fetchAdultImage("http://i.redd.it/a.jpg", fetchImpl)).toBeUndefined();
    expect(await fetchAdultImage("https://cdn.example/teen/a.jpg", fetchImpl)).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
    const image = await fetchAdultImage(SAFE_URL, fetchImpl);
    expect(image?.mimeType).toBe("image/jpeg");
    expect(image?.bytes.byteLength).toBe(3);
  });
});

describe("!boobs engine", () => {
  const stores: Store[] = [];

  afterEach(() => {
    for (const store of stores) store.close();
    stores.length = 0;
  });

  function setup(options?: {
    enabled?: boolean;
    hits?: AdultImageCandidate[];
    failSendImage?: boolean;
    fetchImage?: (url: string) => Promise<{ bytes: Uint8Array; mimeType: string } | undefined>;
    perUser?: number;
    perConversation?: number;
  }): {
    engine: ModerationEngine;
    client: MockXClient;
    search: ImageSearch & { calls: number };
  } {
    const store = new Store(":memory:");
    stores.push(store);
    const client = new MockXClient();
    client.failSendImage = options?.failSendImage ?? false;
    const search = {
      calls: 0,
      async searchAdultChestImages() {
        search.calls += 1;
        return options?.hits ?? [candidate({ url: SAFE_URL })];
      },
    };
    const config = runtime(
      options?.enabled === false
        ? {
            boobs: {
              enabled: false,
              rate_limit_per_user: 1,
              rate_limit_per_conversation: 2,
              rate_limit_window_ms: 60_000,
            },
          }
        : {
            boobs: {
              enabled: true,
              rate_limit_per_user: options?.perUser ?? 1,
              rate_limit_per_conversation: options?.perConversation ?? 2,
              rate_limit_window_ms: 60_000,
            },
          },
    );
    const engine = new ModerationEngine(store, client, config, undefined, {
      imageSearch: search,
      fetchImage:
        options?.fetchImage ??
        (async () => ({ bytes: Uint8Array.from([9, 9, 9]), mimeType: "image/jpeg" })),
    });
    return { engine, client, search };
  }

  it("searches and attaches a native image", async () => {
    const { engine, client, search } = setup();
    await engine.processEvent(message({ id: "b1", senderId: alice.id, text: "!Boobs" }));
    expect(search.calls).toBe(1);
    expect(client.images).toEqual([
      { conversationId: groupId, url: SAFE_URL, mimeType: "image/jpeg", bytes: 3 },
    ]);
    expect(client.sent).toHaveLength(0);
  });

  it("posts the image URL when native attach fails", async () => {
    const { engine, client, search } = setup({ failSendImage: true });
    await engine.processEvent(message({ id: "b2", senderId: alice.id, text: "!boobs" }));
    expect(search.calls).toBe(1);
    expect(client.images).toHaveLength(0);
    expect(client.sent.map((row) => row.text)).toEqual([SAFE_URL]);
  });

  it("does not search when disabled, when extra text is present, or when results are unsafe", async () => {
    const disabled = setup({ enabled: false });
    await disabled.engine.processEvent(message({ id: "d1", senderId: alice.id, text: "!boobs" }));
    expect(disabled.search.calls).toBe(0);
    expect(disabled.client.sent[0]?.text).toMatch(/disabled/);

    const extra = setup();
    await extra.engine.processEvent(message({ id: "e1", senderId: alice.id, text: "!boobs teen" }));
    await extra.engine.processEvent(message({ id: "e2", senderId: alice.id, text: "!boobs please" }));
    expect(extra.search.calls).toBe(0);
    expect(extra.client.sent.map((row) => row.text).join("\n")).toMatch(/Refused/);
    expect(extra.client.sent.map((row) => row.text).join("\n")).toMatch(/does not take extra text/);
    expect(extra.client.sent.map((row) => row.text).join("\n")).not.toMatch(/teen/);

    const unsafe = setup({
      hits: [candidate({ url: "https://cdn.example/schoolgirl/a.jpg", title: "schoolgirl" })],
    });
    await unsafe.engine.processEvent(message({ id: "u1", senderId: alice.id, text: "!boobs" }));
    expect(unsafe.search.calls).toBe(1);
    expect(unsafe.client.images).toHaveLength(0);
    expect(unsafe.client.sent[0]?.text).toMatch(/No safe adult image/);
    expect(unsafe.client.sent[0]?.text).not.toContain("schoolgirl");
  });

  it("rate-limits per user and per conversation without another search", async () => {
    const { engine, client, search } = setup({ perUser: 1, perConversation: 1 });
    const now = 5_000_000;
    await engine.processEvent(message({ id: "r1", senderId: alice.id, text: "!boobs" }), now);
    await engine.processEvent(message({ id: "r2", senderId: alice.id, text: "!boobs" }), now + 1);
    await engine.processEvent(message({ id: "r3", senderId: bob.id, text: "!boobs" }), now + 2);
    expect(search.calls).toBe(1);
    expect(client.images).toHaveLength(1);
    expect(client.sent.some((row) => /Slow down/.test(row.text))).toBe(true);
  });

  it("mentions !boobs in the default !help text", () => {
    const loaded = loadDefaults("config/default.yaml");
    expect(loaded.help).toMatch(/!boobs/);
    expect(loaded.boobs?.enabled).toBe(false);
  });
});

describe("RoutedXClient image delivery", () => {
  const chatGroupId = "g2029561975647150382";

  it("routes encrypted Chat ids through ChatService.sendImage and classic DMs through DM upload", async () => {
    const dm = new MockXClient();
    const image = {
      url: SAFE_URL,
      bytes: Uint8Array.from([1, 2]),
      mimeType: "image/jpeg",
    };
    const routedNoChat = new RoutedXClient(dm, undefined);
    await expect(routedNoChat.sendImage(chatGroupId, image)).rejects.toThrow(
      /Chat configured|encryptStream|media\/upload/,
    );
    expect(dm.images).toHaveLength(0);

    const chatImages: typeof image[] = [];
    const chat = {
      sendImage: async (conversationId: string, img: typeof image) => {
        chatImages.push(img);
        return { dmEventId: "chat-img-1", dmConversationId: conversationId };
      },
    } as unknown as import("../src/chat/service.js").ChatService;
    const routed = new RoutedXClient(dm, chat);
    const sent = await routed.sendImage(chatGroupId, image);
    expect(sent.dmConversationId).toBe(chatGroupId);
    expect(chatImages).toHaveLength(1);
    expect(dm.images).toHaveLength(0);

    await routed.sendImage(groupId, image);
    expect(dm.images).toHaveLength(1);
    expect(dm.images[0]?.url).toBe(SAFE_URL);
  });

  it("posts the https URL when Chat media upload fails and does not use dm_image", async () => {
    const dm = new MockXClient();
    const texts: string[] = [];
    const chat = {
      sendImage: async () => {
        throw new Error("Chat media upload failed");
      },
      sendText: async (conversationId: string, text: string) => {
        texts.push(text);
        return { dmEventId: "text-1", dmConversationId: conversationId };
      },
    } as unknown as import("../src/chat/service.js").ChatService;
    const store = new Store(":memory:");
    const engine = new ModerationEngine(
      store,
      new RoutedXClient(dm, chat),
      runtime(),
      undefined,
      {
        imageSearch: {
          async searchAdultChestImages() {
            return [candidate({ url: SAFE_URL })];
          },
        },
        fetchImage: async () => ({ bytes: Uint8Array.from([9, 9, 9]), mimeType: "image/jpeg" }),
      },
    );
    await engine.processEvent(
      message({ id: "chat-boobs", senderId: alice.id, text: "!boobs", conversationId: chatGroupId }),
    );
    store.close();
    expect(dm.images).toHaveLength(0);
    expect(texts).toEqual([SAFE_URL]);
  });
});
