import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { ModerationEngine } from "../src/bot/engine.js";
import { momJoke, sanitizeTrollReply, TROLL_COOLDOWN_MS } from "../src/bot/troll.js";
import { loadDefaults } from "../src/config.js";
import { MockLlmClient } from "../src/llm/mock.js";
import { Store } from "../src/store.js";
import type { BotRuntimeConfig, DefaultsConfig, DmEvent, XUser } from "../src/types.js";
import { MockXClient } from "../src/x/mock-client.js";

const alice: XUser = { id: "u-alice", username: "alice", name: "Alice" };
const bob: XUser = { id: "u-bob", username: "bob", name: "Bob" };
const owner: XUser = { id: "u-owner", username: "owner", name: "Owner" };
const groupId = "1578398451921985538";
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

const FIRST_JOKE = momJoke("@bob", () => 0);

describe("troll mode", () => {
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

  it("persists the target and roasts only that person", async () => {
    const { engine, client, store } = setup();
    await engine.processEvent(
      message({ id: "on", senderId: alice.id, text: "!troll @bob" }),
    );
    expect(store.getTrollTarget(groupId, bob.id)).toMatchObject({
      userId: bob.id,
      username: "bob",
      lastMs: 0,
      roastNext: 0,
    });
    expect(client.sent.map((row) => row.text)).toEqual([
      "@alice Troll mode on for @bob. I'll reply when they talk in this chat. Enabled: @bob.",
    ]);

    await engine.processEvent(
      message({ id: "a1", senderId: alice.id, text: "I am not the target" }),
    );
    expect(client.sent).toHaveLength(1);

    await engine.processEvent(
      message({ id: "b1", senderId: bob.id, text: "hello from bob", createdAt: "2026-01-01T00:00:01Z" }),
      1_000,
    );
    expect(client.sent.map((row) => row.text)).toEqual([
      "@alice Troll mode on for @bob. I'll reply when they talk in this chat. Enabled: @bob.",
      FIRST_JOKE,
    ]);
    expect(client.sent.some((row) => row.text.includes(bob.id))).toBe(false);
  });

  it("keeps the target across a new engine and a reopened database", async () => {
    const { engine, client, store } = setup();
    await engine.processEvent(message({ id: "on", senderId: alice.id, text: "!troll @bob" }));
    const restarted = new ModerationEngine(store, client, runtime(), undefined, { random: () => 0 });
    await restarted.processEvent(
      message({ id: "b1", senderId: bob.id, text: "still here" }),
      1_000_000,
    );
    expect(client.sent.at(-1)?.text).toBe(FIRST_JOKE);

    const file = path.join(os.tmpdir(), `x-combot-troll-${process.pid}.sqlite`);
    const disk = new Store(file);
    disk.addTrollTarget(groupId, bob.id, "bob");
    disk.addTrollTarget(groupId, alice.id, "alice");
    disk.close();
    const opened = new Store(file);
    expect(opened.listTrollTargets(groupId).map((row) => row.userId)).toEqual([bob.id, alice.id]);
    expect(opened.listTrollTargets("other-chat")).toEqual([]);
    opened.close();
    fs.rmSync(file, { force: true });
    fs.rmSync(`${file}-wal`, { force: true });
    fs.rmSync(`${file}-shm`, { force: true });
  });

  it("stays on through !troll off and a bare !untroll, and stops only for !untroll @handle", async () => {
    const { engine, client, store } = setup();
    await engine.processEvent(message({ id: "on", senderId: alice.id, text: "!troll @bob" }));
    await engine.processEvent(message({ id: "off", senderId: alice.id, text: "!troll off" }));
    await engine.processEvent(message({ id: "bare", senderId: alice.id, text: "!untroll" }));
    await engine.processEvent(message({ id: "wrong", senderId: alice.id, text: "!untroll @alice" }));
    expect(store.getTrollTarget(groupId, bob.id)?.userId).toBe(bob.id);
    await engine.processEvent(
      message({ id: "b1", senderId: bob.id, text: "still targeted" }),
      1_000_000,
    );
    expect(client.sent.at(-1)?.text).toBe(FIRST_JOKE);

    await engine.processEvent(message({ id: "stop", senderId: alice.id, text: "!untroll @bob" }));
    expect(store.listTrollTargets(groupId)).toEqual([]);
    await engine.processEvent(
      message({ id: "b2", senderId: bob.id, text: "no roast" }),
      1_000_000 + TROLL_COOLDOWN_MS,
    );
    expect(client.sent.at(-1)?.text).toBe("@alice Troll mode off for @bob. Troll list is empty.");
    expect(client.sent.some((row) => row.text.includes("Troll mode stays on."))).toBe(true);
    expect(client.sent.some((row) => row.text.includes("Still trolling."))).toBe(true);
    expect(client.sent.some((row) => row.text.includes("Enabled: @bob."))).toBe(true);
    expect(client.sent.some((row) => row.text.includes("@alice is not on the troll list."))).toBe(
      true,
    );
  });

  it("does not reset the cooldown when !troll names someone again, and adding someone else keeps them", async () => {
    const { engine, client, store } = setup();
    const start = 4_000_000;
    await engine.processEvent(message({ id: "on", senderId: alice.id, text: "!troll @bob" }));
    await engine.processEvent(message({ id: "b1", senderId: bob.id, text: "one" }), start);
    await engine.processEvent(message({ id: "again", senderId: alice.id, text: "!troll @bob" }));
    expect(store.getTrollTarget(groupId, bob.id)?.userId).toBe(bob.id);
    expect(store.getTrollTarget(groupId, bob.id)?.lastMs).toBe(start);
    await engine.processEvent(
      message({ id: "b2", senderId: bob.id, text: "two" }),
      start + 1_000,
    );
    expect(client.sent.filter((row) => row.text === FIRST_JOKE)).toHaveLength(1);
    expect(client.sent.at(-1)?.text).toBe("@alice Already trolling @bob. Enabled: @bob.");
    await engine.processEvent(message({ id: "switch", senderId: alice.id, text: "!troll @alice" }));
    expect(store.listTrollTargets(groupId).map((row) => row.userId)).toEqual([bob.id, alice.id]);
    expect(store.getTrollTarget(groupId, bob.id)?.lastMs).toBe(start);
    expect(client.sent.at(-1)?.text).toBe(
      "@alice Troll mode on for @alice. I'll reply when they talk in this chat. Enabled: @bob, @alice.",
    );
  });

  it("accepts a display name and a reply the bot can already resolve", async () => {
    const { engine, store } = setup();
    await engine.processEvent(
      message({
        id: "name",
        senderId: alice.id,
        text: "!troll Bobby Tables",
        participants: [{ id: bob.id, name: "Bobby Tables" }],
      }),
    );
    expect(store.getTrollTarget(groupId, bob.id)?.userId).toBe(bob.id);
    expect(store.getTrollTarget(groupId, bob.id)?.username).toBeUndefined();

    await engine.processEvent(
      message({
        id: "stop-name",
        senderId: alice.id,
        text: "!untroll Bobby Tables",
        participants: [{ id: bob.id, name: "Bobby Tables" }],
      }),
    );
    expect(store.listTrollTargets(groupId)).toEqual([]);
    await engine.processEvent(
      message({
        id: "reply",
        senderId: alice.id,
        text: "!troll",
        replyToSenderId: bob.id,
      }),
    );
    expect(store.getTrollTarget(groupId, bob.id)).toMatchObject({ userId: bob.id, username: "bob" });
  });

  it("does not roast a replay of the same message", async () => {
    const { engine, client } = setup();
    await engine.processEvent(message({ id: "on", senderId: alice.id, text: "!troll @bob" }));
    const spoken = message({ id: "b1", senderId: bob.id, text: "hello", sequenceId: "seq-1" });
    await engine.processEvent(spoken, 1_000_000);
    const again = await engine.processEvent(
      message({
        id: "b1-replay",
        senderId: bob.id,
        text: "hello",
        sequenceId: "seq-1",
      }),
      1_000_000 + 1_000,
    );
    expect(again.replies).toEqual([]);
    expect(client.sent).toHaveLength(2);
    expect(client.sent.at(-1)?.text).toBe(FIRST_JOKE);
  });

  it("caps troll replies to one per cooldown window", async () => {
    const { engine, client } = setup();
    await engine.processEvent(message({ id: "on", senderId: alice.id, text: "!troll @bob" }));
    const start = 5_000_000;
    await engine.processEvent(
      message({ id: "b1", senderId: bob.id, text: "one" }),
      start,
    );
    await engine.processEvent(
      message({ id: "b2", senderId: bob.id, text: "two" }),
      start + 1_000,
    );
    expect(client.sent).toHaveLength(2);
    await engine.processEvent(
      message({ id: "b3", senderId: bob.id, text: "three" }),
      start + TROLL_COOLDOWN_MS,
    );
    expect(client.sent).toHaveLength(3);
    expect(client.sent.slice(1).every((row) => /your mom/i.test(row.text))).toBe(true);
    expect(client.sent.slice(1).every((row) => row.text.includes("@bob"))).toBe(true);
  });

  it("roasts from the chat line and the public timeline, and still replies if the timeline fails", async () => {
    const llm = new MockLlmClient("@bob that car name is doing more work than you are.");
    const { engine, client } = setup(llm);
    client.posts.set(bob.id, ["bought a car and immediately named it Kevin"]);
    client.events.push(
      message({
        id: "old",
        senderId: bob.id,
        text: "I love pineapple pizza",
        createdAt: "2026-01-01T00:00:01Z",
      }),
    );
    await engine.processEvent(message({ id: "on", senderId: alice.id, text: "!troll @bob" }));
    const start = 8_000_000;
    await engine.processEvent(message({ id: "b1", senderId: bob.id, text: "hello" }), start);
    expect(llm.calls).toHaveLength(0);

    await engine.processEvent(
      message({ id: "b2", senderId: bob.id, text: "actually the pizza was mid" }),
      start + TROLL_COOLDOWN_MS,
    );
    expect(client.sent.at(-1)?.text).toBe(
      "@bob that car name is doing more work than you are.",
    );
    const prompt = llm.calls[0]?.[1]?.content ?? "";
    expect(prompt).toContain("@bob");
    expect(prompt).toContain("actually the pizza was mid");
    expect(prompt).toContain("I love pineapple pizza");
    expect(prompt).toContain("bought a car and immediately named it Kevin");
    expect(prompt).not.toContain(bob.id);

    const failed = setup(new MockLlmClient("@bob still talking."));
    failed.client.failPosts = true;
    await failed.engine.processEvent(
      message({ id: "on2", senderId: alice.id, text: "!troll @bob" }),
    );
    await failed.engine.processEvent(
      message({ id: "c1", senderId: bob.id, text: "first" }),
      start,
    );
    await failed.engine.processEvent(
      message({ id: "c2", senderId: bob.id, text: "second line" }),
      start + TROLL_COOLDOWN_MS,
    );
    expect(failed.client.sent.at(-1)?.text).toBe("@bob still talking.");
    expect(failed.llm?.calls[0]?.[1]?.content).toContain("Public posts:\n(none)");
    expect(failed.llm?.calls[0]?.[1]?.content).toContain("second line");
  });

  it("never prints an API user id, including when the model echoes one", async () => {
    const llm = new MockLlmClient(`${snowflake} washed up.`);
    const { engine, client, store } = setup(llm);
    client.addUser({ id: snowflake });
    await engine.processEvent(
      message({ id: "on", senderId: alice.id, text: `!troll ${snowflake}` }),
    );
    expect(store.getTrollTarget(groupId, snowflake)?.userId).toBe(snowflake);
    const start = 9_000_000;
    await engine.processEvent(
      message({
        id: "s1",
        senderId: snowflake,
        sender: { id: snowflake },
        text: "hello",
      }),
      start,
    );
    await engine.processEvent(
      message({
        id: "s2",
        senderId: snowflake,
        sender: { id: snowflake },
        text: "hello again",
      }),
      start + TROLL_COOLDOWN_MS,
    );
    const blob = client.sent.map((row) => row.text).join("\n");
    expect(blob).not.toContain(snowflake);
    expect(blob).not.toMatch(/\d{15,20}/);
    expect(client.sent[0]?.text).toContain("someone");
    expect(client.sent[1]?.text).toMatch(/someone/i);
    expect(client.sent[1]?.text).toMatch(/your mom/i);
    expect(client.sent[2]?.text.toLowerCase()).toContain("someone");
    expect(llm.calls[0]?.[1]?.content ?? "").not.toContain(snowflake);
  });

  it("does not quote a message that trips the age filter", async () => {
    const llm = new MockLlmClient("@bob should not be called");
    const { engine, client } = setup(llm);
    await engine.processEvent(message({ id: "on", senderId: alice.id, text: "!troll @bob" }));
    const start = 3_000_000;
    await engine.processEvent(message({ id: "b1", senderId: bob.id, text: "hello" }), start);
    await engine.processEvent(
      message({ id: "b2", senderId: bob.id, text: "that teen show was bad" }),
      start + TROLL_COOLDOWN_MS,
    );
    expect(llm.calls).toHaveLength(0);
    expect(client.sent.at(-1)?.text).toMatch(/your mom/i);
    expect(client.sent.at(-1)?.text.toLowerCase()).not.toContain("teen");
  });

  it("is listed in the default help text", () => {
    const loaded = loadDefaults("config/default.yaml");
    expect(loaded.help).toMatch(/!troll @user/);
    expect(loaded.help).toMatch(/!untroll @user/);
    expect(loaded.help).toMatch(/who is enabled/);
    expect(loaded.help).not.toMatch(/!troll off/);
  });

  it("adds a second target without clearing the first and roasts each on their own cooldown", async () => {
    const { engine, client, store } = setup();
    await engine.processEvent(message({ id: "on-bob", senderId: alice.id, text: "!troll @bob" }));
    await engine.processEvent(message({ id: "on-alice", senderId: alice.id, text: "!troll @alice" }));
    expect(store.listTrollTargets(groupId).map((row) => row.userId)).toEqual([bob.id, alice.id]);

    const start = 6_000_000;
    await engine.processEvent(message({ id: "b1", senderId: bob.id, text: "bob talks" }), start);
    await engine.processEvent(
      message({ id: "a1", senderId: alice.id, text: "alice talks" }),
      start + 1_000,
    );
    expect(client.sent.filter((row) => row.text === momJoke("@bob", () => 0))).toHaveLength(1);
    expect(client.sent.filter((row) => row.text === momJoke("@alice", () => 0))).toHaveLength(1);

    await engine.processEvent(
      message({ id: "b2", senderId: bob.id, text: "bob again" }),
      start + 2_000,
    );
    expect(client.sent.filter((row) => row.text === momJoke("@bob", () => 0))).toHaveLength(1);
    await engine.processEvent(
      message({ id: "a2", senderId: alice.id, text: "alice again" }),
      start + 1_000 + TROLL_COOLDOWN_MS,
    );
    expect(client.sent.filter((row) => row.text === momJoke("@alice", () => 0))).toHaveLength(2);

    await engine.processEvent(message({ id: "stop-bob", senderId: alice.id, text: "!untroll @bob" }));
    expect(store.listTrollTargets(groupId).map((row) => row.userId)).toEqual([alice.id]);
    expect(client.sent.at(-1)?.text).toBe("@alice Troll mode off for @bob. Enabled: @alice.");

    await engine.processEvent(message({ id: "list", senderId: alice.id, text: "!troll" }));
    expect(client.sent.at(-1)?.text).toBe("@alice Enabled: @alice.");
    expect(store.listTrollTargets(groupId).map((row) => row.userId)).toEqual([alice.id]);

    await engine.processEvent(
      message({
        id: "stop-reply",
        senderId: owner.id,
        text: "!untroll",
        replyToSenderId: alice.id,
      }),
    );
    expect(store.listTrollTargets(groupId)).toEqual([]);
    expect(client.sent.at(-1)?.text).toBe("@owner Troll mode off for @alice. Troll list is empty.");

    await engine.processEvent(message({ id: "empty", senderId: alice.id, text: "!troll" }));
    expect(client.sent.at(-1)?.text).toBe("@alice Troll list is empty.");
    await engine.processEvent(message({ id: "empty-untroll", senderId: alice.id, text: "!untroll" }));
    expect(client.sent.at(-1)?.text).toBe("@alice Troll list is empty.");
  });

  it("keeps a migrated single-target row and still accepts another person", () => {
    const file = path.join(os.tmpdir(), `x-combot-troll-migrate-${process.pid}.sqlite`);
    const legacy = new Database(file);
    legacy.exec(`
      CREATE TABLE troll_targets (
        conversation_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        username TEXT,
        last_ms INTEGER NOT NULL DEFAULT 0,
        roast_next INTEGER NOT NULL DEFAULT 0
      );
    `);
    legacy
      .prepare(
        `INSERT INTO troll_targets (conversation_id, user_id, username, last_ms, roast_next)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(groupId, bob.id, "bob", 5_000, 1);
    legacy.close();

    try {
      const store = new Store(file);
      try {
        expect(store.listTrollTargets(groupId)).toEqual([
          { userId: bob.id, username: "bob", lastMs: 5_000, roastNext: 1 },
        ]);
        store.addTrollTarget(groupId, alice.id, "alice");
        expect(store.listTrollTargets(groupId).map((row) => row.userId)).toEqual([
          bob.id,
          alice.id,
        ]);
        expect(store.getTrollTarget(groupId, bob.id)?.lastMs).toBe(5_000);
      } finally {
        store.close();
      }

      const reopened = new Store(file);
      try {
        expect(reopened.listTrollTargets(groupId).map((row) => row.userId)).toEqual([
          bob.id,
          alice.id,
        ]);
      } finally {
        reopened.close();
      }
    } finally {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    }
  });
});

describe("sanitizeTrollReply", () => {
  it("strips snowflakes and keeps the label", () => {
    const text = sanitizeTrollReply(
      `${snowflake} washed up. Second sentence stays. Third stays. Fourth is gone.`,
      "someone",
      [snowflake],
    );
    expect(text).not.toContain(snowflake);
    expect(text.toLowerCase()).toContain("someone");
    expect(text).not.toContain("Fourth");
  });
});
