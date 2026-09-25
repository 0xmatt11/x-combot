import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModerationEngine } from "../src/bot/engine.js";
import { Poller, nextPollDelayMs, shouldPollClassicDms } from "../src/poller.js";
import type { Store } from "../src/store.js";
import type { XClient } from "../src/x/client.js";
import { CREDITS_DEPLETED_BACKOFF_MS, LiveXClient } from "../src/x/live-client.js";

const INTERVAL_MS = 12_000;
const NOW = new Date("2026-09-23T12:00:00.000Z");

function rateLimitError(status: number, retryAfterMs: number): Error {
  const error = new Error(`HTTP ${status}`) as Error & {
    status: number;
    retryAfterMs: number;
  };
  error.status = status;
  error.retryAfterMs = retryAfterMs;
  return error;
}

function createPoller(listDmEvents: ReturnType<typeof vi.fn>): Poller {
  const client = { listDmEvents } as unknown as XClient;
  const store = {
    getWatermark: () => undefined,
    setWatermark: () => {},
  } as unknown as Store;
  return new Poller(client, store, {} as ModerationEngine, INTERVAL_MS, 50);
}

describe("nextPollDelayMs", () => {
  it("keeps the configured interval when the error has no retry hint", () => {
    expect(nextPollDelayMs(INTERVAL_MS, new Error("network"))).toBe(INTERVAL_MS);
    expect(nextPollDelayMs(INTERVAL_MS, undefined)).toBe(INTERVAL_MS);
  });

  it("uses retryAfterMs when a 429 or 402 wait is longer than the interval", () => {
    expect(nextPollDelayMs(INTERVAL_MS, rateLimitError(429, 60_000))).toBe(60_000);
    expect(nextPollDelayMs(INTERVAL_MS, rateLimitError(402, CREDITS_DEPLETED_BACKOFF_MS))).toBe(
      CREDITS_DEPLETED_BACKOFF_MS,
    );
  });

  it("does not poll faster than the interval when retryAfterMs is shorter", () => {
    expect(nextPollDelayMs(INTERVAL_MS, rateLimitError(429, 1_000))).toBe(INTERVAL_MS);
  });
});

describe("Poller scheduling", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("schedules the next poll on intervalMs after success", async () => {
    const listDmEvents = vi.fn().mockResolvedValue({ events: [] });
    const poller = createPoller(listDmEvents);

    await poller.tick();
    expect(listDmEvents).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(INTERVAL_MS - 1);
    expect(listDmEvents).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(listDmEvents).toHaveBeenCalledTimes(2);

    poller.stop();
  });

  it("waits out a 429 retryAfterMs instead of the poll interval", async () => {
    const retryAfterMs = 60_000;
    const listDmEvents = vi
      .fn()
      .mockRejectedValueOnce(rateLimitError(429, retryAfterMs))
      .mockResolvedValue({ events: [] });
    const poller = createPoller(listDmEvents);

    await poller.tick();
    expect(listDmEvents).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(listDmEvents).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(retryAfterMs - INTERVAL_MS);
    expect(listDmEvents).toHaveBeenCalledTimes(2);

    poller.stop();
  });

  it("waits out a 402 credits backoff instead of the poll interval", async () => {
    const retryAfterMs = CREDITS_DEPLETED_BACKOFF_MS;
    const listDmEvents = vi
      .fn()
      .mockRejectedValueOnce(rateLimitError(402, retryAfterMs))
      .mockResolvedValue({ events: [] });
    const poller = createPoller(listDmEvents);

    await poller.tick();
    expect(listDmEvents).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(listDmEvents).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(retryAfterMs - INTERVAL_MS - 1);
    expect(listDmEvents).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(listDmEvents).toHaveBeenCalledTimes(2);

    poller.stop();
  });

  it("keeps the interval when a failure has no retryAfterMs", async () => {
    const listDmEvents = vi
      .fn()
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValue({ events: [] });
    const poller = createPoller(listDmEvents);

    await poller.tick();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS - 1);
    expect(listDmEvents).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(listDmEvents).toHaveBeenCalledTimes(2);

    poller.stop();
  });

  it("drains LLM retries after a successful DM poll and skips the drain when the poll throws", async () => {
    const drainLlmRetries = vi.fn().mockResolvedValue(0);
    const listDmEvents = vi.fn().mockResolvedValue({ events: [] });
    const client = { listDmEvents } as unknown as XClient;
    const store = {
      getWatermark: () => undefined,
      setWatermark: () => {},
    } as unknown as Store;
    const poller = new Poller(
      client,
      store,
      { drainLlmRetries } as unknown as ModerationEngine,
      INTERVAL_MS,
      50,
    );

    await poller.tick();
    expect(drainLlmRetries).toHaveBeenCalledTimes(1);

    listDmEvents.mockRejectedValueOnce(rateLimitError(429, 60_000));
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(drainLlmRetries).toHaveBeenCalledTimes(1);

    poller.stop();
  });
});

describe("Poller with LiveXClient backoff", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(NOW);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function livePoller(): { poller: Poller; fetchMock: ReturnType<typeof vi.fn> } {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = new LiveXClient({
      tokens: {
        accessToken: "test-access-token",
        expiresAtMs: NOW.getTime() + 60 * 60 * 1000,
      },
    });
    const store = {
      getWatermark: () => undefined,
      setWatermark: () => {},
    } as unknown as Store;
    const poller = new Poller(client, store, {} as ModerationEngine, INTERVAL_MS, 50);
    return { poller, fetchMock };
  }

  it("does not poll again until the 429 reset", async () => {
    const resetSec = Math.floor(NOW.getTime() / 1000) + 90;
    const { poller, fetchMock } = livePoller();
    fetchMock
      .mockResolvedValueOnce(
        new Response("rate limited", {
          status: 429,
          headers: { "x-rate-limit-reset": String(resetSec) },
        }),
      )
      .mockResolvedValue(
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    await poller.tick();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(90_000 - INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    poller.stop();
  });

  it("does not poll again until the 402 credits backoff elapses", async () => {
    const { poller, fetchMock } = livePoller();
    fetchMock.mockResolvedValue(new Response("credits depleted", { status: 402 }));

    await poller.tick();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(CREDITS_DEPLETED_BACKOFF_MS - INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    poller.stop();
  });
});

describe("shouldPollClassicDms", () => {
  it("skips classic DM polling when encrypted Chat is active", () => {
    expect(shouldPollClassicDms({ chatEnabled: true, dmPoll: undefined })).toBe(false);
    expect(shouldPollClassicDms({ chatEnabled: false, dmPoll: undefined })).toBe(true);
  });

  it("lets DM_POLL override the Chat-only default", () => {
    expect(shouldPollClassicDms({ chatEnabled: true, dmPoll: true })).toBe(true);
    expect(shouldPollClassicDms({ chatEnabled: false, dmPoll: false })).toBe(false);
  });
});
