import { afterEach, describe, expect, it } from "vitest";
import { ModerationEngine } from "../src/bot/engine.js";
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
  flood: { max_messages: 8, window_ms: 10_000, mute_ms: 60_000, warn_on_flood: false },
  warns: { limit: 3, auto_mute_ms: 60_000, notify_admins: false },
  filters: [],
  poll: { interval_ms: 1000, max_results: 50 },
  delete: { attempt_on_filter: false, attempt_on_flood: false, attempt_on_mute: false },
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

describe("reply-target moderation", () => {
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

  it("warns and kicks the replied-to sender when the command omits a user", async () => {
    const { engine, client, store } = setup();
    await engine.processEvent(
      message({
        id: "w-reply",
        senderId: owner.id,
        text: "/warn",
        replyToSenderId: bob.id,
      }),
    );
    await engine.processEvent(
      message({
        id: "k-reply",
        senderId: owner.id,
        text: "!kick",
        replyToSenderId: bob.id,
      }),
    );

    expect(store.getWarnCount(groupId, bob.id)).toBe(2);
    expect(store.getWarnCount(groupId, owner.id)).toBe(0);
    expect(store.isMuted(groupId, bob.id)).toBe(true);
    expect(client.sent.some((row) => /Warned @bob/.test(row.text))).toBe(true);
    expect(client.sent.some((row) => /@bob was warned/.test(row.text))).toBe(true);
  });

  it("prefers an explicit user over the reply, and does not fall back when that user is unknown", async () => {
    const { engine, client, store } = setup();
    await engine.processEvent(
      message({
        id: "w-explicit",
        senderId: owner.id,
        text: "!warn @alice spamming",
        replyToSenderId: bob.id,
        mentions: [{ username: "alice", id: alice.id }],
      }),
    );
    expect(store.getWarnCount(groupId, alice.id)).toBe(1);
    expect(store.getWarnCount(groupId, bob.id)).toBe(0);
    expect(client.sent[0]?.text).toMatch(/Warned @alice \(spamming\)/);

    await engine.processEvent(
      message({
        id: "w-unknown",
        senderId: owner.id,
        text: "/kick @nobody",
        replyToSenderId: bob.id,
      }),
    );
    expect(store.getWarnCount(groupId, bob.id)).toBe(0);
    expect(store.isMuted(groupId, bob.id)).toBe(false);
    expect(client.sent.at(-1)?.text).toMatch(/Could not resolve that user/);
  });

  it("asks who when the command has no user and is not a reply", async () => {
    const { engine, client, store } = setup();
    await engine.processEvent(message({ id: "w-miss", senderId: owner.id, text: "!warn" }));
    await engine.processEvent(message({ id: "k-miss", senderId: owner.id, text: "/kick" }));
    expect(store.getWarnCount(groupId, bob.id)).toBe(0);
    expect(store.getWarnCount(groupId, alice.id)).toBe(0);
    expect(store.isMuted(groupId, bob.id)).toBe(false);
    expect(client.sent.map((row) => row.text)).toEqual([
      "Who? Reply to their message, or pass @user.",
      "Who? Reply to their message, or pass @user.",
    ]);
  });

  it("still requires an admin for a reply-targeted command", async () => {
    const { engine, client, store } = setup();
    await engine.processEvent(
      message({
        id: "w-nonadmin",
        senderId: alice.id,
        text: "/warn",
        replyToSenderId: bob.id,
      }),
    );
    expect(store.getWarnCount(groupId, bob.id)).toBe(0);
    expect(client.sent[0]?.text).toMatch(/limited to configured admins/);
  });

  it("targets the sender of a self-reply, matching an explicit self username", async () => {
    const { engine, store } = setup();
    await engine.processEvent(
      message({
        id: "w-self",
        senderId: owner.id,
        text: "!warn",
        replyToSenderId: owner.id,
      }),
    );
    expect(store.getWarnCount(groupId, owner.id)).toBe(1);
    expect(store.getWarnCount(groupId, bob.id)).toBe(0);
  });

  it("applies reply targets to the other user commands", async () => {
    const { engine, client, store } = setup();
    await engine.processEvent(
      message({
        id: "warns",
        senderId: owner.id,
        text: "!warns",
        replyToSenderId: bob.id,
      }),
    );
    await engine.processEvent(
      message({
        id: "mute",
        senderId: owner.id,
        text: "/mute",
        replyToSenderId: bob.id,
      }),
    );
    expect(store.isMuted(groupId, bob.id)).toBe(true);
    await engine.processEvent(
      message({
        id: "unmute",
        senderId: owner.id,
        text: "!unmute",
        replyToSenderId: bob.id,
      }),
    );
    expect(store.isMuted(groupId, bob.id)).toBe(false);
    await engine.processEvent(
      message({
        id: "warn-for-unwarn",
        senderId: owner.id,
        text: "!warn",
        replyToSenderId: alice.id,
      }),
    );
    await engine.processEvent(
      message({
        id: "unwarn",
        senderId: owner.id,
        text: "/unwarn",
        replyToSenderId: alice.id,
      }),
    );
    expect(store.getWarnCount(groupId, alice.id)).toBe(0);
    await engine.processEvent(
      message({
        id: "admin-add",
        senderId: owner.id,
        text: "!admin add",
        replyToSenderId: bob.id,
      }),
    );
    expect(store.listConversationAdmins(groupId)).toEqual([bob.id]);
    expect(client.sent.some((row) => /@bob has 0\//.test(row.text))).toBe(true);
    expect(client.sent.some((row) => /@bob is soft-muted/.test(row.text))).toBe(true);
    expect(client.sent.some((row) => /@bob is no longer soft-muted/.test(row.text))).toBe(true);
    expect(client.sent.some((row) => /Removed one warning from @alice/.test(row.text))).toBe(true);
    expect(client.sent.some((row) => /@bob can now run mod commands/.test(row.text))).toBe(true);
  });

  it("leaves commands that do not take a user alone when they are replies", async () => {
    const { engine, client, store } = setup();
    await engine.processEvent(
      message({
        id: "help-reply",
        senderId: owner.id,
        text: "!help",
        replyToSenderId: bob.id,
      }),
    );
    await engine.processEvent(
      message({
        id: "note-reply",
        senderId: owner.id,
        text: "!note",
        replyToSenderId: bob.id,
      }),
    );
    expect(store.getWarnCount(groupId, bob.id)).toBe(0);
    expect(client.sent.map((row) => row.text)).toEqual([
      "Type !rules",
      "No notes stored for this group.",
    ]);
  });
});
