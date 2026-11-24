import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ModerationEngine } from "../src/bot/engine.js";
import {
  defaultNotificationRoot,
  formatReadyNotification,
  handleMention,
  isNotificationFileName,
  NOT_AUTHORIZED_REASON,
  NOT_IN_GROUP_REASON,
  NotificationPoller,
  notificationDirs,
  parseReadyNotification,
  pollReadyNotifications,
  queueRunBlockReason,
  writeReadyNotificationFile,
  type NotificationDirs,
  type NotificationTransport,
  type NotificationUser,
  type ReadyNotification,
} from "../src/bot/notifications.js";
import { Store } from "../src/store.js";
import type { BotRuntimeConfig, DefaultsConfig, DmEvent, MediaCaption } from "../src/types.js";
import { MockXClient } from "../src/x/mock-client.js";

const GROUP = "g2029561975647150382";
const USER_ID = "1577700998226890753";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function tempDirs(): NotificationDirs {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ready-notifications-"));
  roots.push(root);
  return notificationDirs(root);
}

interface Sent {
  conversationId: string;
  text: string;
  caption?: MediaCaption;
}

function transport(options?: {
  chatAvailable?: boolean;
  user?: NotificationUser | undefined;
  lookupError?: Error;
  sendError?: Error;
}): NotificationTransport & { sent: Sent[]; lookups: string[] } {
  const sent: Sent[] = [];
  const lookups: string[] = [];
  const user = options && "user" in options ? options.user : { id: USER_ID, username: "alice" };
  return {
    sent,
    lookups,
    chatAvailable: () => options?.chatAvailable !== false,
    async getUserById(userId) {
      lookups.push(userId);
      if (options?.lookupError) throw options.lookupError;
      return user;
    },
    async sendMessage(conversationId, text, caption) {
      if (options?.sendError) throw options.sendError;
      sent.push({ conversationId, text, caption });
      return { dmEventId: "sent-1", dmConversationId: conversationId };
    },
  };
}

function example(overrides: Partial<ReadyNotification> = {}): ReadyNotification {
  return {
    conversationId: GROUP,
    userId: USER_ID,
    command: "!undertow",
    text: "your !undertow is live — try !undertow",
    ...overrides,
  };
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.promises.readFile(file, "utf8")) as Record<string, unknown>;
}

function mentioned(text: string, mention: { start: number; end: number }): string {
  const bytes = new TextEncoder().encode(text);
  return new TextDecoder().decode(bytes.slice(mention.start, mention.end));
}

