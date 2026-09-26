import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModerationEngine } from "../src/bot/engine.js";
import {
  FATHOM_CONTRACT,
  FATHOM_RATE_LIMIT,
  FATHOM_SLUG,
  FATHOM_UNAVAILABLE,
  FathomLookupError,
  OPENSEA_AUTH_KEYS_URL,
  OPENSEA_GRAPHQL_URL,
  createFathomLookup,
  downloadFathomImage,
  fathomGraphqlBody,
  fathomImageFromGraphql,
  fathomImageFromRest,
  fathomRestNftUrl,
  isFathomSvgUrl,
  isFathomTokenId,
  isSafeFathomImageUrl,
  randomFathomTokenId,
  type FathomLookup,
} from "../src/bot/fathom.js";
import { parseCommand, parseUnknownBang } from "../src/bot/parser.js";
import { loadDefaults } from "../src/config.js";
import { Store } from "../src/store.js";
import type { BotRuntimeConfig, DefaultsConfig, DmEvent, XUser } from "../src/types.js";
import { MockXClient } from "../src/x/mock-client.js";
import { RoutedXClient } from "../src/x/routed-client.js";

const alice: XUser = { id: "u-alice", username: "alice", name: "Alice" };
const groupId = "1578398451921985538";
const chatGroupId = "g2029561975647150382";

const IMAGE = "https://i2c.seadn.io/ethereum/0xce62f2a3f0ab5b5f0f5c71313cde70d96e14de23/fathom-42.png";
const SVG = "https://raw2.seadn.io/ethereum/0xce62f2a3f0ab5b5f0f5c71313cde70d96e14de23/fathom-42.svg";
const OTHER = "https://raw2.seadn.io/ethereum/0xce62f2a3f0ab5b5f0f5c71313cde70d96e14de23/fathom-100.svg";
const DISPLAY = "https://i2c.seadn.io/ethereum/0xce62f2a3f0ab5b5f0f5c71313cde70d96e14de23/fathom-42-display.png";
const TINY_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#112233"/></svg>`;

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

