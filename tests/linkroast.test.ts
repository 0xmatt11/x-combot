import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { ModerationEngine } from "../src/bot/engine.js";
import {
  containsXStatusLink,
  findXStatusLinks,
  LINKROAST_COOLDOWN_MS,
  linkroastFallback,
  sanitizeLinkroastReply,
} from "../src/bot/linkroast.js";
import { loadDefaults } from "../src/config.js";
import { MockLlmClient } from "../src/llm/mock.js";
import { Store } from "../src/store.js";
import type { BotRuntimeConfig, DefaultsConfig, DmEvent, XUser } from "../src/types.js";
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

describe("status link detection", () => {
  it("matches x.com and twitter.com status URLs, including www", () => {
    expect(findXStatusLinks("https://x.com/alice/status/123")).toEqual([
      "https://x.com/alice/status/123",
    ]);
    expect(containsXStatusLink("http://www.x.com/alice/status/123")).toBe(true);
    expect(containsXStatusLink("https://twitter.com/alice/status/1234567890123456789")).toBe(true);
    expect(containsXStatusLink("https://www.twitter.com/alice/status/1?s=20")).toBe(true);
    expect(containsXStatusLink("https://mobile.twitter.com/alice/status/1")).toBe(true);
    expect(containsXStatusLink("https://mobile.x.com/alice/status/1")).toBe(true);
    expect(containsXStatusLink("https://x.com/i/status/99")).toBe(true);
    expect(containsXStatusLink("https://x.com/i/web/status/99")).toBe(true);
    expect(containsXStatusLink("see https://x.com/alice/status/42.")).toBe(true);
    expect(containsXStatusLink("(https://x.com/alice/status/42)")).toBe(true);
    expect(containsXStatusLink("www.x.com/bob/status/7")).toBe(true);
    expect(containsXStatusLink("HTTPS://X.COM/Alice/Status/99")).toBe(true);
    expect(findXStatusLinks("https://x.com/a/status/1 and https://twitter.com/b/status/2")).toEqual([
      "https://x.com/a/status/1",
      "https://twitter.com/b/status/2",
    ]);
  });

  it("ignores profiles, help pages, and lookalike hosts", () => {
    expect(containsXStatusLink("https://x.com/alice")).toBe(false);
    expect(containsXStatusLink("https://twitter.com/alice")).toBe(false);
    expect(containsXStatusLink("https://www.x.com/alice/followers")).toBe(false);
    expect(containsXStatusLink("https://help.x.com/rules-and-policies")).toBe(false);
    expect(containsXStatusLink("https://x.com/search?q=status")).toBe(false);
    expect(containsXStatusLink("https://example.com/status/123")).toBe(false);
    expect(containsXStatusLink("https://notx.com/user/status/1")).toBe(false);
    expect(containsXStatusLink("https://x.com.evil.com/user/status/1")).toBe(false);
    expect(containsXStatusLink("https://t.co/abc123")).toBe(false);
    expect(containsXStatusLink("just talking about status")).toBe(false);
    expect(containsXStatusLink("")).toBe(false);
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
      "Link roast on. I'll roast X status links in this chat. !linkroast off to stop.",
    ]);

    await engine.processEvent(message({ id: "again", senderId: bob.id, text: "!linkroast ON" }));
    expect(client.sent.at(-1)?.text).toBe("Link roast is already on.");

    const restarted = new ModerationEngine(store, client, runtime(), undefined, { random: () => 0 });
    expect(store.isLinkroastEnabled(groupId)).toBe(true);
    await restarted.processEvent(
      message({ id: "off", senderId: alice.id, text: "/LINKROAST off" }),
    );
    expect(store.isLinkroastEnabled(groupId)).toBe(false);
    expect(client.sent.at(-1)?.text).toBe("Link roast off.");

    await restarted.processEvent(message({ id: "off2", senderId: alice.id, text: "!linkroast off" }));
    expect(client.sent.at(-1)?.text).toBe("Link roast is already off.");
    await restarted.processEvent(message({ id: "bare", senderId: alice.id, text: "!linkroast" }));
    expect(client.sent.at(-1)?.text).toBe("Use !linkroast on or !linkroast off.");
  });

  it("roasts a status link with the LLM and ignores profiles", async () => {
    const roast = "@alice your timeline called. It wants the group chat back.";
    const llm = new MockLlmClient(roast);
    const { engine, client } = setup(llm);
    await engine.processEvent(message({ id: "on", senderId: alice.id, text: "!linkroast on" }));
    const start = 1_000_000;

    await engine.processEvent(
      message({
        id: "profile",
        senderId: alice.id,
        text: "follow me https://x.com/alice",
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
      "Link roast on. I'll roast X status links in this chat. !linkroast off to stop.",
      roast,
    ]);
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]?.[0]?.content).toMatch(/without asking/i);
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
      "Link roast on. I'll roast X status links in this chat. !linkroast off to stop.",
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
      "Link roast on. I'll roast X status links in this chat. !linkroast off to stop.",
      "Link roast off.",
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

  it("is listed in the default help text and the readme command table", () => {
    const loaded = loadDefaults("config/default.yaml");
    expect(loaded.help).toMatch(/!linkroast on/);
    expect(loaded.help).toMatch(/!linkroast off/);
    const readme = fs.readFileSync("README.md", "utf8");
    expect(readme).toMatch(/\| `!linkroast on` \|/);
  });
});

describe("sanitizeLinkroastReply", () => {
  it("strips snowflakes and status URLs and keeps the label", () => {
    const text = sanitizeLinkroastReply(
      `${snowflake} posted https://x.com/alice/status/${snowflake} again. Second sentence stays. Third is gone.`,
      "@alice",
      [snowflake],
    );
    expect(text).not.toContain(snowflake);
    expect(text).not.toMatch(/https?:\/\//);
    expect(text.toLowerCase()).toContain("@alice");
    expect(text).not.toContain("Third");
  });
});
