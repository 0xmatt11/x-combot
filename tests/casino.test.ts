import { afterEach, describe, expect, it, vi } from "vitest";
import { ModerationEngine } from "../src/bot/engine.js";
import {
  BLACKJACK_HELP,
  CRASH_HELP,
  DEFAULT_BET,
  FUN_START,
  POKER_HELP,
  ROULETTE_HELP,
  SESSION_TTL_MS,
  SLOTS_HELP,
  TRIVIA_HELP,
  TRIVIA_QUESTIONS,
  blackjackTotal,
  evaluateFive,
  flyingCents,
  playBlackjack,
  playCasino,
  playCrash,
  playPoker,
  playRoulette,
  playSlots,
  playTrivia,
  rollCrashCents,
  rouletteColor,
  CasinoTable,
  SessionMap,
} from "../src/bot/games/index.js";
import type { Card } from "../src/bot/games/cards.js";
import { TriviaBook } from "../src/bot/games/trivia.js";
import type { CasinoContext } from "../src/bot/games/stake.js";
import { loadDefaults } from "../src/config.js";
import { DEFAULT_XP_CONFIG } from "../src/config.js";
import { MockLlmClient } from "../src/llm/mock.js";
import { Store } from "../src/store.js";
import type { BotRuntimeConfig, DefaultsConfig, DmEvent, XUser } from "../src/types.js";
import { MockXClient } from "../src/x/mock-client.js";

const alice: XUser = { id: "u-alice", username: "alice", name: "Alice" };
const owner: XUser = { id: "u-owner", username: "owner", name: "Owner" };
const groupId = "1578398451921985538";
const snowflake = "1712950172873809920";

const defaults: DefaultsConfig = {
  welcome: { enabled: true, text: "Welcome @{username}!" },
  rules: "Be nice.",
  help: "Type !rules",
  flood: { max_messages: 8, window_ms: 10_000, mute_ms: 60_000, warn_on_flood: true },
  warns: { limit: 2, auto_mute_ms: 60_000, notify_admins: true },
  filters: [],
  poll: { interval_ms: 1000, max_results: 50 },
  delete: { attempt_on_filter: true, attempt_on_flood: true, attempt_on_mute: true },
};

function card(rank: number, suit: number): Card {
  return { rank, suit };
}

function sequence(values: number[]): () => number {
  let index = 0;
  return () => values[index++] ?? values[values.length - 1] ?? 0;
}

function wallet(start = 0, enabled = true): { xp: CasinoContext["xp"]; balance: () => number } {
  let balance = start;
  return {
    balance: () => balance,
    xp: {
      enabled,
      get: () => balance,
      set: (next) => {
        balance = next;
      },
    },
  };
}

function context(
  xp: CasinoContext["xp"],
  partial: Partial<CasinoContext> = {},
): CasinoContext {
  return {
    conversationId: groupId,
    userId: alice.id,
    label: "@alice",
    nowMs: 0,
    rng: () => 0,
    xp,
    ...partial,
  };
}

describe("card totals", () => {
  it("scores soft and hard blackjack hands", () => {
    expect(blackjackTotal([card(0, 0), card(5, 1)])).toEqual({ total: 17, soft: true });
    expect(blackjackTotal([card(0, 0), card(5, 1), card(9, 2)])).toEqual({ total: 17, soft: false });
    expect(blackjackTotal([card(12, 0), card(12, 1)])).toEqual({ total: 20, soft: false });
    expect(blackjackTotal([card(9, 0), card(9, 1), card(9, 2)]).total).toBe(30);
  });

  it("ranks five-card poker hands", () => {
    const royal = evaluateFive([card(0, 0), card(12, 0), card(11, 0), card(10, 0), card(9, 0)]);
    expect(royal.name).toBe("a royal flush");
    const wheel = evaluateFive([card(0, 1), card(1, 1), card(2, 1), card(3, 1), card(4, 1)]);
    expect(wheel.name).toBe("a straight flush");
    expect(wheel.tiebreak).toEqual([5]);
    const house = evaluateFive([card(12, 0), card(12, 1), card(12, 2), card(1, 0), card(1, 1)]);
    expect(house.name).toBe("a full house");
    const pair = evaluateFive([card(0, 0), card(0, 1), card(12, 2), card(6, 3), card(1, 0)]);
    expect(pair.name).toBe("a pair");
  });
});

