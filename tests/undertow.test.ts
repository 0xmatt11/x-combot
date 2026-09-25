import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { ModerationEngine } from "../src/bot/engine.js";
import { parseCommand, parseUnknownBang } from "../src/bot/parser.js";
import {
  OPENSEA_AUTH_KEYS_URL,
  OPENSEA_GRAPHQL_URL,
  UNDERTOW_RATE_LIMIT,
  UNDERTOW_UNAVAILABLE,
  UNDERTOW_USERNAME,
  UndertowLookupError,
  createUndertowLookup,
  isSafeUndertowImageUrl,
  pickUndertowPiece,
  undertowAccountIdFromProfile,
  undertowCreatedGraphqlBody,
  undertowPiecesFromCreated,
  undertowPiecesFromRest,
  undertowProfileGraphqlBody,
  undertowRestCollectionsUrl,
  type UndertowLookup,
  type UndertowPiece,
} from "../src/bot/undertow.js";
import { loadDefaults } from "../src/config.js";
import { Store } from "../src/store.js";
import type { BotRuntimeConfig, DefaultsConfig, DmEvent, XUser } from "../src/types.js";
import { MockXClient } from "../src/x/mock-client.js";
import { RoutedXClient } from "../src/x/routed-client.js";

const alice: XUser = { id: "u-alice", username: "alice", name: "Alice" };
const groupId = "1578398451921985538";
const chatGroupId = "g2029561975647150382";

const FIRST = "https://i2c.seadn.io/ethereum/b40281fb35ed43158317d231f07f977f/human-machine.png";
const SECOND = "https://i2c.seadn.io/ethereum/dc888e7cb1c247dfac930b0718e5854b/ndrtw.gif";
const PAGE_URL = "https://opensea.io/-undertow-/created";

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

function profileBody(accountId = "acct-undertow") {
  return {
    data: {
      profileByIdentifierV2: { __typename: "Profile", accountId },
    },
  };
}

function createdBody(items: Array<{ slug: string; imageUrl?: string | null }>, cursor: string | null = null) {
  return {
    data: {
      userCreatedCollections: {
        items: items.map((item) => ({ slug: item.slug, imageUrl: item.imageUrl ?? null })),
        nextPageCursor: cursor,
      },
    },
  };
}

const pieces: UndertowPiece[] = [
  { slug: "human-machine-create", url: FIRST },
  { slug: "ndrtw", url: SECOND },
  { slug: "ntrct", url: "" },
  { slug: "page", url: PAGE_URL },
];

describe("!undertow command registration", () => {
  it("registers !undertow and /undertow and ignores extra words", () => {
    expect(parseCommand("!undertow")).toEqual({ name: "undertow" });
    expect(parseCommand("!UnderTow")).toEqual({ name: "undertow" });
    expect(parseCommand("/undertow")).toEqual({ name: "undertow" });
    expect(parseCommand("!undertow please more")).toEqual({ name: "undertow", extra: "please more" });
    expect(parseUnknownBang("!undertow")).toBeUndefined();
    expect(parseUnknownBang("/undertow later")).toBeUndefined();
  });
});

