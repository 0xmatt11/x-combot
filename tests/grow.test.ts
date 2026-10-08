import { afterEach, describe, expect, it } from "vitest";
import { ModerationEngine } from "../src/bot/engine.js";
import { parseCommand, parseUnknownBang } from "../src/bot/parser.js";
import {
  DEFAULT_GROW_SETTINGS,
  commandEnabled,
  loadGrowSettings,
  playDod,
  playDtop,
  playGrow,
  playLoan,
  playPvp,
  playSize,
  positiveRatioFor,
  rollDodBonusCm,
  rollGrowthCm,
  streakBonusCm,
  type GrowSettings,
} from "../src/bot/games/grow.js";
import { gamesMenu } from "../src/bot/games/menu.js";
import { loadDefaults } from "../src/config.js";
import { Store } from "../src/store.js";
import type { BotRuntimeConfig, DefaultsConfig, DmEvent, XUser } from "../src/types.js";
import { MockXClient } from "../src/x/mock-client.js";

const chat = "g-grow";
const day = (iso: string) => Date.parse(iso);
const day1 = day("2026-03-01T12:00:00.000Z");
const day2 = day("2026-03-02T12:00:00.000Z");
const day3 = day("2026-03-03T12:00:00.000Z");
const day5 = day("2026-03-05T12:00:00.000Z");
const day9 = day("2026-03-09T12:00:00.000Z");

const settings: GrowSettings = {
  ...DEFAULT_GROW_SETTINGS,
  commands: { ...DEFAULT_GROW_SETTINGS.commands },
  streakGrades: [...DEFAULT_GROW_SETTINGS.streakGrades],
};

function scripted(values: number[]): () => number {
  let index = 0;
  return () => values[index++] ?? 0;
}

function harness(): Store {
  return new Store(":memory:");
}

describe("grow rolls", () => {
  it("never rolls 0 and stays inside the gain and loss ranges", () => {
    for (let i = 0; i < 400; i += 1) {
      const rolled = rollGrowthCm(-5, 10, 0.5, Math.random);
      expect(rolled).not.toBe(0);
      expect(rolled).toBeGreaterThanOrEqual(-5);
      expect(rolled).toBeLessThanOrEqual(10);
      if (rolled > 0) expect(rolled).toBeGreaterThanOrEqual(1);
      if (rolled < 0) expect(rolled).toBeLessThanOrEqual(-1);
    }
  });

  it("uses the ratio as the chance of a gain, and grace forces a gain", () => {
    expect(rollGrowthCm(-5, 10, 0.5, scripted([0, 0]))).toBe(1);
    expect(rollGrowthCm(-5, 10, 0.5, scripted([0.5, 0]))).toBe(-5);
    expect(rollGrowthCm(-5, 10, 0, scripted([0]))).toBe(-5);
    expect(rollGrowthCm(-5, 10, 1, scripted([0.99]))).toBe(10);
    expect(positiveRatioFor(7, settings)).toBe(1);
    expect(positiveRatioFor(8, settings)).toBe(0.5);
    expect(rollDodBonusCm(5, scripted([0]))).toBe(1);
    expect(rollDodBonusCm(5, scripted([0.99]))).toBe(5);
  });

  it("adds one centimeter per streak grade reached", () => {
    expect(streakBonusCm(1, settings.streakGrades)).toBe(0);
    expect(streakBonusCm(2, settings.streakGrades)).toBe(1);
    expect(streakBonusCm(3, settings.streakGrades)).toBe(1);
    expect(streakBonusCm(4, settings.streakGrades)).toBe(2);
    expect(streakBonusCm(8, settings.streakGrades)).toBe(3);
    expect(streakBonusCm(16, settings.streakGrades)).toBe(4);
    expect(streakBonusCm(32, settings.streakGrades)).toBe(5);
    expect(streakBonusCm(100, settings.streakGrades)).toBe(5);
  });
});

