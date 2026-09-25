import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { ModerationEngine } from "../src/bot/engine.js";
import {
  CARTOON_LAST_RESORT,
  DARWIN_LINES,
  FINAL_BOSS_LINES,
  LAST_WORDS_LINES,
  OBITUARY_LINES,
  chooseObituarySubject,
  darwinReply,
  epitaphName,
  finalBossReply,
  isCartoonSafe,
  lastWordsReply,
  obituaryReply,
  pickCartoonLine,
} from "../src/bot/epitaph.js";
import { loadDefaults } from "../src/config.js";
import { MockLlmClient } from "../src/llm/mock.js";
import { Store } from "../src/store.js";
import type { BotRuntimeConfig, DefaultsConfig, DmEvent, XUser } from "../src/types.js";
import { MockXClient } from "../src/x/mock-client.js";

const alice: XUser = { id: "u-alice", username: "alice", name: "Alice" };
const bob: XUser = { id: "u-bob", username: "bob", name: "Bob" };
const owner: XUser = { id: "u-owner", username: "owner", name: "Owner" };
const groupId = "1578398451921985538";

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
    enabled: true,
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

const BANKS = [
  ["darwin", DARWIN_LINES],
  ["lastwords", LAST_WORDS_LINES],
  ["obituary", OBITUARY_LINES],
  ["finalboss", FINAL_BOSS_LINES],
] as const;

describe("cartoon bit banks", () => {
  it("keeps a local bank of cartoon lines and rejects real-world methods", () => {
    for (const [name, lines] of BANKS) {
      expect(lines.length, name).toBeGreaterThanOrEqual(20);
      expect(lines.length, name).toBeLessThanOrEqual(40);
      for (const line of lines) {
        expect(isCartoonSafe(line), `${name}: ${line}`).toBe(true);
        expect(line, name).not.toMatch(/telegram/i);
        expect(line, name).not.toMatch(/\bhow to\b/i);
      }
    }
    for (const line of [...DARWIN_LINES, ...OBITUARY_LINES, ...FINAL_BOSS_LINES]) {
      expect(line).toContain("{who}");
      expect(isCartoonSafe(line.replaceAll("{who}", "@alice"))).toBe(true);
      expect(isCartoonSafe(line.replaceAll("{who}", "this chat"))).toBe(true);
    }
    for (const line of LAST_WORDS_LINES) {
      expect(line).not.toContain("{who}");
    }
    expect(isCartoonSafe("")).toBe(false);
    expect(isCartoonSafe("a rope")).toBe(false);
    expect(isCartoonSafe("take pills")).toBe(false);
    expect(isCartoonSafe("carbon monoxide")).toBe(false);
    expect(pickCartoonLine(["a rope", "a firearm"], "a pie and a honk", () => 0)).toBe(
      "a pie and a honk",
    );
    expect(pickCartoonLine(["a rope"], "a firearm", () => 0)).toBe(CARTOON_LAST_RESORT);
  });

  it("draws one line and names the subject", () => {
    expect(epitaphName("  ")).toBe("this chat");
    expect(epitaphName("@alice")).toBe("@alice");
    expect(chooseObituarySubject({ named: "@bob", reply: "@alice", requester: "@owner" })).toBe(
      "@bob",
    );
    expect(chooseObituarySubject({ reply: "@alice", requester: "@owner" })).toBe("@alice");
    expect(chooseObituarySubject({ requester: "@owner" })).toBe("@owner");
    expect(chooseObituarySubject({})).toBe("this chat");
    expect(darwinReply("@alice", () => 0)).toBe(DARWIN_LINES[0]!.replaceAll("{who}", "@alice"));
    expect(lastWordsReply(() => 0)).toBe(LAST_WORDS_LINES[0]);
    expect(obituaryReply("this chat", () => 0)).toBe(
      OBITUARY_LINES[0]!.replaceAll("{who}", "this chat"),
    );
    expect(finalBossReply("@alice", () => 0)).toBe(
      FINAL_BOSS_LINES[0]!.replaceAll("{who}", "@alice"),
    );
    expect(darwinReply("@alice", () => 0)).not.toContain("{who}");
  });
});