describe("undertow random pick", () => {
  it("picks one safe image and skips empty or OpenSea page urls", () => {
    expect(pickUndertowPiece(pieces, () => 0)).toEqual({ slug: "human-machine-create", url: FIRST });
    expect(pickUndertowPiece(pieces, () => 0.99)).toEqual({ slug: "ndrtw", url: SECOND });
    expect(pickUndertowPiece(pieces, () => 1)).toEqual({ slug: "ndrtw", url: SECOND });
    expect(pickUndertowPiece([], () => 0)).toBeUndefined();
    expect(pickUndertowPiece([{ slug: "page", url: PAGE_URL }], () => 0)).toBeUndefined();
    expect(isSafeUndertowImageUrl(FIRST)).toBe(true);
    expect(isSafeUndertowImageUrl(PAGE_URL)).toBe(false);
    expect(isSafeUndertowImageUrl("https://api.x.ai/v1/images/generations")).toBe(false);
    expect(isSafeUndertowImageUrl("https://grok.com/imagine/undertow.png")).toBe(false);
    expect(isSafeUndertowImageUrl("https://i2c.seadn.io/clip.mp4")).toBe(false);
  });

  it("reads the hardcoded profile and a Created page", () => {
    expect(undertowProfileGraphqlBody()).toContain(UNDERTOW_USERNAME);
    expect(undertowProfileGraphqlBody()).not.toMatch(/please|api\.x\.ai|grok\.com/);
    expect(undertowAccountIdFromProfile(profileBody())).toBe("acct-undertow");
    expect(undertowAccountIdFromProfile({ data: { profileByIdentifierV2: { __typename: "Missing" } } })).toBeUndefined();
    const page = undertowPiecesFromCreated(createdBody(
      [
        { slug: "human-machine-create", imageUrl: FIRST },
        { slug: "ndrtw", imageUrl: SECOND },
      ],
      "cursor-2",
    ));
    expect(page).toEqual({
      pieces: [
        { slug: "human-machine-create", url: FIRST },
        { slug: "ndrtw", url: SECOND },
      ],
      cursor: "cursor-2",
    });
    expect(undertowCreatedGraphqlBody("acct-undertow")).toContain("userCreatedCollections");
    expect(undertowCreatedGraphqlBody("acct-undertow")).toContain("acct-undertow");
    const rest = undertowRestCollectionsUrl();
    expect(rest).toContain("creator_username=-undertow-");
    expect(rest).toContain("limit=50");
    expect(rest).not.toContain("opensea.io/item");
    expect(undertowPiecesFromRest({
      collections: [
        { collection: "ndrtw", name: "NDRTW", image_url: SECOND, opensea_url: PAGE_URL },
        { collection: "blank", image_url: "" },
      ],
      next: "rest-2",
    })).toEqual({
      pieces: [{ slug: "ndrtw", url: SECOND }],
      cursor: "rest-2",
    });
  });
});

