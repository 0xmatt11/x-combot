import { afterEach, describe, expect, it, vi } from "vitest";
import { ModerationEngine } from "../src/bot/engine.js";
import {
  MINESWEEPER_HELP,
  MINESWEEPER_SIZES,
  MINESWEEPER_TIMEOUT_MS,
  minesweeperReply,
  minesweeperSnapshot,
  parseMinesweeperCommand,
  pickIndex,
  resetMinesweeperBoards,
  type MinesweeperSnapshot,
  type Rng,
} from "../src/bot/games/index.js";
import { loadDefaults } from "../src/config.js";
import { Store } from "../src/store.js";
import type { BotRuntimeConfig, DefaultsConfig, DmEvent, XUser } from "../src/types.js";
import { MockXClient } from "../src/x/mock-client.js";

const alice: XUser = { id: "u-alice", username: "alice", name: "Alice" };
const owner: XUser = { id: "u-owner", username: "owner", name: "Owner" };
const groupId = "1578398451921985538";
const otherGroupId = "1578398451921985539";

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

function cells(snap: MinesweeperSnapshot): string[] {
  const labels: string[] = [];
  for (let row = 0; row < snap.rows; row += 1) {
    for (let col = 0; col < snap.cols; col += 1) {
      labels.push(`${String.fromCharCode(65 + col)}${row + 1}`);
    }
  }
  return labels;
}

function playUntilClear(id: string, player: string, rng: Rng): string {
  let reply = minesweeperReply(id, "easy", player, { now: 1, rng });
  for (let guard = 0; guard < 40; guard += 1) {
    const snap = minesweeperSnapshot(id);
    if (!snap) throw new Error("board missing");
    if (snap.status !== "playing") return reply;
    const next = snap.minesPlaced
      ? cells(snap).find(
          (label) =>
            !snap.mines.includes(label) &&
            !snap.revealed.includes(label) &&
            !snap.flags.includes(label),
        )
      : "C3";
    if (!next) throw new Error("no safe cell left");
    reply = minesweeperReply(id, `r ${next}`, player, { now: 2, rng });
  }
  throw new Error("board did not clear");
}

describe("parseMinesweeperCommand", () => {
  it("starts on a difficulty, reveals, and flags", () => {
    expect(parseMinesweeperCommand(undefined)).toEqual({ kind: "show" });
    expect(parseMinesweeperCommand("  ")).toEqual({ kind: "show" });
    expect(parseMinesweeperCommand("EASY")).toEqual({ kind: "start", difficulty: "easy" });
    expect(parseMinesweeperCommand("5x5")).toEqual({ kind: "start", difficulty: "easy" });
    expect(parseMinesweeperCommand("5×5")).toEqual({ kind: "start", difficulty: "easy" });
    expect(parseMinesweeperCommand("medium")).toEqual({ kind: "start", difficulty: "medium" });
    expect(parseMinesweeperCommand("7")).toEqual({ kind: "start", difficulty: "medium" });
    expect(parseMinesweeperCommand("7x7")).toEqual({ kind: "start", difficulty: "medium" });
    expect(parseMinesweeperCommand("r B3")).toEqual({ kind: "reveal", row: 2, col: 1 });
    expect(parseMinesweeperCommand("REVEAL c3")).toEqual({ kind: "reveal", row: 2, col: 2 });
    expect(parseMinesweeperCommand("open 3b")).toEqual({ kind: "reveal", row: 2, col: 1 });
    expect(parseMinesweeperCommand("r B 3")).toEqual({ kind: "reveal", row: 2, col: 1 });
    expect(parseMinesweeperCommand("B3")).toEqual({ kind: "reveal", row: 2, col: 1 });
    expect(parseMinesweeperCommand("f C2")).toEqual({ kind: "flag", row: 1, col: 2, clear: false });
    expect(parseMinesweeperCommand("flag A1")).toEqual({
      kind: "flag",
      row: 0,
      col: 0,
      clear: false,
    });
    expect(parseMinesweeperCommand("unflag G7")).toEqual({
      kind: "flag",
      row: 6,
      col: 6,
      clear: true,
    });
    expect(parseMinesweeperCommand("banana")).toEqual({ kind: "help" });
    expect(parseMinesweeperCommand("r H1")).toEqual({ kind: "help" });
    expect(parseMinesweeperCommand("hard")).toEqual({ kind: "help" });
  });
});

