import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModerationEngine } from "../src/bot/engine.js";
import { loadDefaults, DEFAULT_LLM_CONFIG } from "../src/config.js";
import {
  boundedHistoryRetryMs,
  drainEngineLlmRetries,
  isRecoverableChatError,
  LLM_HISTORY_RETRY_CAP_MS,
  LLM_RATE_LIMIT_ACK,
  LLM_RATE_LIMIT_GAVE_UP,
  LLM_RETRY_MAX_ATTEMPTS,
  llmRetryExhausted,
  startLlmRetryDrain,
} from "../src/llm/chat-retry.js";
import { MockLlmClient } from "../src/llm/mock.js";
import { Store } from "../src/store.js";
import type { BotRuntimeConfig, DefaultsConfig, DmEvent, XUser } from "../src/types.js";
import { MockXClient } from "../src/x/mock-client.js";

const alice: XUser = { id: "u-alice", username: "alice", name: "Alice" };
const owner: XUser = { id: "u-owner", username: "owner", name: "Owner" };
const groupId = "1578398451921985538";
const NOW = 1_700_000_000_000;

const defaults: DefaultsConfig = {
  welcome: { enabled: false, text: "Welcome @{username}!" },
  rules: "Be nice.",
  help: "Type !rules",
  flood: { max_messages: 8, window_ms: 10_000, mute_ms: 60_000, warn_on_flood: false },
  warns: { limit: 2, auto_mute_ms: 60_000, notify_admins: false },
  filters: [],
  poll: { interval_ms: 1000, max_results: 50 },
  delete: { attempt_on_filter: false, attempt_on_flood: false, attempt_on_mute: false },
  llm: {
    ...DEFAULT_LLM_CONFIG,
    enabled: true,
    allow: "everyone",
    context_mode: "recent",
    recent_messages: 2,
    none_recent_messages: 1,
    rate_limit_per_user: 8,
    rate_limit_window_ms: 60_000,
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
  const sender = partial.sender ?? [alice, owner].find((user) => user.id === partial.senderId);
  return {
    eventType: "MessageCreate",
    conversationId: groupId,
    participantIds: [],
    participants: [],
    mentions: [],
    sender,
    createdAt: "2026-01-01T00:00:00Z",
    ...partial,
  };
}

function rateLimit(waitMs: number, status = 429): Error {
  const error = new Error(`Rate limited; retry after ${waitMs}ms`) as Error & {
    status: number;
    retryAfterMs: number;
  };
  error.status = status;
  error.retryAfterMs = waitMs;
  return error;
}

function failHistory(client: MockXClient, times: number, error: unknown): { calls(): number } {
  const original = client.listConversationDmEvents.bind(client);
  let left = times;
  let calls = 0;
  client.listConversationDmEvents = async (params) => {
    calls += 1;
    if (left > 0) {
      left -= 1;
      throw error;
    }
    return original(params);
  };
  return { calls: () => calls };
}

describe("chat retry helpers", () => {
  it("treats 429, 503, 402, and retryAfterMs as recoverable", () => {
    expect(isRecoverableChatError(rateLimit(12_000))).toBe(true);
    expect(isRecoverableChatError(rateLimit(1_000, 402))).toBe(true);
    const unavailable = new Error("X API GET /2/chat -> 503") as Error & { status: number };
    unavailable.status = 503;
    expect(isRecoverableChatError(unavailable)).toBe(true);
    const hinted = new Error("later") as Error & { retryAfterMs: number };
    hinted.retryAfterMs = 20;
    expect(isRecoverableChatError(hinted)).toBe(true);
    expect(isRecoverableChatError(new Error("Rate limited; retry after 9ms"))).toBe(true);
    expect(isRecoverableChatError(new Error("socket hang up"))).toBe(false);
    const fatal = new Error("nope") as Error & { status: number };
    fatal.status = 500;
    expect(isRecoverableChatError(fatal)).toBe(false);
  });

  it("caps the inline history sleep and ends old jobs", () => {
    expect(boundedHistoryRetryMs(30_000)).toBe(LLM_HISTORY_RETRY_CAP_MS);
    expect(boundedHistoryRetryMs(40)).toBe(40);
    expect(boundedHistoryRetryMs(undefined)).toBe(0);
    expect(llmRetryExhausted({ attempts: LLM_RETRY_MAX_ATTEMPTS, createdAtMs: NOW }, NOW)).toBe(
      true,
    );
    expect(llmRetryExhausted({ attempts: 1, createdAtMs: NOW - 6 * 60 * 60 * 1000 }, NOW)).toBe(
      true,
    );
    expect(llmRetryExhausted({ attempts: 1, createdAtMs: NOW }, NOW + 1_000)).toBe(false);
  });

  it("starts a drain immediately and on the interval", async () => {
    vi.useFakeTimers();
    const drainLlmRetries = vi.fn().mockResolvedValue(0);
    const handle = startLlmRetryDrain({ drainLlmRetries }, 1_000);
    expect(drainLlmRetries).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(drainLlmRetries).toHaveBeenCalledTimes(2);
    handle.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(drainLlmRetries).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("ignores an engine that has no drain method", async () => {
    await expect(drainEngineLlmRetries({})).resolves.toBeUndefined();
  });
});

describe("LLM history rate limits", () => {
  const stores: Store[] = [];
  const files: string[] = [];

  afterEach(() => {
    for (const store of stores) store.close();
    stores.length = 0;
    for (const file of files) {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    }
    files.length = 0;
  });

  function setup(llm: MockLlmClient, filename = ":memory:") {
    const slept: number[] = [];
    const store = new Store(filename);
    stores.push(store);
    const client = new MockXClient();
    client.addUser(alice);
    client.addUser(owner);
    const engine = new ModerationEngine(store, client, runtime(), llm, {
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    return { engine, client, store, llm, slept };
  }

  it("retries history once after a bounded sleep, then uses it", async () => {
    const llm = new MockLlmClient("standup is at 10");
    const { engine, client, slept, store } = setup(llm);
    client.events.push(
      message({
        id: "h1",
        senderId: owner.id,
        text: "lets meet at 10",
        createdAt: "2026-01-01T00:00:01Z",
      }),
    );
    const history = failHistory(client, 1, rateLimit(30_000));
    const result = await engine.processEvent(
      message({ id: "q1", senderId: alice.id, text: "!ask when is standup?" }),
      NOW,
    );
    expect(result.llm).toBe(true);
    expect(slept).toEqual([LLM_HISTORY_RETRY_CAP_MS]);
    expect(history.calls()).toBe(2);
    expect(llm.calls[0]?.[1]?.content ?? "").toContain("lets meet at 10");
    expect(client.sent.at(-1)?.text).toBe("@alice standup is at 10");
    expect(store.listLlmRetries()).toHaveLength(0);
  });

  it("answers !ask without history when the retry is still rate-limited", async () => {
    const llm = new MockLlmClient("roasted anyway");
    const { engine, client, slept, store } = setup(llm);
    client.events.push(
      message({ id: "h1", senderId: owner.id, text: "secret standup", createdAt: "2026-01-01T00:00:01Z" }),
    );
    const history = failHistory(client, 2, rateLimit(30_000));
    const result = await engine.processEvent(
      message({ id: "q2", senderId: alice.id, text: "@modbot roast their timeline" }),
      NOW,
    );
    expect(result.llm).toBe(true);
    expect(slept).toEqual([LLM_HISTORY_RETRY_CAP_MS]);
    expect(history.calls()).toBe(2);
    const user = llm.calls[0]?.[1]?.content ?? "";
    expect(user).toContain("roast their timeline");
    expect(user).not.toContain("secret standup");
    expect(client.sent.map((row) => row.text)).toEqual(["@alice roasted anyway"]);
    expect(store.listLlmRetries()).toHaveLength(0);
  });

  it("retries a 503 immediately, then still answers !ask", async () => {
    const llm = new MockLlmClient("still here");
    const { engine, client, slept, store } = setup(llm);
    const error = new Error("X API GET /2/dm_conversations -> 503") as Error & { status: number };
    error.status = 503;
    const history = failHistory(client, 2, error);
    await engine.processEvent(message({ id: "q3", senderId: alice.id, text: "!ask ping" }), NOW);
    expect(slept).toEqual([]);
    expect(history.calls()).toBe(2);
    expect(client.sent.at(-1)?.text).toBe("@alice still here");
    expect(store.listLlmRetries()).toHaveLength(0);
  });

  it("does not queue a non-recoverable history failure", async () => {
    const llm = new MockLlmClient("nope");
    const { engine, client, store } = setup(llm);
    failHistory(client, 1, new Error("socket hang up"));
    await expect(
      engine.processEvent(message({ id: "q4", senderId: alice.id, text: "!ask ping" }), NOW),
    ).rejects.toThrow(/socket hang up/);
    expect(llm.calls).toHaveLength(0);
    expect(store.listLlmRetries()).toHaveLength(0);
    expect(client.sent).toHaveLength(0);
  });

  it("soft-acks and queues summarize, then a restarted engine drains it", async () => {
    const file = path.join(os.tmpdir(), `llm-retry-${process.pid}-${Date.now()}.sqlite`);
    files.push(file);
    const llm = new MockLlmClient("thread summary");
    const first = setup(llm, file);
    first.client.events.push(
      message({ id: "h1", senderId: owner.id, text: "ship friday", createdAt: "2026-01-01T00:00:01Z" }),
    );
    failHistory(first.client, 2, rateLimit(30_000));
    const result = await first.engine.processEvent(
      message({ id: "s1", senderId: alice.id, text: "!summarize" }),
      NOW,
    );
    expect(result.llm).toBe(false);
    expect(first.slept).toEqual([LLM_HISTORY_RETRY_CAP_MS]);
    expect(first.llm.calls).toHaveLength(0);
    expect(first.client.sent.map((row) => row.text)).toEqual([`@alice ${LLM_RATE_LIMIT_ACK}`]);
    expect(first.store.listLlmRetries()).toHaveLength(1);
    expect(JSON.parse(first.store.listLlmRetries()[0]!.payload).kind).toBe("summarize");
    expect(await first.engine.drainLlmRetries(NOW + 29_999)).toBe(0);
    expect(first.llm.calls).toHaveLength(0);

    first.store.close();
    stores.pop();

    const llm2 = new MockLlmClient("thread summary");
    const second = setup(llm2, file);
    second.client.events.push(
      message({ id: "h1", senderId: owner.id, text: "ship friday", createdAt: "2026-01-01T00:00:01Z" }),
    );
    expect(second.store.listLlmRetries()).toHaveLength(1);
    expect(await second.engine.drainLlmRetries(NOW + 30_000)).toBe(1);
    expect(second.client.sent.at(-1)?.text).toBe("@alice thread summary");
    expect(second.llm.calls[0]?.[1]?.content ?? "").toContain("ship friday");
    expect(second.store.listLlmRetries()).toHaveLength(0);
  });

  it("gives up once the attempt cap is reached", async () => {
    const llm = new MockLlmClient("unused");
    const { engine, client, store } = setup(llm);
    failHistory(client, 5, rateLimit(30_000));
    await engine.processEvent(message({ id: "s2", senderId: alice.id, text: "!analyze" }), NOW);
    const job = store.listLlmRetries()[0]!;
    const calls = client.conversationListCalls.length;
    store.db.prepare("UPDATE llm_retry_jobs SET attempts = ? WHERE id = ?").run(
      LLM_RETRY_MAX_ATTEMPTS,
      job.id,
    );
    expect(await engine.drainLlmRetries(NOW + 30_000)).toBe(1);
    expect(client.conversationListCalls).toHaveLength(calls);
    expect(client.sent.at(-1)?.text).toBe(`@alice ${LLM_RATE_LIMIT_GAVE_UP}`);
    expect(store.listLlmRetries()).toHaveLength(0);
    expect(llm.calls).toHaveLength(0);
  });

  it("keeps a computed answer when the send is rate-limited and resends it later", async () => {
    const llm = new MockLlmClient("cached roast");
    const { engine, client, store } = setup(llm);
    const original = client.sendMessage.bind(client);
    let sends = 0;
    client.sendMessage = async (conversationId, text, caption) => {
      sends += 1;
      if (sends === 1) throw rateLimit(2_000);
      return original(conversationId, text, caption);
    };
    await engine.processEvent(message({ id: "q5", senderId: alice.id, text: "!ask hello" }), NOW);
    expect(llm.calls).toHaveLength(1);
    expect(client.sent.map((row) => row.text)).toEqual([`@alice ${LLM_RATE_LIMIT_ACK}`]);
    const payload = JSON.parse(store.listLlmRetries()[0]!.payload) as { cachedAnswer?: string };
    expect(payload.cachedAnswer).toBe("cached roast");
    expect(await engine.drainLlmRetries(NOW + 2_000)).toBe(1);
    expect(llm.calls).toHaveLength(1);
    expect(client.sent.at(-1)?.text).toBe("@alice cached roast");
    expect(store.listLlmRetries()).toHaveLength(0);
  });

  it("holds an LLM event from the activity safety net and ignores other commands", async () => {
    const llm = new MockLlmClient("unused");
    const { engine, client, store } = setup(llm);
    const held = await engine.holdLlmForChatLimit(
      message({ id: "s3", senderId: alice.id, text: "!summarize the week" }),
      rateLimit(4_000),
      NOW,
    );
    expect(held).toBe(true);
    expect(client.sent[0]?.text).toBe(`@alice ${LLM_RATE_LIMIT_ACK}`);
    expect(store.listLlmRetries()).toHaveLength(1);
    const ignored = await engine.holdLlmForChatLimit(
      message({ id: "h", senderId: alice.id, text: "!help" }),
      rateLimit(4_000),
      NOW,
    );
    expect(ignored).toBe(false);
    expect(store.listLlmRetries()).toHaveLength(1);
  });

  it("mentions the rate-limit retry in !help and the README", () => {
    const help = loadDefaults("config/default.yaml").help;
    expect(help).toMatch(/Rate limit/);
    expect(help).toMatch(/!ask, !summarize, or !analyze/);
    const readme = fs.readFileSync("README.md", "utf8");
    expect(readme).toMatch(/llm_retry_jobs/);
    expect(readme).toMatch(/X Chat is rate-limiting me right now/);
  });
});
