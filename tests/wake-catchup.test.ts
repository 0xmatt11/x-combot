import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eventReplayKeys, ModerationEngine } from "../src/bot/engine.js";
import {
  ChatPoller,
  DEFAULT_CHAT_WAKE_COMMAND_MAX_AGE_MS,
  formatWakeCatchupLog,
} from "../src/chat/poller.js";
import { watermarkKey } from "../src/chat/ids.js";
import { chatListenPolicy } from "../src/chat/listen.js";
import type { ChatService } from "../src/chat/service.js";
import { loadEnv } from "../src/env.js";
import { HANG_HEARTBEAT_MS, HANG_WALL_JUMP_MS } from "../src/hang-watchdog.js";
import { Store } from "../src/store.js";
import type { BotRuntimeConfig, DefaultsConfig, DmEvent } from "../src/types.js";
import { MockXClient } from "../src/x/mock-client.js";

const INTERVAL_MS = 12_000;
const GROUP = "g100";
const GROUPS = ["g11", "g22", "g33"] as const;
const NOW = Date.parse("2026-10-09T15:00:00.000Z");
const ALICE = { id: "alice-1", username: "alice", name: "Alice" };

const defaults: DefaultsConfig = {
  welcome: { enabled: false, text: "Welcome @{username}!" },
  rules: "RULES_TEXT",
  help: "HELP_TEXT",
  flood: { max_messages: 0, window_ms: 10_000, mute_ms: 60_000, warn_on_flood: false },
  warns: { limit: 2, auto_mute_ms: 60_000, notify_admins: false },
  filters: [],
  poll: { interval_ms: INTERVAL_MS, max_results: 50 },
  delete: { attempt_on_filter: false, attempt_on_flood: false, attempt_on_mute: false },
};

function runtime(): BotRuntimeConfig {
  return {
    botUserId: "bot-1",
    botUsername: "miladybot",
    ownerId: "owner-1",
    globalAdminIds: [],
    defaults,
  };
}

function command(partial: Partial<DmEvent> & Pick<DmEvent, "id" | "text">): DmEvent {
  return {
    eventType: "MessageCreate",
    conversationId: GROUP,
    senderId: ALICE.id,
    sender: ALICE,
    participantIds: [],
    participants: [],
    mentions: [],
    ...partial,
  };
}

function emptyPull() {
  return { events: [] as DmEvent[], newestId: "n", watermarkId: "n" };
}

function rateLimitError(retryAfterMs: number, status = 429): Error {
  const error = new Error(`HTTP ${status}`) as Error & { status: number; retryAfterMs: number };
  error.status = status;
  error.retryAfterMs = retryAfterMs;
  return error;
}

function wakeLines(info: { mock: { calls: unknown[][] } }): string[] {
  return info.mock.calls
    .map((call) => String(call[0]))
    .filter((line) => line.includes("Wake catch-up:"));
}

