import { afterEach, describe, expect, it } from "vitest";
import { ModerationEngine } from "../src/bot/engine.js";
import { DEFAULT_XP_CONFIG } from "../src/config.js";
import { loadDefaults } from "../src/config.js";
import { Store } from "../src/store.js";
import type { BotRuntimeConfig, DefaultsConfig, DmEvent, XpConfig, XUser } from "../src/types.js";
import { MockXClient } from "../src/x/mock-client.js";

const alice: XUser = { id: "u-alice", username: "alice", name: "Alice" };
const bob: XUser = { id: "u-bob", username: "bob", name: "Bob" };
const owner: XUser = { id: "u-owner", username: "owner", name: "Owner" };
const groupId = "1578398451921985538";

const defaults: DefaultsConfig = {
  welcome: { enabled: true, text: "Welcome @{username}!" },
  rules: "Be nice.",
  help: "Type !rules",
  flood: { max_messages: 5, window_ms: 10_000, mute_ms: 60_000, warn_on_flood: true },
  warns: { limit: 3, auto_mute_ms: 60_000, notify_admins: true },
  filters: [{ type: "keyword", pattern: "spamlink", case_insensitive: true, warn: true }],
  poll: { interval_ms: 1000, max_results: 50 },
  delete: { attempt_on_filter: true, attempt_on_flood: true, attempt_on_mute: true },
};

function runtime(xp?: Partial<XpConfig>): BotRuntimeConfig {
  return {
    botUserId: "bot-1",
    ownerId: owner.id,
    globalAdminIds: [],
    defaults: {
      ...defaults,
      xp: { ...DEFAULT_XP_CONFIG, cooldown_ms: 60_000, ...xp },
    },
  };
}

function message(partial: Partial<DmEvent> & Pick<DmEvent, "id" | "senderId">): DmEvent {
  const sender =
    partial.sender ??
    [alice, bob, owner].find((user) => user.id === partial.senderId);
  return {
    eventType: "MessageCreate",
    conversationId: groupId,
    participantIds: [],
    participants: [],
    mentions: [],
    text: partial.text,
    sender,
    ...partial,
  };
}

