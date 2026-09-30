import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultNotificationRoot,
  formatReadyNotification,
  handleMention,
  isNotificationFileName,
  NotificationPoller,
  notificationDirs,
  parseReadyNotification,
  pollReadyNotifications,
  writeReadyNotificationFile,
  type NotificationDirs,
  type NotificationTransport,
  type NotificationUser,
  type ReadyNotification,
} from "../src/bot/notifications.js";
import type { MediaCaption } from "../src/types.js";

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
    const help = fs.readFileSync("config/default.yaml", "utf8");
    expect(help).not.toMatch(/!notify/);
  });
});