describe("sessions", () => {
  it("expires a row once and drops the oldest past the cap", () => {
    const map = new SessionMap<string>(1_000, 2);
    map.set("a", "1", 0);
    map.set("b", "2", 1);
    map.set("c", "3", 2);
    map.sweep(2);
    expect(map.size).toBe(2);
    expect(map.take("a", 2).status).toBe("missing");
    expect(map.take("c", 2).status).toBe("live");

    const timed = new SessionMap<string>(1_000, 10);
    timed.set("hand", "open", 0);
    expect(timed.take("hand", 1_000).status).toBe("live");
    expect(timed.take("hand", 1_001).status).toBe("expired");
    expect(timed.take("hand", 1_002).status).toBe("missing");
  });
});

describe("!slots", () => {
  it("pays three cherries and a pair, and loses a mismatch", () => {
    const table = new CasinoTable();
    const bank = wallet();
    const three = playSlots(table.fun, context(bank.xp, { rng: () => 0 }), "");
    expect(three).toContain("🍒 | 🍒 | 🍒");
    expect(three).toContain("4×");
    expect(three).toContain(`Fun chips ${FUN_START} → 130`);
    expect(bank.balance()).toBe(0);

    const mismatched = playSlots(
      table.fun,
      context(bank.xp, { rng: sequence([0, 0.4, 0.8]) }),
      "10",
    );
    expect(mismatched).toContain("No match.");
    expect(mismatched).toContain("Fun chips 130 → 120");

    const pair = playSlots(table.fun, context(bank.xp, { rng: sequence([0, 0, 0.4]) }), "10");
    expect(pair).toContain("Pair of cherries — push.");
    expect(pair).toContain("Fun chips 120 → 120");
  });

  it("refuses an XP bet the wallet cannot cover and never goes negative", () => {
    const table = new CasinoTable();
    const bank = wallet(4);
    const reply = playSlots(table.fun, context(bank.xp), "xp 10");
    expect(reply).toContain("Not enough XP");
    expect(reply).toContain("4 XP");
    expect(bank.balance()).toBe(4);

    const lost = playSlots(
      table.fun,
      context(wallet(50).xp, { rng: sequence([0, 0.4, 0.8]) }),
      "xp 50",
    );
    expect(lost).toContain("XP 50 → 0");
    expect(lost).not.toContain("→ -");
  });

  it("pays an XP win and announces a level when the balance crosses one", () => {
    const table = new CasinoTable();
    const bank = wallet(90);
    const reply = playSlots(table.fun, context(bank.xp, { rng: () => 0 }), "xp 10");
    expect(reply).toContain("XP 90 → 120");
    expect(reply).toContain("@alice leveled up to level 1!");
    expect(bank.balance()).toBe(120);
  });

  it("refills an empty fun-chip purse and refuses XP bets when XP is off", () => {
    const table = new CasinoTable();
    const off = wallet(20, false);
    expect(playSlots(table.fun, context(off.xp), "xp 10")).toContain("XP bets are off");
    expect(off.balance()).toBe(20);

    const broke = new CasinoTable();
    const chips = wallet();
    playSlots(broke.fun, context(chips.xp, { rng: sequence([0, 0.4, 0.8]) }), "100");
    const refilled = playSlots(broke.fun, context(chips.xp, { rng: () => 0 }), "");
    expect(refilled).toContain(`refilled to ${FUN_START}`);
    expect(refilled).toContain("Fun chips 100 → 130");
  });

  it("rejects a bad stake with the usage line", () => {
    const table = new CasinoTable();
    expect(playSlots(table.fun, context(wallet().xp), "please")).toBe(SLOTS_HELP);
    expect(playSlots(table.fun, context(wallet().xp), "0")).toBe(SLOTS_HELP);
    expect(playSlots(table.fun, context(wallet().xp), "101")).toBe(SLOTS_HELP);
    expect(DEFAULT_BET).toBe(10);
  });
});