function graphqlHit(tokenId: string, imageUrl: string, contract = FATHOM_CONTRACT) {
  return {
    data: {
      itemsByQuery: [
        {
          tokenId: "100",
          imageUrl: OTHER,
          contractAddress: FATHOM_CONTRACT,
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

describe("!fathom command registration", () => {
  it("registers !fathom and /fathom and ignores extra words", () => {
    expect(parseCommand("!fathom")).toEqual({ name: "fathom" });
    expect(parseCommand("!Fathom")).toEqual({ name: "fathom" });
    expect(parseCommand("/fathom")).toEqual({ name: "fathom" });
    expect(parseCommand("!fathom please more")).toEqual({ name: "fathom", extra: "please more" });
    expect(parseUnknownBang("!fathom")).toBeUndefined();
    expect(parseUnknownBang("/fathom later")).toBeUndefined();
  });
});

describe("fathom token ids and image urls", () => {
  it("picks a token id from 1 through 4444", () => {
    expect(randomFathomTokenId(() => 0)).toBe("1");
    expect(randomFathomTokenId(() => 41.2 / 4444)).toBe("42");
    expect(randomFathomTokenId(() => 1)).toBe("4444");
    expect(isFathomTokenId("1")).toBe(true);
    expect(isFathomTokenId("4444")).toBe(true);
    expect(isFathomTokenId("0")).toBe(false);
    expect(isFathomTokenId("4445")).toBe(false);
  });

  it("allows the collection SVG and rejects OpenSea pages and Imagine hosts", () => {
    expect(isSafeFathomImageUrl(IMAGE)).toBe(true);
    expect(isSafeFathomImageUrl(SVG)).toBe(true);
    expect(isFathomSvgUrl(SVG)).toBe(true);
    expect(isFathomSvgUrl(IMAGE)).toBe(false);
    expect(isSafeFathomImageUrl("https://opensea.io/collection/fathom-lines")).toBe(false);
    expect(isSafeFathomImageUrl(`https://opensea.io/item/ethereum/${FATHOM_CONTRACT}/42`)).toBe(false);
    expect(isSafeFathomImageUrl("https://api.x.ai/v1/images/generations")).toBe(false);
    expect(isSafeFathomImageUrl("https://grok.com/imagine/fathom.png")).toBe(false);
    expect(isSafeFathomImageUrl("ipfs://bafy/fathom.svg")).toBe(false);
    expect(isSafeFathomImageUrl("https://ipfs2.seadn.io/ipfs/bafy/index.html")).toBe(false);
  });

  it("keeps the exact token from a GraphQL search hit", () => {
    const body = graphqlHit("42", SVG);
    expect(fathomImageFromGraphql(body, "42")).toBe(SVG);
    expect(fathomImageFromGraphql(body, "100")).toBe(OTHER);
    expect(
      fathomImageFromGraphql(graphqlHit("42", SVG, "0x0000000000000000000000000000000000000001"), "42"),
    ).toBeUndefined();
    expect(fathomImageFromGraphql(graphqlHit("42", "https://opensea.io/collection/fathom-lines"), "42")).toBeUndefined();
    expect(fathomImageFromGraphql(graphqlHit("42", "https://api.x.ai/v1/images/fathom.png"), "42")).toBeUndefined();
  });

  it("prefers the REST display image and ignores the OpenSea page", () => {
    const body = {
      nft: {
        identifier: "42",
        display_image_url: DISPLAY,
        image_url: SVG,
        opensea_url: `https://opensea.io/item/ethereum/${FATHOM_CONTRACT}/42`,
      },
    };
    expect(fathomImageFromRest(body, "42")).toBe(DISPLAY);
    expect(
      fathomImageFromRest(
        { nft: { identifier: "42", image_url: SVG, opensea_url: "https://opensea.io/collection/fathom-lines" } },
        "42",
      ),
    ).toBe(SVG);
    expect(fathomImageFromRest(body, "7")).toBeUndefined();
  });
});

describe("!fathom OpenSea lookup", () => {
  it("queries public GraphQL for one Fathom Lines token and does not call Imagine", async () => {
    const urls: string[] = [];
    const bodies: string[] = [];
    const lookup = createFathomLookup({
      random: () => 41.2 / 4444,
      attempts: 1,
      fetchImpl: async (input, init) => {
        const url = String(input);
        urls.push(url);
        if (url.includes("api.x.ai") || url.includes("grok.com")) {
          throw new Error("!fathom must not call Imagine");
        }
        bodies.push(String(init?.body ?? ""));
        expect(url).toBe(OPENSEA_GRAPHQL_URL);
        expect(init?.method).toBe("POST");
        return jsonResponse(graphqlHit("42", SVG));
      },
    });
    await expect(lookup.randomImage()).resolves.toEqual({ tokenId: "42", url: SVG });
    expect(urls).toEqual([OPENSEA_GRAPHQL_URL]);
    const sent = JSON.parse(bodies[0] ?? "{}") as {
      variables?: { query?: string; collectionSlug?: string };
    };
    expect(sent.variables?.query).toBe("Fathom Lines 42");
    expect(sent.variables?.collectionSlug).toBe(FATHOM_SLUG);
    expect(bodies[0]).not.toMatch(/please|background|trait|api\.x\.ai|grok\.com/i);
    expect(fathomGraphqlBody("42")).toContain("Fathom Lines 42");
    expect(fathomRestNftUrl("42")).toContain(`/nfts/42`);
    expect(fathomRestNftUrl("42")).toContain(FATHOM_CONTRACT);
  });

  it("tries another token when the first hit has no exact image", async () => {
    const seen: string[] = [];
    let call = 0;
    const lookup = createFathomLookup({
      random: () => (call === 0 ? 41.2 / 4444 : 0.5),
      fetchImpl: async (input, init) => {
        call += 1;
        const body = JSON.parse(String(init?.body ?? "{}")) as { variables?: { query?: string } };
        seen.push(body.variables?.query ?? "");
        if (call === 1) return jsonResponse({ data: { itemsByQuery: [] } });
        expect(String(input)).toBe(OPENSEA_GRAPHQL_URL);
        return jsonResponse(graphqlHit("2223", SVG));
      },
    });
    await expect(lookup.randomImage()).resolves.toEqual({ tokenId: "2223", url: SVG });
    expect(seen).toEqual(["Fathom Lines 42", "Fathom Lines 2223"]);
  });

  it("uses the REST NFT endpoint when an API key is set", async () => {
    const headers: Array<Record<string, string>> = [];
    const lookup = createFathomLookup({
      apiKey: "os-test-key",
      random: () => 41.2 / 4444,
      attempts: 1,
      fetchImpl: async (input, init) => {
        expect(String(input)).toBe(fathomRestNftUrl("42"));
        expect(String(input)).not.toContain("os-test-key");
        headers.push({ ...(init?.headers as Record<string, string>) });
        return jsonResponse({
          nft: {
            identifier: "42",
            display_image_url: DISPLAY,
            image_url: SVG,
            opensea_url: "https://opensea.io/collection/fathom-lines",
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
    const lookup = createFathomLookup({
      random: () => 41.2 / 4444,
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
          nft: { identifier: "42", image_url: SVG, opensea_url: "https://opensea.io/collection/fathom-lines" },
        });
      },
    });
    await expect(lookup.randomImage()).resolves.toEqual({ tokenId: "42", url: SVG });
    expect(urls).toEqual([OPENSEA_GRAPHQL_URL, OPENSEA_AUTH_KEYS_URL, fathomRestNftUrl("42")]);

    urls.length = 0;
    await expect(lookup.randomImage()).resolves.toEqual({ tokenId: "42", url: SVG });
    expect(urls).toEqual([fathomRestNftUrl("42")]);
  });

  it("says OpenSea is busy when the free key is also rate limited", async () => {
    const lookup = createFathomLookup({
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
      name: "FathomLookupError",
      userMessage: FATHOM_RATE_LIMIT,
    });
    try {
      await lookup.randomImage();
    } catch (error) {
      expect(error).toBeInstanceOf(FathomLookupError);
      expect(String(error)).not.toMatch(/os-secret-key/);
      expect((error as FathomLookupError).userMessage).not.toMatch(/https?:|opensea\.io/i);
    }
  });

  it("says a Fathom could not be loaded when OpenSea is down", async () => {
    const lookup = createFathomLookup({
      random: () => 41.2 / 4444,
      attempts: 2,
      fetchImpl: async () => {
        throw new Error("socket down https://api.x.ai/v1/images");
      },
    });
    await expect(lookup.randomImage()).rejects.toMatchObject({ userMessage: FATHOM_UNAVAILABLE });
  });
});

describe("fathom svg raster", () => {
  it("turns an SVG download into a PNG and does not return the markup", async () => {
    const image = await downloadFathomImage(SVG, async () => {
      return new Response(TINY_SVG, {
        status: 200,
        headers: { "content-type": "image/svg+xml" },
      });
    });
    expect(image?.mimeType).toBe("image/png");
    expect(image?.bytes[0]).toBe(0x89);
    expect(image?.bytes[1]).toBe(0x50);
    expect(image?.bytes[2]).toBe(0x4e);
    expect(image?.bytes[3]).toBe(0x47);
    expect(Buffer.from(image?.bytes ?? []).toString("utf8")).not.toContain("<svg");
  });

  it("keeps a raster response as-is", async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const image = await downloadFathomImage(IMAGE, async () => {
      return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
    });
    expect(image).toEqual({ bytes: png, mimeType: "image/png" });
  });
});

describe("!fathom engine", () => {
  const stores: Store[] = [];

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const store of stores) store.close();
    stores.length = 0;
  });

  function setup(options?: {
    image?: { tokenId: string; url: string };
    fail?: Error;
    failSendImage?: boolean;
    fetchImage?: boolean | "miss";
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
    const lookup: FathomLookup = {
      async randomImage() {
        lookupCalls += 1;
        if (options?.fail) throw options.fail;
        return options?.image ?? { tokenId: "42", url: IMAGE };
      },
    };
    let imagineCalls = 0;
    let fetchCalls = 0;
    const engine = new ModerationEngine(store, client, runtime(), undefined, {
      fathom: lookup,
      fetchImage:
        options?.fetchImage === false
          ? undefined
          : async () => {
              fetchCalls += 1;
              if (options?.fetchImage === "miss") return undefined;
              return { bytes: Uint8Array.from([1, 2, 3]), mimeType: "image/png" };
            },
      imagine: {
        async generate() {
          imagineCalls += 1;
          throw new Error("!fathom must not call Imagine");
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

  it("posts one image and mentions the requester", async () => {
    const rig = setup();
    const actions = await rig.engine.processEvent(
      message({ id: "f1", senderId: alice.id, text: "!Fathom" }),
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
    expect(posted).not.toMatch(/opensea\.io|api\.x\.ai|grok\.com|Fathom Lines 42/i);
    expect(posted).not.toMatch(/collection/i);
  });

  it("rasterizes an SVG token and does not use the shared raster-only download", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(TINY_SVG, {
          status: 200,
          headers: { "content-type": "image/svg+xml" },
        });
      }),
    );
    const rig = setup({ image: { tokenId: "42", url: SVG } });
    await rig.engine.processEvent(message({ id: "f-svg", senderId: alice.id, text: "!fathom" }));
    expect(rig.fetchCalls).toBe(0);
    expect(rig.client.images).toHaveLength(1);
    expect(rig.client.images[0]?.mimeType).toBe("image/png");
    expect(rig.client.images[0]?.bytes).toBeGreaterThan(8);
    expect(rig.client.sent).toHaveLength(0);
    expect(JSON.stringify(rig.client.images)).not.toContain("<svg");
  });

  it("rasterizes an SVG render URL that the shared download rejects", async () => {
    const url = "https://lines.ndrtw.com/api/render?seed=1&depth=27";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(TINY_SVG, {
          status: 200,
          headers: { "content-type": "image/svg+xml" },
        });
      }),
    );
    const rig = setup({ image: { tokenId: "7", url }, fetchImage: "miss" });
    await rig.engine.processEvent(message({ id: "f-render", senderId: alice.id, text: "!fathom" }));
    expect(rig.fetchCalls).toBe(1);
    expect(rig.client.images).toHaveLength(1);
    expect(rig.client.images[0]?.mimeType).toBe("image/png");
    expect(rig.client.images[0]?.bytes).toBeGreaterThan(8);
    expect(rig.client.sent).toHaveLength(0);
  });

  it("ignores extra words and does not describe the NFT", async () => {
    const rig = setup();
    await rig.engine.processEvent(
      message({ id: "f2", senderId: alice.id, text: "!fathom background red please" }),
    );
    expect(rig.lookupCalls).toBe(1);
    expect(rig.client.images).toHaveLength(1);
    expect(rig.client.sent).toHaveLength(0);
    expect(JSON.stringify(rig.client.images)).not.toMatch(/background|please|red/);
  });

  it("refuses a banned age term and does not call OpenSea", async () => {
    const rig = setup();
    await rig.engine.processEvent(message({ id: "f3", senderId: alice.id, text: "!fathom teen" }));
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
      fail: new FathomLookupError("opensea rate limit", FATHOM_RATE_LIMIT),
    });
    await rig.engine.processEvent(message({ id: "f4", senderId: alice.id, text: "!fathom" }));
    expect(rig.client.images).toHaveLength(0);
    expect(rig.client.sent.map((row) => row.text)).toEqual([`@alice ${FATHOM_RATE_LIMIT}`]);
    expect(rig.client.sent[0]?.text).not.toMatch(/https?:|opensea\.io|seadn\.io/i);
  });

  it("does not post the image URL when the download or upload fails", async () => {
    const missing = setup({ fetchImage: false });
    await missing.engine.processEvent(message({ id: "f5", senderId: alice.id, text: "!fathom" }));
    expect(missing.client.images).toHaveLength(0);
    expect(missing.client.sent.map((row) => row.text)).toEqual([`@alice ${FATHOM_UNAVAILABLE}`]);
    expect(missing.client.sent[0]?.text).not.toContain(IMAGE);
    expect(missing.client.sent[0]?.text).not.toMatch(/opensea\.io/i);

    const failed = setup({ failSendImage: true });
    await failed.engine.processEvent(message({ id: "f6", senderId: alice.id, text: "!fathom" }));
    expect(failed.client.images).toHaveLength(0);
    expect(failed.client.sent.map((row) => row.text)).toEqual([`@alice ${FATHOM_UNAVAILABLE}`]);
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
      fathom: {
        async randomImage() {
          return { tokenId: "42", url: IMAGE };
        },
      },
      fetchImage: async () => ({ bytes: Uint8Array.from([9, 9, 9]), mimeType: "image/png" }),
      imagine: {
        async generate() {
          throw new Error("!fathom must not call Imagine");
        },
      },
    });
    await engine.processEvent(
      message({
        id: "chat-fathom",
        senderId: alice.id,
        text: "!fathom",
        conversationId: chatGroupId,
        sequenceId: "77",
        encodedEvent: "blob-fathom",
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
        previewText: "!fathom",
        rawEvent: "blob-fathom",
      },
    });
  });

  it("mentions !fathom in the default !help text and the README", () => {
    const loaded = loadDefaults("config/default.yaml");
    const help = loaded.help;
    expect(help).toMatch(/!fathom/);
    expect(help).toMatch(/one random Fathom Lines/);
    expect(help).toMatch(/Image only/);
    const media = help.split("Games:")[0] ?? "";
    expect(media).toMatch(/!fathom/);
    expect(loaded.admin_help ?? "").not.toMatch(/!fathom/);
    const readme = fs.readFileSync("README.md", "utf8");
    expect(readme).toMatch(/`!fathom`/);
    expect(readme).toMatch(/gql\.opensea\.io\/graphql/);
    expect(readme).toMatch(/OPENSEA_API_KEY/);
    expect(readme).toMatch(/itemsByQuery/);
    expect(readme).toMatch(/fathom-lines/);
    expect(readme).toMatch(/api\/v2\/auth\/keys/);
    expect(readme).toMatch(new RegExp(FATHOM_CONTRACT));
    expect(readme).toMatch(/does not post the image URL/i);
  });
});