describe("grow persistence", () => {
  const stores: Store[] = [];

  afterEach(() => {
    for (const store of stores) store.close();
    stores.length = 0;
  });

  function store(): Store {
    const next = harness();
    stores.push(next);
    return next;
  }

  it("locks a second grow on the same UTC day and keeps the streak across days", () => {
    const db = store();
    const first = playGrow(db, {
      conversationId: chat,
      userId: "u-alice",
      label: "@alice",
      nowMs: day1,
      rng: scripted([0]),
      settings,
    });
    expect(first.text).toContain("@alice grew 1 cm");
    expect(first.text).toContain("Size is now 1 cm");
    expect(db.getGrowSize(chat, "u-alice")).toMatchObject({ length: 1, streak: 1, streakMax: 1 });

    const locked = playGrow(db, {
      conversationId: chat,
      userId: "u-alice",
      label: "@alice",
      nowMs: day1 + 60_000,
      rng: scripted([0.99]),
      settings,
    });
    expect(locked.text).toContain("already grew today");
    expect(db.getGrowSize(chat, "u-alice")?.length).toBe(1);

    const second = playGrow(db, {
      conversationId: chat,
      userId: "u-alice",
      label: "@alice",
      nowMs: day2,
      rng: scripted([0]),
      settings,
    });
    expect(second.text).toContain("grew 2 cm");
    expect(second.text).toContain("2 days in a row");
    expect(db.getGrowSize(chat, "u-alice")).toMatchObject({ length: 3, streak: 2, streakMax: 2 });

    playGrow(db, {
      conversationId: chat,
      userId: "u-alice",
      label: "@alice",
      nowMs: day3,
      rng: scripted([0]),
      settings,
    });
    expect(db.getGrowSize(chat, "u-alice")).toMatchObject({ length: 5, streak: 3, streakMax: 3 });

    const reset = playGrow(db, {
      conversationId: chat,
      userId: "u-alice",
      label: "@alice",
      nowMs: day5,
      rng: scripted([0]),
      settings,
    });
    expect(reset.text).not.toContain("days in a row");
    expect(db.getGrowSize(chat, "u-alice")).toMatchObject({ length: 6, streak: 1, streakMax: 3 });
  });

  it("softens a loss with the streak bonus after the first week", () => {
    const db = store();
    db.saveGrowSize({
      conversationId: chat,
      userId: "u-alice",
      label: "@alice",
      length: 20,
      grownAtMs: day("2026-03-08T12:00:00.000Z"),
      firstPlayedMs: day1,
      streak: 1,
      streakMax: 1,
    });
    const shrunk = playGrow(db, {
      conversationId: chat,
      userId: "u-alice",
      label: "@alice",
      nowMs: day9,
      rng: scripted([0.5, 0]),
      settings,
    });
    expect(positiveRatioFor(8, settings)).toBe(0.5);
    expect(shrunk.text).toContain("shrank 4 cm");
    expect(shrunk.text).toContain("2 days in a row");
    expect(db.getGrowSize(chat, "u-alice")?.length).toBe(16);
  });

  it("orders !dtop by length, then recency, and hides an inactive zero", () => {
    const db = store();
    const seed = (
      userId: string,
      label: string,
      length: number,
      grownAtMs: number,
    ) => {
      db.saveGrowSize({
        conversationId: chat,
        userId,
        label,
        length,
        grownAtMs,
        firstPlayedMs: grownAtMs,
        streak: 1,
        streakMax: 1,
      });
    };
    seed("carol", "@carol", 12, day1);
    seed("alice", "@alice", 10, day2);
    seed("bob", "@bob", 10, day1);
    seed("dave", "@dave", 0, day2 - 30 * 24 * 60 * 60 * 1000);
    seed("eve", "@eve", 0, day1);
    const top = playDtop(db, { conversationId: chat, nowMs: day2, settings });
    expect(top.text).toBe(
      [
        "Biggest sizes:",
        "1. @carol — 12 cm [+]",
        "2. @alice — 10 cm",
        "3. @bob — 10 cm [+]",
        "4. @eve — 0 cm [+]",
        "[+] has not grown today. [~] has not grown for more than 7 days.",
      ].join("\n"),
    );
    expect(top.text).not.toContain("@dave");
  });

  it("picks dick of the day once per UTC day without spending the daily grow", () => {
    const db = store();
    playGrow(db, {
      conversationId: chat,
      userId: "u-alice",
      label: "@alice",
      nowMs: day1,
      rng: scripted([0]),
      settings,
    });
    const grownAt = db.getGrowSize(chat, "u-alice")?.grownAtMs;
    const first = playDod(db, { conversationId: chat, nowMs: day1, rng: scripted([0, 0]), settings });
    expect(first.text).toContain("Dick of the day: @alice. +1 cm, now 2 cm");
    expect(db.getGrowSize(chat, "u-alice")).toMatchObject({ length: 2, grownAtMs: grownAt });
    const again = playDod(db, { conversationId: chat, nowMs: day1 + 1000, rng: scripted([0, 0]), settings });
    expect(again.text).toContain("already @alice");
    expect(db.getGrowSize(chat, "u-alice")?.length).toBe(2);
    const locked = playGrow(db, {
      conversationId: chat,
      userId: "u-alice",
      label: "@alice",
      nowMs: day1 + 2000,
      settings,
    });
    expect(locked.text).toContain("already grew today");

    const next = playDod(db, { conversationId: chat, nowMs: day2, rng: scripted([0, 0.99]), settings });
    expect(next.text).toContain("+5 cm");
    expect(db.getGrowSize(chat, "u-alice")?.length).toBe(7);
  });

  it("resolves an open fight, records stats, and refuses a second open fight", () => {
    const db = store();
    const seed = (userId: string, label: string, length: number) => {
      db.saveGrowSize({
        conversationId: chat,
        userId,
        label,
        length,
        grownAtMs: day1,
        firstPlayedMs: day1,
        streak: 1,
        streakMax: 1,
      });
    };
    seed("u-alice", "@alice", 20);
    seed("u-bob", "@bob", 10);
    const open = playPvp(db, {
      conversationId: chat,
      userId: "u-alice",
      label: "@alice",
      args: "4",
      replyToChallenge: false,
      nowMs: day1,
      settings,
    });
    expect(open.trackFight).toBe(true);
    expect(open.text).toContain("@alice challenges the chat for 4 cm");
    const blocked = playPvp(db, {
      conversationId: chat,
      userId: "u-carol",
      label: "@carol",
      args: "1",
      replyToChallenge: false,
      nowMs: day1,
      settings,
    });
    expect(blocked.text).toContain("already open");

    const self = playPvp(db, {
      conversationId: chat,
      userId: "u-alice",
      label: "@alice",
      args: "accept",
      replyToChallenge: false,
      nowMs: day1,
      settings,
    });
    expect(self.text).toContain("cannot fight yourself");

    const won = playPvp(db, {
      conversationId: chat,
      userId: "u-bob",
      label: "@bob",
      args: "",
      replyToChallenge: true,
      nowMs: day1,
      rng: scripted([0]),
      settings,
    });
    expect(won.text).toContain("@alice wins the 4 cm bet");
    expect(won.text).toContain("@alice is now 24 cm. @bob is now 6 cm.");
    expect(db.getGrowFight(chat)).toBeUndefined();
    expect(db.getGrowPvpStats(chat, "u-alice")).toMatchObject({
      battles: 1,
      wins: 1,
      winStreak: 1,
      winStreakMax: 1,
      acquired: 4,
      lost: 0,
    });
    expect(db.getGrowPvpStats(chat, "u-bob")).toMatchObject({
      battles: 1,
      wins: 0,
      winStreak: 0,
      lost: 4,
    });

    playPvp(db, {
      conversationId: chat,
      userId: "u-alice",
      label: "@alice",
      args: "4",
      replyToChallenge: false,
      nowMs: day2,
      settings,
    });
    playPvp(db, {
      conversationId: chat,
      userId: "u-bob",
      label: "@bob",
      args: "accept",
      replyToChallenge: false,
      nowMs: day2,
      rng: scripted([0]),
      settings,
    });
    playPvp(db, {
      conversationId: chat,
      userId: "u-alice",
      label: "@alice",
      args: "4",
      replyToChallenge: false,
      nowMs: day3,
      settings,
    });
    const lost = playPvp(db, {
      conversationId: chat,
      userId: "u-bob",
      label: "@bob",
      args: "accept",
      replyToChallenge: false,
      nowMs: day3,
      rng: scripted([0.9]),
      settings,
    });
    expect(lost.text).toContain("@bob wins the 4 cm bet");
    expect(lost.text).toContain("@alice lost a 2-win streak");
    expect(db.getGrowPvpStats(chat, "u-alice")).toMatchObject({
      battles: 3,
      wins: 2,
      winStreak: 0,
      winStreakMax: 2,
      acquired: 8,
      lost: 4,
    });
    expect(db.getGrowPvpStats(chat, "u-bob")).toMatchObject({
      battles: 3,
      wins: 1,
      winStreak: 1,
      acquired: 4,
      lost: 8,
    });
    const mine = playSize(db, {
      conversationId: chat,
      userId: "u-alice",
      label: "@alice",
      settings,
    });
    expect(mine.text).toContain("win rate 67%");
    expect(mine.text).not.toContain("u-alice");
  });

  it("repays a loan from a positive grow and from a fight win, and adds the negative-size bonus", () => {
    const db = store();
    db.saveGrowSize({
      conversationId: chat,
      userId: "u-alice",
      label: "@alice",
      length: -100,
      grownAtMs: day1,
      firstPlayedMs: day1,
      streak: 1,
      streakMax: 1,
    });
    const ask = playLoan(db, {
      conversationId: chat,
      userId: "u-alice",
      label: "@alice",
      confirm: false,
      settings,
    });
    expect(ask.text).toContain("!loan yes");
    expect(db.getGrowSize(chat, "u-alice")?.length).toBe(-100);

    const granted = playLoan(db, {
      conversationId: chat,
      userId: "u-alice",
      label: "@alice",
      confirm: true,
      settings,
    });
    expect(granted.text).toContain("owes 100 cm");
    expect(db.getGrowSize(chat, "u-alice")?.length).toBe(0);
    expect(db.getGrowLoan(chat, "u-alice")).toBe(100);

    const paid = playGrow(db, {
      conversationId: chat,
      userId: "u-alice",
      label: "@alice",
      nowMs: day2,
      rng: scripted([0.99]),
      settings,
    });
    expect(paid.text).toContain("Loan payment: -1 cm (99 cm left).");
    expect(paid.text).toContain("2 days in a row");
    expect(db.getGrowSize(chat, "u-alice")?.length).toBe(10);
    expect(db.getGrowLoan(chat, "u-alice")).toBe(99);

    db.saveGrowSize({
      conversationId: chat,
      userId: "u-bob",
      label: "@bob",
      length: -50,
      grownAtMs: day("2026-02-01T12:00:00.000Z"),
      firstPlayedMs: day2,
      streak: 1,
      streakMax: 1,
    });
    const hole = playGrow(db, {
      conversationId: chat,
      userId: "u-bob",
      label: "@bob",
      nowMs: day2,
      rng: scripted([0.99]),
      settings,
    });
    expect(hole.text).toContain("Negative-size bonus: +1 cm.");
    expect(db.getGrowSize(chat, "u-bob")?.length).toBe(-39);

    db.saveGrowSize({
      conversationId: chat,
      userId: "u-carol",
      label: "@carol",
      length: 10,
      grownAtMs: day1,
      firstPlayedMs: day1,
      streak: 1,
      streakMax: 1,
    });
    playPvp(db, {
      conversationId: chat,
      userId: "u-alice",
      label: "@alice",
      args: "10",
      replyToChallenge: false,
      nowMs: day3,
      settings,
    });
    const fight = playPvp(db, {
      conversationId: chat,
      userId: "u-carol",
      label: "@carol",
      args: "accept",
      replyToChallenge: false,
      nowMs: day3,
      rng: scripted([0]),
      settings,
    });
    expect(fight.text).toContain("1 cm of the win paid the loan");
    expect(db.getGrowSize(chat, "u-alice")?.length).toBe(19);
    expect(db.getGrowLoan(chat, "u-alice")).toBe(98);
    expect(db.getGrowSize(chat, "u-carol")?.length).toBe(0);
  });

  it("never prints a numeric user id", () => {
    const db = store();
    const text = playGrow(db, {
      conversationId: chat,
      userId: "1712950172873809920",
      label: "1712950172873809920",
      nowMs: day1,
      rng: scripted([0]),
      settings,
    }).text;
    expect(text).toContain("someone");
    expect(text).not.toContain("1712950172873809920");
    const top = playDtop(db, { conversationId: chat, nowMs: day1, settings }).text;
    expect(top).not.toContain("1712950172873809920");
  });
});

