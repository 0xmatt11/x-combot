import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ADULT_BOOTY_QUERY,
  ADULT_BOOTY_SUBREDDITS,
  ADULT_CHEST_QUERY,
  ADULT_SUBREDDITS,
  containsBannedAgeTerm,
  isSafeAdultImage,
  pickAdultBootyImage,
  pickAdultChestImage,
  redactSecrets,
  type AdultImageCandidate,
} from "../src/bot/adult-filter.js";
import { ModerationEngine } from "../src/bot/engine.js";
import { fetchAdultImage } from "../src/bot/image-fetch.js";
import {
  bingHtmlImageSearchUrl,
  createImageSearch,
  duckDuckGoImageScriptUrl,
  extractDuckDuckGoVqd,
  ImageSearchError,
  parseBingHtmlImages,
  parseDuckDuckGoImages,
  parseRedditGateway,
  parseRedditListing,
  serpApiImageSearchUrl,
  type ImageSearch,
} from "../src/bot/image-search.js";
import { loadDefaults, normalizeBoobsConfig } from "../src/config.js";
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

function distinctByte(url: string): number {
  let sum = 0;
  for (let i = 0; i < url.length; i += 1) sum = (sum + url.charCodeAt(i) * (i + 1)) % 251;
  return sum;
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
    expect(containsBannedAgeTerm(ADULT_BOOTY_QUERY)).toBeUndefined();
    expect(ADULT_CHEST_QUERY).not.toMatch(/18\s*\+|porn|nsfw|xxx/i);
    expect(ADULT_BOOTY_QUERY).not.toMatch(/18\s*\+|porn|nsfw|xxx/i);
    expect(ADULT_CHEST_QUERY).toMatch(/cleavage/i);
    expect(ADULT_CHEST_QUERY).toMatch(/chest/i);
    expect(ADULT_BOOTY_QUERY).toMatch(/butt/i);
    expect(ADULT_BOOTY_QUERY).toMatch(/from behind/i);
    expect(ADULT_BOOTY_QUERY).toMatch(/booty/i);
    expect(ADULT_BOOTY_QUERY).not.toMatch(/\bass\b/i);
    expect(ADULT_BOOTY_QUERY).not.toMatch(/breast|chest|boob/i);
    for (const sub of ADULT_SUBREDDITS) {
      expect(containsBannedAgeTerm(sub)).toBeUndefined();
    }
    for (const sub of ADULT_BOOTY_SUBREDDITS) {
      expect(containsBannedAgeTerm(sub)).toBeUndefined();
    }
    expect(ADULT_BOOTY_SUBREDDITS).not.toEqual(ADULT_SUBREDDITS);
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
    expect(pickAdultChestImage([full], () => 0)).toBeUndefined();
    const chestFull = candidate({
      url: "https://i.redd.it/full.jpg",
      title: "full body breasts portrait",
    });
    expect(pickAdultChestImage([chestFull], () => 0)?.url).toBe("https://i.redd.it/full.jpg");
    const standing = candidate({
      url: "https://i.redd.it/standing.jpg",
      title: "woman standing",
    });
    const booty = candidate({
      url: "https://i.redd.it/booty.jpg",
      title: "adult butt close-up",
    });
    expect(pickAdultBootyImage([standing, booty], () => 0)?.url).toBe("https://i.redd.it/booty.jpg");
    expect(pickAdultBootyImage([teen], () => 0)).toBeUndefined();
  });

  it("rejects genital wording and keeps mild chest or butt phrasing", () => {
    const chestUrl = "https://cdn.example/cleavage.jpg";
    const bootyUrl = "https://cdn.example/booty.jpg";
    expect(
      pickAdultChestImage(
        [
          candidate({ url: "https://cdn.example/pussy.jpg", title: "pussy close-up breasts" }),
          candidate({ url: "https://cdn.example/vagina.jpg", title: "vagina and cleavage" }),
          candidate({ url: "https://cdn.example/labia.jpg", title: "labia spread breasts" }),
          candidate({ url: "https://cdn.example/crotch.jpg", title: "crotch cleavage" }),
          candidate({ url: "https://cdn.example/spread.jpg", title: "nude spread breasts" }),
          candidate({ url: "https://cdn.example/penis.jpg", title: "penis and chest" }),
          candidate({ url: chestUrl, title: "classic cleavage close-up" }),
        ],
        () => 0,
      )?.url,
    ).toBe(chestUrl);
    expect(pickAdultChestImage([candidate({ url: chestUrl, title: "cocktail dress cleavage" })], () => 0)?.url).toBe(
      chestUrl,
    );
    expect(
      pickAdultBootyImage([candidate({ url: bootyUrl, title: "analysis of a butt from behind" })], () => 0)?.url,
    ).toBe(bootyUrl);
    expect(pickAdultBootyImage([candidate({ url: bootyUrl, title: "peacock butt" })], () => 0)?.url).toBe(bootyUrl);
    expect(
      pickAdultChestImage([candidate({ url: "https://cdn.example/pu55y.jpg", title: "pu55y breasts" })], () => 0),
    ).toBeUndefined();
  });

  it("keeps chest and booty pools separate and drops chairs and other off-topic hits", () => {
    const chestUrl = "https://cdn.example/cleavage.jpg";
    const bootyUrl = "https://cdn.example/from-behind.jpg";
    const chairUrl = "https://cdn.example/chair.jpg";
    const chest = candidate({ url: chestUrl, title: "cleavage close-up" });
    const booty = candidate({ url: bootyUrl, title: "butt from behind" });
    const chair = candidate({ url: chairUrl, title: "dining chair" });
    const assChair = candidate({ url: "https://cdn.example/ass-chair.jpg", title: "nice ass chair" });
    const drawers = candidate({ url: "https://cdn.example/drawers.jpg", title: "antique chest of drawers" });
    expect(pickAdultChestImage([booty, chair, drawers, chest], () => 0)?.url).toBe(chestUrl);
    expect(pickAdultBootyImage([chest, chair, drawers, booty], () => 0)?.url).toBe(bootyUrl);
    expect(pickAdultChestImage([booty, chair, drawers], () => 0)).toBeUndefined();
    expect(pickAdultBootyImage([chest, chair, assChair, drawers], () => 0)).toBeUndefined();
    expect(pickAdultBootyImage([candidate({ url: chairUrl, title: "office chair" })], () => 0)).toBeUndefined();
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
          { data: { over_18: true, post_hint: "image", title: "close-up chest", url: SAFE_URL } },
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
    expect(url).toContain("cleavage");
    expect(url).toContain("close-up");
    expect(url).not.toMatch(/18\s*\+|porn|nsfw/i);
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
    const bingAt = urls.findIndex((href) => href.includes("www.bing.com/images/async"));
    const redditAt = urls.findIndex((href) => href.includes("gateway.reddit.com"));
    expect(bingAt).toBeGreaterThan(0);
    expect(redditAt).toBeGreaterThan(bingAt);
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
      expect(failure.message).toMatch(/bing html fallback failed/);
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
    expect(urls.some((href) => href.includes("bing.com"))).toBe(false);
  });

  it("parses Bing HTML async results for direct image URLs", () => {
    const html = `
      <div class="imgpt">
        <a class="iusc" m="{&quot;t&quot;:&quot;adult close-up chest crop&quot;,&quot;murl&quot;:&quot;https://cdn.example/adult-close-up.jpg&quot;,&quot;turl&quot;:&quot;https://tse.mm.bing.net/th?id=thumb&quot;,&quot;purl&quot;:&quot;https://example.com/page&quot;}" href="/images/search?view=detailV2"></a>
      </div>
      <div class="imgpt">
        <a m="{&quot;murl&quot;:&quot;https://cdn.example/a.jpg?x=1&amp;y=2&quot;,&quot;t&quot;:&quot;close-up &amp; crop&quot;}" class="iusc"></a>
      </div>
      <a class="iusc" m='{"murl":"https://cdn.example/single.jpg","t":"chest crop"}'></a>
      <a class="iusc" m="{&quot;turl&quot;:&quot;https://tse.mm.bing.net/th?id=only-thumb&quot;,&quot;t&quot;:&quot;thumb only&quot;}"></a>
      <a class="iusc" m="{&quot;murl&quot;:&quot;http://cdn.example/plain.jpg&quot;,&quot;t&quot;:&quot;not https&quot;}"></a>
      <a class="iusc" m="{&quot;murl&quot;:&quot;https://cdn.example/adult-close-up.jpg&quot;,&quot;t&quot;:&quot;duplicate&quot;}"></a>
      <a class="other" m="{&quot;murl&quot;:&quot;https://cdn.example/not-iusc.jpg&quot;}"></a>
    `;
    expect(parseBingHtmlImages(html)).toEqual([
      {
        url: "https://cdn.example/adult-close-up.jpg",
        title: "adult close-up chest crop",
        snippet: "https://example.com/page",
        adult: true,
      },
      {
        url: "https://cdn.example/a.jpg?x=1&y=2",
        title: "close-up & crop",
        snippet: undefined,
        adult: true,
      },
      {
        url: "https://cdn.example/single.jpg",
        title: "chest crop",
        snippet: undefined,
        adult: true,
      },
    ]);
    const page = new URL(bingHtmlImageSearchUrl());
    expect(page.origin + page.pathname).toBe("https://www.bing.com/images/async");
    expect(page.searchParams.get("adlt")).toBe("off");
    expect(page.searchParams.get("async")).toBe("1");
    expect(page.searchParams.get("q")).toBe(ADULT_CHEST_QUERY);
    expect(page.search).not.toMatch(/teen|lolita|schoolgirl/i);
    expect(page.search).not.toContain("Ocp-Apim-Subscription-Key");
  });

  it("uses keyless Bing HTML when DuckDuckGo fails and does not call Reddit", async () => {
    const urls: string[] = [];
    let cookie = "";
    let apiKeyHeader = "";
    const search = createImageSearch({
      provider: "duckduckgo",
      apiKey: "should-not-be-sent",
      fetchImpl: async (url, init) => {
        const href = String(url);
        urls.push(href);
        const headers = new Headers(init?.headers);
        if (href.includes("www.bing.com/images/async")) {
          cookie = headers.get("cookie") ?? "";
          apiKeyHeader = headers.get("Ocp-Apim-Subscription-Key") ?? "";
          return new Response(
            `<a class="iusc" m="{&quot;murl&quot;:&quot;https://cdn.example/bing-direct.jpg&quot;,&quot;turl&quot;:&quot;https://tse.mm.bing.net/th?id=thumb&quot;,&quot;t&quot;:&quot;adult close-up chest&quot;,&quot;purl&quot;:&quot;https://example.com/gallery&quot;}"></a>`,
            { status: 200, headers: { "content-type": "text/html" } },
          );
        }
        if (href.includes("duckduckgo.com")) return new Response("blocked", { status: 403 });
        if (href.includes("reddit.com")) return new Response("should not run", { status: 500 });
        return new Response("unexpected", { status: 500 });
      },
    });
    const hits = await search.searchAdultChestImages();
    expect(hits).toEqual([
      {
        url: "https://cdn.example/bing-direct.jpg",
        title: "adult close-up chest",
        snippet: "https://example.com/gallery",
        adult: true,
      },
    ]);
    expect(hits.every((hit) => !hit.url.includes("bing.net"))).toBe(true);
    expect(urls.some((href) => href.includes("duckduckgo.com"))).toBe(true);
    expect(urls.some((href) => href.includes("www.bing.com/images/async"))).toBe(true);
    expect(urls.some((href) => href.includes("reddit.com"))).toBe(false);
    expect(urls.some((href) => href.includes("api.bing.microsoft.com"))).toBe(false);
    expect(urls.some((href) => href.includes("should-not-be-sent"))).toBe(false);
    expect(apiKeyHeader).toBe("");
    expect(cookie).toContain("ADLT=OFF");
    const bing = new URL(urls.find((href) => href.includes("images/async"))!);
    expect(bing.searchParams.get("adlt")).toBe("off");
    expect(bing.searchParams.get("q")).toBe(ADULT_CHEST_QUERY);
  });

  it("falls through Bing HTML to Reddit when async HTML has no direct images", async () => {
    const urls: string[] = [];
    const search = createImageSearch({
      provider: "ddgs",
      random: () => 0,
      fetchImpl: async (url) => {
        const href = String(url);
        urls.push(href);
        if (href.includes("/i.js?")) {
          return new Response(JSON.stringify({ results: [] }), { status: 200 });
        }
        if (href.includes("duckduckgo.com")) {
          return new Response('vqd="4-emptytoken123456"', { status: 200 });
        }
        if (href.includes("www.bing.com/images/async")) {
          return new Response(
            `<a class="iusc" m="{&quot;turl&quot;:&quot;https://tse.mm.bing.net/th?id=only&quot;}"></a>`,
            { status: 200 },
          );
        }
        if (href.includes("gateway.reddit.com")) {
          return new Response(
            JSON.stringify({
              postIds: ["t3_ok"],
              posts: { t3_ok: { isNSFW: true, title: "close-up chest", url: SAFE_URL } },
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
    const ddgAt = urls.findIndex((href) => href.includes("duckduckgo.com"));
    const scriptAt = urls.findIndex((href) => href.includes("/i.js?"));
    const bingAt = urls.findIndex((href) => href.includes("www.bing.com/images/async"));
    const redditAt = urls.findIndex((href) => href.includes("gateway.reddit.com"));
    expect(ddgAt).toBeGreaterThanOrEqual(0);
    expect(scriptAt).toBeGreaterThan(ddgAt);
    expect(bingAt).toBeGreaterThan(scriptAt);
    expect(redditAt).toBeGreaterThan(bingAt);
  });

  it("skips DuckDuckGo chairs and genital hits and uses the next on-topic provider", async () => {
    const urls: string[] = [];
    const search = createImageSearch({
      provider: "duckduckgo",
      fetchImpl: async (url) => {
        const href = String(url);
        urls.push(href);
        if (href.startsWith("https://duckduckgo.com/i.js?")) {
          return new Response(
            JSON.stringify({
              results: [
                { image: "https://cdn.example/chair.jpg", title: "office chair" },
                { image: "https://cdn.example/pussy.jpg", title: "pussy close-up" },
              ],
            }),
            { status: 200 },
          );
        }
        if (href.includes("duckduckgo.com")) {
          return new Response('vqd="4-offtopictoken123"', { status: 200 });
        }
        if (href.includes("www.bing.com/images/async")) {
          return new Response(
            `<a class="iusc" m="{&quot;murl&quot;:&quot;https://cdn.example/cleavage.jpg&quot;,&quot;t&quot;:&quot;cleavage close-up&quot;}"></a>`,
            { status: 200 },
          );
        }
        return new Response("should not run", { status: 500 });
      },
    });
    const hits = await search.searchAdultChestImages();
    expect(hits.map((hit) => hit.url)).toEqual(["https://cdn.example/cleavage.jpg"]);
    expect(urls.some((href) => href.includes("www.bing.com/images/async"))).toBe(true);
    expect(urls.some((href) => href.includes("reddit.com"))).toBe(false);
    expect(pickAdultChestImage(hits)?.url).toBe("https://cdn.example/cleavage.jpg");
  });
});

describe("!ass / !booty image search", () => {
  it("uses the butt query on DuckDuckGo and does not send the chest phrase", async () => {
    const urls: string[] = [];
    const search = createImageSearch({
      fetchImpl: async (url) => {
        const href = String(url);
        urls.push(href);
        if (href.startsWith("https://duckduckgo.com/i.js?")) {
          return new Response(
            JSON.stringify({
              results: [{ image: "https://cdn.example/booty.jpg", title: "adult butt close-up" }],
            }),
            { status: 200 },
          );
        }
        return new Response('vqd="4-bootytoken123456"', { status: 200 });
      },
    });
    const hits = await search.searchAdultBootyImages();
    expect(hits.map((hit) => hit.url)).toEqual(["https://cdn.example/booty.jpg"]);
    const page = new URL(urls[0]!);
    const script = new URL(urls[1]!);
    expect(page.searchParams.get("q")).toBe(ADULT_BOOTY_QUERY);
    expect(script.searchParams.get("q")).toBe(ADULT_BOOTY_QUERY);
    expect(script.searchParams.get("p")).toBe("-1");
    expect(`${page.search} ${script.search}`).not.toMatch(/breast|boob/i);
  });

  it("reads a butt subreddit from the Reddit provider", async () => {
    const urls: string[] = [];
    const search = createImageSearch({
      provider: "reddit",
      random: () => 0,
      fetchImpl: async (url) => {
        const href = String(url);
        urls.push(href);
        if (href.includes("gateway.reddit.com")) {
          return new Response(
            JSON.stringify({
              postIds: ["t3_ok"],
              posts: {
                t3_ok: { isNSFW: true, title: "adult butt close-up", url: "https://i.redd.it/adult-butt.jpg" },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("blocked", { status: 403 });
      },
    });
    const hits = await search.searchAdultBootyImages();
    expect(urls[0]).toMatch(
      /^https:\/\/gateway\.reddit\.com\/desktopapi\/v1\/subreddits\/(ass|pawg|booty)\?sort=hot&allow_over18=1$/,
    );
    expect(urls[0]).not.toMatch(/\/(boobs|cleavage|BiggerThanYouThought)\?/);
    expect(hits.map((hit) => hit.url)).toEqual(["https://i.redd.it/adult-butt.jpg"]);
    expect(pickAdultBootyImage(hits)?.url).toBe("https://i.redd.it/adult-butt.jpg");
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

  it("reads BOOBS_VISION and leaves it unset by default", () => {
    process.env.BOT_OWNER_ID = process.env.BOT_OWNER_ID ?? "1";
    delete process.env.BOOBS_VISION;
    expect(loadEnv(true).boobsVision).toBeUndefined();
    process.env.BOOBS_VISION = "true";
    expect(loadEnv(true).boobsVision).toBe(true);
    process.env.BOOBS_VISION = "false";
    expect(loadEnv(true).boobsVision).toBe(false);
    process.env.BOOBS_VISION = "maybe";
    expect(() => loadEnv(true)).toThrow(/BOOBS_VISION/);
    delete process.env.BOOBS_VISION;
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
    windowMs?: number;
    vision?: boolean;
    judge?: {
      judgeAdultImage: (
        topic: "chest" | "booty",
        image: { bytes: Uint8Array; mimeType: string },
      ) => Promise<"match" | "reject" | "error">;
    };
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
      topics: [] as Array<"chest" | "booty">,
      async searchAdultChestImages() {
        search.calls += 1;
        search.topics.push("chest");
        if (options?.hits) return options.hits;
        const url = search.calls === 1 ? SAFE_URL : `https://i.redd.it/adult-close-up-${search.calls}.jpg`;
        return [candidate({ url })];
      },
      async searchAdultBootyImages() {
        search.calls += 1;
        search.topics.push("booty");
        return options?.hits ?? [candidate({ url: SAFE_URL, title: "adult butt close-up" })];
      },
    };
    const config = runtime(
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
              vision: options?.vision ?? false,
              rate_limit_per_user: options?.perUser ?? 0,
              rate_limit_per_conversation: options?.perConversation ?? 0,
              rate_limit_window_ms: options?.windowMs ?? 0,
            },
          },
    );
    const engine = new ModerationEngine(store, client, config, undefined, {
      imageSearch: search,
      fetchImage:
        options?.fetchImage ??
        (async (url) => ({
          bytes: Uint8Array.from([9, 9, distinctByte(url)]),
          mimeType: "image/jpeg",
        })),
      adultVision: options?.judge,
    });
    return { engine, client, search };
  }

  it("searches and attaches a native image with no caption", async () => {
    const { engine, client, search } = setup();
    const actions = await engine.processEvent(
      message({ id: "b1", senderId: alice.id, text: "!Boobs" }),
    );
    expect(search.calls).toBe(1);
    expect(client.images).toEqual([
      { conversationId: groupId, url: SAFE_URL, mimeType: "image/jpeg", bytes: 3 },
    ]);
    expect(client.sent).toHaveLength(0);
    expect(actions.replies).toEqual([]);
    expect(JSON.stringify(actions.replies)).not.toContain("18+");
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
    expect(unsafe.client.sent[0]?.text).toMatch(/No matching image came back/);
    expect(unsafe.client.sent[0]?.text).not.toContain("schoolgirl");
  });

  it("allows every !boobs call when rate limits are 0", async () => {
    const { engine, client, search } = setup();
    const now = 5_000_000;
    await engine.processEvent(message({ id: "r1", senderId: alice.id, text: "!boobs" }), now);
    await engine.processEvent(message({ id: "r2", senderId: alice.id, text: "!boobs" }), now + 1);
    await engine.processEvent(message({ id: "r3", senderId: bob.id, text: "!boobs" }), now + 2);
    expect(search.calls).toBe(3);
    expect(client.images).toHaveLength(3);
    expect(client.sent.some((row) => /Slow down/.test(row.text))).toBe(false);
  });

  it("does not rate-limit when the window is 0 even if counts are positive", async () => {
    const { engine, client, search } = setup({ perUser: 1, perConversation: 1, windowMs: 0 });
    const now = 5_000_000;
    await engine.processEvent(message({ id: "w1", senderId: alice.id, text: "!boobs" }), now);
    await engine.processEvent(message({ id: "w2", senderId: alice.id, text: "!boobs" }), now + 1);
    expect(search.calls).toBe(2);
    expect(client.images).toHaveLength(2);
    expect(client.sent.some((row) => /Slow down/.test(row.text))).toBe(false);
  });

  it("rate-limits only when a positive cap and window are both set", async () => {
    const { engine, client, search } = setup({ perUser: 1, perConversation: 1, windowMs: 60_000 });
    const now = 5_000_000;
    await engine.processEvent(message({ id: "r1", senderId: alice.id, text: "!boobs" }), now);
    await engine.processEvent(message({ id: "r2", senderId: alice.id, text: "!boobs" }), now + 1);
    await engine.processEvent(message({ id: "r3", senderId: bob.id, text: "!boobs" }), now + 2);
    expect(search.calls).toBe(1);
    expect(client.images).toHaveLength(1);
    expect(client.sent.some((row) => /Slow down/.test(row.text))).toBe(true);
  });

  it("ignores a vision judge when the flag is off and uses it when the flag is on", async () => {
    let calls = 0;
    const off = setup({
      judge: {
        async judgeAdultImage() {
          calls += 1;
          return "reject";
        },
      },
    });
    await off.engine.processEvent(message({ id: "v-off", senderId: alice.id, text: "!boobs" }));
    expect(calls).toBe(0);
    expect(off.client.images).toHaveLength(1);

    const rejected = setup({
      vision: true,
      hits: [
        candidate({ url: "https://cdn.example/nope.jpg", title: "cleavage close-up" }),
        candidate({ url: "https://cdn.example/yes.jpg", title: "breasts close-up" }),
      ],
      fetchImage: async (url) => ({
        bytes: Uint8Array.from([url.endsWith("yes.jpg") ? 1 : 2]),
        mimeType: "image/jpeg",
      }),
      judge: {
        async judgeAdultImage(_topic, image) {
          calls += 1;
          return image.bytes[0] === 1 ? "match" : "reject";
        },
      },
    });
    await rejected.engine.processEvent(message({ id: "v-on", senderId: alice.id, text: "!boobs" }));
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(calls).toBeLessThanOrEqual(2);
    expect(rejected.client.images.map((row) => row.url)).toEqual(["https://cdn.example/yes.jpg"]);
    expect(rejected.client.sent).toHaveLength(0);

    const missed = setup({
      vision: true,
      judge: {
        async judgeAdultImage() {
          throw new Error("vision timeout");
        },
      },
    });
    await missed.engine.processEvent(message({ id: "v-miss", senderId: alice.id, text: "!boobs" }));
    expect(missed.client.images).toHaveLength(0);
    expect(missed.client.sent[0]?.text).toMatch(/No matching image came back/);

    const unconfigured = setup({ vision: true });
    await unconfigured.engine.processEvent(message({ id: "v-none", senderId: alice.id, text: "!boobs" }));
    expect(unconfigured.client.images).toHaveLength(0);
    expect(unconfigured.client.sent[0]?.text).toMatch(/Image check is unavailable/);
  });

  it("treats omitted and zero boobs rate limits as unlimited", () => {
    expect(normalizeBoobsConfig(undefined)).toMatchObject({
      enabled: false,
      vision: false,
      rate_limit_per_user: 0,
      rate_limit_per_conversation: 0,
      rate_limit_window_ms: 0,
    });
    expect(normalizeBoobsConfig({ vision: true }).vision).toBe(true);
    expect(normalizeBoobsConfig({ enabled: true, rate_limit_per_user: 0 })).toMatchObject({
      enabled: true,
      rate_limit_per_user: 0,
      rate_limit_per_conversation: 0,
      rate_limit_window_ms: 0,
    });
    expect(
      normalizeBoobsConfig({
        rate_limit_per_user: -1,
        rate_limit_per_conversation: Number.NaN,
        rate_limit_window_ms: -5,
      }),
    ).toMatchObject({
      rate_limit_per_user: 0,
      rate_limit_per_conversation: 0,
      rate_limit_window_ms: 0,
    });
    expect(
      normalizeBoobsConfig({
        rate_limit_per_user: 2,
        rate_limit_per_conversation: 3,
        rate_limit_window_ms: 10_000,
      }),
    ).toMatchObject({
      rate_limit_per_user: 2,
      rate_limit_per_conversation: 3,
      rate_limit_window_ms: 10_000,
    });
  });

  it("mentions !boobs in the default !help text", () => {
    const loaded = loadDefaults("config/default.yaml");
    expect(loaded.help).toMatch(/!boobs/);
    expect(loaded.help).toMatch(/!ass/);
    expect(loaded.help).toMatch(/!booty/);
    expect(loaded.help).toMatch(/!imagine/);
    expect(loaded.boobs?.enabled).toBe(false);
    expect(loaded.boobs?.rate_limit_per_user).toBe(0);
    expect(loaded.boobs?.rate_limit_per_conversation).toBe(0);
    expect(loaded.boobs?.rate_limit_window_ms).toBe(0);
    expect(loaded.boobs?.vision).toBe(false);
  });
});

describe("!ass and !booty", () => {
  const stores: Store[] = [];

  afterEach(() => {
    for (const store of stores) store.close();
    stores.length = 0;
  });

  function setup(options?: {
    enabled?: boolean;
    failSendImage?: boolean;
    perUser?: number;
    windowMs?: number;
  }) {
    const store = new Store(":memory:");
    stores.push(store);
    const client = new MockXClient();
    client.failSendImage = options?.failSendImage ?? false;
    const search = {
      calls: 0,
      topics: [] as Array<"chest" | "booty">,
      async searchAdultChestImages() {
        search.calls += 1;
        search.topics.push("chest");
        return [candidate({ url: SAFE_URL })];
      },
      async searchAdultBootyImages() {
        search.calls += 1;
        search.topics.push("booty");
        const url =
          search.calls === 1
            ? "https://i.redd.it/adult-butt.jpg"
            : `https://i.redd.it/adult-butt-${search.calls}.jpg`;
        return [candidate({ url, title: "adult butt close-up" })];
      },
    };
    const engine = new ModerationEngine(
      store,
      client,
      runtime({
        boobs: {
          enabled: options?.enabled !== false,
          rate_limit_per_user: options?.perUser ?? 0,
          rate_limit_per_conversation: 0,
          rate_limit_window_ms: options?.windowMs ?? 0,
        },
      }),
      undefined,
      {
        imageSearch: search,
        fetchImage: async (url) => ({
          bytes: Uint8Array.from([4, 5, distinctByte(url)]),
          mimeType: "image/jpeg",
        }),
      },
    );
    return { engine, client, search };
  }

  it("attaches a native image for both aliases with no caption", async () => {
    const { engine, client, search } = setup();
    const ass = await engine.processEvent(message({ id: "ass-1", senderId: alice.id, text: "!ass" }));
    const booty = await engine.processEvent(
      message({ id: "booty-1", senderId: alice.id, text: "!Booty" }),
    );
    expect(search.topics).toEqual(["booty", "booty"]);
    expect(search.calls).toBe(2);
    expect(client.images).toEqual([
      {
        conversationId: groupId,
        url: "https://i.redd.it/adult-butt.jpg",
        mimeType: "image/jpeg",
        bytes: 3,
      },
      {
        conversationId: groupId,
        url: "https://i.redd.it/adult-butt-2.jpg",
        mimeType: "image/jpeg",
        bytes: 3,
      },
    ]);
    expect(client.sent).toHaveLength(0);
    expect(ass.replies).toEqual([]);
    expect(booty.replies).toEqual([]);
    expect(JSON.stringify([ass.replies, booty.replies])).not.toContain("18+");
  });

  it("posts the image URL when native attach fails and still omits an age caption", async () => {
    const { engine, client } = setup({ failSendImage: true });
    const actions = await engine.processEvent(
      message({ id: "ass-link", senderId: alice.id, text: "!booty" }),
    );
    expect(client.images).toHaveLength(0);
    expect(client.sent.map((row) => row.text)).toEqual(["https://i.redd.it/adult-butt.jpg"]);
    expect(actions.replies).toEqual(["https://i.redd.it/adult-butt.jpg"]);
    expect(actions.replies.join("\n")).not.toContain("18+");
  });

  it("refuses extra text and stays off when the shared switch is disabled", async () => {
    const extra = setup();
    await extra.engine.processEvent(message({ id: "e1", senderId: alice.id, text: "!ass teen" }));
    await extra.engine.processEvent(message({ id: "e2", senderId: alice.id, text: "!booty please" }));
    expect(extra.search.calls).toBe(0);
    const text = extra.client.sent.map((row) => row.text).join("\n");
    expect(text).toMatch(/Refused\. !ass does not search custom text/);
    expect(text).toMatch(/!booty does not take extra text/);
    expect(text).not.toMatch(/teen/);

    const disabled = setup({ enabled: false });
    await disabled.engine.processEvent(message({ id: "d1", senderId: alice.id, text: "!ass" }));
    await disabled.engine.processEvent(message({ id: "d2", senderId: alice.id, text: "!booty" }));
    expect(disabled.search.calls).toBe(0);
    expect(disabled.client.sent.map((row) => row.text)).toEqual([
      "!ass is disabled on this bot.",
      "!booty is disabled on this bot.",
    ]);
  });

  it("shares the !boobs rate-limit window", async () => {
    const { engine, client, search } = setup({ perUser: 1, windowMs: 60_000 });
    const now = 5_000_000;
    await engine.processEvent(message({ id: "r1", senderId: alice.id, text: "!boobs" }), now);
    await engine.processEvent(message({ id: "r2", senderId: alice.id, text: "!ass" }), now + 1);
    expect(search.topics).toEqual(["chest"]);
    expect(client.images).toHaveLength(1);
    expect(client.sent.map((row) => row.text).join("\n")).toMatch(/Slow down — !ass/);
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
          async searchAdultBootyImages() {
            return [candidate({ url: SAFE_URL, title: "adult butt close-up" })];
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
