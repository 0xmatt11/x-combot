import { afterEach, describe, expect, it, vi } from "vitest";
import { ModerationEngine } from "../src/bot/engine.js";
import {
  COIN_HELP,
  EIGHT_BALL_ANSWERS,
  EIGHT_BALL_HELP,
  GAME_CATALOG,
  RPS_HELP,
  coinflipReply,
  eightBallReply,
  gamesMenu,
  parseCoinCall,
  parseRpsChoice,
  pickIndex,
  playerName,
  rpsOutcome,
  rpsReply,
} from "../src/bot/games/index.js";
import { loadDefaults } from "../src/config.js";
import { Store } from "../src/store.js";
import type { BotRuntimeConfig, DefaultsConfig, DmEvent, XUser } from "../src/types.js";
import { MockXClient } from "../src/x/mock-client.js";

const alice: XUser = { id: "u-alice", username: "alice", name: "Alice" };
const owner: XUser = { id: "u-owner", username: "owner", name: "Owner" };
const groupId = "1578398451921985538";

const defaults: DefaultsConfig = {
  welcome: { enabled: true, text: "Welcome @{username}!" },
  rules: "Be nice.",
  help: "Type !rules",
  flood: { max_messages: 3, window_ms: 10_000, mute_ms: 60_000, warn_on_flood: true },
  warns: { limit: 2, auto_mute_ms: 60_000, notify_admins: true },
  filters: [],
  poll: { interval_ms: 1000, max_results: 50 },
  delete: { attempt_on_filter: true, attempt_on_flood: true, attempt_on_mute: true },
};

const PLANNED = [
  "!dice",
  "!rps",
  "!coinflip",
  "!8ball",
  "!tictactoe",
  "!connect4",
  "!duel",
  "!hangman",
  "!story",
  "!wordle",
  "!anagram",
  "!scramble",
  "!guess",
  "!higherlower",
  "!wouldyourather",
  "!truthordare",
  "!slots",
  "!blackjack",
  "!poker",
  "!roulette",
  "!crash",
  "!trivia",
  "!minesweeper",
];

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

describe("player labels", () => {
  it("keeps a handle or display name and drops a snowflake", () => {
    expect(playerName("@alice")).toBe("@alice");
    expect(playerName("Ada")).toBe("Ada");
    expect(playerName("  ")).toBe("someone");
    expect(playerName("1712950172873809920")).toBe("someone");
  });
});

describe("!rps", () => {
  it("accepts the throws and the short aliases", () => {
    expect(parseRpsChoice("rock")).toBe("rock");
    expect(parseRpsChoice("STONE")).toBe("rock");
    expect(parseRpsChoice("r")).toBe("rock");
    expect(parseRpsChoice("paper")).toBe("paper");
    expect(parseRpsChoice("P")).toBe("paper");
    expect(parseRpsChoice("scissors")).toBe("scissors");
    expect(parseRpsChoice("scissor")).toBe("scissors");
    expect(parseRpsChoice("s")).toBe("scissors");
    expect(parseRpsChoice("")).toBeUndefined();
    expect(parseRpsChoice("rock paper")).toBeUndefined();
    expect(parseRpsChoice("lizard")).toBeUndefined();
  });

  it("scores the three throws", () => {
    expect(rpsOutcome("rock", "scissors")).toBe("win");
    expect(rpsOutcome("paper", "rock")).toBe("win");
    expect(rpsOutcome("scissors", "paper")).toBe("win");
    expect(rpsOutcome("rock", "paper")).toBe("lose");
    expect(rpsOutcome("paper", "scissors")).toBe("lose");
    expect(rpsOutcome("scissors", "rock")).toBe("lose");
    expect(rpsOutcome("rock", "rock")).toBe("tie");
  });

  it("names the player and the bot throw", () => {
    expect(rpsReply("paper", "@alice", () => 0)).toBe(
      "✊ @alice played paper. I played rock. @alice wins.",
    );
    expect(rpsReply("rock", "Ada", () => 0)).toBe("✊ Ada played rock. I played rock. Tie.");
    expect(rpsReply("s", "1712950172873809920", () => 0)).toBe(
      "✊ someone played scissors. I played rock. I win.",
    );
    expect(rpsReply("nope", "@alice")).toBe(RPS_HELP);
    expect(rpsReply(undefined, "@alice")).toBe(RPS_HELP);
  });
});