describe("grow switches and commands", () => {
  it("treats a set DISABLE_CMD_* or DISABLE_STREAK as off", () => {
    expect(commandEnabled("grow", {})).toBe(true);
    expect(commandEnabled("dtop", { DISABLE_CMD_TOP: "false" })).toBe(false);
    expect(commandEnabled("size", { DISABLE_CMD_STATS: "1" })).toBe(false);
    const off = loadGrowSettings({ DISABLE_STREAK: "1", DISABLE_CMD_PVP: "yes" });
    expect(off.streakEnabled).toBe(false);
    expect(off.commands.pvp).toBe(false);
    expect(off.commands.grow).toBe(true);
  });

  it("parses the size commands without taking over XP or duel names", () => {
    expect(parseCommand("!grow")).toEqual({ name: "grow" });
    expect(parseCommand("/dick")).toEqual({ name: "grow" });
    expect(parseCommand("!dtop")).toEqual({ name: "dtop" });
    expect(parseCommand("!size")).toEqual({ name: "size" });
    expect(parseCommand("!dod")).toEqual({ name: "dod" });
    expect(parseCommand("!pvp 5")).toEqual({ name: "pvp", args: "5" });
    expect(parseCommand("!fight accept")).toEqual({ name: "pvp", args: "accept" });
    expect(parseCommand("!loan")).toEqual({ name: "loan", confirm: false });
    expect(parseCommand("!borrow yes")).toEqual({ name: "loan", confirm: true });
    expect(parseCommand("!top")).toEqual({ name: "top" });
    expect(parseCommand("!leaderboard")).toEqual({ name: "top" });
    expect(parseCommand("!rank")).toEqual({ name: "xp" });
    expect(parseCommand("!duel attack")).toEqual({ name: "duel", args: "attack" });
    expect(parseCommand("!hit")).toEqual({ name: "hit", args: "" });
    expect(parseUnknownBang("!grow")).toBeUndefined();
    expect(parseUnknownBang("!pvp")).toBeUndefined();
    expect(gamesMenu()).toContain("!grow — daily size (!dick)");
    expect(gamesMenu()).toContain("!dtop — size leaderboard");
    const help = loadDefaults("config/default.yaml").help;
    expect(help).toContain("!grow");
    expect(help).toContain("!dtop");
    expect(help).toContain("!dod");
    expect(help).toContain("!loan");
  });
});

