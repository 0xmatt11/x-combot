import { afterEach, describe, expect, it } from "vitest";
import { ModerationEngine } from "../src/bot/engine.js";
import {
  CHALLENGE_TTL_MS,
  CONNECT4_HELP,
  DUEL_HELP,
  DUEL_HP,
  HANGMAN_HELP,
  HANGMAN_LIVES,
  HANGMAN_WORDS,
  PLAY_TTL_MS,
  STORY_HELP,
  STORY_MAX_CHARS,
  STORY_TTL_MS,
  TICTACTOE_HELP,
  GameRoom,
  connect4Winner,
  oneSentence,
  parseConnect4Column,
  parseDuelAction,
  parseTictactoeSquare,
  rollD6,
  tictactoeWinner,
  type GamePlayer,
  type MultiplayerKind,
} from "../src/bot/games/index.js";
import { loadDefaults } from "../src/config.js";
import { Store } from "../src/store.js";
import type { BotRuntimeConfig, DefaultsConfig, DmEvent, XUser } from "../src/types.js";
import { MockXClient } from "../src/x/mock-client.js";

const alice: XUser = { id: "u-alice", username: "alice", name: "Alice" };
const bob: XUser = { id: "u-bob", username: "bob", name: "Bob" };
const carol: XUser = { id: "u-carol", username: "carol", name: "Carol" };
const owner: XUser = { id: "u-owner", username: "owner", name: "Owner" };
const groupId = "1578398451921985538";

const ada: GamePlayer = { id: alice.id, label: "@alice" };
const ben: GamePlayer = { id: bob.id, label: "@bob" };
const cam: GamePlayer = { id: carol.id, label: "@carol" };

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

function play(
  room: GameRoom,
  kind: MultiplayerKind,
  actor: GamePlayer,
  args = "",
  extra: { challenged?: GamePlayer; nowMs?: number; conversationId?: string } = {},
): string {
  return room.play(kind, {
    conversationId: extra.conversationId ?? groupId,
    actor,
    challenged: extra.challenged,
    args,
    nowMs: extra.nowMs ?? 1_000,
  });
}

function expectNoIds(text: string, ids: string[]): void {
  for (const id of ids) {
    expect(text, id).not.toContain(id);
  }
}

