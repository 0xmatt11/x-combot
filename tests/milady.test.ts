import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { ModerationEngine } from "../src/bot/engine.js";
import { loadEnv } from "../src/env.js";
import {
  MILADY_CONTRACT,
  MILADY_RATE_LIMIT,
  MILADY_SLUG,
  MILADY_UNAVAILABLE,
  MiladyLookupError,
  OPENSEA_AUTH_KEYS_URL,
  OPENSEA_GRAPHQL_URL,
  createMiladyLookup,
  isMiladyTokenId,
  isSafeMiladyImageUrl,
  miladyGraphqlBody,
  miladyImageFromGraphql,
  miladyImageFromRest,
  miladyRestNftUrl,
  randomMiladyTokenId,
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

const IMAGE = "https://i2c.seadn.io/ethereum/0x5af0d9827e0c53e4799bb226655a1de152a425a5/milady-42.png";
const OTHER = "https://i2c.seadn.io/ethereum/0x5af0d9827e0c53e4799bb226655a1de152a425a5/milady-4259.png";
const DISPLAY = "https://i2c.seadn.io/ethereum/0x5af0d9827e0c53e4799bb226655a1de152a425a5/milady-42-display.png";

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

function graphqlHit(tokenId: string, imageUrl: string, contract = MILADY_CONTRACT) {
  return {
    data: {
      itemsByQuery: [
        {
          tokenId: "4259",
          imageUrl: OTHER,
          contractAddress: MILADY_CONTRACT,
        },
        { tokenId, imageUrl, contractAddress: contract },
      ],
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("milady token ids and image urls", () => {
  it("picks a token id from 1 through 10000", () => {
    expect(randomMiladyTokenId(() => 0)).toBe("1");
    expect(randomMiladyTokenId(() => 0.0041)).toBe("42");
    expect(randomMiladyTokenId(() => 1)).toBe("10000");
    expect(isMiladyTokenId("1")).toBe(true);
    expect(isMiladyTokenId("10000")).toBe(true);
    expect(isMiladyTokenId("0")).toBe(false);
    expect(isMiladyTokenId("10001")).toBe(false);
  });

  it("rejects OpenSea pages and Imagine hosts", () => {
    expect(isSafeMiladyImageUrl(IMAGE)).toBe(true);
    expect(isSafeMiladyImageUrl("https://opensea.io/collection/milady")).toBe(false);
    expect(isSafeMiladyImageUrl(`https://opensea.io/item/ethereum/${MILADY_CONTRACT}/42`)).toBe(false);
    expect(isSafeMiladyImageUrl("https://api.x.ai/v1/images/generations")).toBe(false);
    expect(isSafeMiladyImageUrl("https://grok.com/imagine/milady.png")).toBe(false);
    expect(isSafeMiladyImageUrl("ipfs://bafy/milady.png")).toBe(false);
  });

  it("keeps the exact token from a GraphQL search hit", () => {
    const body = graphqlHit("42", IMAGE);
    expect(miladyImageFromGraphql(body, "42")).toBe(IMAGE);
    expect(miladyImageFromGraphql(body, "4259")).toBe(OTHER);
    expect(miladyImageFromGraphql(graphqlHit("42", IMAGE, "0x0000000000000000000000000000000000000001"), "42")).toBeUndefined();
    expect(miladyImageFromGraphql(graphqlHit("42", "https://opensea.io/collection/milady"), "42")).toBeUndefined();
    expect(miladyImageFromGraphql(graphqlHit("42", "https://api.x.ai/v1/images/milady.png"), "42")).toBeUndefined();
  });

  it("prefers the REST display image and ignores the OpenSea page", () => {
    const body = {
      nft: {
        identifier: "42",
        display_image_url: DISPLAY,
        image_url: IMAGE,
        opensea_url: `https://opensea.io/item/ethereum/${MILADY_CONTRACT}/42`,
      },
    };
    expect(miladyImageFromRest(body, "42")).toBe(DISPLAY);
    expect(miladyImageFromRest({ nft: { identifier: "42", image_url: IMAGE, opensea_url: "https://opensea.io/collection/milady" } }, "42")).toBe(IMAGE);
    expect(miladyImageFromRest(body, "7")).toBeUndefined();
  });
});

describe("!milady OpenSea lookup", () => {
  it("queries public GraphQL for one Milady and does not call Imagine", async () => {
    const urls: string[] = [];
    const bodies: string[] = [];
    const lookup = createMiladyLookup({
      random: () => 0.0041,
      attempts: 1,
      fetchImpl: async (input, init) => {
        const url = String(input);
        urls.push(url);
        if (url.includes("api.x.ai") || url.includes("grok.com")) {
          throw new Error("!milady must not call Imagine");
        }
        bodies.push(String(init?.body ?? ""));
        expect(url).toBe(OPENSEA_GRAPHQL_URL);
        expect(init?.method).toBe("POST");
        return jsonResponse(graphqlHit("42", IMAGE));
      },
    });
    await expect(lookup.randomImage()).resolves.toEqual({ tokenId: "42", url: IMAGE });
    expect(urls).toEqual([OPENSEA_GRAPHQL_URL]);
    const sent = JSON.parse(bodies[0] ?? "{}") as {
      variables?: { query?: string; collectionSlug?: string };
    };
    expect(sent.variables?.query).toBe("Milady 42");
    expect(sent.variables?.collectionSlug).toBe(MILADY_SLUG);
    expect(bodies[0]).not.toMatch(/please|background|trait|api\.x\.ai|grok\.com/i);
    expect(miladyGraphqlBody("42")).toContain("Milady 42");
    expect(miladyRestNftUrl("42")).toContain(`/nfts/42`);
    expect(miladyRestNftUrl("42")).toContain(MILADY_CONTRACT);
  });

  it("tries another token when the first hit has no exact image", async () => {
    const seen: string[] = [];
    let call = 0;
    const lookup = createMiladyLookup({
      random: () => (call === 0 ? 0.0041 : 0.5),
      fetchImpl: async (input, init) => {
        call += 1;
        const body = JSON.parse(String(init?.body ?? "{}")) as { variables?: { query?: string } };
        seen.push(body.variables?.query ?? "");
        if (call === 1) return jsonResponse({ data: { itemsByQuery: [] } });
        expect(String(input)).toBe(OPENSEA_GRAPHQL_URL);
        return jsonResponse(graphqlHit("5001", IMAGE));
      },
    });
    await expect(lookup.randomImage()).resolves.toEqual({ tokenId: "5001", url: IMAGE });
    expect(seen).toEqual(["Milady 42", "Milady 5001"]);
  });

  it("uses the REST NFT endpoint when an API key is set", async () => {
    const headers: Array<Record<string, string>> = [];
    const lookup = createMiladyLookup({
      apiKey: "os-test-key",
      random: () => 0.0041,
      attempts: 1,
      fetchImpl: async (input, init) => {
        expect(String(input)).toBe(miladyRestNftUrl("42"));
        expect(String(input)).not.toContain("os-test-key");
        headers.push({ ...(init?.headers as Record<string, string>) });
        return jsonResponse({
          nft: {
            identifier: "42",
            display_image_url: DISPLAY,
            image_url: IMAGE,
            opensea_url: "https://opensea.io/collection/milady",
          },
        });
      },
    });
    await expect(lookup.randomImage()).resolves.toEqual({ tokenId: "42", url: DISPLAY });
    expect(headers[0]?.["x-api-key"]).toBe("os-test-key");
    expect(JSON.stringify(headers)).not.toContain("api.x.ai");
  });

  it("mints a free key after a GraphQL rate limit and does not leak it", async () => {
    const urls: string[] = [];
    const lookup = createMiladyLookup({
      random: () => 0.0041,
      fetchImpl: async (input, init) => {
        const url = String(input);
        urls.push(url);
        if (url === OPENSEA_GRAPHQL_URL) {
          return jsonResponse({ errors: [{ message: "rate limit exceeded" }] }, 429);
        }
        if (url === OPENSEA_AUTH_KEYS_URL) {
          expect(init?.method).toBe("POST");
          return jsonResponse({ api_key: "os-free-key", expires_at: "2099-01-01T00:00:00.000Z" });
        }
        expect((init?.headers as Record<string, string>)["x-api-key"]).toBe("os-free-key");
        return jsonResponse({
          nft: { identifier: "42", image_url: IMAGE, opensea_url: "https://opensea.io/collection/milady" },
        });
      },
    });
    await expect(lookup.randomImage()).resolves.toEqual({ tokenId: "42", url: IMAGE });
    expect(urls).toEqual([OPENSEA_GRAPHQL_URL, OPENSEA_AUTH_KEYS_URL, miladyRestNftUrl("42")]);

    urls.length = 0;
    await expect(lookup.randomImage()).resolves.toEqual({ tokenId: "42", url: IMAGE });
    expect(urls).toEqual([miladyRestNftUrl("42")]);
  });

  it("says OpenSea is busy when the free key is also rate limited", async () => {
    const lookup = createMiladyLookup({
      random: () => 0,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url === OPENSEA_AUTH_KEYS_URL) {
          return jsonResponse({ errors: [{ message: "rate limit", api_key: "os-secret-key" }] }, 429);
        }
        return jsonResponse({ errors: [{ message: "too many requests" }] }, 429);
      },
    });
    await expect(lookup.randomImage()).rejects.toMatchObject({
      name: "MiladyLookupError",
      userMessage: MILADY_RATE_LIMIT,
    });
    try {
      await lookup.randomImage();
    } catch (error) {
      expect(error).toBeInstanceOf(MiladyLookupError);
      expect(String(error)).not.toMatch(/os-secret-key/);
      expect((error as MiladyLookupError).userMessage).not.toMatch(/https?:|opensea\.io/i);
    }
  });

  it("says a Milady could not be loaded when OpenSea is down", async () => {
    const lookup = createMiladyLookup({
      random: () => 0.0041,
      attempts: 2,
      fetchImpl: async () => {
        throw new Error("socket down https://api.x.ai/v1/images");
      },
    });
    await expect(lookup.randomImage()).rejects.toMatchObject({ userMessage: MILADY_UNAVAILABLE });
  });
});

describe("!milady engine", () => {
  const stores: Store[] = [];

  afterEach(() => {
    for (const store of stores) store.close();
    stores.length = 0;
  });

  function setup(options?: {
    image?: { tokenId: string; url: string };
    fail?: Error;
    failSendImage?: boolean;
    fetchImage?: boolean;
  }): {
    engine: ModerationEngine;
    client: MockXClient;
    lookupCalls: number;
    imagineCalls: number;
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
        return options?.image ?? { tokenId: "42", url: IMAGE };
      },
    };
    let imagineCalls = 0;
    const engine = new ModerationEngine(store, client, runtime(), undefined, {
      milady: lookup,
      fetchImage:
        options?.fetchImage === false
          ? undefined
          : async () => ({ bytes: Uint8Array.from([1, 2, 3]), mimeType: "image/png" }),
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
    expect(posted).not.toMatch(/opensea\.io|api\.x\.ai|grok\.com|Milady 42/i);
    expect(posted).not.toMatch(/collection/i);
  });

  it("ignores extra words and does not describe the NFT", async () => {
    const rig = setup();
    await rig.engine.processEvent(
      message({ id: "m2", senderId: alice.id, text: "!milady background red please" }),
    );
    expect(rig.lookupCalls).toBe(1);
    expect(rig.client.images).toHaveLength(1);
    expect(rig.client.sent).toHaveLength(0);
    expect(JSON.stringify(rig.client.images)).not.toMatch(/background|please|red/);
  });

  it("refuses a banned age term and does not call OpenSea", async () => {
    const rig = setup();
    await rig.engine.processEvent(message({ id: "m3", senderId: alice.id, text: "!milady teen" }));
    expect(rig.lookupCalls).toBe(0);
    expect(rig.imagineCalls).toBe(0);
    expect(rig.client.images).toHaveLength(0);
    const text = rig.client.sent.map((row) => row.text).join("\n");
    expect(text).toMatch(/Refused/);
    expect(text).toMatch(/does not search custom text/);
    expect(text).not.toMatch(/teen/);
    expect(text.startsWith("@alice ")).toBe(true);
  });

  it("replies with the OpenSea rate-limit line and no link", async () => {
    const rig = setup({
      fail: new MiladyLookupError("opensea rate limit", MILADY_RATE_LIMIT),
    });
    await rig.engine.processEvent(message({ id: "m4", senderId: alice.id, text: "!milady" }));
    expect(rig.client.images).toHaveLength(0);
    expect(rig.client.sent.map((row) => row.text)).toEqual([`@alice ${MILADY_RATE_LIMIT}`]);
    expect(rig.client.sent[0]?.text).not.toMatch(/https?:|opensea\.io|seadn\.io/i);
  });

  it("does not post the image URL when the download or upload fails", async () => {
    const missing = setup({ fetchImage: false });
    await missing.engine.processEvent(message({ id: "m5", senderId: alice.id, text: "!milady" }));
    expect(missing.client.images).toHaveLength(0);
    expect(missing.client.sent.map((row) => row.text)).toEqual([`@alice ${MILADY_UNAVAILABLE}`]);
    expect(missing.client.sent[0]?.text).not.toContain(IMAGE);
    expect(missing.client.sent[0]?.text).not.toMatch(/opensea\.io/i);

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
          return { tokenId: "42", url: IMAGE };
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

  it("mentions !milady in the default !help text and the README", () => {
    const help = loadDefaults("config/default.yaml").help;
    expect(help).toMatch(/!milady/);
    expect(help).toMatch(/one random Milady Maker/);
    expect(help).toMatch(/Image only/);
    const media = help.split("Games:")[0] ?? "";
    expect(media).toMatch(/!milady/);
    const readme = fs.readFileSync("README.md", "utf8");
    expect(readme).toMatch(/`!milady`/);
    expect(readme).toMatch(/gql\.opensea\.io\/graphql/);
    expect(readme).toMatch(/OPENSEA_API_KEY/);
    expect(readme).toMatch(/itemsByQuery/);
    expect(readme).toMatch(/api\/v2\/auth\/keys/);
    expect(readme).toMatch(new RegExp(MILADY_CONTRACT));
    expect(readme).toMatch(/does not post the image URL/i);
  });
});

describe("milady env", () => {
  it("reads an optional OPENSEA_API_KEY", () => {
    process.env.BOT_OWNER_ID = process.env.BOT_OWNER_ID ?? "1";
    const previous = process.env.OPENSEA_API_KEY;
    try {
      delete process.env.OPENSEA_API_KEY;
      expect(loadEnv(true).openseaApiKey).toBeUndefined();
      process.env.OPENSEA_API_KEY = "  os-test-key  ";
      expect(loadEnv(true).openseaApiKey).toBe("os-test-key");
    } finally {
      if (previous === undefined) delete process.env.OPENSEA_API_KEY;
      else process.env.OPENSEA_API_KEY = previous;
    }
  });
});