describe("grow engine", () => {
  const alice: XUser = { id: "u-alice", username: "alice", name: "Alice" };
  const bob: XUser = { id: "u-bob", username: "bob", name: "Bob" };
  const groupId = "1578398451921985538";
  const stores: Store[] = [];

  const defaults: DefaultsConfig = {
    welcome: { enabled: true, text: "Welcome @{username}!" },
    rules: "Be nice.",
    help: "Type !rules",
    flood: { max_messages: 30, window_ms: 10_000, mute_ms: 60_000, warn_on_flood: true },
    warns: { limit: 3, auto_mute_ms: 60_000, notify_admins: true },
    filters: [],
    poll: { interval_ms: 1000, max_results: 50 },
    delete: { attempt_on_filter: true, attempt_on_flood: true, attempt_on_mute: true },
  };

  afterEach(() => {
    for (const store of stores) store.close();
    stores.length = 0;
  });

  function setup() {
    const db = new Store(":memory:");
    stores.push(db);
    const client = new MockXClient();
    client.addUser(alice);
    client.addUser(bob);
    const config: BotRuntimeConfig = {
      botUserId: "bot-1",
      ownerId: "u-owner",
      globalAdminIds: [],
      defaults,
    };
    const engine = new ModerationEngine(db, client, config, undefined, {
      random: scripted([0, 0, 0.9]),
      commandCleanupMs: 60_000,
    });
    return { engine, client, db };
  }

  function message(partial: Partial<DmEvent> & Pick<DmEvent, "id" | "senderId" | "text">): DmEvent {
    const sender = partial.senderId === bob.id ? bob : alice;
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

  it("keeps !top as the XP board and accepts a fight by reply", async () => {
    const { engine, client, db } = setup();
    const now = day1;
    await engine.processEvent(message({ id: "g1", senderId: alice.id, text: "!grow" }), now);
    await engine.processEvent(message({ id: "g2", senderId: bob.id, text: "!dick" }), now);
    await engine.processEvent(message({ id: "top", senderId: alice.id, text: "!top" }), now);
    expect(client.sent.at(-1)?.text).toContain("No XP yet");
    await engine.processEvent(message({ id: "dtop", senderId: alice.id, text: "!dtop" }), now);
    expect(client.sent.at(-1)?.text).toContain("Biggest sizes:");
    expect(client.sent.at(-1)?.text).not.toContain(alice.id);

    await engine.processEvent(message({ id: "p1", senderId: alice.id, text: "!pvp 1" }), now);
    const fight = db.getGrowFight(groupId);
    expect(fight?.messageId).toBeTruthy();
    await engine.processEvent(
      message({
        id: "p2",
        senderId: bob.id,
        text: "!pvp",
        replyToSenderId: "bot-1",
        replyTo: { senderId: "bot-1", eventId: fight?.messageId ?? undefined, verified: true },
      }),
      now,
    );
    expect(client.sent.at(-1)?.text).toContain("wins the 1 cm bet");
    expect(db.getGrowFight(groupId)).toBeUndefined();
    expect(db.getGrowPvpStats(groupId, "u-alice").battles).toBe(1);
    expect(db.getGrowPvpStats(groupId, "u-bob").battles).toBe(1);
  });
});