describe("tic-tac-toe rules", () => {
  it("parses squares and finds a line", () => {
    expect(parseTictactoeSquare("5")).toBe(4);
    expect(parseTictactoeSquare("a1")).toBe(0);
    expect(parseTictactoeSquare("B2")).toBe(4);
    expect(parseTictactoeSquare("c3")).toBe(8);
    expect(parseTictactoeSquare("play 7")).toBe(6);
    expect(parseTictactoeSquare("10")).toBeUndefined();
    expect(parseTictactoeSquare("accept")).toBeUndefined();
    const cells = ["X", "X", "X", null, null, null, null, null, null] as const;
    expect(tictactoeWinner(cells)).toBe("X");
    expect(tictactoeWinner(Array.from({ length: 9 }, () => "X" as const))).toBe("X");
  });

  it("documents usage, then challenges, accepts, and wins", () => {
    const room = new GameRoom();
    expect(play(room, "tictactoe", ada)).toBe(TICTACTOE_HELP);
    expect(play(room, "tictactoe", ada, "", { challenged: ben })).toBe(
      "@alice challenged @bob to tic-tac-toe. @bob: !tictactoe accept, decline, or play 1-9.",
    );
    expect(room.sessionKeys()).toEqual([`${groupId}:g1`]);
    expect(play(room, "tictactoe", ben, "accept")).toContain("@alice (X) — play 1-9.");
    expect(play(room, "tictactoe", ada, "1")).toContain("@bob (O) — play 1-9.");
    expect(play(room, "tictactoe", ada, "2")).toBe("It's @bob's turn.");
    expect(play(room, "tictactoe", ben, "5")).toContain("X · ·");
    expect(play(room, "tictactoe", ada, "2")).toContain("@bob (O)");
    expect(play(room, "tictactoe", ben, "4")).toContain("@alice (X)");
    const win = play(room, "tictactoe", ada, "3");
    expect(win).toBe("X X X\nO O ·\n· · ·\n@alice wins.");
    expect(room.size()).toBe(0);
  });

  it("lets the first square accept, declines, resigns, and draws", () => {
    const room = new GameRoom();
    play(room, "tictactoe", ada, "", { challenged: ben });
    expect(play(room, "tictactoe", ben, "b2")).toBe("· · ·\n· X ·\n· · ·\n@alice (O) — play 1-9.");
    expect(play(room, "tictactoe", ada, "b2")).toBe("That square is taken.");
    expect(play(room, "tictactoe", cam, "1")).toBe("That's @alice vs @bob.");
    play(room, "tictactoe", ada, "resign");
    expect(room.size()).toBe(0);

    play(room, "tictactoe", ada, "", { challenged: ben });
    expect(play(room, "tictactoe", ben, "decline")).toBe(
      "@bob declined @alice's tic-tac-toe challenge.",
    );
    play(room, "tictactoe", ada, "", { challenged: ben });
    expect(play(room, "tictactoe", ada, "cancel")).toBe(
      "@alice cancelled the tic-tac-toe challenge.",
    );

    play(room, "tictactoe", ada, "", { challenged: ben });
    play(room, "tictactoe", ben, "accept");
    const moves = ["1", "2", "3", "5", "4", "6", "8", "7", "9"];
    let last = "";
    moves.forEach((square, index) => {
      last = play(room, "tictactoe", index % 2 === 0 ? ada : ben, square);
    });
    expect(last).toBe("X O X\nX O O\nO X X\nDraw.");
    expect(room.size()).toBe(0);
  });

  it("expires a pending challenge and keeps another conversation apart", () => {
    const room = new GameRoom();
    play(room, "tictactoe", ada, "", { challenged: ben, nowMs: 0 });
    expect(play(room, "tictactoe", ben, "accept", { nowMs: CHALLENGE_TTL_MS })).toMatch(/timed out/);
    expect(room.size()).toBe(0);

    play(room, "tictactoe", ada, "", { challenged: ben, conversationId: "one" });
    expect(play(room, "tictactoe", ada, "", { conversationId: "two" })).toBe(TICTACTOE_HELP);
    expect(play(room, "tictactoe", ben, "accept", { conversationId: "one" })).toContain("(X)");
  });

  it("never prints a numeric id", () => {
    const room = new GameRoom();
    const snow = "1712950172873809920";
    const reply = play(
      room,
      "tictactoe",
      { id: snow, label: snow },
      "",
      { challenged: { id: "99", label: "@99" } },
    );
    expect(reply).toBe(
      "someone challenged someone to tic-tac-toe. someone: !tictactoe accept, decline, or play 1-9.",
    );
    expectNoIds(reply, [snow, "99"]);
  });
});

describe("connect four", () => {
  it("drops with gravity, wins across, and rejects a full column", () => {
    expect(parseConnect4Column("4")).toBe(3);
    expect(parseConnect4Column("drop 7")).toBe(6);
    expect(parseConnect4Column("8")).toBeUndefined();

    const room = new GameRoom();
    expect(play(room, "connect4", ada)).toBe(CONNECT4_HELP);
    play(room, "connect4", ada, "", { challenged: ben });
    play(room, "connect4", ben, "accept");
    const columns = ["1", "7", "2", "7", "3", "7", "4"];
    let last = "";
    columns.forEach((column, index) => {
      last = play(room, "connect4", index % 2 === 0 ? ada : ben, column);
    });
    expect(last).toContain("X X X X · · O");
    expect(last).toContain("@alice wins.");
    expect(last).toContain("1 2 3 4 5 6 7");
    expect(room.size()).toBe(0);

    play(room, "connect4", ada, "", { challenged: ben });
    play(room, "connect4", ben, "1");
    expect(play(room, "connect4", ada, "1")).toContain("@bob (X)");
    for (let i = 0; i < 4; i += 1) {
      play(room, "connect4", i % 2 === 0 ? ben : ada, "1");
    }
    expect(play(room, "connect4", ben, "1")).toBe("Column 1 is full.");
  });

  it("sees a diagonal and a vertical four", () => {
    const grid = Array.from({ length: 6 }, () => Array.from({ length: 7 }, () => null as "X" | "O" | null));
    grid[5]![0] = "X";
    grid[4]![1] = "X";
    grid[3]![2] = "X";
    grid[2]![3] = "X";
    expect(connect4Winner(grid)).toBe("X");

    const room = new GameRoom();
    play(room, "connect4", ada, "", { challenged: ben });
    play(room, "connect4", ben, "accept");
    let last = "";
    for (let i = 0; i < 7; i += 1) {
      last = play(room, "connect4", i % 2 === 0 ? ada : ben, i % 2 === 0 ? "1" : "2");
    }
    expect(last).toContain("@alice wins.");
    expect(room.size()).toBe(0);
  });

  it("calls a filled board with no four a draw", () => {
    const rows = ["OXXOOXO", "OOOXXOO", "OXXOOOX", "XOOXXXO", "OXXXOXX", "OXXOOXX"];
    const grid = rows.map((row) => [...row].map((cell) => (cell === "X" ? "X" : "O") as "X" | "O"));
    expect(connect4Winner(grid)).toBe("draw");
    const empty = Array.from({ length: 6 }, () => Array.from({ length: 7 }, () => null));
    expect(connect4Winner(empty)).toBeUndefined();
  });
});

