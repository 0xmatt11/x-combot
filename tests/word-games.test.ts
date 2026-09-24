import { afterEach, describe, expect, it, vi } from "vitest";
import { containsBannedAgeTerm } from "../src/bot/adult-filter.js";
import { ModerationEngine } from "../src/bot/engine.js";
import {
  ANAGRAM_WORDS,
  DARE_PROMPTS,
  GAME_IDLE_MS,
  GUESS_HELP,
  SCRAMBLE_WORDS,
  TRUTH_OR_DARE_HELP,
  TRUTH_OR_DARE_LIMIT,
  TRUTH_OR_DARE_MINOR,
  TRUTH_PROMPTS,
  WORDLE_ANSWERS,
  WORDLE_HELP,
  WOULD_YOU_RATHER,
  anagramReply,
  clearWordGameSessions,
  dailyWordleWord,
  formatWordleMarks,
  guessReply,
  higherLowerReply,
  markWordleGuess,
  scrambleLetters,
  scrambleReply,
  spacedLetters,
  truthOrDareReply,
  wordleReply,
  wouldYouRatherReply,
} from "../src/bot/games/index.js";
import { loadDefaults } from "../src/config.js";
import { Store } from "../src/store.js";
import type { BotRuntimeConfig, DefaultsConfig, DmEvent, XUser } from "../src/types.js";
import { MockXClient } from "../src/x/mock-client.js";

const alice: XUser = { id: "u-alice", username: "alice", name: "Alice" };
const owner: XUser = { id: "u-owner", username: "owner", name: "Owner" };
const groupId = "1578398451921985538";
const snowflake = "1712950172873809920";
const now = Date.parse("2026-09-24T15:00:00.000Z");

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

describe("word lists", () => {
  it("keeps anagram and scramble on different lengths and scores", () => {
    expect(new Set(WORDLE_ANSWERS).size).toBe(WORDLE_ANSWERS.length);
    expect(new Set(ANAGRAM_WORDS).size).toBe(ANAGRAM_WORDS.length);
    expect(new Set(SCRAMBLE_WORDS).size).toBe(SCRAMBLE_WORDS.length);
    expect(WORDLE_ANSWERS.every((word) => word.length === 5)).toBe(true);
    expect(ANAGRAM_WORDS.every((word) => word.length >= 7)).toBe(true);
    expect(SCRAMBLE_WORDS.every((word) => word.length === 4)).toBe(true);
    const scramble = new Set<string>(SCRAMBLE_WORDS);
    for (const word of ANAGRAM_WORDS) expect(scramble.has(word)).toBe(false);
    for (const word of WORDLE_ANSWERS) expect(scramble.has(word)).toBe(false);
  });
});

describe("wordle marks", () => {
  it("marks correct, present, and absent without spending a repeated letter twice", () => {
    expect(markWordleGuess("trace", "crane")).toEqual([
      "absent",
      "correct",
      "correct",
      "present",
      "correct",
    ]);
    expect(markWordleGuess("eeeee", "queen")).toEqual([
      "absent",
      "absent",
      "correct",
      "correct",
      "absent",
    ]);
    expect(markWordleGuess("queue", "queen")).toEqual([
      "correct",
      "correct",
      "correct",
      "absent",
      "present",
    ]);
    const line = formatWordleMarks("trace", markWordleGuess("trace", "crane"));
    expect(line).toContain("T=absent");
    expect(line).toContain("C=present");
    expect(line).toContain("A=correct");
  });
});

