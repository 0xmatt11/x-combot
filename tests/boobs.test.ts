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
  ImageSearchError,
  parseRedditGateway,
  parseRedditListing,
  serpApiImageSearchUrl,
  type ImageSearch,
} from "../src/bot/image-search.js";
import { loadDefaults } from "../src/config.js";
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
  it("refuses native attach on encrypted Chat ids and uploads classic group DMs", async () => {
    const dm = new MockXClient();
    const routed = new RoutedXClient(dm, undefined);
    const image = {
      url: SAFE_URL,
      bytes: Uint8Array.from([1, 2]),
      mimeType: "image/jpeg",
    };
    await expect(routed.sendImage("g2029561975647150382", image)).rejects.toThrow(/text-only/);
    expect(dm.images).toHaveLength(0);
    await routed.sendImage(groupId, image);
    expect(dm.images).toHaveLength(1);
    expect(dm.images[0]?.url).toBe(SAFE_URL);
  });
});