describe("ready notification JSON", () => {
  it("accepts the Chief of Staff drop", () => {
    const parsed = parseReadyNotification({
      conversationId: GROUP,
      userId: USER_ID,
      text: "your !undertow is live — try !undertow",
      command: "!undertow",
    });
    expect(parsed).toEqual({
      ok: true,
      value: {
        conversationId: GROUP,
        userId: USER_ID,
        command: "!undertow",
        text: "your !undertow is live — try !undertow",
      },
    });
  });

  it("accepts command alone or text alone and ignores extra fields", () => {
    expect(parseReadyNotification({ conversationId: GROUP, userId: USER_ID, command: "undertow" })).toEqual({
      ok: true,
      value: { conversationId: GROUP, userId: USER_ID, command: "undertow" },
    });
    expect(
      parseReadyNotification({
        conversationId: `  ${GROUP}  `,
        userId: USER_ID,
        text: "  your !undertow is live  ",
        note: "ignored",
      }),
    ).toEqual({
      ok: true,
      value: { conversationId: GROUP, userId: USER_ID, text: "your !undertow is live" },
    });
  });

  it("rejects a body that cannot be posted", () => {
    expect(parseReadyNotification(null).ok).toBe(false);
    expect(parseReadyNotification(["nope"]).ok).toBe(false);
    expect(parseReadyNotification({ userId: USER_ID, command: "!undertow" })).toMatchObject({
      ok: false,
      reason: "conversationId is required.",
    });
    expect(parseReadyNotification({ conversationId: "1578398451921985538", userId: USER_ID, command: "!undertow" })).toMatchObject({
      ok: false,
      reason: "conversationId must be an encrypted Chat group id.",
    });
    expect(parseReadyNotification({ conversationId: GROUP, command: "!undertow" })).toMatchObject({
      ok: false,
      reason: "userId is required.",
    });
    expect(parseReadyNotification({ conversationId: GROUP, userId: "alice", command: "!undertow" })).toMatchObject({
      ok: false,
      reason: "userId must be a numeric X user id.",
    });
    expect(parseReadyNotification({ conversationId: GROUP, userId: USER_ID })).toMatchObject({
      ok: false,
      reason: "Notification needs text or command.",
    });
    expect(parseReadyNotification({ conversationId: GROUP, userId: USER_ID, command: "!" })).toMatchObject({
      ok: false,
      reason: "command must be a bang name such as !undertow.",
    });
    expect(parseReadyNotification({ conversationId: GROUP, userId: USER_ID, command: 1 })).toMatchObject({
      ok: false,
      reason: "command must be a string.",
    });
    expect(
      parseReadyNotification({ conversationId: GROUP, userId: USER_ID, text: "x".repeat(501) }),
    ).toMatchObject({ ok: false, reason: "text is too long." });
    expect(
      parseReadyNotification({ conversationId: GROUP, userId: USER_ID, command: "!milady 3" }),
    ).toMatchObject({ ok: false, reason: "command must be a bang name such as !undertow." });
    expect(
      parseReadyNotification({ conversationId: GROUP, userId: USER_ID, run: true, text: "hi" }),
    ).toMatchObject({ ok: false, reason: "A queue run needs command." });
    expect(
      parseReadyNotification({ conversationId: GROUP, userId: USER_ID, run: "yes", command: "!milady" }),
    ).toMatchObject({ ok: false, reason: "run must be a boolean." });
    expect(
      parseReadyNotification({ conversationId: GROUP, userId: USER_ID, mode: "notify", command: "!milady" }),
    ).toMatchObject({ ok: false, reason: 'mode must be "run".' });
    expect(
      parseReadyNotification({
        conversationId: "all",
        conversationIds: [GROUP],
        userId: USER_ID,
        run: true,
        command: "!milady",
      }),
    ).toMatchObject({ ok: false, reason: 'Use conversationId "all" or conversationIds, not both.' });
    expect(
      parseReadyNotification({ conversationId: GROUP, userId: USER_ID, command: "!undertow", handle: "not a handle" }),
    ).toMatchObject({ ok: false, reason: "handle must be an @handle." });
  });

  it("accepts a queue run, an optional handle, and a group list", () => {
    expect(
      parseReadyNotification({
        conversationId: GROUP,
        userId: USER_ID,
        run: true,
        command: "!milady 3",
        handle: "@alice",
      }),
    ).toEqual({
      ok: true,
      value: {
        conversationId: GROUP,
        userId: USER_ID,
        run: true,
        command: "!milady 3",
        handle: "alice",
      },
    });
    expect(
      parseReadyNotification({
        conversationId: "all",
        userId: USER_ID,
        mode: "run",
        command: "!milady",
      }),
    ).toEqual({
      ok: true,
      value: { conversationId: "all", userId: USER_ID, run: true, command: "!milady" },
    });
    expect(
      parseReadyNotification({
        conversationIds: [GROUP, `  ${GROUP}  `, "g2029561975647150383"],
        userId: USER_ID,
        text: "hello",
      }),
    ).toEqual({
      ok: true,
      value: {
        conversationIds: [GROUP, "g2029561975647150383"],
        userId: USER_ID,
        text: "hello",
      },
    });
  });

  it("names the pending, processing, done, and failed folders beside the database", () => {
    expect(defaultNotificationRoot("/var/bot/data/bot.sqlite")).toBe(
      path.join("/var/bot/data", "notifications"),
    );
    const dirs = notificationDirs(defaultNotificationRoot("/var/bot/data/bot.sqlite"));
    expect(dirs.pending).toBe(path.join("/var/bot/data/notifications/pending"));
    expect(dirs.processing).toBe(path.join("/var/bot/data/notifications/processing"));
    expect(dirs.done).toBe(path.join("/var/bot/data/notifications/done"));
    expect(dirs.failed).toBe(path.join("/var/bot/data/notifications/failed"));
    expect(isNotificationFileName("abc.json")).toBe(true);
    expect(isNotificationFileName(".abc.json.tmp")).toBe(false);
    expect(isNotificationFileName("notes.txt")).toBe(false);
  });
});

