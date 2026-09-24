import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { ModerationEngine } from "../src/bot/engine.js";
import type { ImagineGenerator } from "../src/bot/imagine.js";
import { normalizeImaginePrompt } from "../src/bot/imagine.js";
import {
  buildNoorAbsPrompt,
  buildNoorImaginePrompt,
  buildNoorRoastMessages,
  fallbackNoorRoast,
  formatNoorPost,
  noorMeansLine,
  NOOR_ABS_CODA,
  NOOR_ALERT_POLL_MS,
  planNoorRelay,
  sanitizeNoorRoast,
  sanitizeNoorVision,
  snowflakeTimeMs,
} from "../src/bot/noor.js";
import { loadDefaults } from "../src/config.js";
import { loadEnv } from "../src/env.js";
import type { LlmVisionImage } from "../src/llm/client.js";
import { MockLlmClient } from "../src/llm/mock.js";
import { Store } from "../src/store.js";
import type { BotRuntimeConfig, DefaultsConfig, DmEvent, XUser } from "../src/types.js";
import type { UserTweet } from "../src/x/client.js";
import { MockXClient } from "../src/x/mock-client.js";

const alice: XUser = { id: "u-alice", username: "alice", name: "Alice" };
const noor: XUser = { id: "u-noor", username: "noorrietje", name: "Noor" };
const owner: XUser = { id: "u-owner", username: "owner", name: "Owner" };
const groupId = "1578398451921985538";
const otherGroupId = "1578398451921985539";
const SNOWFLAKE_EPOCH_MS = 1288834974657n;

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

function idAt(ms: number): string {
  return ((BigInt(ms) - SNOWFLAKE_EPOCH_MS) << 22n).toString();
}

function tweet(
  id: string,
  text: string,
  createdAtMs?: number,
  mediaUrls: string[] = [],
): UserTweet {
  return { id, text, createdAtMs, mediaUrls };
}

function runtime(): BotRuntimeConfig {
  return {
    botUserId: "bot-1",
    botUsername: "modbot",
    ownerId: owner.id,
    globalAdminIds: [],
    defaults,
  };
}

class VisionMock extends MockLlmClient {
  readonly visionCalls: LlmVisionImage[] = [];
  visionReply = "She holds a latte toward the camera in a cafe.";

  async completeVision(_prompt: string, image: LlmVisionImage): Promise<string> {
    this.visionCalls.push(image);
    return this.visionReply;
  }
}

function message(partial: Partial<DmEvent> & Pick<DmEvent, "id" | "text">): DmEvent {
  return {
    eventType: "MessageCreate",
    conversationId: groupId,
    participantIds: [],
    participants: [],
    mentions: [],
    senderId: alice.id,
    sender: alice,
    ...partial,
  };
}

