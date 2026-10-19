import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { ModerationEngine } from "../src/bot/engine.js";
import { fetchAdultImage } from "../src/bot/image-fetch.js";
import {
  MEOW_API_URL,
  MEOW_UNAVAILABLE,
  MeowBankError,
  MeowLookupError,
  canonicalMeowImageUrl,
  createMeowLookup,
  defaultMeowBankPath,
  isSafeMeowImageUrl,
  loadMeowBank,
  parseMeowBankText,
  type MeowLookup,
} from "../src/bot/meow.js";
import { loadDefaults } from "../src/config.js";
import { Store } from "../src/store.js";
import type { BotRuntimeConfig, DefaultsConfig, DmEvent, XUser } from "../src/types.js";
import { MockXClient } from "../src/x/mock-client.js";
import { RoutedXClient } from "../src/x/routed-client.js";

const alice: XUser = { id: "u-alice", username: "alice", name: "Alice" };
const groupId = "1578398451921985538";
const chatGroupId = "g2029561975647150382";

const CATAAS = "https://cataas.com/cat/qjfIHFFKfh4ND4mq";
const CATAAS_OTHER = "https://cataas.com/cat/RkO3NrJXivPGFJzW";
const WIKI =
  "https://upload.wikimedia.org/wikipedia/commons/thumb/8/88/Cute_Kitten.jpg/960px-Cute_Kitten.jpg";
const WIKI_B =
  "https://upload.wikimedia.org/wikipedia/commons/thumb/f/fa/Kitten_sleeping.jpg/960px-Kitten_sleeping.jpg";

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

function cuteKitten(id: string) {
  return {
    id,
    tags: ["kitten", "cute"],
    mimetype: "image/jpeg",
    url: `https://cataas.com/cat/${id}?position=center`,
  };
}

describe("meow image urls", () => {
  it("allows Cataas cat stills and Wikimedia kitten photos, and rejects Imagine hosts", () => {
    expect(isSafeMeowImageUrl(CATAAS)).toBe(true);
    expect(canonicalMeowImageUrl(`  ${CATAAS}  `)).toBe(CATAAS);
    expect(canonicalMeowImageUrl(`${CATAAS}?position=center`)).toBeUndefined();
    expect(isSafeMeowImageUrl(WIKI)).toBe(true);
    expect(
      canonicalMeowImageUrl(
        "https://thumb.wikimedia.org/wikipedia/commons/thumb/8/88/Cute_Kitten.jpg/960px-Cute_Kitten.jpg",
      ),
    ).toBe(WIKI);
    expect(isSafeMeowImageUrl("https://cataas.com/cat/kitten")).toBe(false);
    expect(isSafeMeowImageUrl("https://cataas.com/cat/says/hello")).toBe(false);
    expect(isSafeMeowImageUrl("https://api.x.ai/v1/images/generations")).toBe(false);
    expect(isSafeMeowImageUrl("https://grok.com/imagine/kitten.png")).toBe(false);
    expect(isSafeMeowImageUrl("https://imagine-public.x.ai/imagine-public/images/kitten.jpg")).toBe(false);
    expect(isSafeMeowImageUrl("http://cataas.com/cat/qjfIHFFKfh4ND4mq")).toBe(false);
    expect(isSafeMeowImageUrl("https://user:pass@cataas.com/cat/qjfIHFFKfh4ND4mq")).toBe(false);
  });

  it("skips comments and drops duplicate stills", () => {
    const parsed = parseMeowBankText(`# comment\n\n${WIKI}\n${WIKI}\n${WIKI_B}`);
    expect(parsed.invalid).toEqual([]);
    expect(parsed.urls).toEqual([WIKI, WIKI_B]);
    expect(parseMeowBankText("https://grok.com/imagine/kitten.png").invalid).toEqual([
      "https://grok.com/imagine/kitten.png",
    ]);
  });
});