describe("duel", () => {
  it("rolls 1d6, alternates attack and defend, and ends at 0 HP", () => {
    expect(rollD6(() => 0)).toBe(1);
    expect(rollD6(() => 1)).toBe(6);
    expect(parseDuelAction("atk")).toBe("attack");
    expect(parseDuelAction("block")).toBe("defend");
    expect(parseDuelAction("accept")).toBeUndefined();

    const room = new GameRoom(() => 1);
    expect(play(room, "duel", ada)).toBe(DUEL_HELP);
    expect(play(room, "duel", ada, "", { challenged: ada })).toBe("Pick someone else.");
    play(room, "duel", ada, "", { challenged: ben });
    const opened = play(room, "duel", ben, "accept");
    expect(opened).toContain(`HP @alice ${DUEL_HP}, @bob ${DUEL_HP}.`);
    expect(opened).toContain("@alice's turn");
    expect(play(room, "duel", ada, "attack")).toContain(
      "⚔️ @alice hits @bob for 6. HP @alice 10, @bob 4. @bob's turn.",
    );
    expect(play(room, "duel", ben, "attack")).toContain("HP @alice 4, @bob 4.");
    expect(play(room, "duel", ada, "attack")).toBe(
      "⚔️ @alice hits @bob for 6. @bob is out. @alice wins.",
    );
    expect(room.size()).toBe(0);
  });

  it("spends a defend roll on the next hit only", () => {
    const rolls = [2 / 6, 1 / 6, 0];
    let index = 0;
    const room = new GameRoom(() => rolls[index++] ?? 0);
    play(room, "duel", ada, "", { challenged: ben });
    expect(play(room, "duel", ben, "defend")).toContain("🛡️ @bob defends (block 3).");
    expect(play(room, "duel", ada, "attack")).toContain(
      "@alice hits @bob for 0 (roll 2, block 3).",
    );
    expect(play(room, "duel", ben, "attack")).toContain("@bob hits @alice for 1.");
    expect(play(room, "duel", ada, "resign")).toBe("@alice resigned. @bob wins.");
  });
});

describe("hangman", () => {
  it("plays a solo word, then a shared challenge", () => {
    expect(HANGMAN_WORDS).toContain("apple");
    expect(new Set(HANGMAN_WORDS).size).toBe(HANGMAN_WORDS.length);

    const room = new GameRoom(() => 0);
    expect(play(room, "hangman", ada)).toBe(HANGMAN_HELP);
    const started = play(room, "hangman", ada, "start");
    expect(started).toContain("_ _ _ _ _");
    expect(started).toContain(`Lives: ${HANGMAN_LIVES}.`);
    expect(started).not.toContain("apple");
    expect(play(room, "hangman", ada, "p")).toContain("_ p p _ _");
    expect(play(room, "hangman", ada, "p")).toBe("Already guessed p.");
    expect(play(room, "hangman", ada, "zzzz")).toContain("Nope.");
    expect(play(room, "hangman", ada, "apple")).toBe("🪢 @alice got it: apple.");
    expect(room.size()).toBe(0);

    play(room, "hangman", ada, "", { challenged: ben });
    const opening = play(room, "hangman", ben, "z");
    expect(opening).toContain("Lives: 5.");
    expect(opening).toContain("@alice's guess.");
    expect(opening).not.toContain("apple");
    expect(play(room, "hangman", ada, "apple")).toBe("🪢 @alice got it: apple.");
  });

  it("ends a solo game when the lives run out and hides the word until then", () => {
    const room = new GameRoom(() => 0);
    play(room, "hangman", ada, "start");
    const wrong = ["z", "q", "w", "r", "t", "y"];
    let last = "";
    for (const letter of wrong) last = play(room, "hangman", ada, letter);
    expect(last).toBe("🪢 Out of lives. The word was apple.");
    expect(room.size()).toBe(0);

    play(room, "hangman", ada, "start");
    const status = play(room, "hangman", ada, "status");
    expect(status).not.toContain("apple");
    expect(play(room, "hangman", ada, "resign")).toBe("@alice resigned. The word was apple.");
  });
});