describe("Noor alert shaping", () => {
  it("labels her original post, always with the status URL, apart from the translation", () => {
    const post = tweet("55", "  hello   there  ", 10, [
      "https://pbs.twimg.com/media/abc.jpg",
    ]);
    const original = formatNoorPost(post, "noorrietje");
    expect(original).toBe(
      "📌 @noorrietje original\nhttps://x.com/noorrietje/status/55\nhello there",
    );
    expect(original).toContain("https://x.com/noorrietje/status/55");
    expect(original).not.toMatch(/really means/i);
    expect(formatNoorPost(post, "@NoorRietje", post.mediaUrls)).toBe(
      "📌 @noorrietje original\nhttps://x.com/noorrietje/status/55\nhello there\nhttps://pbs.twimg.com/media/abc.jpg",
    );
    const translation = noorMeansLine('  notice me "now"  ');
    expect(translation).toBe(`🪞 What she really means to say is:\n"notice me 'now'"`);
    expect(translation).not.toContain("https://x.com/");
    expect(translation).not.toMatch(/original/i);
  });

  it("keeps a model rewrite and falls back when it is empty or unsafe", () => {
    expect(sanitizeNoorRoast('  "please look at my coffee"  ', "coffee")).toBe(
      "please look at my coffee",
    );
    expect(sanitizeNoorRoast('what she really means to say is "clap for me"', "coffee")).toBe(
      "clap for me",
    );
    expect(sanitizeNoorRoast('🪞 What she really means to say is:\n"clap for me"', "coffee")).toBe(
      "clap for me",
    );
    expect(sanitizeNoorRoast("   ", "I invented a holiday")).toBe(
      fallbackNoorRoast("I invented a holiday"),
    );
    expect(sanitizeNoorRoast("that teen bit", "hello")).toBe(fallbackNoorRoast("hello"));
    expect(sanitizeNoorRoast("that teen bit", "also a teen post")).toBe(fallbackNoorRoast(""));
    expect(fallbackNoorRoast("a teen post")).not.toMatch(/teen/i);
  });

  it("feeds a vision note into the roast and the Imagine parody", () => {
    const messages = buildNoorRoastMessages("coffee outside", [
      "She holds a latte toward the camera in a cafe.",
    ]);
    expect(messages[1]?.content).toContain("What the photo shows:");
    expect(messages[1]?.content).toContain("latte");
    const prompt = buildNoorImaginePrompt("coffee outside", [
      "She holds a latte toward the camera in a cafe.",
    ]);
    expect(prompt).toContain("coffee outside");
    expect(prompt).toContain("latte");
    expect(prompt).toContain("notice-me");
    expect(sanitizeNoorVision("skip")).toBe("");
    expect(sanitizeNoorVision("a teen in frame")).toBe("");
    expect(buildNoorImaginePrompt("that teen show", ["a cafe"])).toBeUndefined();
  });

  it("asks Imagine for a new adult abs still on every call", () => {
    const first = buildNoorAbsPrompt(() => 0.1);
    const second = buildNoorAbsPrompt(() => 0.2);
    expect(first).not.toBe(second);
    expect(first).toMatch(/skinny adult woman/i);
    expect(first).toMatch(/midriff/i);
    expect(normalizeImaginePrompt(first)).toEqual({ ok: true, prompt: first });
    expect(normalizeImaginePrompt(second).ok).toBe(true);
  });

  it("reads a snowflake timestamp", () => {
    const ms = 1_700_000_000_000;
    expect(snowflakeTimeMs(idAt(ms))).toBe(ms);
  });

  it("relays only posts after the watermark, oldest first, and advances past history", () => {
    const planned = planNoorRelay(
      [
        tweet("100", "newer", 2_000),
        tweet("50", "older history", 500),
        tweet("100", "duplicate", 2_000),
        tweet("80", "also new", 1_500),
      ],
      { sinceMs: 1_000 },
    );
    expect(planned.relay.map((row) => row.id)).toEqual(["80", "100"]);
    expect(planned.next).toEqual({ sinceMs: 2_000, tweetId: "100" });
  });

  it("compares tweet ids as numbers so 100 is after 99", () => {
    const planned = planNoorRelay([tweet("100", "next", 50)], { sinceMs: 0, tweetId: "99" });
    expect(planned.relay.map((row) => row.id)).toEqual(["100"]);
    expect(planned.next.tweetId).toBe("100");
  });

  it("does not treat a post at the enable time as new when no tweet id is stored yet", () => {
    const ms = 1_700_000_000_000;
    const planned = planNoorRelay([tweet(idAt(ms), "same moment")], { sinceMs: ms });
    expect(planned.relay).toEqual([]);
    expect(planned.next.tweetId).toBe(idAt(ms));
  });
});

