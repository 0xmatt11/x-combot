import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { ModerationEngine } from "../src/bot/engine.js";
import { momJoke } from "../src/bot/troll.js";
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

describe("!roast", () => {
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

  it("dunks once from chat history and the public timeline, and replies to the requester", async () => {
    const llm = new MockLlmClient("@bob that pineapple loyalty is a cry for help.");
    const { engine, client, store } = setup(llm);
    client.posts.set(bob.id, ["bought a car and immediately named it Kevin"]);
    client.events.push(
      message({
        id: "old",
        senderId: bob.id,
        text: "I love pineapple pizza",
        createdAt: "2026-01-01T00:00:01Z",
      }),
    );
    client.events.push(
      message({
        id: "old2",
        senderId: bob.id,
        text: "the crust is a lifestyle",
        createdAt: "2026-01-01T00:00:02Z",
      }),
    );

    await engine.processEvent(
      message({
        id: "cmd",
        senderId: alice.id,
        text: "!roast @bob",
        sequenceId: "44",
        encodedEvent: "blob-roast",
      }),
    );

    expect(store.getTrollTarget(groupId)).toBeUndefined();
    expect(client.sent).toHaveLength(1);
    expect(client.sent[0]).toMatchObject({
      text: "@alice @bob that pineapple loyalty is a cry for help.",
      replyToSequenceId: "44",
      replyToEvent: "blob-roast",
    });
    expect(client.sent[0]?.text).not.toContain(bob.id);
    const prompt = llm.calls[0]?.[1]?.content ?? "";
    expect(llm.calls[0]?.[0]?.content).toMatch(/Never mention minors/);
    expect(prompt).toContain("I love pineapple pizza");
    expect(prompt).toContain("the crust is a lifestyle");
    expect(prompt).toContain("bought a car and immediately named it Kevin");
    expect(prompt).toContain("Chat history: enough recent lines.");
    expect(prompt).not.toContain(bob.id);
    expect(client.conversationListCalls[0]?.conversationId).toBe(groupId);
  });

  it("says chat history is thin and still uses the timeline", async () => {
    const llm = new MockLlmClient("@bob your timeline is doing the talking.");
    const { engine, client } = setup(llm);
    client.posts.set(bob.id, ["posted a selfie of the same coffee"]);
    client.events.push(
      message({
        id: "only",
        senderId: bob.id,
        text: "hey",
        createdAt: "2026-01-01T00:00:01Z",
      }),
    );

    await engine.processEvent(message({ id: "cmd", senderId: alice.id, text: "/roast @bob" }));

    expect(client.sent[0]?.text).toBe(
      "@alice Not much from them in this chat. @bob your timeline is doing the talking.",
    );
    const prompt = llm.calls[0]?.[1]?.content ?? "";
    expect(prompt).toContain("Chat history: thin.");
    expect(prompt).toContain("hey");
    expect(prompt).toContain("posted a selfie of the same coffee");
  });

  it("resolves a reply with no name and a display name, and does not start troll mode", async () => {
    const llm = new MockLlmClient("@bob still just one roast.");
    const { engine, client, store } = setup(llm);
    client.posts.set(bob.id, ["public post"]);
    client.events.push(
      message({
        id: "h1",
        senderId: bob.id,
        text: "first line in chat",
        createdAt: "2026-01-01T00:00:01Z",
      }),
      message({
        id: "h2",
        senderId: bob.id,
        text: "second line in chat",
        createdAt: "2026-01-01T00:00:02Z",
      }),
    );

    await engine.processEvent(
      message({
        id: "reply",
        senderId: alice.id,
        text: "!roast",
        replyToSenderId: bob.id,
      }),
    );
    expect(store.getTrollTarget(groupId)).toBeUndefined();
    expect(client.sent.at(-1)?.text).toContain("@bob still just one roast.");

    await engine.processEvent(
      message({
        id: "name",
        senderId: alice.id,
        text: "!roast Bobby Tables",
        participants: [{ id: bob.id, name: "Bobby Tables" }],
      }),
    );
    expect(store.getTrollTarget(groupId)).toBeUndefined();
    expect(client.sent).toHaveLength(2);
    expect(llm.calls).toHaveLength(2);
  });

  it("asks who when there is no target, and falls back when the LLM is off", async () => {
    const { engine, client } = setup();
    await engine.processEvent(message({ id: "bare", senderId: alice.id, text: "!roast" }));
    expect(client.sent.at(-1)?.text).toBe(
      "@alice Who? `!roast @user` dunks that person once. Reply to their message or name them.",
    );

    await engine.processEvent(message({ id: "named", senderId: alice.id, text: "!roast @bob" }));
    expect(client.sent.at(-1)?.text).toContain("Not much from them in this chat.");
    expect(client.sent.at(-1)?.text).toContain(momJoke("@bob", () => 0));
  });

  it("is listed in the default help text and the readme", () => {
    const loaded = loadDefaults("config/default.yaml");
    expect(loaded.help).toMatch(/!roast @user/);
    expect(loaded.help).toMatch(/Does not turn on !troll/);
    const readme = fs.readFileSync("README.md", "utf8");
    expect(readme).toMatch(/\| `!roast @user` \|/);
    expect(readme).toMatch(/## Roast/);
  });
});