describe("XP engine", () => {
  const stores: Store[] = [];

  afterEach(() => {
    for (const store of stores) store.close();
    stores.length = 0;
  });

  function setup(xp?: Partial<XpConfig>) {
    const store = new Store(":memory:");
    stores.push(store);
    const client = new MockXClient();
    client.addUser(alice);
    client.addUser(bob);
    client.addUser(owner);
    const engine = new ModerationEngine(store, client, runtime(xp));
    return { engine, client, store };
  }

  it("awards message XP, cools down, and announces the final level once", async () => {
    const { engine, client, store } = setup({ xp_per_message: 1000, cooldown_ms: 60_000 });
    const now = 1_000_000;
    const first = await engine.processEvent(
      message({ id: "a1", senderId: alice.id, text: "hello" }),
      now,
    );
    expect(first.replies).toEqual(["@alice leveled up to level 4!"]);
    expect(store.getUserXp(groupId, alice.id).xp).toBe(1000);

    await engine.processEvent(
      message({ id: "a2", senderId: alice.id, text: "again" }),
      now + 1,
    );
    expect(store.getUserXp(groupId, alice.id).xp).toBe(1000);
    expect(client.sent).toHaveLength(1);

    await engine.processEvent(
      message({ id: "a3", senderId: alice.id, text: "later" }),
      now + 60_000,
    );
    expect(store.getUserXp(groupId, alice.id).xp).toBe(2000);
  });

  it("does not award XP for commands, the bot, filters, or bare + / -", async () => {
    const { engine, store } = setup({ xp_per_message: 50, cooldown_ms: 0 });
    await engine.processEvent(message({ id: "c1", senderId: alice.id, text: "!help" }));
    await engine.processEvent(message({ id: "c2", senderId: alice.id, text: "/rules" }));
    await engine.processEvent(message({ id: "c3", senderId: "bot-1", text: "hello" }));
    await engine.processEvent(message({ id: "c4", senderId: alice.id, text: "+" }));
    await engine.processEvent(message({ id: "c5", senderId: alice.id, text: "buy spamlink" }));
    expect(store.getUserXp(groupId, alice.id).xp).toBe(0);
    expect(store.getUserXp(groupId, "bot-1").xp).toBe(0);
  });

  it("gives one level on a verified + reply and rejects self, missing targets, and cooldown", async () => {
    const { engine, client, store } = setup({ level_grant_cooldown_ms: 60_000 });
    const now = 5_000_000;

    await engine.processEvent(
      message({
        id: "plus-1",
        senderId: alice.id,
        text: "+",
        replyTo: { senderId: bob.id, verified: true },
      }),
      now,
    );
    expect(client.sent.at(-1)?.text).toBe("@alice gave @bob a level! (now level 1)");
    expect(store.getUserXp(groupId, bob.id)).toMatchObject({ xp: 100, username: "bob" });

    await engine.processEvent(
      message({
        id: "plus-2",
        senderId: alice.id,
        text: " + ",
        replyTo: { senderId: bob.id, verified: true },
      }),
      now + 10,
    );
    expect(client.sent.at(-1)?.text).toMatch(/Try again in 1 min/);
    expect(store.getUserXp(groupId, bob.id).xp).toBe(100);

    await engine.processEvent(
      message({
        id: "self",
        senderId: alice.id,
        text: "+",
        replyTo: { senderId: alice.id, verified: true },
      }),
      now,
    );
    expect(client.sent.at(-1)?.text).toMatch(/own level/);
    expect(store.getUserXp(groupId, alice.id).xp).toBe(0);

    const bare = await engine.processEvent(
      message({ id: "bare", senderId: alice.id, text: "+" }),
      now,
    );
    expect(bare.replies).toEqual([]);

    const spoof = await engine.processEvent(
      message({
        id: "spoof",
        senderId: alice.id,
        text: "-",
        replyTo: { senderId: owner.id, verified: false },
      }),
      now,
    );
    expect(spoof.replies[0]).toMatch(/Couldn't tell who/);
    expect(store.getUserXp(groupId, owner.id).xp).toBe(0);
  });

  it("uses the indexed author instead of an unverified preview, then removes a level down to 0", async () => {
    const { engine, client, store } = setup({ level_grant_cooldown_ms: 0, xp_per_message: 0 });
    await engine.processEvent(
      message({ id: "bob-msg", senderId: bob.id, text: "hey", sequenceId: "55" }),
    );
    await engine.processEvent(
      message({
        id: "plus",
        senderId: alice.id,
        text: "+",
        replyTo: { sequenceId: "55", senderId: owner.id, verified: false },
      }),
    );
    expect(client.sent.at(-1)?.text).toBe("@alice gave @bob a level! (now level 1)");
    expect(store.getUserXp(groupId, owner.id).xp).toBe(0);

    await engine.processEvent(
      message({
        id: "minus",
        senderId: alice.id,
        text: "-",
        replyTo: { sequenceId: "55", verified: false },
      }),
    );
    expect(client.sent.at(-1)?.text).toBe("@alice removed a level from @bob (now level 0)");
    expect(store.getUserXp(groupId, bob.id).xp).toBe(0);

    await engine.processEvent(
      message({
        id: "minus-floor",
        senderId: alice.id,
        text: "-",
        replyTo: { senderId: bob.id, verified: true },
      }),
    );
    expect(client.sent.at(-1)?.text).toBe("@alice @bob is already level 0.");
  });

  it("blocks a muted member from granting a level", async () => {
    const { engine, client, store } = setup();
    store.mute(groupId, alice.id, Date.now() + 60_000, "test");
    await engine.processEvent(
      message({
        id: "muted-plus",
        senderId: alice.id,
        text: "+",
        replyTo: { senderId: bob.id, verified: true },
      }),
    );
    expect(store.getUserXp(groupId, bob.id).xp).toBe(0);
    expect(client.sent.some((row) => /gave/.test(row.text))).toBe(false);
  });

  it("answers !xp, !level, !rank, and !top", async () => {
    const { engine, client, store } = setup({
      xp_per_message: 100,
      cooldown_ms: 0,
      leaderboard_size: 10,
    });
    await engine.processEvent(message({ id: "m-alice", senderId: alice.id, text: "hi" }));
    await engine.processEvent(message({ id: "m-bob", senderId: bob.id, text: "yo" }));
    await engine.processEvent(
      message({
        id: "boost",
        senderId: owner.id,
        text: "+",
        replyTo: { senderId: bob.id, verified: true },
      }),
    );

    await engine.processEvent(message({ id: "rank-self", senderId: alice.id, text: "!xp" }));
    expect(client.sent.at(-1)?.text).toBe(
      "@alice — level 1, 100 XP (rank 2). Next level at 235 XP.",
    );

    await engine.processEvent(
      message({
        id: "rank-bob",
        senderId: alice.id,
        text: "/level @bob",
        mentions: [{ username: "bob", id: bob.id }],
      }),
    );
    expect(client.sent.at(-1)?.text).toMatch(/@bob — level 2, 235 XP \(rank 1\)/);

    await engine.processEvent(message({ id: "top", senderId: alice.id, text: "!toplvl" }));
    expect(client.sent.at(-1)?.text).toBe(
      "@alice Top levels:\n1. @bob — level 2 (235 XP)\n2. @alice — level 1 (100 XP)",
    );
    expect(store.xpRank(groupId, owner.id)).toBeUndefined();
  });

  it("awards reaction XP on its own cooldown and can be switched off", async () => {
    const { engine, store } = setup({
      xp_per_message: 10,
      xp_per_reaction: 5,
      cooldown_ms: 60_000,
    });
    const now = 50_000;
    await engine.processEvent(
      message({ id: "msg", senderId: alice.id, text: "hi" }),
      now,
    );
    await engine.processEvent(
      message({
        id: "react",
        senderId: alice.id,
        eventType: "ReactionAdd",
        reactionTargetSequenceId: "1",
      }),
      now,
    );
    expect(store.getUserXp(groupId, alice.id).xp).toBe(15);

    await engine.processEvent(
      message({
        id: "react-2",
        senderId: alice.id,
        eventType: "ReactionAdd",
      }),
      now + 1,
    );
    expect(store.getUserXp(groupId, alice.id).xp).toBe(15);

    const off = setup({ reactions_enabled: false, xp_per_reaction: 5 });
    await off.engine.processEvent(
      message({
        id: "react-off",
        senderId: alice.id,
        eventType: "ReactionAdd",
      }),
    );
    expect(off.store.getUserXp(groupId, alice.id).xp).toBe(0);
  });

  it("turns XP off per conversation", async () => {
    const { engine, client, store } = setup({ xp_per_message: 100 });
    await engine.processEvent(
      message({ id: "set", senderId: owner.id, text: "!set xp_enabled off" }),
    );
    await engine.processEvent(message({ id: "chat", senderId: alice.id, text: "hello" }));
    await engine.processEvent(
      message({
        id: "plus",
        senderId: alice.id,
        text: "+",
        replyTo: { senderId: bob.id, verified: true },
      }),
    );
    await engine.processEvent(message({ id: "ask", senderId: alice.id, text: "!rank" }));
    expect(store.getUserXp(groupId, alice.id).xp).toBe(0);
    expect(store.getUserXp(groupId, bob.id).xp).toBe(0);
    expect(client.sent.at(-1)?.text).toMatch(/XP is off/);
  });

  it("names a Chat giver by @handle when the event only has a numeric sender id", async () => {
    const giverId = "1712950172873809920";
    const { engine, client, store } = setup();
    client.addUser({ id: giverId, username: "matt", name: "Matt" });
    await engine.processEvent(
      message({
        id: "plus-snow",
        senderId: giverId,
        sender: undefined,
        text: "+",
        replyTo: { senderId: bob.id, verified: true },
      }),
    );
    const text = client.sent.at(-1)?.text ?? "";
    expect(text).toBe("@matt gave @bob a level! (now level 1)");
    expect(text).not.toContain(giverId);
    expect(store.getUserXp(groupId, bob.id)).toMatchObject({ xp: 100, username: "bob" });
  });

  it("uses a display name, then someone, when a level giver has no @handle", async () => {
    const namedId = "1712950172873809920";
    const unknownId = "1712950172873809921";
    const { engine, client } = setup({ level_grant_cooldown_ms: 0 });
    client.addUser({ id: namedId, name: "Ada" });
    await engine.processEvent(
      message({
        id: "plus-name",
        senderId: namedId,
        sender: undefined,
        text: "+",
        replyTo: { senderId: bob.id, verified: true },
      }),
    );
    await engine.processEvent(
      message({
        id: "plus-unknown",
        senderId: unknownId,
        sender: undefined,
        text: "+",
        replyTo: { senderId: alice.id, verified: true },
      }),
    );
    expect(client.sent.map((row) => row.text)).toEqual([
      "Ada gave @bob a level! (now level 1)",
      "someone gave @alice a level! (now level 1)",
    ]);
    expect(client.sent.some((row) => row.text.includes(namedId) || row.text.includes(unknownId))).toBe(
      false,
    );
  });

  it("announces a level up without printing the numeric sender id", async () => {
    const senderId = "1712950172873809920";
    const { engine, client, store } = setup({ xp_per_message: 100, cooldown_ms: 0 });
    client.addUser({ id: senderId, username: "ape7458", name: "Jack Nefty" });
    await engine.processEvent(
      message({ id: "lvl", senderId, sender: undefined, text: "hello" }),
    );
    expect(client.sent.at(-1)?.text).toBe("@ape7458 leveled up to level 1!");
    expect(client.sent.some((row) => row.text.includes(senderId))).toBe(false);
    expect(store.getUserXp(groupId, senderId)).toMatchObject({ xp: 100, username: "ape7458" });
  });

  it("keeps a stored @handle on the leaderboard when the profile lookup fails", async () => {
    const senderId = "1712950172873809920";
    const { engine, client } = setup({ xp_per_message: 100, cooldown_ms: 0, leaderboard_size: 10 });
    client.addUser({ id: senderId, username: "ape7458" });
    await engine.processEvent(
      message({ id: "lvl", senderId, sender: undefined, text: "hello" }),
    );
    client.getUserById = async () => {
      throw new Error("rate limited");
    };
    await engine.processEvent(
      message({ id: "top", senderId: alice.id, text: "!top" }),
    );
    expect(client.sent.at(-1)?.text).toBe("@alice Top levels:\n1. @ape7458 — level 1 (100 XP)");
    expect(client.sent.at(-1)?.text).not.toContain(senderId);
  });

  it("mentions !xp in the default help text and loads the xp block", () => {
    const loaded = loadDefaults("config/default.yaml");
    expect(loaded.help).toMatch(/!xp/);
    expect(loaded.help).toMatch(/!top/);
    expect(loaded.xp?.enabled).toBe(true);
    expect(loaded.xp?.xp_per_message).toBe(10);
    expect(loaded.xp?.level_grant_cooldown_ms).toBe(3_600_000);
  });
});
