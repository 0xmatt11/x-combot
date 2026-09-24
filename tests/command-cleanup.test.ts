import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMMAND_CLEANUP_MS, ModerationEngine } from "../src/bot/engine.js";
import { loadDefaults } from "../src/config.js";
import { Store } from "../src/store.js";
import type { BotRuntimeConfig, DefaultsConfig, DmEvent, XUser } from "../src/types.js";
import { MockXClient } from "../src/x/mock-client.js";

const alice: XUser = { id: "u-alice", username: "alice", name: "Alice" };
const bob: XUser = { id: "u-bob", username: "bob", name: "Bob" };
const owner: XUser = { id: "u-owner", username: "owner", name: "Owner" };
const groupId = "1578398451921985538";
const chatId = "g1578398451921985538";

const defaults: DefaultsConfig = {
  welcome: { enabled: true, text: "Welcome @{username}!" },
  rules: "Be nice.",
  help: "Type !rules",
  flood: { max_messages: 0, window_ms: 10_000, mute_ms: 60_000, warn_on_flood: false },
  warns: { limit: 3, auto_mute_ms: 60_000, notify_admins: false },
  filters: [],
  poll: { interval_ms: 1000, max_results: 50 },
  delete: { attempt_on_filter: false, attempt_on_flood: false, attempt_on_mute: false },
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

function message(partial: Partial<DmEvent> & Pick<DmEvent, "id" | "text">): DmEvent {
  const senderId = partial.senderId ?? alice.id;
  const sender =
    partial.sender ??
    [alice, bob, owner].find((user) => user.id === senderId);
  return {
    eventType: "MessageCreate",
    conversationId: groupId,
    participantIds: [],
    participants: [],
    mentions: [],
    senderId,
    sender,
    ...partial,
  };
}

describe("command cleanup", () => {
  const stores: Store[] = [];

  afterEach(() => {
    vi.useRealTimers();
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
    const engine = new ModerationEngine(store, client, runtime(), undefined, {
      commandCleanupMs: COMMAND_CLEANUP_MS,
      imagine: {
        async generate() {
          return { bytes: Uint8Array.from([1, 2, 3]), mimeType: "image/jpeg" };
        },
      },
      video: {
        async generate() {
          return { url: "https://cdn.example/clip.mp4", width: 16, height: 9 };
        },
      },
    });
    return { engine, client, store };
  }

  async function age(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
  }

  it("leaves the help reply up and cannot delete a classic command", async () => {
    vi.useFakeTimers();
    const { engine, client } = setup();
    await engine.processEvent(message({ id: "cmd-help", text: "!help" }));
    expect(client.sent).toHaveLength(1);
    expect(client.sent[0]?.text).toContain("Type !rules");

    await age(COMMAND_CLEANUP_MS - 1);
    expect(client.deleted).toEqual([]);
    await age(1);
    expect(client.deleted).toEqual([]);
    expect(client.sent).toHaveLength(1);
  });

  it("deletes the Chat command only, and keeps !auth plus the confirmation", async () => {
    vi.useFakeTimers();
    const { engine, client, store } = setup();
    store.authorizeChat(chatId);

    await engine.processEvent(
      message({
        id: "cmd-rules",
        senderId: alice.id,
        conversationId: chatId,
        text: "!rules",
        sequenceId: "41",
      }),
    );
    store.rememberChatMessage("sent-1", chatId, "88");
    const rulesReply = client.sent[0]?.text ?? "";
    await age(COMMAND_CLEANUP_MS);
    expect(client.deleted).toEqual(["cmd-rules"]);
    expect(client.sent[0]?.text).toBe(rulesReply);

    await engine.processEvent(
      message({
        id: "cmd-auth",
        senderId: owner.id,
        sender: owner,
        conversationId: chatId,
        text: "!auth",
        sequenceId: "42",
      }),
    );
    expect(store.isChatAuthorized(chatId)).toBe(true);
    expect(client.sent.at(-1)?.text).toMatch(/already authorized/i);
    store.rememberChatMessage("sent-2", chatId, "89");
    await age(COMMAND_CLEANUP_MS);
    expect(client.deleted).toEqual(["cmd-rules", "cmd-auth"]);
    expect(client.sent.at(-1)?.text).toMatch(/already authorized/i);
    expect(store.isChatAuthorized(chatId)).toBe(true);
  });

  it("skips a Chat command that has no sequence id and still keeps the reply", async () => {
    vi.useFakeTimers();
    const { engine, client, store } = setup();
    store.authorizeChat(chatId);
    await engine.processEvent(
      message({
        id: "cmd-help",
        conversationId: chatId,
        text: "!help",
      }),
    );
    expect(client.sent).toHaveLength(1);
    await age(COMMAND_CLEANUP_MS);
    expect(client.deleted).toEqual([]);
    expect(client.sent).toHaveLength(1);
  });

  it("keeps a warn confirmation and the warning", async () => {
    vi.useFakeTimers();
    const { engine, client, store } = setup();
    await engine.processEvent(
      message({ id: "cmd-warn", senderId: owner.id, text: "!warn @bob" }),
    );
    expect(store.getWarnCount(groupId, bob.id)).toBe(1);
    expect(client.sent.length).toBeGreaterThan(0);
    await age(COMMAND_CLEANUP_MS);
    expect(client.deleted).toEqual([]);
    expect(client.sent.length).toBeGreaterThan(0);
    expect(store.getWarnCount(groupId, bob.id)).toBe(1);
  });

  it("keeps pictures, video, welcomes, and ordinary chat", async () => {
    vi.useFakeTimers();
    const { engine, client, store } = setup();
    store.authorizeChat(chatId);
    await engine.processEvent(
      message({ id: "chat", conversationId: chatId, text: "hello", sequenceId: "1" }),
    );
    await engine.processEvent({
      id: "join",
      eventType: "ParticipantsJoin",
      conversationId: chatId,
      participantIds: [bob.id],
      participants: [bob],
      mentions: [],
    });
    await engine.processEvent(
      message({
        id: "cmd-img",
        conversationId: chatId,
        text: "!imagine a red boat",
        sequenceId: "2",
      }),
    );
    expect(client.images).toHaveLength(1);

    await engine.processEvent(
      message({
        id: "cmd-vid",
        conversationId: chatId,
        text: "!video a paper boat",
        sequenceId: "3",
      }),
    );
    await engine.waitForBackgroundWork();
    const sentBefore = client.sent.length;
    expect(sentBefore).toBeGreaterThan(0);

    await age(COMMAND_CLEANUP_MS);
    expect(client.deleted).toEqual(["cmd-img", "cmd-vid"]);
    expect(client.images).toHaveLength(1);
    expect(client.sent).toHaveLength(sentBefore);
    expect(client.sent.some((row) => /Welcome/.test(row.text))).toBe(true);
  });

  it("deletes only the bang for every public !help command, including !help", async () => {
    vi.useFakeTimers();
    const { engine, client, store } = setup();
    store.authorizeChat(chatId);
    const commands = [
      "!help",
      "/help",
      "!rules",
      "!dice",
      "!games",
      "!troll @bob",
      "!roast @bob",
      "!xp",
      "!ask what is up",
      "!boobs",
      "!imagine a red boat",
    ];
    for (const [index, text] of commands.entries()) {
      const sentBefore = client.sent.length;
      const imagesBefore = client.images.length;
      const id = `pub-${index}`;
      await engine.processEvent(
        message({ id, conversationId: chatId, text, sequenceId: String(100 + index) }),
      );
      const replied = client.sent.length > sentBefore || client.images.length > imagesBefore;
      expect(replied, text).toBe(true);
      await age(COMMAND_CLEANUP_MS);
      expect(client.deleted, text).toContain(id);
      expect(client.deleted.filter((row) => row.startsWith("sent-") || row.startsWith("img-")), text).toEqual(
        [],
      );
    }
    expect(client.sent.length).toBeGreaterThan(0);
    expect(client.images.length).toBeGreaterThan(0);
  });

  it("is described in !help and the README", () => {
    const loaded = loadDefaults("config/default.yaml");
    expect(loaded.help).toMatch(
      /User command messages auto-delete after 15 minutes when the API allows/,
    );
    expect(loaded.help).toMatch(/every public command on this list, including !help/);
    expect(loaded.help).toMatch(/Bot replies do not/);
    const readme = fs.readFileSync("README.md", "utf8");
    expect(readme).toMatch(/User command messages auto-delete after 15 minutes when the API allows/);
    expect(readme).toMatch(/Bot replies do not/);
    expect(readme).toMatch(/including `!help` itself/);
    expect(COMMAND_CLEANUP_MS).toBe(15 * 60 * 1000);
  });
});
