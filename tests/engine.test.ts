import { afterEach, describe, expect, it } from "vitest";
import { ModerationEngine } from "../src/bot/engine.js";
import { collectNewEvents } from "../src/poller.js";
import { Store } from "../src/store.js";
import type { BotRuntimeConfig, DefaultsConfig, DmEvent, XUser } from "../src/types.js";
import { MockXClient } from "../src/x/mock-client.js";

const alice: XUser = { id: "u-alice", username: "alice", name: "Alice" };
const bob: XUser = { id: "u-bob", username: "bob", name: "Bob" };
const owner: XUser = { id: "u-owner", username: "owner", name: "Owner" };
const groupId = "1578398451921985538";

const defaults: DefaultsConfig = {
  welcome: { enabled: true, text: "Welcome @{username}!" },
  rules: "Be nice.",
  help: "Type !rules",
  flood: { max_messages: 3, window_ms: 10_000, mute_ms: 60_000, warn_on_flood: true },
  warns: { limit: 2, auto_mute_ms: 60_000, notify_admins: true },
  filters: [{ type: "keyword", pattern: "spamlink", case_insensitive: true, warn: true }],
  poll: { interval_ms: 1000, max_results: 50 },
  delete: { attempt_on_filter: true, attempt_on_flood: true, attempt_on_mute: true },
};

function runtime(): BotRuntimeConfig {
  return {
    botUserId: "bot-1",
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

describe("ModerationEngine", () => {
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
    client.addUser(owner);
    const engine = new ModerationEngine(store, client, runtime());
    return { engine, client, store };
  }

  it("sends a welcome on ParticipantsJoin", async () => {
    const { engine, client } = setup();
    await engine.processEvent({
      id: "join-1",
      eventType: "ParticipantsJoin",
      conversationId: groupId,
      senderId: owner.id,
      participantIds: [alice.id],
      participants: [alice],
      mentions: [],
    });
    expect(client.sent[0]?.text).toBe("Welcome @alice!");
  });

  it("replies to !rules and !help in the group", async () => {
    const { engine, client } = setup();
    await engine.processEvent(message({ id: "m1", senderId: alice.id, text: "!rules" }));
    await engine.processEvent(message({ id: "m2", senderId: alice.id, text: "!help" }));
    expect(client.sent.map((row) => row.text)).toEqual(["Be nice.", "Type !rules"]);
  });

  it("rejects mod commands from non-admins", async () => {
    const { engine, client, store } = setup();
    await engine.processEvent(
      message({ id: "m3", senderId: alice.id, text: "!warn @bob" }),
    );
    expect(client.sent[0]?.text).toMatch(/limited to configured admins/);
    expect(store.getWarnCount(groupId, bob.id)).toBe(0);
  });

  it("tracks warns and auto-mutes at the limit", async () => {
    const { engine, client, store } = setup();
    await engine.processEvent(
      message({
        id: "w1",
        senderId: owner.id,
        text: "!warn @bob spam",
        mentions: [{ username: "bob", id: bob.id }],
      }),
    );
    await engine.processEvent(
      message({
        id: "w2",
        senderId: owner.id,
        text: "!warn @bob again",
        mentions: [{ username: "bob", id: bob.id }],
      }),
    );
    expect(store.getWarnCount(groupId, bob.id)).toBe(2);
    expect(store.isMuted(groupId, bob.id)).toBe(true);
    expect(client.sent.some((row) => /warn limit/i.test(row.text))).toBe(true);
    expect(client.direct.some((row) => row.participantId === owner.id)).toBe(true);
  });

  it("stores and retrieves admin notes", async () => {
    const { engine, client } = setup();
    await engine.processEvent(
      message({ id: "n1", senderId: owner.id, text: "!note topic meetup friday" }),
    );
    await engine.processEvent(message({ id: "n2", senderId: owner.id, text: "!get topic" }));
    expect(client.sent.map((row) => row.text)).toEqual([
      'Saved note "topic".',
      "topic: meetup friday",
    ]);
  });

  it("attempts delete on !del and reports X ownership limitation", async () => {
    const { engine, client } = setup();
    await engine.processEvent(message({ id: "user-msg", senderId: bob.id, text: "hello" }));
    await engine.processEvent(message({ id: "del-1", senderId: owner.id, text: "!del" }));
    expect(client.sent.at(-1)?.text).toMatch(/Could not delete/);
    expect(client.deleted).toEqual([]);
  });

  it("detects flood, attempts delete, and soft-mutes", async () => {
    const { engine, client, store } = setup();
    const now = 1_000_000;
    await engine.processEvent(message({ id: "f1", senderId: bob.id, text: "a" }), now);
    await engine.processEvent(message({ id: "f2", senderId: bob.id, text: "b" }), now + 1);
    await engine.processEvent(message({ id: "f3", senderId: bob.id, text: "c" }), now + 2);
    const result = await engine.processEvent(
      message({ id: "f4", senderId: bob.id, text: "d" }),
      now + 3,
    );
    expect(result.muted).toBe(true);
    expect(store.isMuted(groupId, bob.id, now + 4)).toBe(true);
    expect(client.sent.some((row) => /flooding/i.test(row.text))).toBe(true);
  });

  it("filters keyword messages and warns", async () => {
    const { engine, store } = setup();
    await engine.processEvent(
      message({ id: "spam-1", senderId: bob.id, text: "buy spamlink now" }),
    );
    expect(store.getWarnCount(groupId, bob.id)).toBe(1);
  });

  it("ignores one-to-one conversations", async () => {
    const { engine, client } = setup();
    await engine.processEvent({
      id: "dm-1",
      eventType: "ParticipantsJoin",
      conversationId: "111-222",
      participantIds: [alice.id],
      participants: [alice],
      mentions: [],
    });
    expect(client.sent).toHaveLength(0);
  });

  it("skips the bot's own messages", async () => {
    const { engine, client } = setup();
    await engine.processEvent(
      message({ id: "bot-msg", senderId: "bot-1", text: "!rules" }),
    );
    expect(client.sent).toHaveLength(0);
  });
});

describe("collectNewEvents", () => {
  it("returns oldest-first events newer than the watermark", () => {
    const events: DmEvent[] = ["3", "2", "1"].map((id) => ({
      id,
      eventType: "MessageCreate",
      conversationId: groupId,
      participantIds: [],
      participants: [],
      mentions: [],
    }));
    expect(collectNewEvents(events, "1").map((event) => event.id)).toEqual(["2", "3"]);
    expect(collectNewEvents(events, "3")).toEqual([]);
  });
});