describe("!blackjack", () => {
  const natural = [
    card(0, 0),
    card(8, 1),
    card(12, 2),
    card(7, 3),
  ];

  it("pays a natural 3:2 and stands the dealer on soft 17", () => {
    const table = new CasinoTable();
    const bank = wallet();
    const dealt = playBlackjack(table.blackjack, table.fun, context(bank.xp), "", natural);
    expect(dealt).toContain("blackjack");
    expect(dealt).toContain("3:2");
    expect(dealt).toContain("Fun chips 100 → 115");
    expect(dealt).not.toContain("??");

    const soft = [
      card(0, 0),
      card(0, 1),
      card(5, 2),
      card(5, 3),
      card(12, 0),
    ];
    const opened = playBlackjack(table.blackjack, table.fun, context(bank.xp), "", soft);
    expect(opened).toContain("soft 17");
    expect(opened).toContain("??");
    const stood = playBlackjack(table.blackjack, table.fun, context(bank.xp), "stand");
    expect(stood).toContain("soft 17");
    expect(stood).not.toContain("K♠");
    expect(stood).toContain("Push.");
    expect(stood).toContain("Fun chips 115 → 115");
  });

  it("hits, busts, and expires the bet", () => {
    const table = new CasinoTable();
    const bank = wallet();
    const ctx = context(bank.xp);
    const deck = [card(9, 0), card(4, 1), card(5, 2), card(4, 3), card(12, 0)];
    const opened = playBlackjack(table.blackjack, table.fun, ctx, "", deck);
    expect(opened).toContain("!blackjack hit");
    expect(opened).toContain("Fun chips 100 → 90");
    const busted = playBlackjack(table.blackjack, table.fun, ctx, "hit");
    expect(busted).toContain("busts");
    expect(busted).toContain("Fun chips 100 → 90");
    expect(playBlackjack(table.blackjack, table.fun, ctx, "hit")).toContain("No blackjack hand");

    const again = [card(9, 0), card(9, 1), card(1, 2), card(6, 3), card(4, 0)];
    playBlackjack(table.blackjack, table.fun, ctx, "", again);
    const expired = playBlackjack(
      table.blackjack,
      table.fun,
      context(bank.xp, { nowMs: SESSION_TTL_MS + 1 }),
      "hit",
    );
    expect(expired).toContain("expired");
    expect(expired).toContain("10 fun chips");
    expect(playBlackjack(table.blackjack, table.fun, context(bank.xp), "help")).toBe(BLACKJACK_HELP);
  });

  it("keeps two players on separate hands", () => {
    const table = new CasinoTable();
    const bank = wallet();
    const deck = [card(9, 0), card(4, 1), card(5, 2), card(4, 3), card(4, 0)];
    playBlackjack(table.blackjack, table.fun, context(bank.xp), "", deck);
    const other = playBlackjack(
      table.blackjack,
      table.fun,
      context(bank.xp, { userId: "u-bob", label: "@bob" }),
      "hit",
    );
    expect(other).toContain("No blackjack hand");
  });
});

describe("!poker", () => {
  const aces = [
    card(0, 0),
    card(0, 1),
    card(12, 2),
    card(6, 3),
    card(1, 0),
    card(2, 1),
    card(3, 2),
    card(4, 3),
    card(5, 0),
    card(8, 1),
    card(0, 2),
  ];

  it("shows down a pair against the bot and draws once", () => {
    const table = new CasinoTable();
    const bank = wallet();
    const ctx = context(bank.xp);
    const dealt = playPoker(table.poker, table.fun, ctx, "", aces);
    expect(dealt).toContain("1 A♠");
    expect(dealt).toContain("One draw");
    expect(dealt).toContain("Fun chips 100 → 90");
    expect(playPoker(table.poker, table.fun, ctx, "draw 1 2 3 4")).toBe(POKER_HELP);
    const won = playPoker(table.poker, table.fun, ctx, "stand");
    expect(won).toContain("a pair");
    expect(won).toContain("@alice wins.");
    expect(won).toContain("Fun chips 100 → 110");
  });

  it("replaces up to three cards and names a snowflake as someone", () => {
    const table = new CasinoTable();
    const bank = wallet();
    const ctx = context(bank.xp, { label: snowflake, userId: snowflake });
    playPoker(table.poker, table.fun, ctx, "10", aces);
    const drawn = playPoker(table.poker, table.fun, ctx, "draw 5");
    expect(drawn).toContain("Drew 5.");
    expect(drawn).toContain("three of a kind");
    expect(drawn).toContain("someone wins.");
    expect(drawn).not.toContain(snowflake);
  });
});