describe("Noor alert store", () => {
  const stores: Store[] = [];

  afterEach(() => {
    for (const store of stores) store.close();
    stores.length = 0;
  });

  it("stores an enable watermark and does not move it on a second enable", () => {
    const store = new Store(":memory:");
    stores.push(store);
    expect(store.enableNoorAlert("c1", 1_000)).toBe("enabled");
    expect(store.getNoorAlert("c1")).toEqual({
      conversationId: "c1",
      enabled: true,
      sinceMs: 1_000,
      tweetId: undefined,
      absEnabled: false,
    });
    store.setNoorWatermark("c1", 1_500, "55");
    expect(store.enableNoorAlert("c1", 9_000)).toBe("already");
    expect(store.getNoorAlert("c1")).toMatchObject({
      enabled: true,
      sinceMs: 1_500,
      tweetId: "55",
    });
    expect(store.listEnabledNoorAlerts().map((row) => row.conversationId)).toEqual(["c1"]);
  });

  it("turns off without deleting the row, ignores a watermark write, and resets on re-enable", () => {
    const store = new Store(":memory:");
    stores.push(store);
    store.enableNoorAlert("b", 100);
    store.enableNoorAlert("a", 100);
    store.setNoorWatermark("a", 100, "7");
    expect(store.disableNoorAlert("a")).toBe("disabled");
    expect(store.disableNoorAlert("a")).toBe("already");
    store.setNoorWatermark("a", 100, "99");
    expect(store.getNoorAlert("a")).toMatchObject({ enabled: false, tweetId: "7" });
    expect(store.listEnabledNoorAlerts().map((row) => row.conversationId)).toEqual(["b"]);
    expect(store.enableNoorAlert("a", 5_000)).toBe("enabled");
    expect(store.getNoorAlert("a")).toEqual({
      conversationId: "a",
      enabled: true,
      sinceMs: 5_000,
      tweetId: undefined,
      absEnabled: false,
    });
  });

  it("requires Noor on before abs, and clears abs when Noor turns off", () => {
    const store = new Store(":memory:");
    stores.push(store);
    expect(store.enableNoorAbs("c1")).toBe("need-noor");
    expect(store.getNoorAlert("c1")).toBeUndefined();
    store.enableNoorAlert("c1", 1_000);
    expect(store.enableNoorAbs("c1")).toBe("enabled");
    expect(store.enableNoorAbs("c1")).toBe("already");
    expect(store.getNoorAlert("c1")?.absEnabled).toBe(true);
    expect(store.listEnabledNoorAlerts()[0]?.absEnabled).toBe(true);
    expect(store.disableNoorAlert("c1")).toBe("disabled");
    expect(store.getNoorAlert("c1")?.absEnabled).toBe(false);
    expect(store.enableNoorAlert("c1", 2_000)).toBe("enabled");
    expect(store.getNoorAlert("c1")?.absEnabled).toBe(false);
    expect(store.enableNoorAbs("c1")).toBe("enabled");
    expect(store.disableNoorAbs("c1")).toBe("disabled");
    expect(store.disableNoorAbs("c1")).toBe("already");
    expect(store.getNoorAlert("c1")).toMatchObject({ enabled: true, absEnabled: false });
  });

  it("adds abs_enabled when an older database is missing that column", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "noor-abs-"));
    const file = path.join(dir, "bot.sqlite");
    const db = new Database(file);
    db.exec(`CREATE TABLE noor_alerts (
      conversation_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL,
      since_ms INTEGER NOT NULL,
      tweet_id TEXT
    )`);
    db.prepare(
      `INSERT INTO noor_alerts (conversation_id, enabled, since_ms, tweet_id) VALUES ('old', 1, 10, '3')`,
    ).run();
    db.close();
    const store = new Store(file);
    stores.push(store);
    expect(store.getNoorAlert("old")).toMatchObject({
      enabled: true,
      absEnabled: false,
      tweetId: "3",
    });
    expect(store.enableNoorAbs("old")).toBe("enabled");
    expect(store.getNoorAlert("old")?.absEnabled).toBe(true);
  });
});