describe("story", () => {
  it("takes one sentence from each person, then stops", () => {
    const room = new GameRoom();
    expect(play(room, "story", ada)).toBe(STORY_HELP);
    expect(oneSentence("The door opened.")).toBe("The door opened.");
    expect(oneSentence("Hi. Bye.")).toBeUndefined();
    expect(oneSentence("x".repeat(STORY_MAX_CHARS + 1))).toBeUndefined();
    expect(play(room, "story", ada, "The door opened.")).toContain("Start");
    expect(play(room, "story", ada, "start")).toContain("@alice started a story.");
    expect(play(room, "story", ada, "The lantern flickered.")).toContain("1 line.");
    expect(play(room, "story", ada, "Another line.")).toContain("Someone else goes next.");
    expect(play(room, "story", ada, "Hi. Bye.")).toBe("Add one sentence (140 characters max).");
    expect(play(room, "story", ben, "A hinge creaked.")).toContain("2 lines.");
    expect(play(room, "story", ada)).toContain("Last: @bob — A hinge creaked.");
    const ended = play(room, "story", cam, "stop");
    expect(ended).toContain("@carol ended the story (2 lines).");
    expect(ended).toContain("The lantern flickered. A hinge creaked.");
    expect(room.size()).toBe(0);
  });

  it("drops a story after the idle window", () => {
    const room = new GameRoom();
    play(room, "story", ada, "start", { nowMs: 0 });
    expect(play(room, "story", ben, "A late line.", { nowMs: STORY_TTL_MS })).toMatch(/timed out/);
    expect(room.size()).toBe(0);
  });
});

describe("shared session rules", () => {
  it("refuses a second game of the same kind and expires an active one", () => {
    const room = new GameRoom();
    play(room, "tictactoe", ada, "", { challenged: ben, nowMs: 0 });
    expect(play(room, "tictactoe", cam, "", { challenged: ada, nowMs: 1 })).toMatch(/already going/);
    play(room, "duel", ada, "", { challenged: ben, nowMs: 1 });
    expect(room.size()).toBe(2);
    play(room, "tictactoe", ben, "accept", { nowMs: 2 });
    expect(play(room, "tictactoe", ada, "1", { nowMs: 2 + PLAY_TTL_MS })).toMatch(/timed out/);
  });
});

