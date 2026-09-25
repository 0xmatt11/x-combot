import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModerationEngine } from "../src/bot/engine.js";
import {
  TRIVIA_QUESTIONS,
  clearHigherLowerSessions,
  clearWouldYouRatherSessions,
  compatibility,
  deterministicTriviaChoice,
  gamesMenu,
  resolveShipQuery,
  shipReply,
} from "../src/bot/games/index.js";
import { loadDefaults, DEFAULT_LLM_CONFIG } from "../src/config.js";
import { MockLlmClient } from "../src/llm/mock.js";
import { Store } from "../src/store.js";
import type { BotRuntimeConfig, DefaultsConfig, DmEvent, XUser } from "../src/types.js";
import { MockXClient } from "../src/x/mock-client.js";

const alice: XUser = { id: "u-alice", username: "alice", name: "Alice" };
const bob: XUser = { id: "u-bob", username: "bob", name: "Bob" };
const owner: XUser = { id: "u-owner", username: "owner", name: "Owner" };
const matt: XUser = { id: "u-matt", username: "0xMatt66", name: "Matt" };
const milady: XUser = { id: "u-milady", username: "miladybot669", name: "Milady" };
const groupId = "1578398451921985538";

const defaults: DefaultsConfig = {
  welcome: { enabled: true, text: "Welcome @{username}!" },
  rules: "Be nice.",
  help: "Type !rules",
  flood: { max_messages: 8, window_ms: 10_000, mute_ms: 60_000, warn_on_flood: true },
  warns: { limit: 2, auto_mute_ms: 60_000, notify_admins: true },
  filters: [],
  poll: { interval_ms: 1000, max_results: 50 },
  delete: { attempt_on_filter: true, attempt_on_flood: true, attempt_on_mute: true },
  llm: {
    ...DEFAULT_LLM_CONFIG,
    enabled: true,
    allow: "everyone",
    context_mode: "none",
    recent_messages: 2,
    none_recent_messages: 0,
    rate_limit_per_user: 20,
    rate_limit_window_ms: 60_000,
  },
};