describe("Noor alert relay", () => {
  const stores: Store[] = [];

  afterEach(() => {
    for (const store of stores) store.close();
    stores.length = 0;
  });

  function setup(options?: {
    llm?: MockLlmClient;
    fetchImage?: (url: string) => Promise<{ bytes: Uint8Array; mimeType: string } | undefined>;
    imagine?: ImagineGenerator;
    username?: string;
  }) {
    const store = new Store(":memory:");
    stores.push(store);
    const client = new MockXClient();
    client.addUser(alice);
    client.addUser(noor);
    client.addUser(owner);
    const engine = new ModerationEngine(
      store,
      client,
      { ...runtime(), noorUsername: options?.username },
      options?.llm,
      { fetchImage: options?.fetchImage, imagine: options?.imagine },
    );
    return { engine, client, store };
  }

  it("acks on and off, and a second on does not reset the watermark", async () => {
    const { engine, client, store } = setup();
    const now = 1_700_000_000_000;
    await engine.processEvent(message({ id: "on", text: "!nOoR On" }), now);
    expect(client.sent.map((row) => row.text)).toEqual([
      "Noor alert on for @noorrietje. New posts only. !noor off to stop.",
    ]);
    expect(store.getNoorAlert(groupId)).toMatchObject({ enabled: true, sinceMs: now });
    store.setNoorWatermark(groupId, now, "42");
    await engine.processEvent(message({ id: "again", text: "!noor on" }), now + 10);
    expect(client.sent.at(-1)?.text).toBe(
      "Noor alert is already on for @noorrietje. !noor off to stop.",
    );
    expect(store.getNoorAlert(groupId)?.tweetId).toBe("42");
    await engine.processEvent(message({ id: "off", text: "!NOOR OFF" }), now + 20);
    expect(client.sent.at(-1)?.text).toBe("Noor alert off.");
    expect(store.getNoorAlert(groupId)?.enabled).toBe(false);
    await engine.processEvent(message({ id: "off2", text: "!Noor off" }), now + 30);
    expect(client.sent.at(-1)?.text).toBe("Noor alert is already off.");
    await engine.processEvent(message({ id: "huh", text: "!noor please" }), now + 40);
    expect(client.sent.at(-1)?.text).toBe("Use !noor on or !noor off.");
  });

  it("does not dump history and relays each new post once", async () => {
    const { engine, client, store } = setup();
    const now = 1_700_000_000_000;
    await engine.processEvent(message({ id: "on", text: "!noor on" }), now);
    client.sent.length = 0;
    client.tweets.set(noor.id, [
      tweet("10", "old post", now - 60_000),
      tweet("20", "brand new", now + 1_000),
      tweet("30", "even newer", now + 2_000),
    ]);
    await engine.pollNoorAlerts(now + 5_000);
    expect(client.sent.map((row) => row.text)).toEqual([
      "📌 @noorrietje original\nhttps://x.com/noorrietje/status/20\nbrand new",
      `🪞 What she really means to say is:\n"${fallbackNoorRoast("brand new")}"`,
      "📌 @noorrietje original\nhttps://x.com/noorrietje/status/30\neven newer",
      `🪞 What she really means to say is:\n"${fallbackNoorRoast("even newer")}"`,
    ]);
    expect(store.getNoorAlert(groupId)?.tweetId).toBe("30");

    client.tweets.set(noor.id, [
      tweet("10", "old post", now - 60_000),
      tweet("20", "brand new", now + 1_000),
      tweet("30", "even newer", now + 2_000),
    ]);
    await engine.pollNoorAlerts(now + 5_000 + NOOR_ALERT_POLL_MS);
    expect(client.sent).toHaveLength(4);

    client.tweets.set(noor.id, [
      ...client.tweets.get(noor.id)!,
      tweet("40", "later", now + 90_000),
    ]);
    await engine.pollNoorAlerts(now + 5_000 + NOOR_ALERT_POLL_MS);
    expect(client.sent).toHaveLength(4);
    await engine.pollNoorAlerts(now + 5_000 + NOOR_ALERT_POLL_MS * 2);
    expect(client.sent.at(-2)?.text).toContain("later");
    expect(client.sent.at(-1)?.text.startsWith("🪞 What she really means to say is:")).toBe(true);
    expect(store.getNoorAlert(groupId)?.tweetId).toBe("40");
  });

  it("uses the LLM rewrite and falls back when the completion fails", async () => {
    const llm = new MockLlmClient('  "notice me, this latte is my whole personality"  ');
    const { engine, client } = setup({ llm });
    const now = 1_700_000_000_000;
    await engine.processEvent(message({ id: "on", text: "!noor on" }), now);
    client.sent.length = 0;
    client.tweets.set(noor.id, [tweet("20", "coffee outside", now + 10)]);
    await engine.pollNoorAlerts(now + NOOR_ALERT_POLL_MS);
    expect(client.sent[1]?.text).toBe(
      `🪞 What she really means to say is:\n"notice me, this latte is my whole personality"`,
    );
    expect(client.sent[0]?.text).toContain("https://x.com/noorrietje/status/20");
    expect(client.sent[0]?.text).toMatch(/^📌 @noorrietje original/);
    expect(client.sent[1]?.text).not.toContain("https://x.com/");
    expect(llm.calls).toHaveLength(1);

    const failing = new MockLlmClient();
    failing.complete = async () => {
      throw new Error("nope");
    };
    const again = setup({ llm: failing });
    await again.engine.processEvent(message({ id: "on2", text: "!noor on" }), now);
    again.client.sent.length = 0;
    again.client.tweets.set(noor.id, [tweet("21", "another coffee", now + 10)]);
    await again.engine.pollNoorAlerts(now + NOOR_ALERT_POLL_MS);
    expect(again.client.sent[1]?.text).toBe(
      `🪞 What she really means to say is:\n"${fallbackNoorRoast("another coffee")}"`,
    );
  });

  it("does not send a post that trips the age filter to the model", async () => {
    const llm = new MockLlmClient("should not be used");
    const { engine, client } = setup({ llm });
    const now = 1_700_000_000_000;
    await engine.processEvent(message({ id: "on", text: "!noor on" }), now);
    client.sent.length = 0;
    client.tweets.set(noor.id, [tweet("20", "that teen show", now + 10)]);
    await engine.pollNoorAlerts(now + NOOR_ALERT_POLL_MS);
    expect(llm.calls).toHaveLength(0);
    expect(client.sent[0]?.text).toContain("that teen show");
    expect(client.sent[1]?.text.toLowerCase()).not.toContain("teen");
  });

  it("describes a photo, roasts with that context, then posts an Imagine remix", async () => {
    const llm = new VisionMock("please look at my little coffee moment");
    const imaginePrompts: string[] = [];
    const imagine: ImagineGenerator = {
      async generate(prompt) {
        imaginePrompts.push(prompt);
        return { bytes: Uint8Array.from([8, 8, 8]), mimeType: "image/png" };
      },
    };
    const media = "https://pbs.twimg.com/media/abc.jpg";
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    const { engine, client } = setup({
      llm,
      imagine,
      fetchImage: async (url) =>
        url === media ? { bytes, mimeType: "image/jpeg" } : undefined,
    });
    const order: string[] = [];
    const sendMessage = client.sendMessage.bind(client);
    const sendImage = client.sendImage.bind(client);
    client.sendMessage = async (conversationId, text) => {
      order.push(`text:${text}`);
      return sendMessage(conversationId, text);
    };
    client.sendImage = async (conversationId, image) => {
      order.push(`image:${image.url}`);
      return sendImage(conversationId, image);
    };
    const now = 1_700_000_000_000;
    await engine.processEvent(message({ id: "on", text: "!noor on" }), now);
    client.sent.length = 0;
    order.length = 0;
    client.tweets.set(noor.id, [tweet("20", "coffee outside", now + 10, [media])]);
    await engine.pollNoorAlerts(now + NOOR_ALERT_POLL_MS);

    expect(llm.visionCalls).toHaveLength(1);
    expect(llm.visionCalls[0]?.mimeType).toBe("image/jpeg");
    expect(llm.visionCalls[0]?.base64.length).toBeGreaterThan(0);
    expect(llm.calls[0]?.[1]?.content).toContain("latte");
    expect(imaginePrompts).toHaveLength(1);
    expect(imaginePrompts[0]).toContain("coffee outside");
    expect(imaginePrompts[0]).toContain("latte");
    expect(order[0]).toMatch(
      /^text:📌 @noorrietje original\nhttps:\/\/x\.com\/noorrietje\/status\/20\ncoffee outside/,
    );
    expect(order[0]).not.toContain(media);
    expect(order[0]).not.toMatch(/really means/i);
    expect(order[1]).toBe(`image:${media}`);
    expect(order[2]).toMatch(/^text:🪞 What she really means to say is:\n"/);
    expect(order[2]).not.toContain("https://x.com/");
    expect(order[3]).toBe("image:https://api.x.ai/v1/images/generations");
    expect(client.images).toEqual([
      { conversationId: groupId, url: media, mimeType: "image/jpeg", bytes: bytes.byteLength },
      {
        conversationId: groupId,
        url: "https://api.x.ai/v1/images/generations",
        mimeType: "image/png",
        bytes: 3,
      },
    ]);
    expect(client.images.every((row) => row.bytes > 0)).toBe(true);
    expect(client.sent[1]?.text).toBe(
      `🪞 What she really means to say is:\n"please look at my little coffee moment"`,
    );
  });

  it("attaches every downloaded photo and the Imagine remix URL as sendImage bytes", async () => {
    const herA = "https://pbs.twimg.com/media/one.jpg";
    const herB = "https://pbs.twimg.com/media/two.jpg";
    const remixUrl = "https://imgen.x.ai/remix.jpg";
    const files = new Map<string, { bytes: Uint8Array; mimeType: string }>([
      [herA, { bytes: Uint8Array.from([1, 1, 1, 1]), mimeType: "image/jpeg" }],
      [herB, { bytes: Uint8Array.from([2, 2, 2, 2]), mimeType: "image/jpeg" }],
      [remixUrl, { bytes: Uint8Array.from([9, 9, 9, 9, 9]), mimeType: "image/jpeg" }],
    ]);
    const { engine, client } = setup({
      llm: new VisionMock("notice the outfit"),
      imagine: {
        async generate() {
          return { url: remixUrl };
        },
      },
      fetchImage: async (url) => files.get(url),
    });
    const order: string[] = [];
    const sendMessage = client.sendMessage.bind(client);
    const sendImage = client.sendImage.bind(client);
    client.sendMessage = async (conversationId, text) => {
      order.push(`text:${text}`);
      return sendMessage(conversationId, text);
    };
    client.sendImage = async (conversationId, image) => {
      order.push(`image:${image.url}:${image.bytes?.byteLength ?? 0}`);
      return sendImage(conversationId, image);
    };
    const now = 1_700_000_000_000;
    await engine.processEvent(message({ id: "on", text: "!noor on" }), now);
    order.length = 0;
    client.sent.length = 0;
    client.tweets.set(noor.id, [tweet("21", "two pics", now + 10, [herA, herB])]);
    await engine.pollNoorAlerts(now + NOOR_ALERT_POLL_MS);

    expect(order.map((line) => line.split(":")[0])).toEqual([
      "text",
      "image",
      "image",
      "text",
      "image",
    ]);
    expect(order[1]).toBe(`image:${herA}:4`);
    expect(order[2]).toBe(`image:${herB}:4`);
    expect(order[3]).toMatch(/^text:🪞 What she really means to say is:\n"/);
    expect(order[0]).toContain("https://x.com/noorrietje/status/21");
    expect(order[0]).not.toMatch(/really means/i);
    expect(order[4]).toBe(`image:${remixUrl}:5`);
    expect(client.sent.map((row) => row.text).some((text) => text === herA || text === herB || text === remixUrl)).toBe(
      false,
    );
    expect(client.images.map((row) => row.bytes)).toEqual([4, 4, 5]);
  });

  it("does not call vision or Imagine for a text-only post", async () => {
    const llm = new VisionMock("notice me");
    const imaginePrompts: string[] = [];
    const { engine, client } = setup({
      llm,
      imagine: {
        async generate(prompt) {
          imaginePrompts.push(prompt);
          return { bytes: Uint8Array.from([1]), mimeType: "image/png" };
        },
      },
    });
    const now = 1_700_000_000_000;
    await engine.processEvent(message({ id: "on", text: "!noor on" }), now);
    client.sent.length = 0;
    client.tweets.set(noor.id, [tweet("20", "just words", now + 10)]);
    await engine.pollNoorAlerts(now + NOOR_ALERT_POLL_MS);
    expect(llm.visionCalls).toHaveLength(0);
    expect(imaginePrompts).toEqual([]);
    expect(client.images).toHaveLength(0);
    expect(client.sent).toHaveLength(2);
    expect(client.sent[0]?.text).toContain("https://x.com/noorrietje/status/20");
    expect(client.sent[0]?.text.startsWith("📌 @noorrietje original")).toBe(true);
    expect(client.sent[1]?.text.startsWith("🪞 What she really means to say is:")).toBe(true);
    expect(client.sent[1]?.text).not.toContain("https://x.com/");
  });

  it("attaches a photo when fetch works, otherwise puts the link in the text", async () => {
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    const media = "https://pbs.twimg.com/media/abc.jpg";
    const { engine, client } = setup({
      fetchImage: async () => ({ bytes, mimeType: "image/jpeg" }),
    });
    const now = 1_700_000_000_000;
    await engine.processEvent(message({ id: "on", text: "!noor on" }), now);
    client.sent.length = 0;
    client.tweets.set(noor.id, [tweet("20", "pic", now + 10, [media])]);
    await engine.pollNoorAlerts(now + NOOR_ALERT_POLL_MS);
    expect(client.sent[0]?.text).toBe(
      "📌 @noorrietje original\nhttps://x.com/noorrietje/status/20\npic",
    );
    expect(client.sent[0]?.text).not.toContain(media);
    expect(client.images).toEqual([
      { conversationId: groupId, url: media, mimeType: "image/jpeg", bytes: bytes.byteLength },
    ]);
    expect(client.images[0]?.bytes).toBeGreaterThan(0);

    const plain = setup();
    await plain.engine.processEvent(message({ id: "on2", text: "!noor on" }), now);
    plain.client.sent.length = 0;
    plain.client.tweets.set(noor.id, [tweet("21", "pic", now + 10, [media])]);
    await plain.engine.pollNoorAlerts(now + NOOR_ALERT_POLL_MS);
    expect(plain.client.sent[0]?.text).toBe(
      `📌 @noorrietje original\nhttps://x.com/noorrietje/status/21\npic\n${media}`,
    );
    expect(plain.client.images).toHaveLength(0);
  });

  it("relays into each enabled conversation and skips one that was turned off", async () => {
    const { engine, client, store } = setup();
    const now = 1_700_000_000_000;
    await engine.processEvent(message({ id: "on", text: "!noor on" }), now);
    await engine.processEvent(
      message({ id: "on2", text: "!noor on", conversationId: otherGroupId }),
      now,
    );
    await engine.processEvent(
      message({ id: "off2", text: "!noor off", conversationId: otherGroupId }),
      now + 1,
    );
    client.sent.length = 0;
    client.tweets.set(noor.id, [tweet("20", "only once per chat", now + 10)]);
    await engine.pollNoorAlerts(now + NOOR_ALERT_POLL_MS);
    expect(client.sent.every((row) => row.conversationId === groupId)).toBe(true);
    expect(client.sent).toHaveLength(2);
    expect(store.getNoorAlert(groupId)?.tweetId).toBe("20");
    expect(store.getNoorAlert(otherGroupId)?.tweetId).toBeUndefined();
  });

  it("appends the abs coda and a fresh Imagine still when abs mode is on", async () => {
    const prompts: string[] = [];
    const { engine, client, store } = setup({
      imagine: {
        async generate(prompt) {
          prompts.push(prompt);
          return { bytes: Uint8Array.from([7, 7, 7]), mimeType: "image/jpeg" };
        },
      },
    });
    const now = 1_700_000_000_000;
    await engine.processEvent(message({ id: "abs-first", text: "!noorabs on" }), now);
    expect(client.sent.at(-1)?.text).toBe("Turn on !noor first.");
    expect(store.getNoorAlert(groupId)).toBeUndefined();

    await engine.processEvent(message({ id: "on", text: "!noor on" }), now + 1);
    await engine.processEvent(message({ id: "abs", text: "!NoorAbs ON" }), now + 2);
    expect(client.sent.at(-1)?.text).toBe(
      "Noor abs on. New posts end with the abs coda. !noorabs off to stop.",
    );
    expect(store.getNoorAlert(groupId)?.absEnabled).toBe(true);
    await engine.processEvent(message({ id: "abs2", text: "!noorabs on" }), now + 3);
    expect(client.sent.at(-1)?.text).toBe("Noor abs is already on. !noorabs off to stop.");

    client.sent.length = 0;
    client.images.length = 0;
    client.tweets.set(noor.id, [tweet("20", "just words", now + 10)]);
    await engine.pollNoorAlerts(now + NOOR_ALERT_POLL_MS);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatch(/abs/i);
    expect(client.sent.map((row) => row.text)).toEqual([
      "📌 @noorrietje original\nhttps://x.com/noorrietje/status/20\njust words",
      expect.stringMatching(/^🪞 What she really means to say is:\n"/),
      NOOR_ABS_CODA,
    ]);
    expect(client.images).toEqual([
      {
        conversationId: groupId,
        url: "https://api.x.ai/v1/images/generations",
        mimeType: "image/jpeg",
        bytes: 3,
      },
    ]);
  });

  it("sends the abs coda after a photo remix, and still sends the text when Imagine fails", async () => {
    const her = "https://pbs.twimg.com/media/abs.jpg";
    const prompts: string[] = [];
    const { engine, client } = setup({
      llm: new VisionMock("beach pose"),
      fetchImage: async (url) =>
        url === her ? { bytes: Uint8Array.from([1, 2]), mimeType: "image/jpeg" } : undefined,
      imagine: {
        async generate(prompt) {
          prompts.push(prompt);
          if (prompts.length === 1) return { bytes: Uint8Array.from([9]), mimeType: "image/png" };
          throw new Error("rate limited");
        },
      },
    });
    const now = 1_700_000_000_000;
    await engine.processEvent(message({ id: "on", text: "!noor on" }), now);
    await engine.processEvent(message({ id: "abs", text: "!noorabs on" }), now + 1);
    client.sent.length = 0;
    client.images.length = 0;
    client.tweets.set(noor.id, [tweet("21", "photo", now + 10, [her])]);
    await engine.pollNoorAlerts(now + NOOR_ALERT_POLL_MS);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("photo");
    expect(prompts[1]).toMatch(/midriff/i);
    expect(client.sent.map((row) => row.text).at(-1)).toBe(NOOR_ABS_CODA);
    expect(client.sent[0]?.text.startsWith("📌 @noorrietje original")).toBe(true);
    expect(client.sent.some((row) => row.text.startsWith("🪞 What she really means to say is:"))).toBe(
      true,
    );
    expect(client.images.map((row) => row.bytes)).toEqual([2, 1]);
    expect(client.images[0]?.url).toBe(her);

    const broken = setup({
      imagine: {
        async generate() {
          throw new Error("imagine down");
        },
      },
    });
    await broken.engine.processEvent(message({ id: "on2", text: "!noor on" }), now);
    await broken.engine.processEvent(message({ id: "abs2", text: "!noorabs on" }), now + 1);
    broken.client.sent.length = 0;
    broken.client.tweets.set(noor.id, [tweet("22", "words only", now + 10)]);
    await broken.engine.pollNoorAlerts(now + NOOR_ALERT_POLL_MS);
    expect(broken.client.sent.map((row) => row.text).at(-1)).toBe(NOOR_ABS_CODA);
    expect(broken.client.images).toHaveLength(0);
  });

  it("drops the abs coda when !noor off clears it", async () => {
    const prompts: string[] = [];
    const { engine, client, store } = setup({
      imagine: {
        async generate(prompt) {
          prompts.push(prompt);
          return { bytes: Uint8Array.from([4]), mimeType: "image/jpeg" };
        },
      },
    });
    const now = 1_700_000_000_000;
    await engine.processEvent(message({ id: "on", text: "!noor on" }), now);
    await engine.processEvent(message({ id: "abs", text: "!noorabs on" }), now + 1);
    await engine.processEvent(message({ id: "off", text: "!NOOR OFF" }), now + 2);
    expect(client.sent.at(-1)?.text).toBe("Noor alert off. Abs coda off too.");
    expect(store.getNoorAlert(groupId)?.absEnabled).toBe(false);
    await engine.processEvent(message({ id: "on2", text: "!noor on" }), now + 3);
    expect(store.getNoorAlert(groupId)?.absEnabled).toBe(false);
    client.sent.length = 0;
    client.tweets.set(noor.id, [tweet("23", "after", now + 10)]);
    await engine.pollNoorAlerts(now + NOOR_ALERT_POLL_MS);
    expect(prompts).toEqual([]);
    expect(client.sent.map((row) => row.text).some((text) => text === NOOR_ABS_CODA)).toBe(false);
    expect(client.images).toHaveLength(0);
    await engine.processEvent(message({ id: "abs-off", text: "!noorabs off" }), now + 4);
    expect(client.sent.at(-1)?.text).toBe("Noor abs is already off.");
  });

  it("is listed in the default help text", () => {
    const loaded = loadDefaults("config/default.yaml");
    expect(loaded.help).toMatch(/!noor on/);
    expect(loaded.help).toMatch(/!noor off/);
    expect(loaded.help).toMatch(/!noorabs on/);
    expect(loaded.help).toMatch(/!noorabs off/);
  });
});

describe("NOOR_ALERT_USERNAME", () => {
  it("defaults to unset and rejects a bad handle", () => {
    process.env.BOT_OWNER_ID = process.env.BOT_OWNER_ID ?? "1";
    const previous = process.env.NOOR_ALERT_USERNAME;
    try {
      delete process.env.NOOR_ALERT_USERNAME;
      expect(loadEnv(true).noorUsername).toBeUndefined();
      process.env.NOOR_ALERT_USERNAME = "@OtherUser";
      expect(loadEnv(true).noorUsername).toBe("OtherUser");
      process.env.NOOR_ALERT_USERNAME = "has a space";
      expect(() => loadEnv(true)).toThrow(/NOOR_ALERT_USERNAME/);
    } finally {
      if (previous === undefined) delete process.env.NOOR_ALERT_USERNAME;
      else process.env.NOOR_ALERT_USERNAME = previous;
    }
  });
});