describe("!coinflip", () => {
  it("treats a blank call as a plain flip and rejects junk", () => {
    expect(parseCoinCall(undefined)).toEqual({ ok: true });
    expect(parseCoinCall("  ")).toEqual({ ok: true });
    expect(parseCoinCall("HEADS")).toEqual({ ok: true, call: "heads" });
    expect(parseCoinCall("head")).toEqual({ ok: true, call: "heads" });
    expect(parseCoinCall("h")).toEqual({ ok: true, call: "heads" });
    expect(parseCoinCall("tails")).toEqual({ ok: true, call: "tails" });
    expect(parseCoinCall("tail")).toEqual({ ok: true, call: "tails" });
    expect(parseCoinCall("t")).toEqual({ ok: true, call: "tails" });
    expect(parseCoinCall("edge")).toEqual({ ok: false, help: COIN_HELP });
    expect(parseCoinCall("heads please")).toEqual({ ok: false, help: COIN_HELP });
  });

  it("reports the flip, and a call only when one was made", () => {
    expect(coinflipReply(undefined, "@alice", () => 0)).toBe("🪙 @alice flipped heads.");
    expect(coinflipReply("heads", "@alice", () => 0)).toBe(
      "🪙 @alice called heads. It's heads. @alice wins.",
    );
    expect(coinflipReply("tails", "Ada", () => 0)).toBe(
      "🪙 Ada called tails. It's heads. I win.",
    );
    expect(coinflipReply("h", "1712950172873809920", () => 1)).toBe(
      "🪙 someone called heads. It's tails. I win.",
    );
    expect(coinflipReply("sideways", "@alice")).toBe(COIN_HELP);
  });
});

describe("!8ball", () => {
  it("keeps a positive, neutral, negative, and snarky answer", () => {
    const tones = new Set(EIGHT_BALL_ANSWERS.map((answer) => answer.tone));
    expect(tones).toEqual(new Set(["positive", "negative", "neutral", "snarky"]));
    const text = EIGHT_BALL_ANSWERS.map((answer) => answer.text);
    expect(text).toContain("It is certain.");
    expect(text).toContain("Reply hazy, try again.");
    expect(text).toContain("My reply is no.");
    expect(text).toContain("Don't count on it.");
    expect(text.some((line) => line.toLowerCase().includes("better question"))).toBe(true);
  });

  it("requires a question and does not echo it", () => {
    expect(eightBallReply(undefined, "@alice")).toBe(EIGHT_BALL_HELP);
    expect(eightBallReply("   ", "@alice")).toBe(EIGHT_BALL_HELP);
    const reply = eightBallReply("will it rain?", "@alice", () => 0);
    expect(reply).toBe("🎱 @alice — It is certain.");
    expect(reply).not.toContain("rain");
    expect(eightBallReply("will it rain?", "1712950172873809920", () => 1)).toBe(
      `🎱 someone — ${EIGHT_BALL_ANSWERS[EIGHT_BALL_ANSWERS.length - 1]!.text}`,
    );
  });
});

describe("!games menu", () => {
  it("lists every planned game once, grouped, one line each", () => {
    const menu = gamesMenu();
    const lines = menu.split("\n");
    expect(lines[0]).toBe("Games:");
    expect(menu).toContain("Instant:\n!dice — roll dice");
    expect(menu).toContain("Multiplayer (coming):");
    expect(menu).toContain("Word/solo (coming):");
    expect(menu).toContain("XP/casino (coming):");
    expect(menu).toContain("Board:\n!minesweeper — minesweeper");
    expect(menu).not.toContain("minesweeper (coming)");

    const commands = GAME_CATALOG.flatMap((group) => group.games.map((game) => game.command));
    expect(commands).toEqual(PLANNED);
    for (const command of PLANNED) {
      const hits = lines.filter((line) => line.startsWith(`${command} —`));
      expect(hits, command).toHaveLength(1);
    }
    const gameLines = lines.filter((line) => line.startsWith("!"));
    expect(gameLines).toHaveLength(PLANNED.length);
  });
});

describe("pickIndex", () => {
  it("stays inside the list when the RNG is wild", () => {
    expect(pickIndex(3, () => 0)).toBe(0);
    expect(pickIndex(3, () => 1)).toBe(2);
    expect(pickIndex(3, () => Number.NaN)).toBe(0);
    expect(pickIndex(3, () => -4)).toBe(0);
    expect(pickIndex(1, () => 0.5)).toBe(0);
  });
});