describe("!undertow OpenSea lookup", () => {
  it("queries public GraphQL and posts one random Created image", async () => {
    const urls: string[] = [];
    const bodies: string[] = [];
    const lookup = createUndertowLookup({
      random: () => 0.99,
      fetchImpl: async (input, init) => {
        const url = String(input);
        urls.push(url);
        if (url.includes("api.x.ai") || url.includes("grok.com")) {
          throw new Error("!undertow must not call Imagine");
        }
        bodies.push(String(init?.body ?? ""));
        expect(url).toBe(OPENSEA_GRAPHQL_URL);
        if (bodies.length === 1) return jsonResponse(profileBody());
        return jsonResponse(createdBody([
          { slug: "human-machine-create", imageUrl: FIRST },
          { slug: "ndrtw", imageUrl: SECOND },
          { slug: "missing" },
        ]));
      },
    });
    await expect(lookup.randomImage()).resolves.toEqual({ slug: "ndrtw", url: SECOND });
    expect(urls).toEqual([OPENSEA_GRAPHQL_URL, OPENSEA_GRAPHQL_URL]);
    expect(bodies[0]).toContain(UNDERTOW_USERNAME);
    expect(bodies.join("\n")).not.toMatch(/please|background|api\.x\.ai|grok\.com/);
  });

  it("follows a Created cursor and still picks one image", async () => {
    let createdCalls = 0;
    const lookup = createUndertowLookup({
      random: () => 0,
      fetchImpl: async (_input, init) => {
        const body = String(init?.body ?? "");
        if (body.includes("profileByIdentifierV2")) return jsonResponse(profileBody());
        createdCalls += 1;
        if (createdCalls === 1) {
          return jsonResponse(createdBody([{ slug: "human-machine-create", imageUrl: FIRST }], "page-2"));
        }
        return jsonResponse(createdBody([{ slug: "ndrtw", imageUrl: SECOND }]));
      },
    });
    await expect(lookup.randomImage()).resolves.toEqual({ slug: "human-machine-create", url: FIRST });
    expect(createdCalls).toBe(2);
  });

  it("uses the REST collections list when an API key is set", async () => {
    const headers: Array<Record<string, string>> = [];
    const lookup = createUndertowLookup({
      apiKey: "os-test-key",
      random: () => 0,
      fetchImpl: async (input, init) => {
        expect(String(input)).toContain("creator_username=-undertow-");
        expect(String(input)).not.toContain("os-test-key");
        headers.push({ ...(init?.headers as Record<string, string>) });
        return jsonResponse({
          collections: [
            { collection: "ndrtw", image_url: SECOND, opensea_url: PAGE_URL },
            { collection: "human-machine-create", image_url: FIRST, opensea_url: PAGE_URL },
          ],
        });
      },
    });
    await expect(lookup.randomImage()).resolves.toEqual({ slug: "ndrtw", url: SECOND });
    expect(headers[0]?.["x-api-key"]).toBe("os-test-key");
    expect(JSON.stringify(headers)).not.toContain("api.x.ai");
  });

  it("says OpenSea is busy when GraphQL and the free key are rate limited", async () => {
    const lookup = createUndertowLookup({
      fetchImpl: async (input) => {
        const url = String(input);
        if (url === OPENSEA_AUTH_KEYS_URL) {
          return jsonResponse({ errors: [{ message: "rate limit", api_key: "os-secret-key" }] }, 429);
        }
        return jsonResponse({ errors: [{ message: "too many requests" }] }, 429);
      },
    });
    await expect(lookup.randomImage()).rejects.toMatchObject({
      name: "UndertowLookupError",
      userMessage: UNDERTOW_RATE_LIMIT,
    });
    try {
      await lookup.randomImage();
    } catch (error) {
      expect(error).toBeInstanceOf(UndertowLookupError);
      expect(String(error)).not.toMatch(/os-secret-key|Telegram/i);
      expect((error as UndertowLookupError).userMessage).not.toMatch(/https?:|opensea\.io|Telegram/i);
    }
  });

  it("says an Undertow could not be loaded when the Created tab is empty or OpenSea is down", async () => {
    const empty = createUndertowLookup({
      fetchImpl: async (_input, init) => {
        const body = String(init?.body ?? "");
        if (body.includes("profileByIdentifierV2")) return jsonResponse(profileBody());
        return jsonResponse(createdBody([]));
      },
    });
    await expect(empty.randomImage()).rejects.toMatchObject({ userMessage: UNDERTOW_UNAVAILABLE });

    const down = createUndertowLookup({
      fetchImpl: async () => {
        throw new Error("socket down https://api.x.ai/v1/images");
      },
    });
    await expect(down.randomImage()).rejects.toMatchObject({ userMessage: UNDERTOW_UNAVAILABLE });
    try {
      await down.randomImage();
    } catch (error) {
      expect((error as UndertowLookupError).userMessage).not.toMatch(/https?:|Telegram/i);
    }
  });
});