describe("!minesweeper board", () => {
  afterEach(() => {
    resetMinesweeperBoards();
  });

  it("starts a 5×5 or 7×7 grid and nothing larger", () => {
    expect(MINESWEEPER_SIZES.easy).toEqual({ rows: 5, cols: 5, mines: 4 });
    expect(MINESWEEPER_SIZES.medium).toEqual({ rows: 7, cols: 7, mines: 8 });

    const easy = minesweeperReply(groupId, "easy", "@alice", { now: 0, rng: () => 0 });
    expect(easy).toContain("💣 @alice — easy 5×5, 4 mines");
    expect(easy).toContain("  A B C D E");
    expect(easy).toContain("1 # # # # #");
    expect(easy).toContain("5 # # # # #");
    expect(easy).not.toContain("6 #");
    expect(easy.split("\n")).toHaveLength(8);

    const medium = minesweeperReply(otherGroupId, "medium", "@alice", { now: 0, rng: () => 0 });
    expect(medium).toContain("💣 @alice — medium 7×7, 8 mines");
    expect(medium).toContain("  A B C D E F G");
    expect(medium).toContain("7 # # # # # # #");
    expect(medium).not.toContain("8 #");
    expect(medium.split("\n")).toHaveLength(10);

    expect(minesweeperSnapshot(groupId)?.rows).toBe(5);
    expect(minesweeperSnapshot(otherGroupId)?.rows).toBe(7);
  });

  it("keeps the first open off a mine and floods the empty pocket", () => {
    minesweeperReply(groupId, "5", "@alice", { now: 0, rng: () => 0 });
    const reply = minesweeperReply(groupId, "r C3", "@alice", { now: 1, rng: () => 0 });
    const snap = minesweeperSnapshot(groupId);
    expect(snap?.minesPlaced).toBe(true);
    expect(snap?.mines).toHaveLength(4);
    expect(snap?.mines).not.toContain("C3");
    expect(snap?.revealed.length).toBeGreaterThanOrEqual(9);
    expect(reply).not.toContain("hit a mine");
    const openedRow = reply.split("\n").find((line) => /^\d /.test(line) && line.includes("·"));
    expect(openedRow).toBeDefined();
  });

  it("places the same mine count when the shared picker is given a wild sample", () => {
    for (const sample of [Number.NaN, -4, 0, 0.5, 1, 50]) {
      resetMinesweeperBoards();
      const rng = () => sample;
      expect(pickIndex(16, rng)).toBeGreaterThanOrEqual(0);
      expect(pickIndex(16, rng)).toBeLessThan(16);
      minesweeperReply(groupId, "easy", "@alice", { now: 0, rng });
      minesweeperReply(groupId, "r A1", "@alice", { now: 1, rng });
      const snap = minesweeperSnapshot(groupId);
      expect(snap?.mines).toHaveLength(MINESWEEPER_SIZES.easy.mines);
      expect(snap?.mines).not.toContain("A1");
      expect(snap?.status === "playing" || snap?.status === "won").toBe(true);
    }
  });

  it("toggles a flag and will not open that cell until it is cleared", () => {
    minesweeperReply(groupId, undefined, "@alice", { now: 0, rng: () => 0 });
    const flagged = minesweeperReply(groupId, "f B2", "@alice", { now: 1, rng: () => 0 });
    expect(flagged).toContain("💣 @alice flagged B2.");
    expect(flagged).toContain("F");
    expect(minesweeperSnapshot(groupId)?.flags).toEqual(["B2"]);

    const blocked = minesweeperReply(groupId, "reveal B2", "@alice", { now: 2, rng: () => 0 });
    expect(blocked).toContain("B2 is flagged. Unflag it with !minesweeper f B2.");
    expect(minesweeperSnapshot(groupId)?.revealed).toEqual([]);

    const cleared = minesweeperReply(groupId, "unflag B2", "@alice", { now: 3, rng: () => 0 });
    expect(cleared).toContain("💣 @alice unflagged B2.");
    expect(minesweeperSnapshot(groupId)?.flags).toEqual([]);

    const again = minesweeperReply(groupId, "flag B2", "@alice", { now: 4, rng: () => 0 });
    expect(again).toContain("F");
    const toggled = minesweeperReply(groupId, "f B2", "@alice", { now: 5, rng: () => 0 });
    expect(toggled).toContain("💣 @alice unflagged B2.");
  });

  it("rejects a cell off this board and a second open of the same cell", () => {
    minesweeperReply(groupId, "easy", "@alice", { now: 0, rng: () => 0 });
    expect(minesweeperReply(groupId, "r G1", "@alice", { now: 1, rng: () => 0 })).toBe(
      "That cell is off this board. Columns are A–E and rows are 1–5.",
    );
    minesweeperReply(groupId, "r C3", "@alice", { now: 2, rng: () => 0 });
    const again = minesweeperReply(groupId, "r C3", "@alice", { now: 3, rng: () => 0 });
    expect(again).toContain("C3 is already open.");
    expect(minesweeperReply(groupId, "nope", "@alice")).toBe(MINESWEEPER_HELP);
  });

  it("names the winner with a handle, a display name, or someone", () => {
    const handle = playUntilClear(groupId, "@alice", () => 0);
    expect(handle).toContain("💣 @alice cleared the field.");
    expect(handle).toContain("*");
    expect(minesweeperSnapshot(groupId)?.status).toBe("won");

    resetMinesweeperBoards();
    const named = playUntilClear(groupId, "Ada", () => 0);
    expect(named).toContain("💣 Ada cleared the field.");

    resetMinesweeperBoards();
    const snowflake = "1712950172873809920";
    const unnamed = playUntilClear(groupId, snowflake, () => 0);
    expect(unnamed).toContain("💣 someone cleared the field.");
    expect(unnamed).not.toContain(snowflake);
    expect(minesweeperReply(groupId, "r A1", "Ada", { now: 3, rng: () => 0 })).toContain(
      "That game is over.",
    );
  });

  it("names the player who hits a mine and never prints a snowflake", () => {
    const snowflake = "1712950172873809920";
    let seedUsed = -1;
    let mine = "";
    for (let seed = 0; seed < 30; seed += 1) {
      resetMinesweeperBoards();
      const rng = () => seed / 30;
      minesweeperReply(groupId, "easy", "Ada", { now: 0, rng });
      minesweeperReply(groupId, "r A1", "Ada", { now: 1, rng });
      const snap = minesweeperSnapshot(groupId);
      const hidden = snap?.mines.find((label) => !snap.revealed.includes(label));
      if (!snap || snap.status !== "playing" || !hidden) continue;
      seedUsed = seed;
      mine = hidden;
      break;
    }
    expect(seedUsed).toBeGreaterThanOrEqual(0);
    const rng = () => seedUsed / 30;

    resetMinesweeperBoards();
    minesweeperReply(groupId, "easy", "Ada", { now: 0, rng });
    minesweeperReply(groupId, "r A1", "Ada", { now: 1, rng });
    const named = minesweeperReply(groupId, `reveal ${mine}`, "Ada", { now: 2, rng });
    expect(named).toContain("💣 Ada hit a mine.");
    expect(named).toContain("X");
    expect(named).not.toContain(snowflake);

    resetMinesweeperBoards();
    minesweeperReply(groupId, "easy", snowflake, { now: 0, rng });
    minesweeperReply(groupId, "r A1", snowflake, { now: 1, rng });
    const unnamed = minesweeperReply(groupId, `r ${mine}`, snowflake, { now: 2, rng });
    expect(unnamed).toContain("💣 someone hit a mine.");
    expect(unnamed).not.toContain(snowflake);
    expect(minesweeperSnapshot(groupId)?.status).toBe("lost");
  });

  it("drops an idle board after the timeout and keeps a fresh one", () => {
    minesweeperReply(groupId, "easy", "@alice", { now: 1_000, rng: () => 0 });
    const still = minesweeperReply(groupId, "r B2", "@alice", {
      now: 1_000 + MINESWEEPER_TIMEOUT_MS - 1,
      rng: () => 0,
    });
    expect(still).not.toContain("timed out");

    resetMinesweeperBoards();
    minesweeperReply(groupId, "medium", "@alice", { now: 1_000, rng: () => 0 });
    const expired = minesweeperReply(groupId, "f C4", "@alice", {
      now: 1_000 + MINESWEEPER_TIMEOUT_MS,
      rng: () => 0,
    });
    expect(expired).toBe(
      "That minesweeper board timed out. Start again with !minesweeper easy or !minesweeper medium.",
    );
    expect(minesweeperSnapshot(groupId)).toBeUndefined();

    const again = minesweeperReply(groupId, "", "@alice", {
      now: 1_000 + MINESWEEPER_TIMEOUT_MS,
      rng: () => 0,
    });
    expect(again).toContain("easy 5×5");
    expect(minesweeperReply(otherGroupId, "r B2", "@alice", { now: 5, rng: () => 0 })).toBe(
      "No minesweeper board in this chat. Start with !minesweeper easy (5×5) or !minesweeper medium (7×7).",
    );
  });

  it("replaces the board when a new difficulty starts", () => {
    minesweeperReply(groupId, "easy", "@alice", { now: 0, rng: () => 0 });
    minesweeperReply(groupId, "r C3", "@alice", { now: 1, rng: () => 0 });
    const replaced = minesweeperReply(groupId, "7x7", "@alice", { now: 2, rng: () => 0 });
    expect(replaced).toContain("medium 7×7, 8 mines");
    expect(minesweeperSnapshot(groupId)).toMatchObject({
      rows: 7,
      cols: 7,
      mineCount: 8,
      minesPlaced: false,
      revealed: [],
    });
  });
});