describe("instant game commands", () => {
  const stores: Store[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const store of stores) store.close();
    stores.length = 0;
  });

  function setup(): { engine: ModerationEngine; client: MockXClient } {
    const store = new Store(":memory:");
    stores.push(store);
    const client = new MockXClient();
    client.addUser(alice);
    client.addUser(owner);
    const config: BotRuntimeConfig = {
      botUserId: "bot-1",
      ownerId: owner.id,
      globalAdminIds: [],
      defaults,
    };
    return { engine: new ModerationEngine(store, client, config), client };
  }

  it("lets a non-admin play rps, flip, and 8ball", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { engine, client } = setup();
    await engine.processEvent(message({ id: "g1", senderId: alice.id, text: "!rps paper" }));
    await engine.processEvent(message({ id: "g2", senderId: alice.id, text: "/flip tails" }));
    await engine.processEvent(
      message({ id: "g3", senderId: alice.id, text: "!8ball will it rain?" }),
    );
    await engine.processEvent(message({ id: "g4", senderId: alice.id, text: "!coinflip" }));
    expect(client.sent.map((row) => row.text)).toEqual([
      "✊ @alice played paper. I played rock. @alice wins.",
      "🪙 @alice called tails. It's heads. I win.",
      "🎱 @alice — It is certain.",
      "🪙 @alice flipped heads.",
    ]);
    expect(client.sent.some((row) => /admins/i.test(row.text))).toBe(false);
    expect(client.sent.some((row) => row.text.includes("rain"))).toBe(false);
  });

  it("answers a bad throw, a bad call, and an empty 8ball with usage", async () => {
    const { engine, client } = setup();
    await engine.processEvent(message({ id: "g5", senderId: alice.id, text: "!rps" }));
    await engine.processEvent(message({ id: "g6", senderId: alice.id, text: "!coinflip edge" }));
    await engine.processEvent(message({ id: "g7", senderId: alice.id, text: "/eightball" }));
    expect(client.sent.map((row) => row.text)).toEqual([RPS_HELP, COIN_HELP, EIGHT_BALL_HELP]);
  });

  it("posts the catalog from !games", async () => {
    const { engine, client } = setup();
    await engine.processEvent(message({ id: "g8", senderId: alice.id, text: "/games" }));
    expect(client.sent.map((row) => row.text)).toEqual([gamesMenu()]);
    expect(client.sent[0]?.text).toContain("!tictactoe");
    expect(client.sent[0]?.text).toContain("!minesweeper");
  });

  it("resolves a Chat sender and never prints the numeric id", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { engine, client } = setup();
    const snowflake = "1712950172873809920";
    const matt: XUser = { id: snowflake, username: "HisHandle", name: "Matt" };
    const named: XUser = { id: "u-ada", name: "Ada" };
    client.addUser(matt);
    client.addUser(named);

    await engine.processEvent(
      message({ id: "g9", senderId: matt.id, sender: undefined, text: "!rps rock" }),
    );
    await engine.processEvent(
      message({ id: "g10", senderId: named.id, sender: undefined, text: "!flip" }),
    );
    await engine.processEvent(
      message({
        id: "g11",
        senderId: "1860000000000000001",
        sender: undefined,
        text: "!eightball yes?",
      }),
    );

    expect(client.sent.map((row) => row.text)).toEqual([
      "✊ @HisHandle played rock. I played rock. Tie.",
      "🪙 Ada flipped heads.",
      "🎱 someone — It is certain.",
    ]);
    for (const row of client.sent) {
      expect(row.text).not.toContain(snowflake);
      expect(row.text).not.toContain("1860000000000000001");
    }
  });

  it("uses someone when the only identity is a short id", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { engine, client } = setup();
    const idOnly: XUser = { id: "99" };
    client.addUser(idOnly);
    await engine.processEvent(
      message({ id: "g12", senderId: idOnly.id, sender: idOnly, text: "!coinflip heads" }),
    );
    expect(client.sent.map((row) => row.text)).toEqual([
      "🪙 someone called heads. It's heads. someone wins.",
    ]);
    expect(client.sent.some((row) => row.text.includes("99"))).toBe(false);
  });

  it("lists the new commands in the default help text", () => {
    const loaded = loadDefaults("config/default.yaml");
    expect(loaded.help).toMatch(/!games/);
    expect(loaded.help).toMatch(/!rps/);
    expect(loaded.help).toMatch(/!coinflip/);
    expect(loaded.help).toMatch(/!flip/);
    expect(loaded.help).toMatch(/!8ball/);
    expect(loaded.help).toMatch(/!eightball/);
    expect(loaded.help).toMatch(/!minesweeper/);
    expect(loaded.help).toMatch(/more games/i);
  });
});