describe("!wordle", () => {
  afterEach(() => {
    clearWordGameSessions();
  });

  it("tracks a daily board, then a practice round, and never prints a snowflake", () => {
    const word = dailyWordleWord("daily", now);
    const other = WORDLE_ANSWERS.find((entry) => entry !== word)!;
    const start = wordleReply({
      conversationId: "daily",
      player: "@alice",
      nowMs: now,
      rng: () => 0,
    });
    expect(start).toContain("@alice — daily Wordle");
    expect(start).toContain("correct, present, absent");

    const marked = wordleReply({
      conversationId: "daily",
      guess: other,
      player: "@alice",
      nowMs: now,
    });
    const marks = formatWordleMarks(other, markWordleGuess(other, word));
    expect(marked).toContain(marks);
    expect(marked).toMatch(/correct|present|absent/);

    const board = wordleReply({ conversationId: "daily", player: "Ada", nowMs: now });
    expect(board).toContain("@alice");
    expect(board).toContain("1/6");

    const won = wordleReply({
      conversationId: "daily",
      guess: word,
      player: "@alice",
      nowMs: now,
    });
    expect(won).toContain("solved the daily Wordle in 2 guesses");
    expect(won).toContain(word.toUpperCase());
    expect(
      wordleReply({ conversationId: "daily", guess: word, player: "@alice", nowMs: now }),
    ).toContain("practice round");

    const practice = wordleReply({
      conversationId: "daily",
      player: "@alice",
      nowMs: now,
      rng: () => 0,
    });
    expect(practice).toContain("practice Wordle");
    const still = wordleReply({
      conversationId: "daily",
      guess: word,
      player: "@alice",
      nowMs: now,
    });
    expect(still).not.toContain("solved");

    const hidden = wordleReply({
      conversationId: "hidden",
      player: snowflake,
      nowMs: now,
    });
    expect(hidden).toContain("someone — daily Wordle");
    expect(hidden).not.toContain(snowflake);
  });

  it("rejects a bad guess without spending a try, and drops the board after idle", () => {
    expect(
      wordleReply({ conversationId: "bad", guess: "nope", player: "@alice", nowMs: now }),
    ).toContain(WORDLE_HELP);

    wordleReply({ conversationId: "bad", player: "@alice", nowMs: now });
    const rejected = wordleReply({
      conversationId: "bad",
      guess: "zzzzz",
      player: "@alice",
      nowMs: now,
    });
    expect(rejected).toContain("isn't in the word list");
    expect(rejected).toContain("0/6");

    const word = dailyWordleWord("expire", now);
    const other = WORDLE_ANSWERS.find((entry) => entry !== word)!;
    wordleReply({ conversationId: "expire", player: "@alice", nowMs: now });
    wordleReply({ conversationId: "expire", guess: other, player: "@alice", nowMs: now });
    const fresh = wordleReply({
      conversationId: "expire",
      player: "@alice",
      nowMs: now + GAME_IDLE_MS,
    });
    expect(fresh).toContain("daily Wordle");
    expect(fresh).not.toContain(formatWordleMarks(other, markWordleGuess(other, word)));
  });

  it("starts a new daily after midnight even if the old board is still inside the idle window", () => {
    const late = Date.parse("2026-09-24T23:50:00.000Z");
    const morning = Date.parse("2026-09-25T00:10:00.000Z");
    const word = dailyWordleWord("midnight", late);
    const other = WORDLE_ANSWERS.find((entry) => entry !== word)!;
    wordleReply({ conversationId: "midnight", player: "@alice", nowMs: late });
    wordleReply({ conversationId: "midnight", guess: other, player: "@alice", nowMs: late });
    const rolled = wordleReply({ conversationId: "midnight", player: "@alice", nowMs: morning });
    expect(rolled).toContain("daily Wordle");
    expect(rolled).toContain("6 guesses");
    expect(rolled).not.toContain(formatWordleMarks(other, markWordleGuess(other, word)));
  });

  it("keeps chats on their own boards", () => {
    const word = dailyWordleWord("one", now);
    const other = WORDLE_ANSWERS.find((entry) => entry !== word)!;
    wordleReply({ conversationId: "one", guess: other, player: "@alice", nowMs: now });
    const two = wordleReply({ conversationId: "two", player: "@alice", nowMs: now });
    expect(two).not.toContain(formatWordleMarks(other, markWordleGuess(other, word)));
  });
});