describe("cartoon bit commands", () => {
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

  it("posts one canned line for !darwin, !lastwords, and !finalboss and does not call the LLM", async () => {
    const llm = new MockLlmClient("this should not be used");
    const { engine, client } = setup(llm);

    await engine.processEvent(
      message({ id: "d1", senderId: alice.id, text: "!darwin please more", sequenceId: "9" }),
    );
    expect(client.sent[0]?.text).toBe(darwinReply("@alice", () => 0));
    expect(client.sent[0]?.replyToSequenceId).toBe("9");

    await engine.processEvent(message({ id: "l1", senderId: alice.id, text: "/lastwords a speech" }));
    expect(client.sent[1]?.text).toBe(`@alice ${lastWordsReply(() => 0)}`);

    await engine.processEvent(message({ id: "f1", senderId: alice.id, text: "!FINALBOSS phase two" }));
    expect(client.sent[2]?.text).toBe(finalBossReply("@alice", () => 0));
    expect(llm.calls).toHaveLength(0);
    expect(client.sent.every((row) => isCartoonSafe(row.text))).toBe(true);
  });

  it("roasts the mention, the reply, or the requester", async () => {
    const { engine, client } = setup();

    await engine.processEvent(message({ id: "o1", senderId: alice.id, text: "!obituary @bob" }));
    expect(client.sent[0]?.text).toBe(`@alice ${obituaryReply("@bob", () => 0)}`);

    await engine.processEvent(
      message({
        id: "o2",
        senderId: alice.id,
        text: "!obituary",
        replyToSenderId: bob.id,
      }),
    );
    expect(client.sent[1]?.text).toBe(`@alice ${obituaryReply("@bob", () => 0)}`);

    await engine.processEvent(
      message({
        id: "o3",
        senderId: alice.id,
        text: "!obituary",
        replyToSenderId: "bot-1",
      }),
    );
    expect(client.sent[2]?.text).toBe(obituaryReply("@alice", () => 0));

    await engine.processEvent(message({ id: "o4", senderId: alice.id, text: "/obituary" }));
    expect(client.sent[3]?.text).toBe(obituaryReply("@alice", () => 0));

    await engine.processEvent(
      message({
        id: "o5",
        senderId: alice.id,
        text: "!obituary Bobby Tables",
        participants: [{ id: bob.id, name: "Bobby Tables" }],
      }),
    );
    expect(client.sent[4]?.text).toBe(`@alice ${obituaryReply("Bobby Tables", () => 0)}`);
  });

  it("refuses the bot and an unknown name, and @mention wins over a reply", async () => {
    const { engine, client } = setup();

    await engine.processEvent(message({ id: "b1", senderId: alice.id, text: "!obituary @modbot" }));
    expect(client.sent[0]?.text).toBe("@alice Pick someone else.");

    await engine.processEvent(
      message({
        id: "b2",
        senderId: alice.id,
        text: "!obituary @nobody",
        replyToSenderId: bob.id,
      }),
    );
    expect(client.sent[1]?.text).toBe("@alice Could not resolve that user.");

    await engine.processEvent(
      message({
        id: "b3",
        senderId: alice.id,
        text: "!obituary @bob",
        replyToSenderId: owner.id,
      }),
    );
    expect(client.sent[2]?.text).toBe(`@alice ${obituaryReply("@bob", () => 0)}`);
  });

  it("is listed in the default !help text and the README", () => {
    const help = loadDefaults("config/default.yaml").help;
    expect(help).toMatch(/!darwin — one cartoon how-they-went-out bit/);
    expect(help).toMatch(/!lastwords — one dramatic or dumb last line/);
    expect(help).toMatch(/!obituary — short fake roast obituary/);
    expect(help).toMatch(/!finalboss — a ridiculous video-game boss goes down/);
    const readme = fs.readFileSync("README.md", "utf8");
    expect(readme).toMatch(/\| `!darwin` \|/);
    expect(readme).toMatch(/\| `!lastwords` \|/);
    expect(readme).toMatch(/\| `!obituary` \|/);
    expect(readme).toMatch(/\| `!finalboss` \|/);
    expect(readme).toMatch(/## Cartoon bits/);
    expect(readme).toMatch(/do not describe real-world methods/);
    expect(readme).toMatch(/do not cost XP/);
  });
});