describe("!meow lookup", () => {
  it("loads the committed Wikimedia bank", () => {
    const urls = loadMeowBank();
    expect(defaultMeowBankPath()).toMatch(/config\/kitten-bank\.txt$/);
    expect(urls).toHaveLength(19);
    expect(new Set(urls).size).toBe(19);
    expect(urls.every((url) => isSafeMeowImageUrl(url))).toBe(true);
    expect(urls.every((url) => /kitten/i.test(url))).toBe(true);
    expect(urls.every((url) => url.startsWith("https://upload.wikimedia.org/"))).toBe(true);
    expect(urls[2]).toBe(WIKI);
    const raw = fs.readFileSync("config/kitten-bank.txt", "utf8");
    expect(raw).toMatch(/Wikimedia Commons/);
    expect(raw).not.toMatch(/grok\.com|api\.x\.ai|imagine-public/i);
  });

  it("uses a cute Cataas still and keeps a bank photo as fallback", async () => {
    const seen: string[] = [];
    const lookup = createMeowLookup({
      urls: [WIKI, WIKI_B],
      random: () => 0,
      fetchImpl: async (url, init) => {
        seen.push(String(url));
        expect(new Headers(init?.headers).get("accept")).toMatch(/application\/json/i);
        return jsonResponse(cuteKitten("qjfIHFFKfh4ND4mq"));
      },
    });
    await expect(lookup.randomImage()).resolves.toEqual({ url: CATAAS, fallbackUrl: WIKI });
    expect(seen).toEqual([MEOW_API_URL]);
  });

  it("skips a gif, then takes the next cute still", async () => {
    const bodies = [
      { id: "8nqmX1ooqvk4fzRU", tags: ["kitten", "cute", "gif"], mimetype: "image/gif" },
      cuteKitten("RkO3NrJXivPGFJzW"),
    ];
    let calls = 0;
    const lookup = createMeowLookup({
      urls: [WIKI],
      random: () => 0,
      fetchImpl: async () => jsonResponse(bodies[calls++] ?? cuteKitten("qjfIHFFKfh4ND4mq")),
    });
    await expect(lookup.randomImage()).resolves.toEqual({ url: CATAAS_OTHER, fallbackUrl: WIKI });
    expect(calls).toBe(2);
  });

  it("skips a meme tag and uses the bank after two misses", async () => {
    let calls = 0;
    const lookup = createMeowLookup({
      urls: [WIKI],
      random: () => 0,
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({
          id: "BX0XdDZffs3PqkV7",
          tags: ["xbox", "kitten", "cute", "achievement"],
          mimetype: "image/png",
        });
      },
    });
    await expect(lookup.randomImage()).resolves.toEqual({ url: WIKI });
    expect(calls).toBe(2);
  });

  it("falls back to the bank when Cataas fails and varies the pick", async () => {
    let draws = 0;
    const lookup = createMeowLookup({
      urls: [WIKI, WIKI_B],
      random: () => {
        draws += 1;
        return draws === 1 ? 0 : 0.9;
      },
      fetchImpl: async () => {
        throw new Error("cataas down");
      },
    });
    await expect(lookup.randomImage()).resolves.toEqual({ url: WIKI, fallbackUrl: WIKI_B });
    await expect(lookup.randomImage()).resolves.toEqual({ url: WIKI_B, fallbackUrl: WIKI });
  });

  it("rejects an Imagine URL from Cataas and an empty bank", async () => {
    const lookup = createMeowLookup({
      urls: [WIKI],
      api: false,
      random: () => 0,
    });
    await expect(lookup.randomImage()).resolves.toEqual({ url: WIKI });

    const blocked = createMeowLookup({
      urls: [WIKI],
      random: () => 0,
      fetchImpl: async () =>
        jsonResponse({
          id: "qjfIHFFKfh4ND4mq",
          tags: ["kitten", "cute"],
          mimetype: "image/jpeg",
          url: "https://grok.com/imagine/kitten.jpg",
        }),
    });
    await expect(blocked.randomImage()).resolves.toEqual({ url: WIKI });

    const empty = createMeowLookup({
      urls: [],
      api: false,
    });
    await expect(empty.randomImage()).rejects.toMatchObject({
      name: "MeowLookupError",
      userMessage: MEOW_UNAVAILABLE,
    });
    expect(() => createMeowLookup({ bankText: "https://api.x.ai/v1/images/kitten.png" })).toThrow(MeowBankError);
    expect(() => loadMeowBank({ bankText: "# nothing\n" })).toThrow(MeowBankError);
  });

  it("downloads a sample bank still through the same image fetch !meow uses", async () => {
    const urls = loadMeowBank();
    const sample = urls[2];
    expect(sample).toBe(WIKI);
    const fetched = await fetchAdultImage(sample!);
    expect(fetched).toBeDefined();
    expect(fetched!.bytes.byteLength).toBeGreaterThan(1000);
    expect(fetched!.mimeType).toMatch(/^image\/(png|jpeg|gif|webp)$/);
  }, 20_000);
});