describe("!roulette", () => {
  it("pays color 1:1 and a number 35:1", () => {
    expect(rouletteColor(0)).toBe("green");
    let red = 0;
    let black = 0;
    for (let n = 1; n <= 36; n += 1) {
      if (rouletteColor(n) === "red") red += 1;
      else black += 1;
    }
    expect(red).toBe(18);
    expect(black).toBe(18);

    const table = new CasinoTable();
    const bank = wallet();
    const lost = playRoulette(table.fun, context(bank.xp, { rng: () => 0 }), "red");
    expect(lost).toContain("🟢 0 green");
    expect(lost).toContain("No win.");
    expect(lost).toContain("Fun chips 100 → 90");

    const numbered = playRoulette(table.fun, context(bank.xp, { rng: () => 0 }), "0 10");
    expect(numbered).toContain("35:1");
    expect(numbered).toContain("Fun chips 90 → 440");

    const color = playRoulette(table.fun, context(bank.xp, { rng: () => 2 / 37 }), "black");
    expect(color).toContain("⚫ 2 black");
    expect(color).toContain("@alice wins.");
    expect(playRoulette(table.fun, context(bank.xp), "even")).toBe(ROULETTE_HELP);
  });
});

describe("!crash", () => {
  it("cashes out below the crash point and busts after it", () => {
    expect(rollCrashCents(() => 0.1)).toBe(970);
    expect(flyingCents(8_000)).toBe(271);
    expect(rollCrashCents(() => 0.99)).toBe(100);

    const table = new CasinoTable();
    const bank = wallet();
    const ctx = context(bank.xp, { rng: () => 0.1 });
    const launched = playCrash(table.crash, table.fun, ctx, "");
    expect(launched).toContain("flying");
    expect(launched).not.toContain("9.70");
    expect(launched).toContain("Fun chips 100 → 90");
    const cashed = playCrash(
      table.crash,
      table.fun,
      context(bank.xp, { nowMs: 8_000 }),
      "out",
    );
    expect(cashed).toContain("2.71×");
    expect(cashed).toContain("9.70×");
    expect(cashed).toContain("Fun chips 100 → 117");

    const bust = playCrash(table.crash, table.fun, context(bank.xp, { rng: () => 0.99 }), "auto 2");
    expect(bust).toContain("crashed at 1.00×");
    expect(bust).toContain("Fun chips 117 → 107");
    expect(playCrash(table.crash, table.fun, context(bank.xp), "auto 1")).toBe(CRASH_HELP);
  });

  it("drops an expired round and the bet", () => {
    const table = new CasinoTable();
    const bank = wallet(10);
    playCrash(table.crash, table.fun, context(bank.xp, { rng: () => 0.1 }), "xp 10");
    expect(bank.balance()).toBe(0);
    const expired = playCrash(
      table.crash,
      table.fun,
      context(bank.xp, { nowMs: SESSION_TTL_MS + 5 }),
      "out",
    );
    expect(expired).toContain("expired");
    expect(bank.balance()).toBe(0);
  });
});

