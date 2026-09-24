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

  it("deletes the bot reply after 15 minutes and leaves a classic command message", async () => {
    vi.useFakeTimers();
    const { engine, client } = setup();
    await engine.processEvent(message({ id: "cmd-help", text: "!help" }));
    expect(client.sent).toHaveLength(1);
    expect(client.deleted).toEqual([]);

    await age(COMMAND_CLEANUP_MS - 1);
    expect(client.deleted).toEqual([]);

    await age(1);
    expect(client.deleted).toEqual(["sent-1"]);
    expect(client.sent[0]?.text).toContain("Type !rules");
  });

  it("deletes a Chat command and the indexed reply, and keeps !auth in SQLite", async () => {
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
    await age(COMMAND_CLEANUP_MS);
    expect(client.deleted).toEqual(["cmd-rules", "sent-1"]);

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
    store.rememberChatMessage("sent-2", chatId, "89");
    await age(COMMAND_CLEANUP_MS);
    expect(client.deleted).toEqual(["cmd-rules", "sent-1", "cmd-auth", "sent-2"]);
    expect(store.isChatAuthorized(chatId)).toBe(true);
  });

  it("skips a Chat reply that still has no sequence id", async () => {
    vi.useFakeTimers();
    const { engine, client, store } = setup();
    store.authorizeChat(chatId);
    await engine.processEvent(
      message({
        id: "cmd-help",
        conversationId: chatId,
        text: "!help",
        sequenceId: "7",
      }),
    );
    await age(COMMAND_CLEANUP_MS);
    expect(client.deleted).toEqual(["cmd-help"]);
  });

  it("deletes a warn confirmation and keeps the warning", async () => {
    vi.useFakeTimers();
    const { engine, client, store } = setup();
    await engine.processEvent(
      message({ id: "cmd-warn", senderId: owner.id, text: "!warn @bob" }),
    );
    expect(store.getWarnCount(groupId, bob.id)).toBe(1);
    await age(COMMAND_CLEANUP_MS);
    expect(client.deleted).toEqual(["sent-1"]);
    expect(store.getWarnCount(groupId, bob.id)).toBe(1);
    expect(client.direct).toEqual([]);
  });

  it("deletes an image reply and a late video reply, not ordinary chat", async () => {
    vi.useFakeTimers();
    const { engine, client } = setup();
    await engine.processEvent(message({ id: "chat", text: "hello" }));
    await engine.processEvent({
      id: "join",
      eventType: "ParticipantsJoin",
      conversationId: groupId,
      participantIds: [bob.id],
      participants: [bob],
      mentions: [],
    });
    await engine.processEvent(message({ id: "cmd-img", text: "!imagine a red boat" }));
    expect(client.images).toHaveLength(1);

    await engine.processEvent(message({ id: "cmd-vid", text: "!video a paper boat" }));
    await engine.waitForBackgroundWork();
    expect(client.sent.map((row) => row.text).some((text) => text.includes("paper boat") || text.includes("clip"))).toBe(
      true,
    );

    await age(COMMAND_CLEANUP_MS);
    expect(client.deleted).toContain("img-1");
    expect(client.deleted).not.toContain("chat");
    expect(client.deleted).not.toContain("join");
    expect(client.deleted.filter((id) => id.startsWith("sent-")).length).toBeGreaterThanOrEqual(2);
  });

  it("deletes the reply for every public !help command, including !help", async () => {
    vi.useFakeTimers();
    const { engine, client } = setup();
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
      const deletedBefore = client.deleted.length;
      const sentBefore = client.sent.length;
      const imagesBefore = client.images.length;
      await engine.processEvent(message({ id: `pub-${index}`, text }));
      const replied = client.sent.length > sentBefore || client.images.length > imagesBefore;
      expect(replied, text).toBe(true);
      await age(COMMAND_CLEANUP_MS);
      const fresh = client.deleted.slice(deletedBefore);
      expect(fresh.some((id) => id.startsWith("sent-") || id.startsWith("img-")), text).toBe(true);
      expect(fresh, text).not.toContain(`pub-${index}`);
    }
  });

  it("is described in !help and the README", () => {
    const loaded = loadDefaults("config/default.yaml");
    expect(loaded.help).toMatch(
      /Command messages and the bot's replies to them are deleted after 15 minutes when the API allows/,
    );
    expect(loaded.help).toMatch(/every public command on this list, including !help/);
    expect(loaded.help).toMatch(/not only admin commands/);
    const readme = fs.readFileSync("README.md", "utf8");
    expect(readme).toMatch(/every public command on the `!help` list, not only admin or mod commands/);
    expect(readme).toMatch(/!help` itself/);
    expect(COMMAND_CLEANUP_MS).toBe(15 * 60 * 1000);
  });
});