describe("!anagram and !scramble", () => {
  afterEach(() => {
    clearWordGameSessions();
  });

  it("scores a longer anagram by misses, not by streak", () => {
    const opened = anagramReply({
      conversationId: "ana",
      player: "@alice",
      nowMs: now,
      rng: () => 0,
    });
    expect(opened).toContain(spacedLetters(scrambleLetters("diamond", () => 0)));
    expect(opened).toContain("Score 70");
    expect(opened).not.toContain("DIAMOND");
    expect(opened).not.toContain("streak");

    const missed = anagramReply({
      conversationId: "ana",
      guess: "picture",
      player: "@alice",
      nowMs: now,
    });
    expect(missed).toContain("nope");
    expect(missed).toContain("Score 65");
    expect(missed).not.toContain("DIAMOND");

    expect(
      anagramReply({
        conversationId: "ana",
        guess: "diamond",
        player: "@alice",
        nowMs: now,
      }),
    ).toBe("@alice unscrambled DIAMOND for 65 points.");
  });

  it("reveals the anagram after the last miss", () => {
    anagramReply({ conversationId: "ana-lose", player: "@alice", nowMs: now, rng: () => 0 });
    let last = "";
    for (let i = 0; i < 5; i += 1) {
      last = anagramReply({
        conversationId: "ana-lose",
        guess: "zzzzzzz",
        player: "@alice",
        nowMs: now,
      });
    }
    expect(last).toContain("The word was DIAMOND");
    expect(last).toContain("0 points");
  });

  it("scores scramble as a short-word streak and deals the next word", () => {
    const opened = scrambleReply({
      conversationId: "scr",
      player: "@alice",
      nowMs: now,
      rng: () => 0,
    });
    expect(opened).toContain(spacedLetters(scrambleLetters("frog", () => 0)));
    expect(opened).toContain("Streak 0");
    expect(opened).toContain("Round score 0");
    expect(opened).not.toContain("points");

    const solved = scrambleReply({
      conversationId: "scr",
      guess: "frog",
      player: "@alice",
      nowMs: now,
      rng: () => 0,
    });
    expect(solved).toContain("solved FROG");
    expect(solved).toContain("Streak 1");
    expect(solved).toContain("Round score 4");
    expect(solved).toContain(spacedLetters(scrambleLetters("duck", () => 0)));
    expect(solved).not.toContain("points");

    const again = scrambleReply({
      conversationId: "scr",
      guess: "duck",
      player: "@alice",
      nowMs: now,
      rng: () => 0,
    });
    expect(again).toContain("Streak 2");
    expect(again).toContain("Round score 12");

    const missed = scrambleReply({
      conversationId: "scr-miss",
      player: "@alice",
      nowMs: now,
      rng: () => 0,
    });
    expect(missed).toContain("scramble:");
    const fail = scrambleReply({
      conversationId: "scr-miss",
      guess: "zzzz",
      player: "@alice",
      nowMs: now,
      rng: () => 0,
    });
    expect(fail).toContain("It was FROG");
    expect(fail).toContain("Streak reset");
    expect(fail).toContain("Round score 0");
  });
});