describe("ready notification mentions", () => {
  it("tags the handle and covers only those bytes", () => {
    const message = formatReadyNotification("alice", { command: "!undertow" });
    expect(message.text).toBe("@alice your !undertow is live");
    expect(message.text.toLowerCase()).not.toContain("telegram");
    expect(message.caption.text).toBe("@alice");
    expect(message.caption.mention).toEqual({ username: "alice", start: 0, end: 6 });
    expect(mentioned(message.text, message.caption.mention!)).toBe("@alice");
    expect(message.caption.mention!.end).toBeLessThan(new TextEncoder().encode(message.text).byteLength);
  });

  it("uses text when Chief of Staff provided it", () => {
    const message = formatReadyNotification("@alice", example());
    expect(message.text).toBe("@alice your !undertow is live — try !undertow");
    expect(message.caption.mention).toEqual({ username: "alice", start: 0, end: 6 });
    expect(mentioned(message.text, message.caption.mention!)).toBe("@alice");
  });

  it("does not prefix a body that already starts with that handle", () => {
    const message = formatReadyNotification("alice", { text: "@alice, your !undertow is live" });
    expect(message.text).toBe("@alice, your !undertow is live");
    expect(mentioned(message.text, message.caption.mention!)).toBe("@alice");
    expect(message.text.slice(message.caption.mention!.end)).toBe(", your !undertow is live");
  });

  it("adds a bang when command omitted it", () => {
    expect(formatReadyNotification("alice", { command: "undertow" }).text).toBe(
      "@alice your !undertow is live",
    );
  });

  it("does not treat a display name or a numeric id as a mention", () => {
    expect(handleMention("Alice")).toBeUndefined();
    expect(handleMention("@1577700998226890753")).toBeUndefined();
    expect(handleMention("@alice your !undertow is live")).toBeUndefined();
    const long = "abcdefghijklmno";
    expect(handleMention(`@${long}`)).toEqual({
      username: long,
      start: 0,
      end: new TextEncoder().encode(`@${long}`).byteLength,
    });
  });
});