describe("wake catch-up", () => {
  const stores: Store[] = [];
  const pollers: ChatPoller[] = [];

  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    for (const poller of pollers) poller.stop();
    pollers.length = 0;
    for (const store of stores) store.close();
    stores.length = 0;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function track(poller: ChatPoller, store: Store): void {
    pollers.push(poller);
    stores.push(store);
  }

  it("reads one group on wake and does not poll again immediately", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pull = vi.fn().mockResolvedValue(emptyPull());
    const listInbox = vi.fn().mockResolvedValue({ supported: true, ids: [] });
    const store = new Store(":memory:");
    const poller = new ChatPoller(
      { pullNew: pull, listInboxGroupIds: listInbox } as unknown as ChatService,
      store,
      { processEvent: vi.fn() } as unknown as ModerationEngine,
      INTERVAL_MS,
      [...GROUPS],
      50,
      INTERVAL_MS,
      {
        policy: chatListenPolicy({ mode: "all" }),
        maxPollsPerTick: 1,
      },
    );
    track(poller, store);

    await poller.kick();
    // No activity yet, so the tie goes to the lowest conversation id.
    expect(pull.mock.calls.map((call) => call[0])).toEqual(["g11"]);
    expect(listInbox).not.toHaveBeenCalled();
    expect(wakeLines(vi.mocked(console.info))).toEqual([
      expect.stringContaining(
        formatWakeCatchupLog({
          answered: 0,
          stale: 0,
          alreadyHandled: 0,
          groupsChecked: 1,
          groupsDeferred: 2,
        }),
      ),
    ]);

    await vi.advanceTimersByTimeAsync(0);
    expect(pull).toHaveBeenCalledTimes(1);
    expect(wakeLines(vi.mocked(console.info))).toHaveLength(1);
  });

  it("treats a timer that fires after a clock jump as the one wake poll", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let now = NOW;
    const pull = vi.fn().mockResolvedValue(emptyPull());
    const listInbox = vi.fn().mockResolvedValue({ supported: true, ids: [] });
    const store = new Store(":memory:");
    const poller = new ChatPoller(
      { pullNew: pull, listInboxGroupIds: listInbox } as unknown as ChatService,
      store,
      { processEvent: vi.fn() } as unknown as ModerationEngine,
      INTERVAL_MS,
      [...GROUPS],
      50,
      INTERVAL_MS,
      {
        policy: chatListenPolicy({ mode: "all" }),
        maxPollsPerTick: 1,
        now: () => now,
      },
    );
    track(poller, store);

    await poller.tick();
    expect(pull).toHaveBeenCalledTimes(1);
    expect(listInbox).toHaveBeenCalledTimes(1);

    now += HANG_WALL_JUMP_MS + 60_000;
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(pull).toHaveBeenCalledTimes(2);
    expect(pull.mock.calls.map((call) => call[0])).toEqual(["g11", "g11"]);
    expect(listInbox).toHaveBeenCalledTimes(1);
    expect(wakeLines(vi.mocked(console.info))).toEqual([
      expect.stringContaining(
        formatWakeCatchupLog({
          answered: 0,
          stale: 0,
          alreadyHandled: 0,
          groupsChecked: 1,
          groupsDeferred: 2,
        }),
      ),
    ]);

    await poller.kick();
    expect(pull).toHaveBeenCalledTimes(2);
    expect(wakeLines(vi.mocked(console.info))).toHaveLength(1);

    now += HANG_HEARTBEAT_MS;
    await poller.kick();
    expect(pull).toHaveBeenCalledTimes(3);
  });

  it("skips the history read while a rate-limit backoff is active", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const retryAfterMs = 60_000;
    const pull = vi.fn().mockRejectedValueOnce(rateLimitError(retryAfterMs)).mockResolvedValue(emptyPull());
    const store = new Store(":memory:");
    const poller = new ChatPoller(
      { pullNew: pull } as unknown as ChatService,
      store,
      { processEvent: vi.fn() } as unknown as ModerationEngine,
      INTERVAL_MS,
      [GROUP],
      50,
    );
    track(poller, store);

    await poller.kick();
    expect(pull).toHaveBeenCalledTimes(1);

    await poller.kick();
    await vi.advanceTimersByTimeAsync(0);
    expect(pull).toHaveBeenCalledTimes(1);
    const lines = wakeLines(vi.mocked(console.info));
    expect(lines.at(-1)).toContain(
      formatWakeCatchupLog(
        { answered: 0, stale: 0, alreadyHandled: 0, groupsChecked: 0, groupsDeferred: 1 },
        { backoff: true },
      ),
    );
    expect(lines.some((line) => line.includes("secret"))).toBe(false);

    await vi.advanceTimersByTimeAsync(retryAfterMs - 1);
    expect(pull).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(pull).toHaveBeenCalledTimes(2);
  });

  it("skips commands older than the wake window, marks them handled, and still answers newer ones", async () => {
    const store = new Store(":memory:");
    store.authorizeChat(GROUP);
    store.setWatermark(watermarkKey(GROUP), "seed");
    const client = new MockXClient({ id: "bot-1", username: "miladybot", name: "Mod Bot" });
    client.addUser(ALICE);
    const engine = new ModerationEngine(store, client, runtime());
    const maxAge = DEFAULT_CHAT_WAKE_COMMAND_MAX_AGE_MS;
    const stale = command({
      id: "stale-1",
      sequenceId: "10",
      text: "!help secret-phrase-xyz",
      createdAt: new Date(NOW - maxAge - 1).toISOString(),
    });
    const boundary = command({
      id: "boundary-1",
      sequenceId: "11",
      text: "!rules",
      createdAt: new Date(NOW - maxAge).toISOString(),
    });
    const undated = command({
      id: "undated-1",
      sequenceId: "12",
      text: "!help",
    });
    const page = [stale, boundary, undated];
    const pull = vi.fn().mockResolvedValue({
      events: page,
      newestId: undated.id,
      watermarkId: undated.id,
    });
    const poller = new ChatPoller(
      { pullNew: pull } as unknown as ChatService,
      store,
      engine,
      INTERVAL_MS,
      [GROUP],
      50,
      INTERVAL_MS,
      { now: () => NOW },
    );
    track(poller, store);

    await poller.kick();

    const sent = client.sent.map((message) => message.text).join("\n");
    expect(sent).toContain("RULES_TEXT");
    expect(sent).toContain("HELP_TEXT");
    expect(sent).not.toContain("secret-phrase-xyz");
    expect(client.sent).toHaveLength(2);
    for (const key of eventReplayKeys(stale)) {
      expect(store.hasProcessed(key)).toBe(true);
    }
    const lines = wakeLines(vi.mocked(console.info));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(
      formatWakeCatchupLog({
        answered: 2,
        stale: 1,
        alreadyHandled: 0,
        groupsChecked: 1,
        groupsDeferred: 0,
      }),
    );
    expect(lines[0]).not.toContain("secret-phrase-xyz");
    expect(lines[0]).not.toContain("!help");

    await poller.kick();
    expect(client.sent).toHaveLength(2);
    expect(wakeLines(vi.mocked(console.info)).at(-1)).toContain(
      formatWakeCatchupLog({
        answered: 0,
        stale: 0,
        alreadyHandled: 3,
        groupsChecked: 1,
        groupsDeferred: 0,
      }),
    );

    pull.mockResolvedValue({
      events: [
        command({
          id: "stale-2",
          sequenceId: "10",
          text: "!help secret-phrase-xyz",
          createdAt: stale.createdAt,
        }),
      ],
      newestId: "stale-2",
      watermarkId: "stale-2",
    });
    await poller.pollOnce();
    expect(client.sent).toHaveLength(2);
    expect(wakeLines(vi.mocked(console.info))).toHaveLength(2);
  });

  it("uses the configured wake window instead of 30 minutes", async () => {
    const store = new Store(":memory:");
    store.authorizeChat(GROUP);
    store.setWatermark(watermarkKey(GROUP), "seed");
    const client = new MockXClient({ id: "bot-1", username: "miladybot", name: "Mod Bot" });
    client.addUser(ALICE);
    const engine = new ModerationEngine(store, client, runtime());
    const pull = vi.fn().mockResolvedValue({
      events: [
        command({
          id: "two-min",
          sequenceId: "30",
          text: "!rules",
          createdAt: new Date(NOW - 2 * 60_000).toISOString(),
        }),
      ],
      newestId: "two-min",
      watermarkId: "two-min",
    });
    const poller = new ChatPoller(
      { pullNew: pull } as unknown as ChatService,
      store,
      engine,
      INTERVAL_MS,
      [GROUP],
      50,
      INTERVAL_MS,
      { now: () => NOW, wakeCommandMaxAgeMs: 60_000 },
    );
    track(poller, store);

    await poller.kick();
    expect(client.sent).toHaveLength(0);
    expect(store.hasProcessed("two-min")).toBe(true);
    expect(wakeLines(vi.mocked(console.info))[0]).toContain(
      formatWakeCatchupLog({
        answered: 0,
        stale: 1,
        alreadyHandled: 0,
        groupsChecked: 1,
        groupsDeferred: 0,
      }),
    );
  });

  it("answers an old command on a normal poll", async () => {
    const store = new Store(":memory:");
    store.authorizeChat(GROUP);
    store.setWatermark(watermarkKey(GROUP), "seed");
    const client = new MockXClient({ id: "bot-1", username: "miladybot", name: "Mod Bot" });
    client.addUser(ALICE);
    const engine = new ModerationEngine(store, client, runtime());
    const pull = vi.fn().mockResolvedValue({
      events: [
        command({
          id: "old-rules",
          sequenceId: "20",
          text: "!rules",
          createdAt: new Date(NOW - 2 * 60 * 60 * 1000).toISOString(),
        }),
      ],
      newestId: "old-rules",
      watermarkId: "old-rules",
    });
    const poller = new ChatPoller(
      { pullNew: pull } as unknown as ChatService,
      store,
      engine,
      INTERVAL_MS,
      [GROUP],
      50,
      INTERVAL_MS,
      { now: () => NOW },
    );
    track(poller, store);

    await poller.pollOnce();
    expect(client.sent.map((message) => message.text).join("\n")).toContain("RULES_TEXT");
    expect(wakeLines(vi.mocked(console.info))).toHaveLength(0);
  });

  it("does not answer a command Activity or an earlier poll already handled", async () => {
    const store = new Store(":memory:");
    store.authorizeChat(GROUP);
    store.setWatermark(watermarkKey(GROUP), "seed");
    const client = new MockXClient({ id: "bot-1", username: "miladybot", name: "Mod Bot" });
    client.addUser(ALICE);
    const engine = new ModerationEngine(store, client, runtime());
    const createdAt = new Date(NOW - 5 * 60_000).toISOString();
    await engine.processEvent(
      command({
        id: "activity-help",
        sequenceId: "55",
        text: "!help",
        createdAt,
      }),
    );
    expect(client.sent).toHaveLength(1);

    const help = command({
      id: "evt-help",
      sequenceId: "55",
      text: "!help",
      createdAt,
    });
    const rules = command({
      id: "evt-rules",
      sequenceId: "56",
      text: "!rules",
      createdAt,
    });
    const seenWatermarks: Array<string | undefined> = [];
    const pull = vi.fn(async (_conversationId: string, watermark: string | undefined) => {
      seenWatermarks.push(watermark);
      return {
        events: [help, rules],
        newestId: rules.id,
        watermarkId: rules.id,
      };
    });
    const poller = new ChatPoller(
      { pullNew: pull } as unknown as ChatService,
      store,
      engine,
      INTERVAL_MS,
      [GROUP],
      50,
      INTERVAL_MS,
      { now: () => NOW },
    );
    track(poller, store);

    await poller.kick();
    expect(seenWatermarks[0]).toBe("seed");
    expect(client.sent).toHaveLength(2);
    expect(client.sent.filter((message) => message.text.includes("HELP_TEXT"))).toHaveLength(1);
    expect(client.sent.filter((message) => message.text.includes("RULES_TEXT"))).toHaveLength(1);
    expect(wakeLines(vi.mocked(console.info))[0]).toContain(
      formatWakeCatchupLog({
        answered: 1,
        stale: 0,
        alreadyHandled: 1,
        groupsChecked: 1,
        groupsDeferred: 0,
      }),
    );

    await poller.kick();
    expect(seenWatermarks[1]).toBe(rules.id);
    expect(client.sent).toHaveLength(2);
    expect(wakeLines(vi.mocked(console.info))[1]).toContain(
      formatWakeCatchupLog({
        answered: 0,
        stale: 0,
        alreadyHandled: 2,
        groupsChecked: 1,
        groupsDeferred: 0,
      }),
    );
    expect(wakeLines(vi.mocked(console.info)).join("\n")).not.toContain("!help");
    expect(wakeLines(vi.mocked(console.info)).join("\n")).not.toContain("!rules");
  });

  it("reads the most recently active group and returns the rest to the normal rotation", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let now = NOW;
    const calls: string[] = [];
    const pull = vi.fn(async (conversationId: string) => {
      calls.push(conversationId);
      return emptyPull();
    });
    const store = new Store(":memory:");
    const poller = new ChatPoller(
      { pullNew: pull } as unknown as ChatService,
      store,
      { processEvent: vi.fn() } as unknown as ModerationEngine,
      INTERVAL_MS,
      [...GROUPS],
      50,
      INTERVAL_MS,
      {
        policy: chatListenPolicy({ mode: "all" }),
        maxPollsPerTick: 1,
        now: () => now,
      },
    );
    track(poller, store);
    poller.observeFromActivity("g11");
    now += 1_000;
    poller.observeFromActivity("g33");

    await poller.kick();
    expect(calls).toEqual(["g33"]);
    expect(wakeLines(vi.mocked(console.info))).toEqual([
      expect.stringContaining(
        formatWakeCatchupLog({
          answered: 0,
          stale: 0,
          alreadyHandled: 0,
          groupsChecked: 1,
          groupsDeferred: 2,
        }),
      ),
    ]);

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(calls).toEqual(["g33", "g11"]);
    expect(wakeLines(vi.mocked(console.info))).toHaveLength(1);
  });

  it("ranks a newer command ahead of older Activity", async () => {
    let now = NOW - 120_000;
    const calls: string[] = [];
    const pull = vi.fn(async (conversationId: string) => {
      calls.push(conversationId);
      if (conversationId !== "g22") return emptyPull();
      return {
        events: [
          command({
            id: "rules-g22",
            sequenceId: "1",
            text: "!rules",
            conversationId: "g22",
            createdAt: new Date(NOW).toISOString(),
          }),
        ],
        newestId: "rules-g22",
        watermarkId: "rules-g22",
      };
    });
    const store = new Store(":memory:");
    const poller = new ChatPoller(
      { pullNew: pull } as unknown as ChatService,
      store,
      { processEvent: vi.fn().mockResolvedValue({ replies: [] }) } as unknown as ModerationEngine,
      INTERVAL_MS,
      [...GROUPS],
      50,
      INTERVAL_MS,
      {
        policy: chatListenPolicy({ mode: "all" }),
        maxPollsPerTick: GROUPS.length,
        now: () => now,
      },
    );
    track(poller, store);
    poller.observeFromActivity("g11");
    now = NOW;

    await poller.pollOnce();
    expect(calls).toEqual([...GROUPS]);
    calls.length = 0;

    await poller.kick();
    expect(calls).toEqual(["g22"]);
    expect(wakeLines(vi.mocked(console.info))).toEqual([
      expect.stringContaining(
        formatWakeCatchupLog({
          answered: 0,
          stale: 0,
          alreadyHandled: 0,
          groupsChecked: 1,
          groupsDeferred: 2,
        }),
      ),
    ]);
  });

  it("reads two groups when CHAT_WAKE_MAX_GROUPS is 2, newest first", async () => {
    let now = NOW;
    const calls: string[] = [];
    const pull = vi.fn(async (conversationId: string) => {
      calls.push(conversationId);
      return emptyPull();
    });
    const store = new Store(":memory:");
    const poller = new ChatPoller(
      { pullNew: pull } as unknown as ChatService,
      store,
      { processEvent: vi.fn() } as unknown as ModerationEngine,
      INTERVAL_MS,
      [...GROUPS],
      50,
      INTERVAL_MS,
      {
        policy: chatListenPolicy({ mode: "all" }),
        wakeMaxGroups: 2,
        now: () => now,
      },
    );
    track(poller, store);
    poller.observeFromActivity("g11");
    now += 1_000;
    poller.observeFromActivity("g22");
    now += 1_000;
    poller.observeFromActivity("g33");

    await poller.kick();
    expect(calls).toEqual(["g33", "g22"]);
    expect(wakeLines(vi.mocked(console.info))).toEqual([
      expect.stringContaining(
        formatWakeCatchupLog({
          answered: 0,
          stale: 0,
          alreadyHandled: 0,
          groupsChecked: 2,
          groupsDeferred: 1,
        }),
      ),
    ]);
  });

  it.each([429, 402])(
    "stops the wake on the first %s and does not call X again until backoff ends",
    async (status) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      let now = NOW;
      const calls: string[] = [];
      const retryAfterMs = 60_000;
      const pull = vi.fn(async (conversationId: string) => {
        calls.push(conversationId);
        if (calls.length === 1) throw rateLimitError(retryAfterMs, status);
        return emptyPull();
      });
      const store = new Store(":memory:");
      const poller = new ChatPoller(
        { pullNew: pull } as unknown as ChatService,
        store,
        { processEvent: vi.fn() } as unknown as ModerationEngine,
        INTERVAL_MS,
        [...GROUPS],
        50,
        INTERVAL_MS,
        {
          policy: chatListenPolicy({ mode: "all" }),
          maxPollsPerTick: 1,
          wakeMaxGroups: 2,
          now: () => now,
        },
      );
      track(poller, store);
      poller.observeFromActivity("g11");
      now += 1_000;
      poller.observeFromActivity("g22");
      now += 1_000;
      poller.observeFromActivity("g33");

      await poller.kick();
      expect(calls).toEqual(["g33"]);
      expect(wakeLines(vi.mocked(console.info))[0]).toContain(
        formatWakeCatchupLog({
          answered: 0,
          stale: 0,
          alreadyHandled: 0,
          groupsChecked: 1,
          groupsDeferred: 2,
        }),
      );

      await poller.kick();
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toEqual(["g33"]);
      expect(wakeLines(vi.mocked(console.info)).at(-1)).toContain(
        formatWakeCatchupLog(
          { answered: 0, stale: 0, alreadyHandled: 0, groupsChecked: 0, groupsDeferred: 3 },
          { backoff: true },
        ),
      );

      await vi.advanceTimersByTimeAsync(retryAfterMs - 1);
      expect(calls).toEqual(["g33"]);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toEqual(["g33", "g22"]);
      expect(wakeLines(vi.mocked(console.info)).filter((line) => !line.includes("backoff"))).toHaveLength(1);
    },
  );

  it("reads CHAT_WAKE_COMMAND_MAX_AGE_MINUTES", () => {
    process.env.BOT_OWNER_ID = process.env.BOT_OWNER_ID ?? "1";
    const previous = process.env.CHAT_WAKE_COMMAND_MAX_AGE_MINUTES;
    try {
      delete process.env.CHAT_WAKE_COMMAND_MAX_AGE_MINUTES;
      expect(loadEnv(true).chatWakeCommandMaxAgeMinutes).toBeUndefined();
      process.env.CHAT_WAKE_COMMAND_MAX_AGE_MINUTES = " 15 ";
      expect(loadEnv(true).chatWakeCommandMaxAgeMinutes).toBe(15);
      process.env.CHAT_WAKE_COMMAND_MAX_AGE_MINUTES = "0";
      expect(loadEnv(true).chatWakeCommandMaxAgeMinutes).toBe(0);
      process.env.CHAT_WAKE_COMMAND_MAX_AGE_MINUTES = "-1";
      expect(() => loadEnv(true)).toThrow(/CHAT_WAKE_COMMAND_MAX_AGE_MINUTES/);
      process.env.CHAT_WAKE_COMMAND_MAX_AGE_MINUTES = "30.5";
      expect(() => loadEnv(true)).toThrow(/CHAT_WAKE_COMMAND_MAX_AGE_MINUTES/);
    } finally {
      if (previous === undefined) delete process.env.CHAT_WAKE_COMMAND_MAX_AGE_MINUTES;
      else process.env.CHAT_WAKE_COMMAND_MAX_AGE_MINUTES = previous;
    }
  });

  it("reads CHAT_WAKE_MAX_GROUPS", () => {
    process.env.BOT_OWNER_ID = process.env.BOT_OWNER_ID ?? "1";
    const previous = process.env.CHAT_WAKE_MAX_GROUPS;
    try {
      delete process.env.CHAT_WAKE_MAX_GROUPS;
      expect(loadEnv(true).chatWakeMaxGroups).toBeUndefined();
      process.env.CHAT_WAKE_MAX_GROUPS = " 3 ";
      expect(loadEnv(true).chatWakeMaxGroups).toBe(3);
      process.env.CHAT_WAKE_MAX_GROUPS = "1";
      expect(loadEnv(true).chatWakeMaxGroups).toBe(1);
      process.env.CHAT_WAKE_MAX_GROUPS = "0";
      expect(() => loadEnv(true)).toThrow(/CHAT_WAKE_MAX_GROUPS/);
      process.env.CHAT_WAKE_MAX_GROUPS = "-1";
      expect(() => loadEnv(true)).toThrow(/CHAT_WAKE_MAX_GROUPS/);
      process.env.CHAT_WAKE_MAX_GROUPS = "1.5";
      expect(() => loadEnv(true)).toThrow(/CHAT_WAKE_MAX_GROUPS/);
    } finally {
      if (previous === undefined) delete process.env.CHAT_WAKE_MAX_GROUPS;
      else process.env.CHAT_WAKE_MAX_GROUPS = previous;
    }
  });
});