describe("!guess and !higherlower", () => {
  afterEach(() => {
    clearWordGameSessions();
  });

  it("picks a range and answers higher or lower", () => {
    const opened = guessReply({
      conversationId: "num",
      player: "@alice",
      nowMs: now,
      rng: () => 0,
    });
    expect(opened).toContain("from 1 to 10");
    expect(opened).toContain("higher or lower");

    expect(
      guessReply({ conversationId: "num", guess: "11", player: "@alice", nowMs: now }),
    ).toContain("11 is outside 1 to 10");
    expect(
      guessReply({ conversationId: "num", guess: "5", player: "@alice", nowMs: now }),
    ).toContain("@alice — lower than 5");
    expect(
      guessReply({ conversationId: "num", guess: "1", player: snowflake, nowMs: now }),
    ).toBe("someone got it in 2 guesses. The number was 1.");

    expect(
      guessReply({ conversationId: "num", guess: "1", player: "@alice", nowMs: now }),
    ).toContain("that round is over");
    expect(
      guessReply({ conversationId: "fresh", guess: "nope", player: "@alice", nowMs: now }),
    ).toContain(GUESS_HELP);
  });

  it("ends the number round when the tries run out, and forgets it after idle", () => {
    guessReply({ conversationId: "cap", player: "@alice", nowMs: now, rng: () => 0 });
    let last = "";
    for (let i = 0; i < 5; i += 1) {
      last = guessReply({ conversationId: "cap", guess: "10", player: "@alice", nowMs: now });
    }
    expect(last).toContain("out of guesses");
    expect(last).toContain("The number was 1");

    guessReply({ conversationId: "idle", player: "@alice", nowMs: now, rng: () => 0 });
    guessReply({ conversationId: "idle", guess: "5", player: "@alice", nowMs: now });
    const fresh = guessReply({
      conversationId: "idle",
      player: "@alice",
      nowMs: now + GAME_IDLE_MS,
      rng: () => 0,
    });
    expect(fresh).toContain("I'm thinking of a number");
    expect(fresh).not.toContain("Guess 1 of");
  });

  it("keeps a higher-lower streak, pushes ties, and ends on a miss", () => {
    const dealt = higherLowerReply({
      conversationId: "cards",
      player: "@alice",
      nowMs: now,
      rng: () => 0,
    });
    expect(dealt).toContain("Ace of clubs");
    expect(dealt).toContain("Streak 0");

    const push = higherLowerReply({
      conversationId: "cards",
      call: "higher",
      player: "@alice",
      nowMs: now,
      rng: () => 0,
    });
    expect(push).toContain("push, same rank");
    expect(push).toContain("Ace of diamonds");
    expect(push).toContain("Streak 0");

    const up = higherLowerReply({
      conversationId: "cards",
      call: "h",
      player: "@alice",
      nowMs: now,
      rng: () => 0.99,
    });
    expect(up).toContain("@alice — higher. King of spades. Streak 1.");

    const miss = higherLowerReply({
      conversationId: "cards",
      call: "higher",
      player: snowflake,
      nowMs: now,
      rng: () => 0,
    });
    expect(miss).toContain("someone — miss");
    expect(miss).toContain("Ace of clubs is lower");
    expect(miss).toContain("Streak ended at 1");
    expect(miss).not.toContain(snowflake);

    const again = higherLowerReply({
      conversationId: "cards",
      player: "@alice",
      nowMs: now,
      rng: () => 0,
    });
    expect(again).toContain("Ace of clubs");
    expect(again).toContain("Streak 0");
  });
});