describe("!trivia", () => {
  it("asks, scores an answer, and does not repeat the open question", () => {
    const sessions = new CasinoTable().trivia;
    const book = new TriviaBook();
    const bank = wallet();
    const ctx = context(bank.xp, { rng: () => 0 });
    const asked = playTrivia(sessions, book, ctx, "");
    expect(asked).toContain(TRIVIA_QUESTIONS[0]!.prompt);
    expect(asked).toContain("a)");
    expect(asked).not.toContain(alice.id);
    const right = playTrivia(sessions, book, ctx, "b");
    expect(right).toContain("correct");
    expect(right).toContain("1 right, 0 wrong");
    expect(playTrivia(sessions, book, ctx, "b")).toContain("No trivia question");
    const next = playTrivia(sessions, book, ctx, "");
    expect(next).toContain(TRIVIA_QUESTIONS[1]!.prompt);
    const wrong = playTrivia(sessions, book, ctx, "a");
    expect(wrong).toContain("nope");
    expect(wrong).toContain("1 right, 1 wrong");
    const score = playTrivia(sessions, book, context(bank.xp, { label: snowflake }), "score");
    expect(score).toContain("someone");
    expect(score).not.toContain(snowflake);
    expect(playTrivia(sessions, book, ctx, "maybe")).toBe(TRIVIA_HELP);
  });

  it("lets anyone in the chat answer the open question", () => {
    const sessions = new CasinoTable().trivia;
    const book = new TriviaBook();
    const bank = wallet();
    const asker = context(bank.xp, { userId: "u-alice", label: "@alice", rng: () => 0 });
    const other = context(bank.xp, {
      userId: "u-bob",
      label: "@bob",
      rng: () => 0,
    });
    const asked = playTrivia(sessions, book, asker, "");
    expect(asked).toContain("❓ @alice");
    const reprint = playTrivia(sessions, book, other, "");
    expect(reprint).toContain(TRIVIA_QUESTIONS[0]!.prompt);
    expect(reprint).toContain("❓ @alice");
    const answered = playTrivia(sessions, book, other, "b");
    expect(answered).toContain("@bob — correct.");
    expect(answered).toContain("@bob: 1 right, 0 wrong.");
    expect(playTrivia(sessions, book, asker, "score")).toContain("@alice: 0 right, 0 wrong.");
    expect(playTrivia(sessions, book, other, "score")).toContain("@bob: 1 right, 0 wrong.");
  });
});

