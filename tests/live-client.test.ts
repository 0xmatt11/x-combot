import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHAT_MESSAGE_EVENT_FIELDS,
  CREDITS_DEPLETED_BACKOFF_MS,
  LiveXClient,
  dmMediaSpec,
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

describe("DM image attach", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps gif uploads to dm_gif and still photos to dm_image", () => {
    expect(dmMediaSpec("image/gif").mediaCategory).toBe("dm_gif");
    expect(dmMediaSpec("image/jpeg").mediaCategory).toBe("dm_image");
    expect(dmMediaSpec("image/png; charset=binary").mediaType).toBe("image/png");
  });

  it("uploads dm_image then sends attachments.media_id", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        const path = String(url);
        if (path.endsWith("/2/media/upload/initialize")) {
          return new Response(JSON.stringify({ data: { id: "999" } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (path.includes("/append") || path.includes("/finalize")) {
          return new Response("", { status: 200 });
        }
        return new Response(
          JSON.stringify({ data: { dm_conversation_id: "1578", dm_event_id: "evt-9" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const live = new LiveXClient({
      tokens: {
        accessToken: "test-access-token",
        expiresAtMs: Date.now() + 60 * 60 * 1000,
      },
    });
    const result = await live.sendImage("1578398451921985538", {
      url: "https://i.redd.it/should-not-be-logged.jpg",
      bytes: Uint8Array.from([1, 2, 3, 4]),
      mimeType: "image/jpeg",
    });
    expect(result.dmEventId).toBe("evt-9");
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/2/media/upload/initialize",
      "/2/media/upload/999/append",
      "/2/media/upload/999/finalize",
      "/2/dm_conversations/1578398451921985538/messages",
    ]);
    const initBody = JSON.parse(String(calls[0]?.init.body));
    expect(initBody).toMatchObject({
      media_type: "image/jpeg",
      media_category: "dm_image",
      total_bytes: 4,
    });
    expect(calls[1]?.init.body).toBeInstanceOf(FormData);
    const message = JSON.parse(String(calls[3]?.init.body));
    expect(message).toEqual({
      text: "18+",
      attachments: [{ media_id: "999" }],
    });
    expect(String(calls[0]?.init.headers && (calls[0].init.headers as Record<string, string>).Authorization)).toBe(
      "Bearer test-access-token",
    );
    expect(calls.some((call) => call.url.includes("should-not-be-logged"))).toBe(false);
  });
});

describe("Activity subscription auth", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function freshClient(): LiveXClient {
    return new LiveXClient({
      clientId: "cid",
      tokens: {
        accessToken: "user-access-token",
        refreshToken: "user-refresh-token",
        expiresAtMs: Date.now() + 60 * 60 * 1000,
      },
    });
  }

  function authHeader(init: RequestInit | undefined): string | undefined {
    const headers = init?.headers;
    if (!headers || typeof headers !== "object" || headers instanceof Headers) return undefined;
    return (headers as Record<string, string>).Authorization;
  }

  it("lists subscriptions with the app-only bearer and does not refresh the user token", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const expired = new LiveXClient({
      tokens: {
        accessToken: "user-access-token",
        refreshToken: "user-refresh-token",
        expiresAtMs: Date.now() - 60_000,
      },
    });

    await expired.listActivitySubscriptions("app-only-bearer");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(new URL(String(url)).pathname).toBe("/2/activity/subscriptions");
    expect(new URL(String(url)).searchParams.get("max_results")).toBe("1000");
    expect(init.method ?? "GET").toBe("GET");
    expect(authHeader(init)).toBe("Bearer app-only-bearer");
  });

  it("does not fall back to the user token when the app bearer is rejected", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ title: "Unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const error = await capture(freshClient().listActivitySubscriptions("app-only-bearer"));
    expect(error.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain("/2/activity/subscriptions");
    expect(authHeader((fetchMock.mock.calls[0] as [URL, RequestInit])[1])).toBe(
      "Bearer app-only-bearer",
    );
  });

  it("refuses to list subscriptions when the app bearer is missing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const error = await capture(freshClient().listActivitySubscriptions("  "));
    expect(error.message).toMatch(/ACTIVITY_BEARER_TOKEN is required for GET \/2\/activity\/subscriptions/);
    expect(error.message).toMatch(/403/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("creates chat.received with the user access token", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: { id: "sub-1" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const body = {
      event_type: "chat.received",
      filter: { user_id: "bot-1" },
    };

    await freshClient().createActivitySubscription(body);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(new URL(String(url)).pathname).toBe("/2/activity/subscriptions");
    expect(init.method).toBe("POST");
    expect(authHeader(init)).toBe("Bearer user-access-token");
    expect(JSON.parse(String(init.body))).toEqual(body);
  });
});