describe("!wouldyourather and !truthordare", () => {
  afterEach(() => {
    clearWordGameSessions();
  });

  it("tallies A and B in the chat and does not print voter ids", () => {
    const opened = wouldYouRatherReply({
      conversationId: "wyr",
      player: "@alice",
      voterKey: "u-alice",
      nowMs: now,
      rng: () => 0,
    });
    expect(opened).toContain(`A) ${WOULD_YOU_RATHER[0].a}`);
    expect(opened).toContain(`B) ${WOULD_YOU_RATHER[0].b}`);
    expect(opened).toContain("Tally: A 0, B 0");

    const a = wouldYouRatherReply({
      conversationId: "wyr",
      choice: "A",
      player: "@alice",
      voterKey: "u-alice",
      nowMs: now,
    });
    expect(a).toContain("@alice voted A");
    expect(a).toContain("Tally: A 1 (@alice), B 0");

    const b = wouldYouRatherReply({
      conversationId: "wyr",
      choice: "b",
      player: "Ada",
      voterKey: "u-ada",
      nowMs: now,
    });
    expect(b).toContain("Tally: A 1 (@alice), B 1 (Ada)");

    const moved = wouldYouRatherReply({
      conversationId: "wyr",
      choice: "B",
      player: "@alice",
      voterKey: "u-alice",
      nowMs: now,
    });
    expect(moved).toContain("Tally: A 0, B 2 (@alice, Ada)");

    const hidden = wouldYouRatherReply({
      conversationId: "wyr-id",
      choice: "A",
      player: snowflake,
      voterKey: snowflake,
      nowMs: now,
      rng: () => 0,
    });
    expect(hidden).toContain("someone voted A");
    expect(hidden).toContain("Tally: A 1 (someone), B 0");
    expect(hidden).not.toContain(snowflake);

    const next = wouldYouRatherReply({
      conversationId: "wyr",
      choice: "next",
      player: "@alice",
      voterKey: "u-alice",
      nowMs: now,
      rng: () => 0,
    });
    expect(next).toContain(`A) ${WOULD_YOU_RATHER[1].a}`);
    expect(next).toContain("Tally: A 0, B 0");
  });

  it("forgets the tally after the idle timeout", () => {
    wouldYouRatherReply({
      conversationId: "wyr-idle",
      choice: "A",
      player: "@alice",
      voterKey: "u-alice",
      nowMs: now,
      rng: () => 0,
    });
    const fresh = wouldYouRatherReply({
      conversationId: "wyr-idle",
      player: "@alice",
      voterKey: "u-alice",
      nowMs: now + GAME_IDLE_MS,
      rng: () => 0,
    });
    expect(fresh).toContain("Tally: A 0, B 0");
  });

  it("serves a PG-13 truth or dare and refuses minors", () => {
    for (const prompt of [...TRUTH_PROMPTS, ...DARE_PROMPTS]) {
      expect(containsBannedAgeTerm(prompt), prompt).toBeUndefined();
    }

    expect(
      truthOrDareReply({
        conversationId: "tod",
        player: "@alice",
        nowMs: now,
        rng: () => 0,
      }),
    ).toBe(`@alice — Truth: ${TRUTH_PROMPTS[0]}`);
    expect(
      truthOrDareReply({
        conversationId: "tod-dare",
        mode: "dare",
        player: "@alice",
        nowMs: now,
        rng: () => 0,
      }),
    ).toBe(`@alice — Dare: ${DARE_PROMPTS[0]}`);

    const repeat = truthOrDareReply({
      conversationId: "tod",
      mode: "truth",
      player: "@alice",
      nowMs: now,
      rng: () => 0,
    });
    expect(repeat).toBe(`@alice — Truth: ${TRUTH_PROMPTS[1]}`);

    for (const mode of ["teen", "t33n", "a child", "17 years old"]) {
      const refused = truthOrDareReply({
        conversationId: "tod-minor",
        mode,
        player: snowflake,
        nowMs: now,
        rng: () => 0,
      });
      expect(refused, mode).toContain(TRUTH_OR_DARE_MINOR);
      expect(refused, mode).not.toContain(TRUTH_PROMPTS[0]);
      expect(refused, mode).not.toContain(snowflake);
    }

    expect(
      truthOrDareReply({
        conversationId: "tod-crime",
        mode: "steal a car",
        player: "@alice",
        nowMs: now,
      }),
    ).toContain(TRUTH_OR_DARE_LIMIT);
    expect(
      truthOrDareReply({
        conversationId: "tod-help",
        mode: "truth please",
        player: "@alice",
        nowMs: now,
      }),
    ).toContain(TRUTH_OR_DARE_HELP);
  });
});