describe("!undertow engine", () => {
  const stores: Store[] = [];

  afterEach(() => {
    for (const store of stores) store.close();
    stores.length = 0;
  });

  function setup(options?: {
    image?: UndertowPiece;
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
    const lookup: UndertowLookup = {
      async randomImage() {
        lookupCalls += 1;
        if (options?.fail) throw options.fail;
        return options?.image ?? { slug: "ndrtw", url: SECOND };
      },
    };
    let imagineCalls = 0;
    const engine = new ModerationEngine(store, client, runtime(), undefined, {
      undertow: lookup,
      fetchImage:
        options?.fetchImage === false
          ? undefined
          : async () => ({ bytes: Uint8Array.from([1, 2, 3]), mimeType: "image/png" }),
      imagine: {
        async generate() {
          imagineCalls += 1;
          throw new Error("!undertow must not call Imagine");
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
      message({ id: "u1", senderId: alice.id, text: "!Undertow" }),
    );
    expect(rig.lookupCalls).toBe(1);
    expect(rig.imagineCalls).toBe(0);
    expect(rig.client.images).toHaveLength(1);
    expect(rig.client.images[0]).toMatchObject({
      url: SECOND,
      caption: "@alice",
      mention: "alice",
      mimeType: "image/png",
    });
    expect(rig.client.sent).toHaveLength(0);
    expect(actions.replies).toEqual([]);
    const posted = JSON.stringify(rig.client.images);
    expect(posted).not.toMatch(/opensea\.io|api\.x\.ai|grok\.com/i);
    expect(rig.client.images[0]?.caption).not.toMatch(/ndrtw|human-machine/i);
    expect(posted).not.toMatch(/Telegram/i);
  });

  it("ignores extra words", async () => {
    const rig = setup();
    await rig.engine.processEvent(
      message({ id: "u2", senderId: alice.id, text: "!undertow background red please" }),
    );
    expect(rig.lookupCalls).toBe(1);
    expect(rig.client.images).toHaveLength(1);
    expect(rig.client.sent).toHaveLength(0);
    expect(JSON.stringify(rig.client.images)).not.toMatch(/background|please|red/);
  });

  it("replies with a short failure and no link", async () => {
    const rig = setup({
      fail: new UndertowLookupError("opensea rate limit", UNDERTOW_RATE_LIMIT),
    });
    await rig.engine.processEvent(message({ id: "u3", senderId: alice.id, text: "/undertow" }));
    expect(rig.client.images).toHaveLength(0);
    expect(rig.client.sent.map((row) => row.text)).toEqual([`@alice ${UNDERTOW_RATE_LIMIT}`]);
    expect(rig.client.sent[0]?.text).not.toMatch(/https?:|opensea\.io|seadn\.io|Telegram/i);

    const missing = setup({ fetchImage: false });
    await missing.engine.processEvent(message({ id: "u4", senderId: alice.id, text: "!undertow" }));
    expect(missing.client.sent.map((row) => row.text)).toEqual([`@alice ${UNDERTOW_UNAVAILABLE}`]);
    expect(missing.client.sent[0]?.text).not.toContain(SECOND);
  });

  it("reply-threads the image in encrypted Chat", async () => {
    const store = new Store(":memory:");
    stores.push(store);
    store.authorizeChat(chatGroupId);
    const images: { url?: string; caption?: import("../src/types.js").MediaCaption }[] = [];
    const chat = {
      sendImage: async (
        _conversationId: string,
        image: { url?: string; caption?: import("../src/types.js").MediaCaption },
      ) => {
        images.push(image);
        return { dmEventId: "img-1", dmConversationId: chatGroupId };
      },
      sendText: async () => ({ dmEventId: "text-1", dmConversationId: chatGroupId }),
    } as unknown as import("../src/chat/service.js").ChatService;
    const engine = new ModerationEngine(store, new RoutedXClient(new MockXClient(), chat), runtime(), undefined, {
      undertow: {
        async randomImage() {
          return { slug: "ndrtw", url: SECOND };
        },
      },
      fetchImage: async () => ({ bytes: Uint8Array.from([9, 9, 9]), mimeType: "image/png" }),
      imagine: {
        async generate() {
          throw new Error("!undertow must not call Imagine");
        },
      },
    });
    await engine.processEvent(
      message({
        id: "chat-undertow",
        senderId: alice.id,
        text: "!undertow",
        conversationId: chatGroupId,
        sequenceId: "77",
        encodedEvent: "blob-undertow",
      }),
    );
    expect(images).toHaveLength(1);
    expect(images[0]?.url).toBe(SECOND);
    expect(images[0]?.caption).toEqual({
      text: "@alice",
      mention: { username: "alice", start: 0, end: 6 },
      replyTo: {
        sequenceId: "77",
        senderId: alice.id,
        previewText: "!undertow",
        rawEvent: "blob-undertow",
      },
    });
  });

  it("mentions !undertow in the default !help text and the README", () => {
    const help = loadDefaults("config/default.yaml").help;
    expect(help).toMatch(/!undertow/);
    expect(help).toMatch(/one random created piece/);
    expect(help).toMatch(/Image only/);
    const media = help.split("Games:")[0] ?? "";
    expect(media).toMatch(/!undertow/);
    expect(help).not.toMatch(/Telegram/i);
    const readme = fs.readFileSync("README.md", "utf8");
    expect(readme).toMatch(/`!undertow`/);
    expect(readme).toMatch(/userCreatedCollections/);
    expect(readme).toMatch(/profileByIdentifierV2/);
    expect(readme).toMatch(/creator_username=-undertow-/);
    expect(readme).toMatch(/does not post the image URL/i);
  });
});
