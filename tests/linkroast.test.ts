import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { ModerationEngine } from "../src/bot/engine.js";
import {
  chatLinkSignals,
  classicDmLinkSignals,
  containsLink,
  findLinks,
  LINKROAST_COOLDOWN_MS,
  LINKROAST_ON_ACK,
  linkroastFallback,
  messageHasRoastableLink,
  sanitizeLinkroastReply,
} from "../src/bot/linkroast.js";
import { chatEventToDm } from "../src/chat/normalize.js";
import { loadDefaults } from "../src/config.js";
import { MockLlmClient } from "../src/llm/mock.js";
import { Store } from "../src/store.js";
import type { BotRuntimeConfig, DefaultsConfig, DmEvent, XUser } from "../src/types.js";
import { normalizeClassicDmEvent } from "../src/x/live-client.js";
import { MockXClient } from "../src/x/mock-client.js";

const alice: XUser = { id: "u-alice", username: "alice", name: "Alice" };
const bob: XUser = { id: "u-bob", username: "bob", name: "Bob" };
const owner: XUser = { id: "u-owner", username: "owner", name: "Owner" };
const groupId = "1578398451921985538";
const otherGroup = "1578398451921985539";
const snowflake = "1712950172873809920";

const defaults: DefaultsConfig = {
  welcome: { enabled: false, text: "Welcome @{username}!" },
  rules: "Be nice.",
  help: "Type !rules",
  flood: { max_messages: 0, window_ms: 10_000, mute_ms: 60_000, warn_on_flood: false },
  warns: { limit: 3, auto_mute_ms: 60_000, notify_admins: false },
  filters: [],
  poll: { interval_ms: 1000, max_results: 50 },
  delete: { attempt_on_filter: false, attempt_on_flood: false, attempt_on_mute: false },
  xp: {
    enabled: false,
    xp_per_message: 10,
    xp_per_reaction: 5,
    cooldown_ms: 60_000,
    reactions_enabled: false,
    level_grant_enabled: false,
    level_grant_cooldown_ms: 3_600_000,
    leaderboard_size: 10,
  },
};

function runtime(): BotRuntimeConfig {
  return {
    botUserId: "bot-1",
    botUsername: "modbot",
    ownerId: owner.id,
    globalAdminIds: [],
    defaults,
  };
}

function message(partial: Partial<DmEvent> & Pick<DmEvent, "id" | "senderId" | "text">): DmEvent {
  const sender =
    partial.sender ??
    [alice, bob, owner].find((user) => user.id === partial.senderId);
  return {
    eventType: "MessageCreate",
    conversationId: groupId,
    participantIds: [],
    participants: [],
    mentions: [],
    sender,
    ...partial,
  };
}

const FIRST_FALLBACK = linkroastFallback("@alice", () => 0);

