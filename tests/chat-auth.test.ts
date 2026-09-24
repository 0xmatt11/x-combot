import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  CHAT_AUTH_ALREADY,
  CHAT_AUTH_CLASSIC,
  CHAT_AUTH_OK,
  ModerationEngine,
} from "../src/bot/engine.js";
import { isChatAuthMessage, parseCommand, parseUnknownBang } from "../src/bot/parser.js";
import { watermarkKey } from "../src/chat/ids.js";
import { CHAT_AUTH_GRANDFATHER_KEY, Store } from "../src/store.js";
import type { BotRuntimeConfig, DefaultsConfig, DmEvent, XUser } from "../src/types.js";
import { MockXClient } from "../src/x/mock-client.js";

const alice: XUser = { id: "u-alice", username: "alice", name: "Alice" };
const matt: XUser = { id: "u-matt", username: "0xMatt66", name: "Matt" };
const admin: XUser = { id: "u-admin", username: "admin", name: "Admin" };
const convoAdmin: XUser = { id: "u-convo", username: "convo", name: "Convo" };
const chatId = "g2029561975647150382";
const classicId = "1578398451921985538";
const knownChat = "g1111111111111111111";
const laterChat = "g2222222222222222222";

const defaults: DefaultsConfig = {
  welcome: { enabled: true, text: "Welcome @{username}!" },
  leave: { enabled: true, text: "@{username} has left" },
  rules: "Be nice.",
  help: "Type !rules",
  flood: { max_messages: 2, window_ms: 60_000, mute_ms: 60_000, warn_on_flood: true },
  warns: { limit: 2, auto_mute_ms: 60_000, notify_admins: true },
  filters: [{ type: "keyword", pattern: "spamlink", case_insensitive: true, warn: true }],
  poll: { interval_ms: 1000, max_results: 50 },
  delete: { attempt_on_filter: true, attempt_on_flood: true, attempt_on_mute: true },
  llm: {
    enabled: true,
    allow: "everyone",
    wake_prefixes: ["!ask"],
    context_mode: "none",
    none_recent_messages: 0,
    recent_messages: 5,
    full_max_messages: 20,
    full_max_chars: 1000,
    truncate: "oldest",
    rate_limit_per_user: 8,
    rate_limit_window_ms: 60_000,
    max_reply_chars: 500,
    max_pages: 1,
    system_prompt: "test",
  },
  xp: {
    enabled: true,
    xp_per_message: 10,
    xp_per_reaction: 5,
    cooldown_ms: 0,
    reactions_enabled: true,
    level_grant_enabled: true,
    level_grant_cooldown_ms: 0,
    leaderboard_size: 10,
  },
};

function runtime(): BotRuntimeConfig {
  return {
    botUserId: "bot-1",
    botUsername: "miladybot669",
    ownerId: matt.id,
    globalAdminIds: [admin.id],
    defaults,
  };
}

function message(partial: Partial<DmEvent> & Pick<DmEvent, "id" | "senderId" | "text">): DmEvent {
  const sender =
    partial.sender ??
    [alice, matt, admin, convoAdmin].find((user) => user.id === partial.senderId);
  return {
    eventType: "MessageCreate",
    conversationId: chatId,
    participantIds: [],
    participants: [],
    mentions: [],
    sender,
    ...partial,
  };
}

function count(store: Store, table: string): number {
  const row = store.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  return row.count;
}

