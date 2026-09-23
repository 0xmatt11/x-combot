import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHAT_MESSAGE_EVENT_FIELDS,
  CREDITS_DEPLETED_BACKOFF_MS,
  LiveXClient,
  headerBackoffMs,
  type ApiError,
} from "../src/x/live-client.js";

const NOW = new Date("2026-09-23T12:00:00.000Z");

function client(): LiveXClient {
  return new LiveXClient({
    tokens: {
      accessToken: "test-access-token",
      expiresAtMs: NOW.getTime() + 60 * 60 * 1000,
    },
  });
}

async function capture(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    return error as ApiError;
  }
  throw new Error("expected rejection");
}

describe("headerBackoffMs", () => {
  const now = NOW.getTime();

  it("reads x-rate-limit-reset as UTC epoch seconds", () => {
    const headers = new Headers({
      "x-rate-limit-reset": String(Math.floor(now / 1000) + 90),
    });
    expect(headerBackoffMs(headers, now)).toBe(90_000);
  });

  it("reads Retry-After delay-seconds", () => {
    expect(headerBackoffMs(new Headers({ "retry-after": "45" }), now)).toBe(45_000);
  });

  it("reads a Retry-After HTTP date", () => {
    const headers = new Headers({
      "retry-after": new Date(now + 75_000).toUTCString(),
    });
    expect(headerBackoffMs(headers, now)).toBe(75_000);
  });

  it("uses the longer of x-rate-limit-reset and Retry-After", () => {
    const headers = new Headers({
      "x-rate-limit-reset": String(Math.floor(now / 1000) + 30),
      "retry-after": "180",
    });
    expect(headerBackoffMs(headers, now)).toBe(180_000);

    const resetLonger = new Headers({
      "x-rate-limit-reset": String(Math.floor(now / 1000) + 200),
      "retry-after": "10",
    });
    expect(headerBackoffMs(resetLonger, now)).toBe(200_000);
  });

  it("returns undefined when neither header is usable", () => {
    expect(headerBackoffMs(new Headers(), now)).toBeUndefined();
    expect(headerBackoffMs(new Headers({ "x-rate-limit-reset": "nope" }), now)).toBeUndefined();
  });

  it("clamps an already-elapsed reset to a short minimum", () => {
    const headers = new Headers({
      "x-rate-limit-reset": String(Math.floor(now / 1000) - 10),
    });
    expect(headerBackoffMs(headers, now)).toBe(1_000);
  });
});

describe("LiveXClient 429 and 402", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("attaches retryAfterMs from x-rate-limit-reset on HTTP 429", async () => {
    const resetSec = Math.floor(NOW.getTime() / 1000) + 120;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("rate limited", {
          status: 429,
          headers: { "x-rate-limit-reset": String(resetSec) },
        }),
      ),
    );

    const error = await capture(client().listDmEvents({}));
    expect(error.status).toBe(429);
    expect(error.retryAfterMs).toBe(120_000);
    expect(error.message).toContain("120000");
  });

  it("prefers the longer Retry-After over a shorter reset", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("", {
          status: 429,
          headers: {
            "x-rate-limit-reset": String(Math.floor(NOW.getTime() / 1000) + 20),
            "retry-after": "90",
          },
        }),
      ),
    );

    const error = await capture(client().listDmEvents({}));
    expect(error.status).toBe(429);
    expect(error.retryAfterMs).toBe(90_000);
  });

  it("falls back to 15s when a 429 has no reset headers", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 429 })));
    const error = await capture(client().listDmEvents({}));
    expect(error.status).toBe(429);
    expect(error.retryAfterMs).toBe(15_000);
  });

  it("backs off several minutes on HTTP 402 even without Retry-After", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("credits depleted", { status: 402 })),
    );

    const error = await capture(client().listDmEvents({}));
    expect(error.status).toBe(402);
    expect(error.retryAfterMs).toBe(CREDITS_DEPLETED_BACKOFF_MS);
    expect(CREDITS_DEPLETED_BACKOFF_MS).toBeGreaterThanOrEqual(3 * 60 * 1000);
    expect(error.message).toMatch(/Credits depleted/i);
  });

  it("honors a Retry-After longer than the 402 floor", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("", {
          status: 402,
          headers: { "retry-after": "600" },
        }),
      ),
    );

    const error = await capture(client().listDmEvents({}));
    expect(error.retryAfterMs).toBe(600_000);
  });

  it("requests Chat conversation events on /2/chat", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [], meta: { conversation_key_events: [] } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await client().getChatConversationEvents("g2029561975647150382", { maxResults: 25 });
    const url = new URL(String((fetchMock.mock.calls as unknown[][])[0]?.[0]));
    expect(url.pathname).toBe("/2/chat/conversations/g2029561975647150382/events");
    expect(url.searchParams.get("max_results")).toBe("25");
    const fields = url.searchParams.get("chat_message_event.fields")?.split(",") ?? [];
    const allowed = [
      "id",
      "conversation_id",
      "conversation_token",
      "created_at",
      "encoded_event",
      "is_trusted",
      "previous_id",
      "sender_id",
      "message_event_signature",
    ];
    expect(fields).toEqual(CHAT_MESSAGE_EVENT_FIELDS.split(","));
    expect(fields.every((field) => allowed.includes(field))).toBe(true);
    expect(fields).toContain("created_at");
    expect(fields).toContain("encoded_event");
    expect(fields).not.toContain("created_at_msec");
    expect(fields).not.toContain("sequence_id");
  });

  it("does not attach retryAfterMs to other HTTP failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "nope" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const error = await capture(client().listDmEvents({}));
    expect(error.status).toBe(500);
    expect(error.retryAfterMs).toBeUndefined();
  });
});