describe("word and solo commands", () => {
  const stores: Store[] = [];

  afterEach(() => {
    clearWordGameSessions();
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

  it("lets a non-admin play every word and solo command", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { engine, client } = setup();
    const word = dailyWordleWord(groupId, now);
    await engine.processEvent(message({ id: "w1", senderId: alice.id, text: "!wordle" }), now);
    await engine.processEvent(
      message({ id: "w2", senderId: alice.id, text: `!wordle ${word}` }),
      now,
    );
    await engine.processEvent(message({ id: "w3", senderId: alice.id, text: "/anagram" }), now);
    await engine.processEvent(message({ id: "w4", senderId: alice.id, text: "!scramble" }), now);
    await engine.processEvent(message({ id: "w5", senderId: alice.id, text: "!guess" }), now);
    await engine.processEvent(message({ id: "w6", senderId: alice.id, text: "!guess 1" }), now);
    await engine.processEvent(message({ id: "w7", senderId: alice.id, text: "!higherlower" }), now);
    await engine.processEvent(
      message({ id: "w8", senderId: alice.id, text: "!higherlower higher" }),
      now,
    );
    await engine.processEvent(
      message({ id: "w9", senderId: alice.id, text: "!wouldyourather" }),
      now,
    );
    await engine.processEvent(
      message({ id: "w10", senderId: alice.id, text: "!wouldyourather A" }),
      now,
    );
    await engine.processEvent(message({ id: "w11", senderId: alice.id, text: "!truthordare" }), now);

    const texts = client.sent.map((row) => row.text);
    expect(texts[0]).toContain("@alice — daily Wordle");
    expect(texts[1]).toContain(`solved the daily Wordle in 1 guess`);
    expect(texts[1]).toContain(word.toUpperCase());
    expect(texts[2]).toContain(spacedLetters(scrambleLetters("diamond", () => 0)));
    expect(texts[3]).toContain(spacedLetters(scrambleLetters("frog", () => 0)));
    expect(texts[4]).toContain("from 1 to 10");
    expect(texts[5]).toContain("got it in 1 guess");
    expect(texts[6]).toContain("Ace of clubs");
    expect(texts[7]).toContain("push, same rank");
    expect(texts[8]).toContain("Tally: A 0, B 0");
    expect(texts[9]).toContain("Tally: A 1 (@alice), B 0");
    expect(texts[10]).toContain(`Truth: ${TRUTH_PROMPTS[0]}`);
    expect(texts.some((text) => /limited to configured admins/i.test(text))).toBe(false);
    expect(texts.some((text) => text.includes(alice.id))).toBe(false);
  });

  it("resolves a Chat sender and refuses a minor truth or dare", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { engine, client } = setup();
    const matt: XUser = { id: snowflake, username: "HisHandle", name: "Matt" };
    client.addUser(matt);
    await engine.processEvent(
      message({ id: "c1", senderId: matt.id, sender: undefined, text: "!guess" }),
      now,
    );
    await engine.processEvent(
      message({ id: "c2", senderId: matt.id, sender: undefined, text: "!wouldyourather B" }),
      now,
    );
    await engine.processEvent(
      message({
        id: "c3",
        senderId: "1860000000000000001",
        sender: undefined,
        text: "!truthordare dare a teen",
      }),
      now,
    );

    const texts = client.sent.map((row) => row.text);
    expect(texts[0]).toContain("@HisHandle — I'm thinking of a number");
    expect(texts[1]).toContain("@HisHandle voted B");
    expect(texts[1]).not.toContain(snowflake);
    expect(texts[2]).toContain(TRUTH_OR_DARE_MINOR);
    expect(texts[2]).toContain("someone");
    for (const text of texts) {
      expect(text).not.toContain(snowflake);
      expect(text).not.toContain("1860000000000000001");
    }
  });

  it("lists the word and solo commands in the default help text", () => {
    const loaded = loadDefaults("config/default.yaml");
    expect(loaded.help).toMatch(/!wordle/);
    expect(loaded.help).toMatch(/!anagram/);
    expect(loaded.help).toMatch(/!scramble/);
    expect(loaded.help).toMatch(/!guess/);
    expect(loaded.help).toMatch(/!higherlower/);
    expect(loaded.help).toMatch(/!wouldyourather/);
    expect(loaded.help).toMatch(/!truthordare/);
    expect(loaded.help).toMatch(/correct, present, or absent/);
  });
});