function message(partial: Partial<DmEvent> & Pick<DmEvent, "id" | "senderId" | "text">): DmEvent {
  const known = [alice, bob, owner, matt, milady].find((user) => user.id === partial.senderId);
  const sender = partial.sender ?? known;
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

describe("loose trivia choices", () => {
  it("reads a letter, a bang, a glued command, and a short phrase", () => {
    expect(deterministicTriviaChoice("a")).toBe(0);
    expect(deterministicTriviaChoice("A")).toBe(0);
    expect(deterministicTriviaChoice("!a")).toBe(0);
    expect(deterministicTriviaChoice("!A")).toBe(0);
    expect(deterministicTriviaChoice("!trivia c")).toBe(2);
    expect(deterministicTriviaChoice("!triviac")).toBe(2);
    expect(deterministicTriviaChoice("!triviaa")).toBe(0);
    expect(deterministicTriviaChoice("/quizb")).toBe(1);
    expect(deterministicTriviaChoice("c")).toBe(2);
    expect(deterministicTriviaChoice("i think it's A")).toBe(0);
    expect(deterministicTriviaChoice("I think it's A")).toBe(0);
    expect(deterministicTriviaChoice("go with b")).toBe(1);
    expect(deterministicTriviaChoice("hello")).toBeUndefined();
    expect(deterministicTriviaChoice("!banana")).toBeUndefined();
  });
});

describe("!ship names", () => {
  const members = [matt, milady, alice];

  it("matches @handles and partial display names", () => {
    const handles = shipReply("@0xMatt66 @miladybot669", members, alice.id);
    expect(handles).toContain("@0xMatt66");
    expect(handles).toContain("@miladybot669");
    expect(handles).toMatch(/\d+%/);

    const partial = shipReply("Matt Milady", members, alice.id);
    expect(partial).toContain("@0xMatt66");
    expect(partial).toContain("@miladybot669");
    expect(partial).toMatch(/\d+%/);
    expect(shipReply("matt milady", members, alice.id)).toBe(partial);

    expect(compatibility(matt.id, milady.id)).toBe(compatibility(milady.id, matt.id));
  });

  it("matches a first name and a handle substring, and asks when two people fit", () => {
    const named = resolveShipQuery("Matt", [{ id: "1", username: "0xMatt66", name: "Matt Jones" }]);
    expect(named.ok && named.user.id).toBe("1");
    const handle = resolveShipQuery("Milady", [{ id: "2", username: "miladybot669" }]);
    expect(handle.ok && handle.user.id).toBe("2");

    const ambiguous = shipReply("Matt Milady", [
      matt,
      { id: "u-matt-2", username: "matt_b", name: "Matt" },
      milady,
    ], alice.id);
    expect(ambiguous).toMatch(/Which Matt\?/);
    expect(shipReply("@nobody @miladybot669", members, alice.id)).toContain("Couldn't find nobody");
  });
});

describe("active game answers", () => {
  const stores: Store[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    clearHigherLowerSessions();
    clearWouldYouRatherSessions();
    for (const store of stores) store.close();
    stores.length = 0;
  });

  function setup(llm?: MockLlmClient): {
    engine: ModerationEngine;
    client: MockXClient;
    llm: MockLlmClient;
  } {
    const store = new Store(":memory:");
    stores.push(store);
    const client = new MockXClient();
    client.addUser(alice);
    client.addUser(bob);
    client.addUser(owner);
    client.addUser(matt);
    client.addUser(milady);
    const config: BotRuntimeConfig = {
      botUserId: "bot-1",
      botUsername: "modbot",
      ownerId: owner.id,
      globalAdminIds: [],
      defaults,
    };
    const model = llm ?? new MockLlmClient("isn't on my roster — maybe it's trivia");
    const engine = new ModerationEngine(store, client, config, model);
    return { engine, client, llm: model };
  }

  async function ask(engine: ModerationEngine, id: string): Promise<void> {
    await engine.processEvent(message({ id, senderId: alice.id, text: "!trivia" }));
  }

  it("scores loose answers for the player who replies, including someone else's question", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { engine, client, llm } = setup();
    await ask(engine, "q1");
    await engine.processEvent(message({ id: "a1", senderId: bob.id, text: "!trivia c" }));
    expect(client.sent[1]?.text).not.toContain("No trivia question");
    expect(client.sent[1]?.text).toMatch(/@bob — (correct|nope)/);
    expect(client.sent[1]?.text).toContain("@bob:");

    await ask(engine, "q2");
    await engine.processEvent(message({ id: "a2", senderId: bob.id, text: "a" }));
    await ask(engine, "q3");
    await engine.processEvent(message({ id: "a3", senderId: bob.id, text: "!a" }));
    await ask(engine, "q4");
    await engine.processEvent(message({ id: "a4", senderId: bob.id, text: "!triviac" }));
    await ask(engine, "q5");
    await engine.processEvent(message({ id: "a5", senderId: bob.id, text: "i think it's A" }));

    const answers = ["a1", "a2", "a3", "a4", "a5"].map((_, index) => client.sent[index * 2 + 1]?.text ?? "");
    for (const text of answers) {
      expect(text).toContain("@bob — nope.");
      expect(text).toContain("was b)");
      expect(text).not.toContain("isn't on my roster");
      expect(text).not.toContain("No trivia question");
    }
    await ask(engine, "q6");
    await engine.processEvent(message({ id: "a6", senderId: bob.id, text: "i think it's B" }));
    expect(client.sent.at(-1)?.text).toContain("@bob — correct.");
    expect(client.sent.at(-1)?.text).toMatch(/right/);
    expect(llm.calls).toHaveLength(0);
    expect(client.sent.some((row) => row.text.includes(bob.id))).toBe(false);
  });

  it("uses the chat model only for an ambiguous answer, and leaves ordinary chat alone", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const llm = new MockLlmClient("B");
    const { engine, client } = setup(llm);
    await ask(engine, "q1");
    await engine.processEvent(
      message({
        id: "chat",
        senderId: bob.id,
        text: "Gonna add LLM interpretation for all command replies for games , shits kinda clunky",
      }),
    );
    await engine.processEvent(message({ id: "hi", senderId: bob.id, text: "hello" }));
    expect(llm.calls).toHaveLength(0);
    expect(client.sent).toHaveLength(1);

    await engine.processEvent(message({ id: "guess", senderId: bob.id, text: "the third one" }));
    expect(llm.calls).toHaveLength(1);
    const system = llm.calls[0]?.[0]?.content ?? "";
    const user = llm.calls[0]?.[1]?.content ?? "";
    expect(system).toMatch(/NONE/);
    expect(user).toContain(TRIVIA_QUESTIONS[0]!.prompt);
    expect(user).toContain("the third one");
    expect(client.sent[1]?.text).toContain("@bob — correct.");
    expect(client.sent[1]?.text).not.toContain("isn't on my roster");
  });

  it("still jokes about an unknown bang when no game is open", async () => {
    const llm = new MockLlmClient("the goat has left the chat");
    const { engine, client } = setup(llm);
    await engine.processEvent(message({ id: "u1", senderId: alice.id, text: "!banana" }));
    await engine.processEvent(message({ id: "u2", senderId: alice.id, text: "!triviac" }));
    expect(client.sent.map((row) => row.text)).toEqual([
      "@alice the goat has left the chat",
      "@alice the goat has left the chat",
    ]);
    expect(llm.calls[0]?.[1]?.content).toContain("!banana");
    expect(llm.calls[1]?.[1]?.content).toContain("!triviac");
    expect(llm.calls[1]?.[0]?.content).toMatch(/does not implement/);
  });

  it("ships @handles on the message and names learned from earlier lines", async () => {
    const { engine, client, llm } = setup();
    await engine.processEvent(
      message({
        id: "s1",
        senderId: alice.id,
        text: "!ship @0xMatt66 @miladybot669",
        participants: [alice, matt, milady],
      }),
    );
    expect(client.sent[0]?.text).toContain("@0xMatt66");
    expect(client.sent[0]?.text).toContain("@miladybot669");
    expect(client.sent[0]?.text).toMatch(/\d+%/);
    expect(client.sent[0]?.text.startsWith("@alice ")).toBe(true);

    await engine.processEvent(message({ id: "p1", senderId: matt.id, sender: matt, text: "hey" }));
    await engine.processEvent(message({ id: "p2", senderId: milady.id, sender: milady, text: "yo" }));
    await engine.processEvent(message({ id: "s2", senderId: alice.id, text: "!ship Matt Milady" }));
    expect(client.sent[1]?.text).toContain("@0xMatt66");
    expect(client.sent[1]?.text).toContain("@miladybot669");
    expect(llm.calls).toHaveLength(0);
  });

  it("takes a bare square on your turn and a bare higher/lower call", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { engine, client } = setup();
    await engine.processEvent(message({ id: "t1", senderId: alice.id, text: "!tictactoe @bob" }));
    await engine.processEvent(message({ id: "t2", senderId: bob.id, text: "5" }));
    expect(client.sent[1]?.text).toContain("X");
    expect(client.sent[1]?.text).not.toContain("isn't on my roster");

    await engine.processEvent(message({ id: "h1", senderId: alice.id, text: "!higherlower" }));
    await engine.processEvent(message({ id: "h2", senderId: alice.id, text: "higher" }));
    expect(client.sent.at(-1)?.text).toMatch(/higher|lower|push|miss|Streak/i);
  });

  it("documents loose answers and !ship in help", () => {
    const loaded = loadDefaults("config/default.yaml");
    expect(loaded.help).toMatch(/Open round: a letter, !a, or a short phrase/);
    expect(loaded.help).toMatch(/!ship/);
    expect(gamesMenu()).toMatch(/Open round: a letter, !a, or a short phrase/);
    expect(gamesMenu()).toContain("!ship —");
    const readme = fs.readFileSync("README.md", "utf8");
    expect(readme).toMatch(/one session for the conversation/);
    expect(readme).toMatch(/!triviac/);
    expect(readme).toMatch(/!ship Matt Milady/);
  });
});