describe("!minesweeper command", () => {
  const stores: Store[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    resetMinesweeperBoards();
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

  it("lets a non-admin start, flag, and reveal", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { engine, client } = setup();
    await engine.processEvent(message({ id: "m1", senderId: alice.id, text: "!minesweeper easy" }));
    await engine.processEvent(message({ id: "m2", senderId: alice.id, text: "/minesweeper f B2" }));
    await engine.processEvent(message({ id: "m3", senderId: alice.id, text: "!minesweeper r B2" }));
    await engine.processEvent(message({ id: "m4", senderId: alice.id, text: "!minesweeper nope" }));
    const sent = client.sent.map((row) => row.text);
    expect(sent[0]).toContain("💣 @alice — easy 5×5, 4 mines");
    expect(sent[1]).toContain("💣 @alice flagged B2.");
    expect(sent[2]).toContain("B2 is flagged.");
    expect(sent[3]).toBe(MINESWEEPER_HELP);
    expect(sent.some((text) => /admins/i.test(text))).toBe(false);
  });

  it("resolves a Chat sender and never prints the numeric id", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { engine, client } = setup();
    const snowflake = "1712950172873809920";
    const matt: XUser = { id: snowflake, username: "HisHandle", name: "Matt" };
    const named: XUser = { id: "u-ada", name: "Ada" };
    const missing = "1860000000000000001";
    client.addUser(matt);
    client.addUser(named);

    await engine.processEvent(
      message({
        id: "m5",
        senderId: matt.id,
        sender: undefined,
        text: "!minesweeper",
        conversationId: groupId,
      }),
    );
    await engine.processEvent(
      message({
        id: "m6",
        senderId: named.id,
        sender: undefined,
        text: "!minesweeper medium",
        conversationId: otherGroupId,
      }),
    );
    await engine.processEvent(
      message({
        id: "m7",
        senderId: missing,
        sender: undefined,
        text: "!minesweeper easy",
        conversationId: "1578398451921985540",
      }),
    );

    expect(client.sent.map((row) => row.text)[0]).toContain("💣 @HisHandle — easy 5×5, 4 mines");
    expect(client.sent.map((row) => row.text)[1]).toContain("💣 Ada — medium 7×7, 8 mines");
    expect(client.sent.map((row) => row.text)[2]).toContain("💣 someone — easy 5×5, 4 mines");
    for (const row of client.sent) {
      expect(row.text).not.toContain(snowflake);
      expect(row.text).not.toContain(missing);
    }
  });

  it("uses someone for a short id that has no human name", async () => {
    const { engine, client } = setup();
    const idOnly: XUser = { id: "99" };
    client.addUser(idOnly);
    await engine.processEvent(
      message({ id: "m8", senderId: idOnly.id, sender: idOnly, text: "!minesweeper 5" }),
    );
    expect(client.sent[0]?.text).toContain("💣 someone — easy 5×5, 4 mines");
    expect(client.sent[0]?.text).not.toContain("99");
  });

  it("expires the in-memory board on the engine clock", async () => {
    const { engine, client } = setup();
    await engine.processEvent(
      message({ id: "m9", senderId: alice.id, text: "!minesweeper easy" }),
      5_000,
    );
    await engine.processEvent(
      message({ id: "m10", senderId: alice.id, text: "!minesweeper r C3" }),
      5_000 + MINESWEEPER_TIMEOUT_MS,
    );
    expect(client.sent[1]?.text).toContain("timed out");
    expect(client.sent[1]?.text).not.toContain(alice.id);
  });

  it("does not reply when the event has no sender", async () => {
    const { engine, client } = setup();
    await engine.processEvent({
      id: "m11",
      eventType: "MessageCreate",
      conversationId: groupId,
      participantIds: [],
      participants: [],
      mentions: [],
      text: "!minesweeper",
    });
    expect(client.sent).toEqual([]);
  });

  it("documents minesweeper in help and points at the !games catalog", () => {
    const loaded = loadDefaults("config/default.yaml");
    expect(loaded.help).toMatch(/!minesweeper/);
    expect(loaded.help).toMatch(/5×5/);
    expect(loaded.help).toMatch(/7×7/);
    expect(loaded.help).toMatch(/Full catalog: !games/);
    expect(loaded.help).toMatch(/!dice/);
    expect(loaded.help).toMatch(/!rps/);
  });
});