describe("!meow engine", () => {
  const stores: Store[] = [];

  afterEach(() => {
    for (const store of stores) store.close();
    stores.length = 0;
  });

  function setup(options?: {
    image?: { url: string; fallbackUrl?: string };
    fail?: Error;
    failSendImage?: boolean;
    fetchImage?: boolean;
    fetchFailsFor?: string;
    meowUrls?: readonly string[];
    meowFetch?: typeof fetch;
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
    const lookup: MeowLookup = {
      async randomImage() {
        lookupCalls += 1;
        if (options?.fail) throw options.fail;
        return options?.image ?? { url: CATAAS, fallbackUrl: WIKI };
      },
    };
    let imagineCalls = 0;
    const fetchedUrls: string[] = [];
    const engine = new ModerationEngine(store, client, runtime(), undefined, {
      ...(options?.useDefaultLookup
        ? { meowUrls: options.meowUrls ?? [WIKI, WIKI_B], meowFetch: options.meowFetch }
        : { meow: lookup }),
      fetchImage:
        options?.fetchImage === false
          ? undefined
          : async (url) => {
              fetchedUrls.push(url);
              if (options?.fetchFailsFor && url.includes(options.fetchFailsFor)) return undefined;
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
      fetchedUrls,
      get lookupCalls() {
        return lookupCalls;
      },
      get imagineCalls() {
        return imagineCalls;
      },
    };
  }

  it("posts one kitten photo and mentions the requester", async () => {
    const rig = setup();
    const actions = await rig.engine.processEvent(message({ id: "m1", senderId: alice.id, text: "!Meow" }));
    expect(rig.lookupCalls).toBe(1);
    expect(rig.imagineCalls).toBe(0);
    expect(rig.fetchedUrls).toEqual([CATAAS]);
    expect(rig.client.images).toHaveLength(1);
    expect(rig.client.images[0]).toMatchObject({
      url: CATAAS,
      caption: "@alice",
      mention: "alice",
      mimeType: "image/jpeg",
    });
    expect(rig.client.sent).toHaveLength(0);
    expect(actions.replies).toEqual([]);
    expect(JSON.stringify(rig.client.images)).not.toMatch(/grok\.com|api\.x\.ai|imagine/i);
  });

  it("posts the bank photo when the Cataas download fails", async () => {
    const rig = setup({ fetchFailsFor: "cataas.com" });
    await rig.engine.processEvent(message({ id: "fall", senderId: alice.id, text: "!meow" }));
    expect(rig.imagineCalls).toBe(0);
    expect(rig.fetchedUrls).toEqual([CATAAS, WIKI]);
    expect(rig.client.images).toHaveLength(1);
    expect(rig.client.images[0]?.url).toBe(WIKI);
    expect(rig.client.sent).toHaveLength(0);
  });

  it("uses the startup bank when Cataas is down and no lookup is injected", async () => {
    const rig = setup({
      useDefaultLookup: true,
      meowUrls: [WIKI_B, WIKI],
      meowFetch: async () => {
        throw new Error("cataas down");
      },
    });
    await rig.engine.processEvent(message({ id: "bank", senderId: alice.id, text: "!meow" }));
    expect(rig.lookupCalls).toBe(0);
    expect(rig.imagineCalls).toBe(0);
    expect(rig.fetchedUrls).toHaveLength(1);
    expect([WIKI, WIKI_B]).toContain(rig.fetchedUrls[0]);
    expect(rig.client.images).toHaveLength(1);
    expect(rig.client.sent).toHaveLength(0);
  });

  it("asks Cataas from the default client and does not call Imagine", async () => {
    const rig = setup({
      useDefaultLookup: true,
      meowUrls: [WIKI],
      meowFetch: async (url) => {
        expect(String(url)).toBe(MEOW_API_URL);
        expect(String(url)).not.toMatch(/api\.x\.ai|grok\.com/);
        return jsonResponse(cuteKitten("RkO3NrJXivPGFJzW"));
      },
    });
    await rig.engine.processEvent(message({ id: "api", senderId: alice.id, text: "!meow" }));
    expect(rig.imagineCalls).toBe(0);
    expect(rig.fetchedUrls).toEqual([CATAAS_OTHER]);
    expect(rig.client.images[0]?.url).toBe(CATAAS_OTHER);
    expect(rig.client.sent).toHaveLength(0);
  });

  it("ignores extra words and does not describe the photo", async () => {
    const rig = setup();
    await rig.engine.processEvent(
      message({ id: "m2", senderId: alice.id, text: "!meow orange tabby please" }),
    );
    expect(rig.lookupCalls).toBe(1);
    expect(rig.client.images).toHaveLength(1);
    expect(rig.client.sent).toHaveLength(0);
    expect(JSON.stringify(rig.client.images)).not.toMatch(/orange|tabby|please/);
  });

  it("refuses a banned age term and does not fetch a photo", async () => {
    const rig = setup();
    await rig.engine.processEvent(message({ id: "m3", senderId: alice.id, text: "!meow teen" }));
    expect(rig.lookupCalls).toBe(0);
    expect(rig.imagineCalls).toBe(0);
    expect(rig.fetchedUrls).toEqual([]);
    expect(rig.client.images).toHaveLength(0);
    const text = rig.client.sent.map((row) => row.text).join("\n");
    expect(text).toMatch(/Refused/);
    expect(text).toMatch(/does not search custom text/);
    expect(text).not.toMatch(/teen/);
    expect(text.startsWith("@alice ")).toBe(true);
  });

  it("replies once when lookup fails and posts no link", async () => {
    const rig = setup({ fail: new MeowLookupError("no kitten photo", MEOW_UNAVAILABLE) });
    await rig.engine.processEvent(message({ id: "m4", senderId: alice.id, text: "!meow" }));
    expect(rig.client.images).toHaveLength(0);
    expect(rig.client.sent.map((row) => row.text)).toEqual([`@alice ${MEOW_UNAVAILABLE}`]);
    expect(rig.client.sent[0]?.text).not.toMatch(/https?:|cataas\.com|wikimedia/i);
  });

  it("does not post the image URL when the download or upload fails", async () => {
    const missing = setup({ fetchImage: false });
    await missing.engine.processEvent(message({ id: "m5", senderId: alice.id, text: "!meow" }));
    expect(missing.client.images).toHaveLength(0);
    expect(missing.client.sent).toHaveLength(1);
    expect(missing.client.sent.map((row) => row.text)).toEqual([`@alice ${MEOW_UNAVAILABLE}`]);
    expect(missing.client.sent[0]?.text).not.toContain(CATAAS);
    expect(missing.client.sent[0]?.text).not.toMatch(/cataas\.com|wikimedia|grok\.com/i);

    const failed = setup({ failSendImage: true });
    await failed.engine.processEvent(message({ id: "m6", senderId: alice.id, text: "!meow" }));
    expect(failed.fetchedUrls).toEqual([CATAAS, WIKI]);
    expect(failed.client.images).toHaveLength(0);
    expect(failed.client.sent).toHaveLength(1);
    expect(failed.client.sent.map((row) => row.text)).toEqual([`@alice ${MEOW_UNAVAILABLE}`]);
    expect(failed.client.sent[0]?.text).not.toContain(CATAAS);
  });

  it("reply-threads the photo in encrypted Chat", async () => {
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
      meow: {
        async randomImage() {
          return { url: CATAAS };
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
    const help = loadDefaults("config/default.yaml").help;
    expect(help).toMatch(/!meow/);
    expect(help).toMatch(/random cute kitten photo/);
    expect(help).toMatch(/Image only/);
    const media = help.split("Games:")[0] ?? "";
    expect(media).toMatch(/!meow/);
    const readme = fs.readFileSync("README.md", "utf8");
    const section = readme.split("## Meow")[1]?.split("## Milady memes")[0] ?? "";
    expect(section).toMatch(/`!meow`/);
    expect(section).toMatch(/config\/kitten-bank\.txt/);
    expect(section).toMatch(/cataas\.com\/cat\/kitten/);
    expect(section).toMatch(/kitten/);
    expect(section).toMatch(/cute/);
    expect(section).toMatch(/does not post the image URL/i);
    expect(section).toMatch(/does not open https:\/\/grok\.com\/imagine/);
    expect(section).toMatch(/does not `POST` `https:\/\/api\.x\.ai\/v1\/images\/generations`/);
    expect(section).toMatch(/XAI_API_KEY/);
  });
});