describe("multiplayer commands in chat", () => {
  const stores: Store[] = [];

  afterEach(() => {
    for (const store of stores) store.close();
    stores.length = 0;
  });

  function setup(): { engine: ModerationEngine; client: MockXClient; store: Store } {
    const store = new Store(":memory:");
    stores.push(store);
    const client = new MockXClient();
    client.addUser(alice);
    client.addUser(bob);
    client.addUser(carol);
    client.addUser(owner);
    const config: BotRuntimeConfig = {
      botUserId: "bot-1",
      ownerId: owner.id,
      globalAdminIds: [],
      defaults,
    };
    return { engine: new ModerationEngine(store, client, config), client, store };
  }

  function message(partial: Partial<DmEvent> & Pick<DmEvent, "id" | "senderId" | "text">): DmEvent {
    return {
      eventType: "MessageCreate",
      conversationId: groupId,
      participantIds: [],
      participants: [],
      mentions: [],
      sender: partial.senderId === bob.id ? bob : partial.senderId === carol.id ? carol : alice,
      ...partial,
    };
  }

  it("lets a non-admin challenge by @mention and by a trusted reply", async () => {
    const { engine, client } = setup();
    await engine.processEvent(message({ id: "m1", senderId: alice.id, text: "/tictactoe" }));
    await engine.processEvent(message({ id: "m2", senderId: alice.id, text: "!tictactoe @bob" }));
    await engine.processEvent(
      message({ id: "m3", senderId: bob.id, text: "!tictactoe accept" }),
    );
    await engine.processEvent(message({ id: "m4", senderId: alice.id, text: "!tictactoe a1" }));
    expect(client.sent.map((row) => row.text)[0]).toBe(TICTACTOE_HELP);
    expect(client.sent[1]?.text).toContain("@alice challenged @bob to tic-tac-toe.");
    expect(client.sent[3]?.text.startsWith("X · ·")).toBe(true);
    expect(client.sent.some((row) => /admins/i.test(row.text))).toBe(false);
  });

  it("resolves an encrypted Chat reply without printing user ids", async () => {
    const { engine, client } = setup();
    const snowAlice = "1712950172873809921";
    const snowBob = "1712950172873809922";
    client.addUser({ id: snowAlice, username: "HisHandle", name: "Matt" });
    client.addUser({ id: snowBob, username: "bob", name: "Bob" });
    await engine.processEvent(
      message({
        id: "m5",
        senderId: snowAlice,
        sender: { id: snowAlice },
        text: "!duel",
        replyToSenderId: snowBob,
      }),
    );
    const text = client.sent[0]?.text ?? "";
    expect(text).toContain("@HisHandle challenged @bob to a duel.");
    expectNoIds(text, [snowAlice, snowBob]);
  });

  it("says someone when the reply sender cannot be named", async () => {
    const { engine, client } = setup();
    const snowAlice = "1712950172873809923";
    const snowBob = "1712950172873809924";
    await engine.processEvent(
      message({
        id: "m6",
        senderId: snowAlice,
        sender: { id: snowAlice },
        text: "!connect4",
        replyToSenderId: snowBob,
      }),
    );
    const text = client.sent[0]?.text ?? "";
    expect(text).toContain("someone challenged someone to connect four.");
    expectNoIds(text, [snowAlice, snowBob]);
  });

  it("ignores an unverified reply and still uses a stored message author", async () => {
    const { engine, client, store } = setup();
    await engine.processEvent(
      message({
        id: "m7",
        senderId: alice.id,
        text: "!hangman",
        replyTo: { senderId: bob.id, verified: false },
      }),
    );
    expect(client.sent[0]?.text).toBe(HANGMAN_HELP);

    store.rememberMessageAuthor(groupId, "seq-9", bob.id);
    await engine.processEvent(
      message({
        id: "m8",
        senderId: alice.id,
        text: "!hangman",
        replyTo: { sequenceId: "seq-9", senderId: "1860000000000000001", verified: false },
      }),
    );
    const text = client.sent[1]?.text ?? "";
    expect(text).toContain("@alice challenged @bob to hangman.");
    expect(text).not.toContain("1860000000000000001");
  });

  it("rejects a missing user, yourself, and the bot", async () => {
    const { engine, client } = setup();
    await engine.processEvent(message({ id: "m9", senderId: alice.id, text: "!duel @nobody" }));
    await engine.processEvent(message({ id: "m10", senderId: alice.id, text: "!duel @alice" }));
    await engine.processEvent(
      message({
        id: "m11",
        senderId: alice.id,
        text: "!duel",
        replyToSenderId: alice.id,
      }),
    );
    await engine.processEvent(
      message({
        id: "m12",
        senderId: alice.id,
        text: "!duel",
        replyToSenderId: "bot-1",
      }),
    );
    expect(client.sent.map((row) => row.text)).toEqual([
      "Could not resolve that user.",
      "Pick someone else.",
      "Reply to someone else, or pass @user.",
      "Pick someone else.",
    ]);
  });

  it("plays hangman and a story without leaving the public command path", async () => {
    const { engine, client } = setup();
    await engine.processEvent(message({ id: "m13", senderId: alice.id, text: "!hangman start" }));
    await engine.processEvent(message({ id: "m14", senderId: alice.id, text: "!story start" }));
    await engine.processEvent(
      message({ id: "m15", senderId: alice.id, text: "!story The well was dry." }),
    );
    await engine.processEvent(
      message({ id: "m16", senderId: bob.id, text: "/story Then it rained." }),
    );
    await engine.processEvent(message({ id: "m17", senderId: alice.id, text: "!story stop" }));
    const texts = client.sent.map((row) => row.text);
    expect(texts[0]).toContain("Lives: 6.");
    expect(texts[1]).toContain("@alice started a story.");
    expect(texts[2]).toContain("The well was dry.");
    expect(texts[3]).toContain("@bob: Then it rained.");
    expect(texts[4]).toContain("The well was dry. Then it rained.");
    for (const text of texts) {
      expect(text).not.toContain(alice.id);
      expect(text).not.toContain(bob.id);
    }
  });

  it("lists the commands in the default help text", () => {
    const loaded = loadDefaults("config/default.yaml");
    expect(loaded.help).toMatch(/!tictactoe/);
    expect(loaded.help).toMatch(/!connect4/);
    expect(loaded.help).toMatch(/!duel/);
    expect(loaded.help).toMatch(/!hangman/);
    expect(loaded.help).toMatch(/!story/);
    expect(loaded.help).toMatch(/!games/);
  });
});