describe("ready notification queue", () => {
  it("sends and moves the file to done", async () => {
    const dirs = tempDirs();
    const client = transport();
    await writeReadyNotificationFile({ pendingDir: dirs.pending, id: "undertow", payload: example() });
    expect(fs.existsSync(path.join(dirs.pending, ".undertow.json.tmp"))).toBe(false);

    const result = await pollReadyNotifications(dirs, client);
    expect(result).toEqual({ skipped: false, sent: 1, failed: 0 });
    expect(client.lookups).toEqual([USER_ID]);
    expect(client.sent).toEqual([
      {
        conversationId: GROUP,
        text: "@alice your !undertow is live — try !undertow",
        caption: {
          text: "@alice",
          mention: { username: "alice", start: 0, end: 6 },
        },
      },
    ]);
    expect(fs.readdirSync(dirs.pending)).toEqual([]);
    expect(fs.readdirSync(dirs.processing)).toEqual([]);
    const done = await readJson(path.join(dirs.done, "undertow.json"));
    expect(done).toEqual(example());
    expect(done.reason).toBeUndefined();
  });

  it("skips the send when Chat is unavailable and records why", async () => {
    const dirs = tempDirs();
    const client = transport({ chatAvailable: false, lookupError: new Error("should not look up") });
    await writeReadyNotificationFile({
      pendingDir: dirs.pending,
      id: "quiet",
      payload: { conversationId: GROUP, userId: USER_ID, command: "!undertow" },
    });

    const result = await pollReadyNotifications(dirs, client);
    expect(result).toEqual({ skipped: true, sent: 0, failed: 1 });
    expect(client.sent).toEqual([]);
    expect(client.lookups).toEqual([]);
    expect(fs.readdirSync(dirs.pending)).toEqual([]);
    expect(fs.readdirSync(dirs.processing)).toEqual([]);
    const failed = await readJson(path.join(dirs.failed, "quiet.json"));
    expect(failed.reason).toBe("Chat is unavailable.");
    expect(failed.conversationId).toBe(GROUP);
    expect(failed.userId).toBe(USER_ID);
    expect(failed.command).toBe("!undertow");
    expect(failed.failedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("moves a send failure, a missing handle, and bad JSON to failed", async () => {
    const dirs = tempDirs();
    const client = transport({ sendError: new Error("No conversation key cached") });
    client.getUserById = async (userId) => {
      client.lookups.push(userId);
      if (userId === "42") return undefined;
      return { id: userId, username: "alice" };
    };
    await writeReadyNotificationFile({
      pendingDir: dirs.pending,
      id: "send",
      payload: { conversationId: GROUP, userId: USER_ID, command: "!undertow" },
    });
    await writeReadyNotificationFile({
      pendingDir: dirs.pending,
      id: "who",
      payload: { conversationId: GROUP, userId: "42", command: "!undertow" },
    });
    await fs.promises.writeFile(path.join(dirs.pending, "bad.json"), "{", "utf8");
    await fs.promises.writeFile(path.join(dirs.pending, ".half.json.tmp"), '{"command":"!nope"}', "utf8");
    await fs.promises.writeFile(path.join(dirs.pending, "notes.txt"), "leave me", "utf8");

    const sent = await pollReadyNotifications(dirs, client);
    expect(sent.sent).toBe(0);
    expect(sent.failed).toBe(3);
    expect(client.sent).toEqual([]);

    const sendFailed = await readJson(path.join(dirs.failed, "send.json"));
    expect(sendFailed.reason).toBe("Send failed: No conversation key cached");
    const who = await readJson(path.join(dirs.failed, "who.json"));
    expect(who.reason).toBe("No @handle for that userId.");
    expect(who.userId).toBe("42");
    const bad = await readJson(path.join(dirs.failed, "bad.json"));
    expect(bad.reason).toBe("Notification file is not JSON.");
    expect(bad.raw).toBe("{");

    expect(fs.readFileSync(path.join(dirs.pending, ".half.json.tmp"), "utf8")).toContain("!nope");
    expect(fs.readFileSync(path.join(dirs.pending, "notes.txt"), "utf8")).toBe("leave me");
    expect(fs.readdirSync(dirs.processing)).toEqual([]);
    expect(client.lookups).toEqual([USER_ID, "42"]);
  });

  it("fails the lookup and a user with no username", async () => {
    const dirs = tempDirs();
    await writeReadyNotificationFile({
      pendingDir: dirs.pending,
      id: "down",
      payload: { conversationId: GROUP, userId: USER_ID, command: "!undertow" },
    });
    const down = transport({ lookupError: new Error("HTTP 429") });
    expect(await pollReadyNotifications(dirs, down)).toMatchObject({ sent: 0, failed: 1, skipped: false });
    expect((await readJson(path.join(dirs.failed, "down.json"))).reason).toBe(
      "Could not look up that user: HTTP 429",
    );

    await writeReadyNotificationFile({
      pendingDir: dirs.pending,
      id: "noname",
      payload: { conversationId: GROUP, userId: USER_ID, text: "your !undertow is live" },
    });
    const noname = transport({ user: { id: USER_ID, username: "1577700998226890753", name: "Alice" } });
    await pollReadyNotifications(dirs, noname);
    expect((await readJson(path.join(dirs.failed, "noname.json"))).reason).toBe(
      "No @handle for that userId.",
    );
    expect(noname.sent).toEqual([]);
  });

  it("retries a failed file that is copied back to pending", async () => {
    const dirs = tempDirs();
    const blocked = transport({ chatAvailable: false });
    await writeReadyNotificationFile({
      pendingDir: dirs.pending,
      id: "retry",
      payload: { conversationId: GROUP, userId: USER_ID, command: "!undertow" },
    });
    await pollReadyNotifications(dirs, blocked);
    await fs.promises.rename(path.join(dirs.failed, "retry.json"), path.join(dirs.pending, "retry.json"));

    const client = transport();
    const result = await pollReadyNotifications(dirs, client);
    expect(result).toEqual({ skipped: false, sent: 1, failed: 0 });
    expect(client.sent[0]?.text).toBe("@alice your !undertow is live");
    expect(client.sent[0]?.caption?.mention).toEqual({ username: "alice", start: 0, end: 6 });
  });

  it("polls from the timer hook once and then stops", async () => {
    const dirs = tempDirs();
    const client = transport();
    await writeReadyNotificationFile({
      pendingDir: dirs.pending,
      id: "tick",
      payload: { conversationId: GROUP, userId: USER_ID, command: "!undertow" },
    });
    const poller = new NotificationPoller(dirs, client, 5_000);
    try {
      await poller.tick();
      expect(client.sent).toHaveLength(1);
      expect(fs.existsSync(path.join(dirs.done, "tick.json"))).toBe(true);
    } finally {
      poller.stop();
    }
  });
});

describe("ready notification docs", () => {
  it("documents the drop folder and the schema in the README", () => {
    const readme = fs.readFileSync("README.md", "utf8");
    expect(readme).toMatch(/data\/notifications\/pending/);
    expect(readme).toMatch(/data\/notifications\/processing/);
    expect(readme).toMatch(/data\/notifications\/done/);
    expect(readme).toMatch(/data\/notifications\/failed/);
    expect(readme).toMatch(/conversationId/);
    expect(readme).toMatch(/1577700998226890753/);
    expect(readme).toMatch(/!undertow/);
    expect(readme).toMatch(/Chat is unavailable/);
    expect(readme).toMatch(/@handle your !command is live/);
    expect(readme).toMatch(/"run": true/);
    expect(readme).toMatch(/!milady 3/);
    expect(readme).toMatch(/conversationIds/);
    expect(readme).toMatch(/sender_label/);
    expect(readme).toMatch(/chat_authorizations/);
    expect(readme).toMatch(/Bot is not in that group \(404\)\./);
    expect(readme).toMatch(/!purge cannot be run from the notification queue/);
    expect(readme).toMatch(/QUEUE_RUN_COMMANDS/);
    const help = fs.readFileSync("config/default.yaml", "utf8");
    expect(help).not.toMatch(/!notify/);
    expect(help).not.toMatch(/notification queue/);
  });
});

const GROUP_B = "g2029561975647150383";
const GROUP_C = "g2029561975647150384";
const MILADY_IMAGE =
  "https://memedepot.com/cdn-cgi/imagedelivery/naCPMwxXX46-hrE49eZovw/57b85cf0-f015-4285-ad1c-8a3ea4eda400/public";

const queueDefaults: DefaultsConfig = {
  welcome: { enabled: false, text: "Welcome @{username}!" },
  rules: "Be nice.",
  help: "Type !rules",
  flood: { max_messages: 0, window_ms: 10_000, mute_ms: 60_000, warn_on_flood: false },
  warns: { limit: 3, auto_mute_ms: 60_000, notify_admins: false },
  filters: [],
  poll: { interval_ms: 1000, max_results: 50 },
  delete: { attempt_on_filter: false, attempt_on_flood: false, attempt_on_mute: false },
};

function queueRuntime(botUserId: string): BotRuntimeConfig {
  return {
    botUserId,
    ownerId: USER_ID,
    globalAdminIds: [],
    defaults: queueDefaults,
  };
}

function notFound(): Error & { status: number } {
  const error = new Error("Conversation not found") as Error & { status: number };
  error.status = 404;
  return error;
}

describe("notification queue runs", () => {
  const stores: Store[] = [];

  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
  });

  function rig(botUserId = "bot-1"): {
    store: Store;
    client: MockXClient;
    engine: ModerationEngine;
  } {
    const store = new Store(":memory:");
    stores.push(store);
    const client = new MockXClient({ id: botUserId, username: "modbot", name: "Mod Bot" });
    client.addUser({ id: USER_ID, username: "alice", name: "Alice" });
    const engine = new ModerationEngine(store, client, queueRuntime(botUserId), undefined, {
      milady: {
        async randomImage() {
          return { url: MILADY_IMAGE };
        },
        async randomImages(count: number) {
          return Array.from({ length: count }, () => ({ url: MILADY_IMAGE }));
        },
      },
      fetchImage: async () => ({ bytes: Uint8Array.from([1, 2, 3]), mimeType: "image/png" }),
      commandCleanupMs: 60 * 60 * 1000,
    });
    return { store, client, engine };
  }

  function wired(
    parts: ReturnType<typeof rig>,
    getUserById?: NotificationTransport["getUserById"],
  ): NotificationTransport {
    return {
      chatAvailable: () => true,
      getUserById: getUserById ?? ((userId) => parts.client.getUserById(userId)),
      sendMessage: (conversationId, text, caption) => parts.client.sendMessage(conversationId, text, caption),
      lookupSenderLabel: (userId) => parts.engine.lookupSenderLabel(userId),
      isAuthorized: (conversationId) => parts.store.isChatAuthorized(conversationId),
      listAuthorized: () => parts.store.listChatAuthorizations(),
      runCommand: (request) => parts.engine.runQueuedCommand(request),
    };
  }

  function rememberHandle(store: Store, senderId: string, label: string, ts: number): void {
    store.db
      .prepare(
        `INSERT INTO chat_history_messages (
           conversation_id, message_id, sender_id, sender_label, text, ts_ms
         ) VALUES (?, ?, ?, ?, 'hi', ?)`,
      )
      .run(GROUP, `hist-${senderId}-${ts}`, senderId, label, ts);
  }

  it("runs !milady through the engine and posts the native image", async () => {
    const dirs = tempDirs();
    const parts = rig();
    parts.store.authorizeChat(GROUP);
    await writeReadyNotificationFile({
      pendingDir: dirs.pending,
      id: "milady",
      payload: { conversationId: GROUP, userId: USER_ID, run: true, command: "!milady" },
    });

    const result = await pollReadyNotifications(dirs, wired(parts));
    expect(result).toEqual({ skipped: false, sent: 1, failed: 0 });
    expect(parts.client.images).toHaveLength(1);
    expect(parts.client.images[0]).toMatchObject({
      conversationId: GROUP,
      url: MILADY_IMAGE,
      caption: "@alice",
      mention: "alice",
      mimeType: "image/png",
    });
    expect(parts.client.sent).toEqual([]);
    const done = await readJson(path.join(dirs.done, "milady.json"));
    expect(done.command).toBe("!milady");
    expect(done.run).toBe(true);
    expect(done.results).toEqual([
      { conversationId: GROUP, status: "sent", messageIds: ["img-1"] },
    ]);
    expect(done.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const stored = parts.store.db
      .prepare("SELECT text FROM chat_history_messages WHERE text LIKE '%!milady%'")
      .all();
    expect(stored).toEqual([]);
  });

  it("runs !milady 3 as one album", async () => {
    const dirs = tempDirs();
    const parts = rig();
    parts.store.authorizeChat(GROUP);
    await writeReadyNotificationFile({
      pendingDir: dirs.pending,
      id: "three",
      payload: { conversationId: GROUP, userId: USER_ID, mode: "run", command: "!milady 3" } as ReadyNotification,
    });

    await pollReadyNotifications(dirs, wired(parts));
    expect(parts.client.imageBatches).toHaveLength(1);
    expect(parts.client.imageBatches[0]?.urls).toEqual([MILADY_IMAGE, MILADY_IMAGE, MILADY_IMAGE]);
    expect(parts.client.imageBatches[0]).toMatchObject({ caption: "@alice", mention: "alice" });
    expect(parts.client.sent).toEqual([]);
    const done = await readJson(path.join(dirs.done, "three.json"));
    expect(done.results).toEqual([
      { conversationId: GROUP, status: "sent", messageIds: ["img-batch-1"] },
    ]);
  });

  it("still ignores a real message from the bot, and runs a queue file that names the bot", async () => {
    const dirs = tempDirs();
    const parts = rig(USER_ID);
    parts.client.addUser({ id: USER_ID, username: "alice", name: "Alice" });
    parts.store.authorizeChat(GROUP);
    const inbound: DmEvent = {
      id: "real-from-bot",
      eventType: "MessageCreate",
      conversationId: GROUP,
      senderId: USER_ID,
      sender: { id: USER_ID, username: "alice" },
      text: "!milady",
      participantIds: [],
      participants: [],
      mentions: [],
    };
    await parts.engine.processEvent(inbound);
    expect(parts.client.images).toHaveLength(0);

    await writeReadyNotificationFile({
      pendingDir: dirs.pending,
      id: "self",
      payload: { conversationId: GROUP, userId: USER_ID, run: true, command: "!milady" },
    });
    const result = await pollReadyNotifications(dirs, wired(parts));
    expect(result).toEqual({ skipped: false, sent: 1, failed: 0 });
    expect(parts.client.images).toHaveLength(1);
    expect(parts.client.images[0]).toMatchObject({ caption: "@alice", mention: "alice" });
  });

  it("blocks owner commands that are not on the queue allowlist", async () => {
    const dirs = tempDirs();
    const parts = rig();
    parts.store.authorizeChat(GROUP);
    expect(queueRunBlockReason("!purge")).toBe("!purge cannot be run from the notification queue.");
    expect(queueRunBlockReason("!auth")).toBe("!auth cannot be run from the notification queue.");
    expect(queueRunBlockReason("!milady 3")).toBeUndefined();
    await writeReadyNotificationFile({
      pendingDir: dirs.pending,
      id: "purge",
      payload: { conversationId: GROUP, userId: USER_ID, run: true, command: "!purge" },
    });
    await writeReadyNotificationFile({
      pendingDir: dirs.pending,
      id: "auth",
      payload: { conversationId: GROUP, userId: USER_ID, run: true, command: "!auth" },
    });

    const result = await pollReadyNotifications(dirs, wired(parts));
    expect(result).toEqual({ skipped: false, sent: 0, failed: 2 });
    expect((await readJson(path.join(dirs.failed, "purge.json"))).reason).toBe(
      "!purge cannot be run from the notification queue.",
    );
    expect((await readJson(path.join(dirs.failed, "auth.json"))).reason).toBe(
      "!auth cannot be run from the notification queue.",
    );
    expect(parts.client.sent).toEqual([]);
    expect(parts.client.images).toEqual([]);
    expect(parts.client.deleted).toEqual([]);
  });

  it("fails a run when the group is not authorized", async () => {
    const dirs = tempDirs();
    const parts = rig();
    await writeReadyNotificationFile({
      pendingDir: dirs.pending,
      id: "locked",
      payload: { conversationId: GROUP, userId: USER_ID, run: true, command: "!milady" },
    });

    const result = await pollReadyNotifications(dirs, wired(parts));
    expect(result).toEqual({ skipped: false, sent: 0, failed: 1 });
    const failed = await readJson(path.join(dirs.failed, "locked.json"));
    expect(failed.reason).toBe(NOT_AUTHORIZED_REASON);
    expect(parts.client.images).toEqual([]);
    expect(parts.client.sent).toEqual([]);
    await expect(
      parts.engine.runQueuedCommand({
        conversationId: GROUP,
        userId: USER_ID,
        handle: "alice",
        command: "!milady",
        messageId: "queue-direct",
      }),
    ).rejects.toThrow(NOT_AUTHORIZED_REASON);
  });

  it("falls back to sender_label, then a job handle, after a missed lookup", async () => {
    const dirs = tempDirs();
    const parts = rig();
    parts.store.authorizeChat(GROUP);
    rememberHandle(parts.store, USER_ID, "@oldname", 1);
    rememberHandle(parts.store, USER_ID, "Alice Jones", 2);
    rememberHandle(parts.store, USER_ID, "@alice", 3);
    const missing = wired(parts, async () => undefined);

    await writeReadyNotificationFile({
      pendingDir: dirs.pending,
      id: "history",
      payload: { conversationId: GROUP, userId: USER_ID, command: "!undertow" },
    });
    await pollReadyNotifications(dirs, missing);
    expect(parts.client.sent.map((row) => row.text)).toEqual(["@alice your !undertow is live"]);

    await writeReadyNotificationFile({
      pendingDir: dirs.pending,
      id: "named",
      payload: { conversationId: GROUP, userId: USER_ID, handle: "bob", text: "your !undertow is live" },
    });
    await pollReadyNotifications(dirs, missing);
    expect(parts.client.sent.map((row) => row.text)).toEqual([
      "@alice your !undertow is live",
      "@bob your !undertow is live",
    ]);

    const live = wired(parts, async (userId) => ({ id: userId, username: "alice" }));
    await writeReadyNotificationFile({
      pendingDir: dirs.pending,
      id: "live",
      payload: {
        conversationId: GROUP,
        userId: USER_ID,
        handle: "bob",
        text: "your !undertow is live",
      },
    });
    await pollReadyNotifications(dirs, live);
    expect(parts.client.sent.at(-1)?.text).toBe("@alice your !undertow is live");
  });

  it("fans a run out to every authorized group and skips a 404", async () => {
    const dirs = tempDirs();
    const parts = rig();
    for (const id of [GROUP_C, GROUP, GROUP_B]) parts.store.authorizeChat(id);
    const sendImage = parts.client.sendImage.bind(parts.client);
    const sendMessage = parts.client.sendMessage.bind(parts.client);
    parts.client.sendImage = async (conversationId, image) => {
      if (conversationId === GROUP_B) throw notFound();
      return sendImage(conversationId, image);
    };
    parts.client.sendMessage = async (conversationId, text, caption) => {
      if (conversationId === GROUP_B) throw notFound();
      return sendMessage(conversationId, text, caption);
    };

    await writeReadyNotificationFile({
      pendingDir: dirs.pending,
      id: "everywhere",
      payload: { conversationId: "all", userId: USER_ID, run: true, command: "!milady" },
    });
    const result = await pollReadyNotifications(dirs, wired(parts));
    expect(result).toEqual({ skipped: false, sent: 1, failed: 0 });
    expect(parts.client.images.map((image) => image.conversationId)).toEqual([GROUP, GROUP_C]);
    expect(parts.client.images.every((image) => image.caption === "@alice" && image.mention === "alice")).toBe(true);
    expect(parts.client.sent).toEqual([]);
    const done = await readJson(path.join(dirs.done, "everywhere.json"));
    expect(done.results).toEqual([
      { conversationId: GROUP, status: "sent", messageIds: ["img-1"] },
      { conversationId: GROUP_B, status: "skipped", reason: NOT_IN_GROUP_REASON },
      { conversationId: GROUP_C, status: "sent", messageIds: ["img-2"] },
    ]);
  });
});