describe("link detection", () => {
  it("matches any http(s) URL, www without a scheme, shortlinks, and x.com statuses", () => {
    expect(findLinks("https://x.com/alice/status/123")).toEqual([
      "https://x.com/alice/status/123",
    ]);
    expect(containsLink("http://www.x.com/alice/status/123")).toBe(true);
    expect(containsLink("https://twitter.com/alice/status/1234567890123456789")).toBe(true);
    expect(containsLink("https://www.twitter.com/alice/status/1?s=20")).toBe(true);
    expect(containsLink("https://mobile.twitter.com/alice/status/1")).toBe(true);
    expect(containsLink("https://mobile.x.com/alice/status/1")).toBe(true);
    expect(containsLink("https://x.com/i/status/99")).toBe(true);
    expect(containsLink("https://x.com/i/web/status/99")).toBe(true);
    expect(containsLink("see https://x.com/alice/status/42.")).toBe(true);
    expect(containsLink("(https://x.com/alice/status/42)")).toBe(true);
    expect(containsLink("www.x.com/bob/status/7")).toBe(true);
    expect(containsLink("HTTPS://X.COM/Alice/Status/99")).toBe(true);
    expect(findLinks("https://x.com/a/status/1 and https://twitter.com/b/status/2")).toEqual([
      "https://x.com/a/status/1",
      "https://twitter.com/b/status/2",
    ]);
    expect(containsLink("https://x.com/alice")).toBe(true);
    expect(containsLink("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(true);
    expect(containsLink("https://t.co/abc123")).toBe(true);
    expect(containsLink("https://opensea.io/collection/milady")).toBe(true);
    expect(findLinks("see www.example.com/news.")).toEqual(["www.example.com/news"]);
    expect(containsLink("WWW.YouTube.com/watch?v=1")).toBe(true);
  });

  it("ignores bare domains, emails, and text with no URL", () => {
    expect(containsLink("example.com/status/123")).toBe(false);
    expect(containsLink("notx.com/user/status/1")).toBe(false);
    expect(containsLink("alice@example.com")).toBe(false);
    expect(containsLink("ftp://example.com/file")).toBe(false);
    expect(containsLink("just talking about status")).toBe(false);
    expect(containsLink("")).toBe(false);
    expect(containsLink("http://localhost/secret")).toBe(false);
  });

  it("reads classic URL entities and a referenced post id", () => {
    expect(
      classicDmLinkSignals({
        entities: {
          urls: [
            {
              url: "https://t.co/abc123",
              expanded_url: "https://www.youtube.com/watch?v=1",
              display_url: "youtube.com/watch",
            },
          ],
        },
        referenced_tweets: [{ id: snowflake }],
      }),
    ).toEqual({
      urls: [
        "https://t.co/abc123",
        "https://www.youtube.com/watch?v=1",
        "https://youtube.com/watch",
      ],
      statusIds: [snowflake],
    });
    expect(
      messageHasRoastableLink({
        text: "shared a post",
        linkSignals: { urls: [], statusIds: [snowflake] },
      }),
    ).toBe(true);
    expect(messageHasRoastableLink({ text: "hello" })).toBe(false);
  });

  it("reads Chat post and url cards, url entities, and ignores media", () => {
    expect(
      chatLinkSignals({
        content: {
          text: "look",
          attachments: [{ attachment_type: "post", rest_id: snowflake }],
        },
      }),
    ).toEqual({ urls: [], statusIds: [snowflake] });
    expect(
      chatLinkSignals({
        attachments: [
          { attachmentType: "post", postUrl: "https://x.com/alice/status/42" },
        ],
      }),
    ).toEqual({ urls: ["https://x.com/alice/status/42"], statusIds: [] });
    expect(
      chatLinkSignals({
        content: {
          attachments: [{ post: { rest_id: "99", post_url: "https://x.com/a/status/99" } }],
        },
      }),
    ).toEqual({ urls: ["https://x.com/a/status/99"], statusIds: ["99"] });
    const cardOnly = chatEventToDm(
      groupId,
      { id: "evt-empty", sender_id: alice.id },
      {
        type: "message",
        content: {
          contentType: "text",
          attachments: [{ attachmentType: "post", restId: snowflake }],
        },
      },
    );
    expect(cardOnly?.text).toBe("");
    expect(cardOnly?.linkSignals?.statusIds).toEqual([snowflake]);
    expect(
      chatLinkSignals({
        content: {
          text: "",
          attachments: [{ attachmentType: "url", url: "https://news.example.com/story" }],
        },
      }),
    ).toEqual({ urls: ["https://news.example.com/story"], statusIds: [] });
    expect(
      chatLinkSignals({
        content: {
          text: "no url in the text",
          entities: [{ type: "url", url: "https://opensea.io/item/1" }],
        },
      }),
    ).toEqual({ urls: ["https://opensea.io/item/1"], statusIds: [] });
    expect(
      chatLinkSignals({
        content: {
          text: "fwd",
          forwardedMessage: { messageText: "https://example.com/fwd" },
        },
      }),
    ).toEqual({ urls: ["https://example.com/fwd"], statusIds: [] });
    expect(
      chatLinkSignals({
        content: {
          text: "pic",
          attachments: [
            {
              attachmentType: "media",
              legacyMediaUrlHttps: "https://ton.x.com/i/ton/data/xchat_media/abc",
            },
          ],
        },
      }),
    ).toBeUndefined();
    expect(
      chatLinkSignals({
        content: {
          text: "lol",
          replyingToPreview: { text: "https://example.com/old" },
        },
      }),
    ).toBeUndefined();
    expect(
      chatLinkSignals({
        content: {
          text: "span only https://example.com/in-text",
          entities: [[0, 10, "url"]],
        },
      }),
    ).toBeUndefined();
  });
});

describe("link roast mode", () => {
  const stores: Store[] = [];

  afterEach(() => {
    for (const store of stores) store.close();
    stores.length = 0;
  });

  function setup(llm?: MockLlmClient) {
    const store = new Store(":memory:");
    stores.push(store);
    const client = new MockXClient();
    client.addUser(alice);
    client.addUser(bob);
    client.addUser(owner);
    const engine = new ModerationEngine(store, client, runtime(), llm, { random: () => 0 });
    return { engine, client, store, llm };
  }

  it("toggles with a short ack and stays on across a new engine", async () => {
    const { engine, client, store } = setup();
    await engine.processEvent(message({ id: "on", senderId: alice.id, text: "!LiNkRoAsT oN" }));
    expect(store.isLinkroastEnabled(groupId)).toBe(true);
    expect(client.sent.map((row) => row.text)).toEqual([
      `@alice ${LINKROAST_ON_ACK}`,
    ]);

    await engine.processEvent(message({ id: "again", senderId: bob.id, text: "!linkroast ON" }));
    expect(client.sent.at(-1)?.text).toBe("@bob Link roast is already on.");

    const restarted = new ModerationEngine(store, client, runtime(), undefined, { random: () => 0 });
    expect(store.isLinkroastEnabled(groupId)).toBe(true);
    await restarted.processEvent(
      message({ id: "off", senderId: alice.id, text: "/LINKROAST off" }),
    );
    expect(store.isLinkroastEnabled(groupId)).toBe(false);
    expect(client.sent.at(-1)?.text).toBe("@alice Link roast off.");

    await restarted.processEvent(message({ id: "off2", senderId: alice.id, text: "!linkroast off" }));
    expect(client.sent.at(-1)?.text).toBe("@alice Link roast is already off.");
    await restarted.processEvent(message({ id: "bare", senderId: alice.id, text: "!linkroast" }));
    expect(client.sent.at(-1)?.text).toBe("@alice Use !linkroast on or !linkroast off.");
  });

  it("roasts a status link with the LLM and ignores text with no URL", async () => {
    const roast = "@alice your timeline called. It wants the group chat back.";
    const llm = new MockLlmClient(roast);
    const { engine, client } = setup(llm);
    await engine.processEvent(message({ id: "on", senderId: alice.id, text: "!linkroast on" }));
    const start = 1_000_000;

    await engine.processEvent(
      message({
        id: "plain",
        senderId: alice.id,
        text: "follow me",
      }),
      start,
    );
    expect(llm.calls).toHaveLength(0);
    expect(client.sent).toHaveLength(1);

    await engine.processEvent(
      message({
        id: "status",
        senderId: alice.id,
        text: `new post https://x.com/alice/status/${snowflake}`,
      }),
      start,
    );
    expect(client.sent.map((row) => row.text)).toEqual([
      `@alice ${LINKROAST_ON_ACK}`,
      roast,
    ]);
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]?.[0]?.content).toMatch(/link or shared a post/i);
    expect(llm.calls[0]?.[1]?.content).toMatch(/without asking/i);
    expect(llm.calls[0]?.[1]?.content).toContain("@alice");
    expect(llm.calls[0]?.[1]?.content ?? "").not.toContain(snowflake);
    expect(client.sent.some((row) => row.text.includes(snowflake))).toBe(false);
  });

  it("rate-limits one roast per user and still roasts someone else", async () => {
    const llm = new MockLlmClient([
      "@alice first roast stays.",
      "@bob gets a turn.",
      "@alice second roast stays.",
    ]);
    const { engine, client } = setup(llm);
    await engine.processEvent(message({ id: "on", senderId: alice.id, text: "!linkroast on" }));
    const start = 2_000_000;

    await engine.processEvent(
      message({ id: "a1", senderId: alice.id, text: "https://x.com/alice/status/1" }),
      start,
    );
    await engine.processEvent(
      message({ id: "a2", senderId: alice.id, text: "https://twitter.com/alice/status/2" }),
      start + 10_000,
    );
    await engine.processEvent(
      message({ id: "b1", senderId: bob.id, text: "https://www.x.com/bob/status/3" }),
      start + 20_000,
    );
    await engine.processEvent(
      message({ id: "a3", senderId: alice.id, text: "https://mobile.twitter.com/alice/status/4" }),
      start + LINKROAST_COOLDOWN_MS,
    );

    expect(client.sent.map((row) => row.text)).toEqual([
      `@alice ${LINKROAST_ON_ACK}`,
      "@alice first roast stays.",
      "@bob gets a turn.",
      "@alice second roast stays.",
    ]);
    expect(llm.calls).toHaveLength(3);
  });

  it("stops roasting when turned off and ignores the bot", async () => {
    const llm = new MockLlmClient("@alice should not be used after off");
    const { engine, client } = setup(llm);
    await engine.processEvent(message({ id: "on", senderId: alice.id, text: "!linkroast on" }));
    await engine.processEvent(message({ id: "off", senderId: alice.id, text: "!linkroast off" }));
    const start = 3_000_000;
    await engine.processEvent(
      message({ id: "a1", senderId: alice.id, text: "https://x.com/alice/status/9" }),
      start,
    );
    await engine.processEvent(
      message({
        id: "bot",
        senderId: "bot-1",
        sender: { id: "bot-1", username: "modbot" },
        text: "https://x.com/modbot/status/9",
      }),
      start,
    );
    expect(llm.calls).toHaveLength(0);
    expect(client.sent.map((row) => row.text)).toEqual([
      `@alice ${LINKROAST_ON_ACK}`,
      "@alice Link roast off.",
    ]);
  });

  it("does not roast a different conversation", async () => {
    const llm = new MockLlmClient("@alice nope");
    const { engine, client } = setup(llm);
    await engine.processEvent(message({ id: "on", senderId: alice.id, text: "!linkroast on" }));
    await engine.processEvent(
      message({
        id: "other",
        senderId: alice.id,
        conversationId: otherGroup,
        text: "https://x.com/alice/status/5",
      }),
      4_000_000,
    );
    expect(llm.calls).toHaveLength(0);
    expect(client.sent).toHaveLength(1);
  });

  it("uses a template when the completion fails or the LLM is off", async () => {
    const failing = new MockLlmClient([]);
    const { engine, client, store } = setup(failing);
    await engine.processEvent(message({ id: "on", senderId: alice.id, text: "!linkroast on" }));
    const start = 5_000_000;
    await engine.processEvent(
      message({ id: "a1", senderId: alice.id, text: "https://x.com/alice/status/11" }),
      start,
    );
    expect(client.sent.at(-1)?.text).toBe(FIRST_FALLBACK);
    expect(client.sent.at(-1)?.text.toLowerCase()).toMatch(/link|post|tweet|promo|status/);

    store.patchSettings(groupId, { llm_enabled: false });
    const quiet = new MockLlmClient("@alice the model should stay quiet");
    const engineOff = new ModerationEngine(store, client, runtime(), quiet, {
      random: () => 0,
    });
    await engineOff.processEvent(
      message({ id: "a2", senderId: alice.id, text: "https://twitter.com/alice/status/12" }),
      start + LINKROAST_COOLDOWN_MS,
    );
    expect(quiet.calls).toHaveLength(0);
    expect(client.sent.at(-1)?.text).toBe(FIRST_FALLBACK);
  });

  it("does not quote a message that trips the age filter", async () => {
    const llm = new MockLlmClient("@alice should not be called");
    const { engine, client } = setup(llm);
    await engine.processEvent(message({ id: "on", senderId: alice.id, text: "!linkroast on" }));
    await engine.processEvent(
      message({
        id: "bad",
        senderId: alice.id,
        text: "that teen show https://x.com/alice/status/8",
      }),
      6_000_000,
    );
    expect(llm.calls).toHaveLength(0);
    expect(client.sent.at(-1)?.text).toBe(FIRST_FALLBACK);
    expect(client.sent.at(-1)?.text.toLowerCase()).not.toContain("teen");
  });

  it("roasts generic URLs, shortlinks, www, profiles, and a shared post with no pasted URL", async () => {
    const llm = new MockLlmClient([
      "@alice youtube stays.",
      "@bob shortlink stays.",
      "@alice www stays.",
      "@bob profile stays.",
      "@alice card stays.",
      "@bob news stays.",
      "@alice entity stays.",
    ]);
    const { engine, client } = setup(llm);
    await engine.processEvent(message({ id: "on", senderId: alice.id, text: "!linkroast on" }));
    const start = 7_000_000;
    const later = (step: number) => start + step * LINKROAST_COOLDOWN_MS;

    await engine.processEvent(
      message({
        id: "yt",
        senderId: alice.id,
        text: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      }),
      later(0),
    );
    await engine.processEvent(
      message({ id: "short", senderId: bob.id, text: "https://t.co/abc123" }),
      later(0),
    );
    await engine.processEvent(
      message({ id: "www", senderId: alice.id, text: "www.opensea.io/collection/milady" }),
      later(1),
    );
    await engine.processEvent(
      message({ id: "profile", senderId: bob.id, text: "https://x.com/bob" }),
      later(1),
    );
    await engine.processEvent(
      message({
        id: "card",
        senderId: alice.id,
        text: "look",
        linkSignals: { urls: [], statusIds: [snowflake] },
      }),
      later(2),
    );
    const shared = chatEventToDm(
      groupId,
      { id: "evt-share", sender_id: bob.id },
      {
        type: "message",
        senderId: bob.id,
        content: {
          contentType: "text",
          text: "card only",
          attachments: [{ attachmentType: "url", url: "https://news.example.com/story" }],
        },
      },
    );
    expect(shared?.text).toBe("card only");
    expect(shared?.linkSignals?.urls).toEqual(["https://news.example.com/story"]);
    await engine.processEvent(
      message({
        id: "evt-share",
        senderId: bob.id,
        text: shared?.text ?? "",
        linkSignals: shared?.linkSignals,
      }),
      later(2),
    );

    const classic = normalizeClassicDmEvent(
      {
        id: "dm-entity",
        event_type: "MessageCreate",
        dm_conversation_id: groupId,
        sender_id: alice.id,
        text: "via the card",
        entities: {
          urls: [{ expanded_url: "https://opensea.io/item/1" }],
        },
        referenced_tweets: [{ id: snowflake }],
      },
      new Map([[alice.id, alice]]),
    );
    expect(classic.linkSignals?.urls).toEqual(["https://opensea.io/item/1"]);
    expect(classic.linkSignals?.statusIds).toEqual([snowflake]);
    expect(classic.replyToSenderId).toBeUndefined();
    expect(containsLink(classic.text)).toBe(false);
    await engine.processEvent(
      message({
        id: "dm-entity",
        senderId: alice.id,
        text: classic.text ?? "",
        linkSignals: classic.linkSignals,
      }),
      later(3),
    );

    expect(client.sent.map((row) => row.text)).toEqual([
      `@alice ${LINKROAST_ON_ACK}`,
      "@alice youtube stays.",
      "@bob shortlink stays.",
      "@alice www stays.",
      "@bob profile stays.",
      "@alice card stays.",
      "@bob news stays.",
      "@alice entity stays.",
    ]);
    expect(llm.calls).toHaveLength(7);
    expect(llm.calls[0]?.[1]?.content ?? "").not.toContain("youtube.com");
    expect(client.sent.some((row) => row.text.includes(snowflake))).toBe(false);
  });

  it("roasts a Sent a post card when the text has no URL", async () => {
    // chat-xdk decrypt of a share-sheet post. The chat UI labels this
    // "Sent a post" and draws the tweet preview from restId. message_text
    // is empty, and the ciphertext often has no http URL.
    const sentAPost = {
      type: "message",
      id: "msg-sent-a-post",
      senderId: alice.id,
      sequenceId: "9001",
      content: {
        contentType: "text",
        text: "",
        sentFrom: "shareSheet",
        attachments: [{ post: { restId: snowflake } }],
      },
      attachments: [{ attachmentType: "post", restId: snowflake }],
    };
    expect(chatLinkSignals({ content: sentAPost.content })).toEqual({
      urls: [],
      statusIds: [snowflake],
    });
    expect(chatLinkSignals({ attachments: sentAPost.attachments })).toEqual({
      urls: [],
      statusIds: [snowflake],
    });
    const event = chatEventToDm(
      groupId,
      { id: "evt-sent-a-post", sender_id: alice.id, sequence_id: "9001" },
      sentAPost,
    );
    expect(event?.text).toBe("");
    expect(containsLink(event?.text)).toBe(false);
    expect(event?.linkSignals).toEqual({ urls: [], statusIds: [snowflake] });

    const roast = "@alice that preview is not a conversation.";
    const llm = new MockLlmClient(roast);
    const { engine, client } = setup(llm);
    await engine.processEvent(message({ id: "on", senderId: alice.id, text: "!linkroast on" }));
    await engine.processEvent(
      message({
        id: event?.id ?? "evt-sent-a-post",
        senderId: alice.id,
        text: event?.text ?? "",
        linkSignals: event?.linkSignals,
      }),
      9_000_000,
    );
    expect(client.sent.map((row) => row.text)).toEqual([
      `@alice ${LINKROAST_ON_ACK}`,
      roast,
    ]);
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]?.[1]?.content).toContain("(just the link)");
    expect(llm.calls[0]?.[1]?.content ?? "").not.toContain(snowflake);
  });

  it("does not roast a bang command that includes a URL", async () => {
    const { engine, client } = setup();
    await engine.processEvent(message({ id: "on", senderId: alice.id, text: "!linkroast on" }));
    const start = 8_000_000;
    await engine.processEvent(
      message({
        id: "rules",
        senderId: alice.id,
        text: "!rules https://www.youtube.com/watch?v=1",
      }),
      start,
    );
    await engine.processEvent(
      message({
        id: "banana",
        senderId: alice.id,
        text: "!banana https://t.co/abc123",
      }),
      start + 1_000,
    );
    await engine.processEvent(
      message({
        id: "ask",
        senderId: bob.id,
        text: "/ask what is https://example.com/docs",
      }),
      start + 2_000,
    );
    expect(client.sent.map((row) => row.text)).toEqual([
      `@alice ${LINKROAST_ON_ACK}`,
      "@alice Be nice.",
      "@bob LLM replies are not configured. Set LLM_PROVIDER (openai, grok, or local) and the matching key/URL: OPENAI_API_KEY, XAI_API_KEY, or LLM_BASE_URL for a local server.",
    ]);

    await engine.processEvent(
      message({
        id: "mid",
        senderId: alice.id,
        text: "read !rules at https://example.com/docs",
      }),
      start + LINKROAST_COOLDOWN_MS,
    );
    expect(client.sent.at(-1)?.text).toBe(FIRST_FALLBACK);
  });

  it("is listed in the default help text and the readme command table", () => {
    const loaded = loadDefaults("config/default.yaml");
    expect(loaded.help).toMatch(/!linkroast on/);
    expect(loaded.help).toMatch(/!linkroast off/);
    expect(loaded.help).toMatch(/Sent a post/);
    const readme = fs.readFileSync("README.md", "utf8");
    expect(readme).toMatch(/\| `!linkroast on` \| Roast any link or shared post/);
    expect(readme).toMatch(/Sent a post/);
    expect(readme).toMatch(/t\.co/);
    expect(readme).toMatch(/referenced_tweets/);
  });
});

describe("sanitizeLinkroastReply", () => {
  it("strips snowflakes and status URLs and keeps the label", () => {
    const text = sanitizeLinkroastReply(
      `${snowflake} posted https://www.youtube.com/watch?v=1 and https://x.com/alice/status/${snowflake} again. Second sentence stays. Third is gone.`,
      "@alice",
      [snowflake],
    );
    expect(text).not.toContain(snowflake);
    expect(text).not.toMatch(/https?:\/\//);
    expect(text.toLowerCase()).toContain("@alice");
    expect(text).not.toContain("Third");
  });
});