describe("casino commands", () => {
  const stores: Store[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const store of stores) store.close();
    stores.length = 0;
  });

  function setup(options?: { llm?: MockLlmClient; xpEnabled?: boolean }): {
    engine: ModerationEngine;
    client: MockXClient;
    store: Store;
    llm?: MockLlmClient;
  } {
    const store = new Store(":memory:");
    stores.push(store);
    const client = new MockXClient();
    client.addUser(alice);
    client.addUser(owner);
    const config: BotRuntimeConfig = {
      botUserId: "bot-1",
      ownerId: owner.id,
      globalAdminIds: [],
      defaults: {
        ...defaults,
        xp: { ...DEFAULT_XP_CONFIG, enabled: options?.xpEnabled ?? true },
      },
    };
    const engine = new ModerationEngine(store, client, config, options?.llm);
    return { engine, client, store, llm: options?.llm };
  }

  function message(partial: Partial<DmEvent> & Pick<DmEvent, "id" | "senderId" | "text">): DmEvent {
    const sender = partial.sender ?? (partial.senderId === owner.id ? owner : alice);
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

  it("plays blackjack instead of asking the LLM", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const llm = new MockLlmClient("feature not found");
    const { engine, client } = setup({ llm });
    await engine.processEvent(message({ id: "bj1", senderId: alice.id, text: "!blackjack" }));
    await engine.processEvent(message({ id: "bj2", senderId: alice.id, text: "!hit" }));
    await engine.processEvent(message({ id: "bj3", senderId: alice.id, text: "/bj stand" }));
    expect(llm.calls).toEqual([]);
    expect(client.sent.length).toBeGreaterThan(0);
    for (const row of client.sent) {
      expect(row.text.toLowerCase()).not.toContain("feature not found");
      expect(row.text).not.toContain("limited to configured admins");
      expect(row.text).not.toContain(alice.id);
    }
    expect(client.sent[0]?.text).toMatch(/🃏|blackjack/i);
  });

  it("names a Chat sender and never prints the numeric id", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { engine, client } = setup();
    const matt: XUser = { id: snowflake, username: "HisHandle", name: "Matt" };
    client.addUser(matt);
    await engine.processEvent(
      message({ id: "c1", senderId: matt.id, sender: undefined, text: "!slots" }),
    );
    await engine.processEvent(
      message({
        id: "c2",
        senderId: "1860000000000000001",
        sender: undefined,
        text: "!roulette red",
      }),
    );
    expect(client.sent[0]?.text).toContain("@HisHandle");
    expect(client.sent[1]?.text).toContain("someone");
    for (const row of client.sent) {
      expect(row.text).not.toContain(snowflake);
      expect(row.text).not.toContain("1860000000000000001");
    }
  });

  it("wagers XP without going negative and levels up on a win", async () => {
    const { engine, client, store } = setup();
    store.setUserXp(groupId, alice.id, 4, "alice");
    await engine.processEvent(message({ id: "x1", senderId: alice.id, text: "!slots xp 10" }));
    expect(store.getUserXp(groupId, alice.id).xp).toBe(4);
    expect(client.sent[0]?.text).toContain("Not enough XP");

    vi.spyOn(Math, "random").mockReturnValue(0);
    store.setUserXp(groupId, alice.id, 90, "alice");
    await engine.processEvent(message({ id: "x2", senderId: alice.id, text: "!slots xp 10" }));
    expect(store.getUserXp(groupId, alice.id).xp).toBe(120);
    expect(client.sent[1]?.text).toContain("XP 90 → 120");
    expect(client.sent[1]?.text).toContain("@alice leveled up to level 1!");

    store.setUserXp(groupId, alice.id, 100, "alice");
    vi.spyOn(Math, "random").mockReturnValue(0);
    await engine.processEvent(message({ id: "x3", senderId: alice.id, text: "!roulette red xp 100" }));
    expect(store.getUserXp(groupId, alice.id).xp).toBe(0);
    expect(client.sent[2]?.text).toContain("XP 100 → 0");
  });

  it("leaves XP alone when a fun-chip game is played and when XP bets are off", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { engine, client, store } = setup({ xpEnabled: false });
    store.setUserXp(groupId, alice.id, 40, "alice");
    await engine.processEvent(message({ id: "f1", senderId: alice.id, text: "!slots xp 10" }));
    await engine.processEvent(message({ id: "f2", senderId: alice.id, text: "!slots" }));
    expect(store.getUserXp(groupId, alice.id).xp).toBe(40);
    expect(client.sent[0]?.text).toContain("XP bets are off");
    expect(client.sent[1]?.text).toContain("Fun chips 100 → 130");
  });

  it("runs a crash cash-out and a trivia round in the chat", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.1);
    const { engine, client } = setup();
    await engine.processEvent(
      message({ id: "k1", senderId: alice.id, text: "!crash" }),
      1_000,
    );
    await engine.processEvent(
      message({ id: "k2", senderId: alice.id, text: "!crash out" }),
      9_000,
    );
    expect(client.sent[1]?.text).toContain("2.71×");
    expect(client.sent[1]?.text).toContain("@alice");

    vi.spyOn(Math, "random").mockReturnValue(0);
    await engine.processEvent(message({ id: "t1", senderId: alice.id, text: "!trivia" }));
    await engine.processEvent(message({ id: "t2", senderId: alice.id, text: "!trivia b" }));
    expect(client.sent[2]?.text).toContain(TRIVIA_QUESTIONS[0]!.prompt);
    expect(client.sent[3]?.text).toContain("correct");
    expect(client.sent.some((row) => row.text.includes(alice.id))).toBe(false);
  });

  it("routes !stand to the open poker hand", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { engine, client } = setup();
    await engine.processEvent(message({ id: "p1", senderId: alice.id, text: "!poker" }));
    await engine.processEvent(message({ id: "p2", senderId: alice.id, text: "!stand" }));
    expect(client.sent[0]?.text).toContain("!poker stand");
    expect(client.sent[1]?.text).toMatch(/wins|Push/);
    expect(client.sent.some((row) => /admins/i.test(row.text))).toBe(false);
  });

  it("lists the casino commands in the default help text", () => {
    const loaded = loadDefaults("config/default.yaml");
    expect(loaded.help).toMatch(/!slots/);
    expect(loaded.help).toMatch(/!blackjack/);
    expect(loaded.help).toMatch(/!poker/);
    expect(loaded.help).toMatch(/!roulette/);
    expect(loaded.help).toMatch(/!crash/);
    expect(loaded.help).toMatch(/!trivia/);
  });

  it("scrubs a numeric id if one is passed as the player", () => {
    const table = new CasinoTable();
    const bank = wallet();
    const reply = playCasino(table, {
      ...context(bank.xp, { label: snowflake, userId: snowflake, rng: () => 0 }),
      game: "slots",
      args: "",
    });
    expect(reply).toContain("someone");
    expect(reply).not.toContain(snowflake);
  });
});