describe("encrypted Chat !auth gate", () => {
  const stores: Store[] = [];
  const dirs: string[] = [];

  afterEach(() => {
    for (const store of stores) store.close();
    stores.length = 0;
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  function setup(file = ":memory:"): { engine: ModerationEngine; client: MockXClient; store: Store } {
    const store = new Store(file);
    stores.push(store);
    const client = new MockXClient();
    client.addUser(alice);
    client.addUser(matt);
    client.addUser(admin);
    client.addUser(convoAdmin);
    const engine = new ModerationEngine(store, client, runtime());
    return { engine, client, store };
  }

  it("ignores commands, chat, welcomes, and the owner's other messages until !auth", async () => {
    const { engine, client, store } = setup();
    store.addConversationAdmin(chatId, convoAdmin.id);

    await engine.processEvent(message({ id: "help", senderId: alice.id, text: "!help" }));
    await engine.processEvent(message({ id: "status", senderId: matt.id, text: "!status" }));
    await engine.processEvent(message({ id: "ask", senderId: alice.id, text: "!ask hello" }));
    await engine.processEvent(message({ id: "please", senderId: matt.id, text: "!auth please" }));
    await engine.processEvent(message({ id: "slash", senderId: matt.id, text: "/auth" }));
    await engine.processEvent(message({ id: "admin-auth", senderId: admin.id, text: "!auth" }));
    await engine.processEvent(message({ id: "convo-auth", senderId: convoAdmin.id, text: "  !AUTH  " }));
    await engine.processEvent(message({ id: "chat", senderId: alice.id, text: "hello spamlink everyone" }));
    await engine.processEvent({
      id: "join-1",
      eventType: "ParticipantsJoin",
      conversationId: chatId,
      participantIds: [alice.id],
      participants: [alice],
      mentions: [],
    });
    await engine.processEvent({
      id: "leave-1",
      eventType: "ParticipantsLeave",
      conversationId: chatId,
      participantIds: [alice.id],
      participants: [alice],
      mentions: [],
    });

    expect(client.sent).toEqual([]);
    expect(store.isChatAuthorized(chatId)).toBe(false);
    expect(count(store, "chat_authorizations")).toBe(0);
    expect(count(store, "flood_events")).toBe(0);
    expect(count(store, "warns")).toBe(0);
    expect(store.getUserXp(chatId, alice.id).xp).toBe(0);
  });

  it("authorizes when Matt sends !auth, persists across a new Store, and then moderates", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "chat-auth-"));
    dirs.push(dir);
    const file = path.join(dir, "bot.sqlite");
    const first = setup(file);

    const ignored = await first.engine.processEvent(
      message({ id: "before", senderId: alice.id, text: "!help" }),
    );
    expect(ignored.replies).toEqual([]);

    const authorized = await first.engine.processEvent(
      message({ id: "auth", senderId: matt.id, text: "  !AuTh  " }),
    );
    expect(authorized.replies).toEqual([`@0xMatt66 ${CHAT_AUTH_OK}`]);
    expect(first.client.sent.map((row) => row.text)).toEqual([`@0xMatt66 ${CHAT_AUTH_OK}`]);
    expect(first.store.isChatAuthorized(chatId)).toBe(true);

    const again = await first.engine.processEvent(
      message({ id: "auth-2", senderId: matt.id, text: "!auth" }),
    );
    expect(again.replies).toEqual([`@0xMatt66 ${CHAT_AUTH_ALREADY}`]);
    expect(count(first.store, "chat_authorizations")).toBe(1);

    const replay = await first.engine.processEvent(
      message({ id: "before", senderId: alice.id, text: "!help" }),
    );
    expect(replay.replies).toEqual([]);

    await first.engine.processEvent(
      message({ id: "after", senderId: alice.id, text: "!help" }),
    );
    expect(first.client.sent.at(-1)?.text).toBe("@alice Type !rules");
    await first.engine.processEvent({
      id: "join-2",
      eventType: "ParticipantsJoin",
      conversationId: chatId,
      participantIds: [alice.id],
      participants: [alice],
      mentions: [],
    });
    expect(first.client.sent.at(-1)?.text).toBe("Welcome @alice!");

    first.store.close();
    stores.pop();

    const restarted = setup(file);
    expect(restarted.store.isChatAuthorized(chatId)).toBe(true);
    await restarted.engine.processEvent(
      message({ id: "restart-help", senderId: alice.id, text: "!help" }),
    );
    expect(restarted.client.sent.map((row) => row.text)).toEqual(["@alice Type !rules"]);
    expect(restarted.store.getUserXp(chatId, alice.id).xp).toBe(0);
  });

  it("leaves classic group DMs ungated and tells the owner !auth is for Chat", async () => {
    const { engine, client } = setup();
    await engine.processEvent(
      message({ id: "classic-help", senderId: alice.id, text: "!help", conversationId: classicId }),
    );
    await engine.processEvent(
      message({ id: "classic-auth", senderId: matt.id, text: "!auth", conversationId: classicId }),
    );
    expect(client.sent.map((row) => row.text)).toEqual([
      "@alice Type !rules",
      `@0xMatt66 ${CHAT_AUTH_CLASSIC}`,
    ]);
  });

  it("grandfathers Chat watermarks that existed before the gate and not ones written after", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "chat-auth-grandfather-"));
    dirs.push(dir);
    const file = path.join(dir, "bot.sqlite");
    const raw = new Database(file);
    raw.exec("CREATE TABLE watermarks (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const insert = raw.prepare("INSERT INTO watermarks (key, value) VALUES (?, ?)");
    insert.run(watermarkKey(knownChat), "evt-old");
    insert.run(watermarkKey(classicId), "evt-dm");
    raw.close();

    const opened = new Store(file);
    stores.push(opened);
    expect(opened.getWatermark(CHAT_AUTH_GRANDFATHER_KEY)).toBe("1");
    expect(opened.isChatAuthorized(knownChat)).toBe(true);
    expect(opened.isChatAuthorized(classicId)).toBe(false);
    opened.setWatermark(watermarkKey(laterChat), "evt-new");
    expect(opened.isChatAuthorized(laterChat)).toBe(false);
    opened.close();
    stores.pop();

    const again = new Store(file);
    stores.push(again);
    expect(again.isChatAuthorized(knownChat)).toBe(true);
    expect(again.isChatAuthorized(laterChat)).toBe(false);

    const client = new MockXClient();
    const engine = new ModerationEngine(again, client, runtime());
    await engine.processEvent(
      message({
        id: "known-help",
        senderId: alice.id,
        text: "!help",
        conversationId: knownChat,
      }),
    );
    await engine.processEvent(
      message({
        id: "later-help",
        senderId: alice.id,
        text: "!help",
        conversationId: laterChat,
      }),
    );
    expect(client.sent.map((row) => row.text)).toEqual(["@alice Type !rules"]);
  });
});

describe("parse !auth", () => {
  it("accepts exact !auth in any case and rejects extras", () => {
    expect(isChatAuthMessage("  !AuTh  ")).toBe(true);
    expect(isChatAuthMessage("!auth")).toBe(true);
    expect(parseCommand("!AUTH")).toEqual({ name: "auth" });
    expect(parseCommand("!auth please")).toBeUndefined();
    expect(parseCommand("/auth")).toBeUndefined();
    expect(parseUnknownBang("!auth")).toBeUndefined();
    expect(parseUnknownBang("!auth please")).toBeUndefined();
    expect(isChatAuthMessage("!auth please")).toBe(false);
    expect(isChatAuthMessage("/auth")).toBe(false);
  });
});
