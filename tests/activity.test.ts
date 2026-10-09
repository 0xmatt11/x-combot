import { afterEach, describe, expect, it, vi } from "vitest";
import { ModerationEngine } from "../src/bot/engine.js";
import type { LlmClient } from "../src/llm/client.js";
import { LLM_RATE_LIMIT_ACK } from "../src/llm/chat-retry.js";
import { MockLlmClient } from "../src/llm/mock.js";
import {
  ChatActivityIntake,
  chatReceivedSubscriptionBody,
  crcResponseToken,
  hasChatReceivedSubscription,
  parseActivityChat,
  parseActivityGroupSignal,
  signWebhookBody,
  takeActivityLines,
} from "../src/chat/activity.js";
import { chatListenPolicy } from "../src/chat/listen.js";
import { readActivityBody } from "../src/chat/activity-stream.js";
import {
  ensureChatActivitySubscription,
  requireActivityAppBearer,
} from "../src/chat/activity-subscribe.js";
import { startActivityWebhook } from "../src/chat/activity-webhook.js";
import type { ChatCipher, DecryptedEvent, LoadedChatIdentity } from "../src/chat/cipher.js";
import { DECRYPT_WARN_INTERVAL_MS, logDecryptErrors, resetDecryptWarningWindow } from "../src/chat/decrypt-log.js";
import type { ChatHttp, RawChatEventsPage } from "../src/chat/http.js";
import { ChatService } from "../src/chat/service.js";
import { Store } from "../src/store.js";
import type { BotRuntimeConfig, DefaultsConfig } from "../src/types.js";
import { MockXClient } from "../src/x/mock-client.js";
import { RoutedXClient } from "../src/x/routed-client.js";

const GROUP = "g2029561975647150382";

const defaults: DefaultsConfig = {
  welcome: { enabled: false, text: "Welcome @{username}!" },
  rules: "Be nice.",
  help: "CHAT_HELP_OK",
  flood: { max_messages: 5, window_ms: 10_000, mute_ms: 60_000, warn_on_flood: false },
  warns: { limit: 3, auto_mute_ms: 60_000, notify_admins: false },
  filters: [],
  poll: { interval_ms: 1000, max_results: 50 },
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

class FakeCipher implements ChatCipher {
  readonly texts: string[] = [];
  readonly batches: string[][] = [];
  readonly events = new Map<string, DecryptedEvent>();

  setSigningKeys(): void {}

  verifyKeyBinding(): boolean {
    return true;
  }

  matchesRegisteredKey(): boolean {
    return false;
  }

  loadedIdentity(): LoadedChatIdentity | undefined {
    return undefined;
  }

  decryptEvents(eventsB64: string[]) {
    this.batches.push([...eventsB64]);
    const messages = [];
    const errors: Record<string, string> = {};
    for (const b64 of eventsB64) {
      const event = this.events.get(b64);
      if (event) messages.push({ event, originalB64: b64 });
      else errors[b64] = "missing key";
    }
    return { messages, errors };
  }

  encryptMessage(_conversationId: string, text: string) {
    this.texts.push(text);
    return {
      messageId: "mid-1",
      encryptedContent: `enc:${text}`,
      encodedEventSignature: "sig",
    };
  }

  encryptReply(conversationId: string, text: string) {
    return this.encryptMessage(conversationId, text);
  }

  encryptStream(plaintext: Uint8Array, _conversationKey: Uint8Array) {
    return plaintext;
  }

  prepareMessageDelete() {
    return {
      messageId: "del",
      encodedMessageEventDetail: "d",
      signature: "s",
      signatureVersion: "7",
      publicKeyVersion: "1",
    };
  }

  prepareConversationKeyChange(params: { conversationId: string }) {
    return {
      conversationId: params.conversationId,
      conversationKeyVersion: "1",
      participantKeys: [],
      actionSignatures: [],
    };
  }

  signingPublicKey(): string {
    return "bot-signing-key";
  }
}

class FakeHttp implements ChatHttp {
  async getConversationEvents(): Promise<RawChatEventsPage> {
    return { data: [] };
  }
  async getMemberIds(): Promise<string[]> {
    return ["alice-1"];
  }
  async getUserPublicKeys() {
    return [];
  }
  async sendChatMessage() {
    return { messageId: "sent" };
  }
  async deleteChatMessages() {
    return { deleted: true };
  }
  async addConversationKeys(): Promise<void> {}
  async addUserPublicKey() {
    return { version: "1" };
  }

  async uploadChatMedia(_conversationId: string, ciphertext: Uint8Array) {
    return `media-hash-${ciphertext.byteLength}`;
  }
}

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      event_type: "chat.received",
      event_uuid: "99",
      payload: {
        id: "evt-2",
        sender_id: "alice-1",
        conversation_id: GROUP,
        encoded_event: "b64-help",
        conversation_token: "tok",
        conversation_key_change_event: "key-new",
        created_at_msec: "1710000000000",
        ...overrides,
      },
    },
  };
}

describe("Activity Chat parsing", () => {
  it("reads a chat.received envelope and ignores 1:1 plus chat.sent", () => {
    const parsed = parseActivityChat(envelope());
    expect(parsed).toMatchObject({
      eventType: "chat.received",
      conversationId: GROUP,
      keyEvents: ["key-new"],
      raw: { id: "evt-2", encoded_event: "b64-help", conversation_token: "tok" },
    });
    expect(parsed?.raw.created_at).toBe(new Date(1_710_000_000_000).toISOString());

    expect(
      parseActivityChat({
        data: {
          event_type: "chat.received",
          payload: { conversation_id: "111-222", encoded_event: "b64" },
        },
      }),
    ).toBeUndefined();

    const sent = parseActivityChat(envelope());
    expect(sent?.eventType).toBe("chat.received");
    const sentEnvelope = envelope();
    (sentEnvelope.data as { event_type: string }).event_type = "chat.sent";
    expect(parseActivityChat(sentEnvelope)?.eventType).toBe("chat.sent");
    expect(
      parseActivityChat({
        data: {
          event_type: "chat.sent",
          payload: {
            conversation_id: GROUP,
            message_id: "uuid-1",
            sequence_id: "4242",
          },
        },
      }),
    ).toMatchObject({
      eventType: "chat.sent",
      clientMessageId: "uuid-1",
      raw: { id: "uuid-1", sequence_id: "4242" },
    });
  });

  it("splits NDJSON and drops heartbeat blanks", () => {
    const first = takeActivityLines('{"a":1}\n\n{"b":');
    expect(first.lines).toEqual(['{"a":1}']);
    expect(first.rest).toBe('{"b":');
    const second = takeActivityLines(`${first.rest}2}\r\n`);
    expect(second.lines).toEqual(['{"b":2}']);
  });

  it("answers CRC with the OAuth 2.0 client secret", () => {
    expect(crcResponseToken("challenge", "secret")).toMatch(/^sha256=/);
    expect(signWebhookBody("{}", "secret")).toBe(crcResponseToken("{}", "secret"));
  });
});

describe("Activity intake", () => {
  const stores: Store[] = [];
  afterEach(() => {
    for (const store of stores) store.close();
    stores.length = 0;
  });

  it("decrypts a mocked chat.received event and runs the command layer", async () => {
    const store = new Store(":memory:");
    stores.push(store);
    store.authorizeChat(GROUP);
    const cipher = new FakeCipher();
    cipher.events.set("b64-help", {
      type: "message",
      sequenceId: "55",
      senderId: "alice-1",
      content: { contentType: "text", text: "!help" },
    });
    const service = new ChatService(new FakeHttp(), cipher, store);
    const dm = new MockXClient({ id: "bot-1", username: "miladybot" });
    const engine = new ModerationEngine(store, new RoutedXClient(dm, service), runtime());
    const intake = new ChatActivityIntake(service, engine, chatListenPolicy({ allowIds: [GROUP] }));

    await intake.handle(envelope());
    expect(cipher.batches[0]?.[0]).toBe("key-new");
    expect(cipher.batches[0]).toContain("b64-help");
    expect(cipher.texts).toEqual(["someone CHAT_HELP_OK"]);

    await intake.handle(envelope());
    expect(cipher.texts).toEqual(["someone CHAT_HELP_OK"]);

    const other = envelope({ conversation_id: "g999" });
    await intake.handle(other);
    expect(cipher.texts).toEqual(["someone CHAT_HELP_OK"]);
  });

  it("records a chat.sent sequence and does not run the echoed command", async () => {
    const store = new Store(":memory:");
    stores.push(store);
    store.authorizeChat(GROUP);
    const cipher = new FakeCipher();
    cipher.events.set("b64-help", {
      type: "message",
      sequenceId: "55",
      senderId: "bot-1",
      id: "mid-1",
      content: { contentType: "text", text: "!help" },
    });
    const service = new ChatService(new FakeHttp(), cipher, store);
    const engine = new ModerationEngine(
      store,
      new RoutedXClient(new MockXClient({ id: "bot-1", username: "miladybot" }), service),
      runtime(),
    );
    const intake = new ChatActivityIntake(service, engine, chatListenPolicy({ allowIds: [GROUP] }));
    const sent = envelope({
      id: "server-evt",
      message_id: "mid-1",
      sender_id: "bot-1",
      sequence_id: "4242",
    });
    (sent.data as { event_type: string }).event_type = "chat.sent";
    await intake.handle(sent);
    expect(cipher.texts).toEqual([]);
    expect(store.lookupChatMessage("mid-1")?.sequenceId).toBe("4242");
  });

  it("moderates every encrypted group when no allowlist is set", async () => {
    const store = new Store(":memory:");
    stores.push(store);
    store.authorizeChat("g999");
    const cipher = new FakeCipher();
    cipher.events.set("b64-help", {
      type: "message",
      sequenceId: "55",
      senderId: "alice-1",
      content: { contentType: "text", text: "!help" },
    });
    const service = new ChatService(new FakeHttp(), cipher, store);
    const dm = new MockXClient({ id: "bot-1", username: "miladybot" });
    const engine = new ModerationEngine(store, new RoutedXClient(dm, service), runtime());
    const seen: Array<{ id: string; eventId: string | undefined }> = [];
    const intake = new ChatActivityIntake(
      service,
      engine,
      chatListenPolicy({ mode: "all" }),
      (id, eventId) => seen.push({ id, eventId }),
    );

    await intake.handle(envelope({ conversation_id: "g999" }));
    expect(cipher.texts).toEqual(["someone CHAT_HELP_OK"]);
    expect(seen).toEqual([{ id: "g999", eventId: "evt-2" }]);
    expect(
      parseActivityChat(envelope({ conversation_id: "111-222" })),
    ).toBeUndefined();
  });

  it("skips a denied group even when listen mode is all", async () => {
    const store = new Store(":memory:");
    stores.push(store);
    const cipher = new FakeCipher();
    cipher.events.set("b64-help", {
      type: "message",
      sequenceId: "55",
      senderId: "alice-1",
      content: { contentType: "text", text: "!help" },
    });
    const service = new ChatService(new FakeHttp(), cipher, store);
    const engine = new ModerationEngine(
      store,
      new RoutedXClient(new MockXClient({ id: "bot-1", username: "miladybot" }), service),
      runtime(),
    );
    const intake = new ChatActivityIntake(
      service,
      engine,
      chatListenPolicy({ mode: "all", denyIds: [GROUP] }),
    );

    await intake.handle(envelope());
    expect(cipher.texts).toEqual([]);
  });

  it("registers a join signal for polling without decrypting it", async () => {
    const store = new Store(":memory:");
    stores.push(store);
    const cipher = new FakeCipher();
    const service = new ChatService(new FakeHttp(), cipher, store);
    const engine = new ModerationEngine(
      store,
      new RoutedXClient(new MockXClient({ id: "bot-1", username: "miladybot" }), service),
      runtime(),
    );
    const seen: string[] = [];
    const intake = new ChatActivityIntake(
      service,
      engine,
      chatListenPolicy({ mode: "all" }),
      (id) => seen.push(id),
    );
    const body = {
      data: {
        event_type: "chat.conversation.join",
        payload: { conversation_id: "xchat:g999" },
      },
    };
    expect(parseActivityGroupSignal(body)).toEqual({
      eventType: "chat.conversation.join",
      conversationId: "g999",
    });
    expect(
      parseActivityGroupSignal({
        data: { event_type: "chat.conversation.join", payload: { conversation_id: "111-222" } },
      }),
    ).toBeUndefined();

    await intake.handle(body);
    expect(seen).toEqual(["g999"]);
    expect(cipher.batches).toEqual([]);
  });

  it("logs a rotate hint when a newly seen group fails to decrypt", async () => {
    resetDecryptWarningWindow();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new Store(":memory:");
    stores.push(store);
    const cipher = new FakeCipher();
    const service = new ChatService(new FakeHttp(), cipher, store);
    const engine = new ModerationEngine(
      store,
      new RoutedXClient(new MockXClient({ id: "bot-1", username: "miladybot" }), service),
      runtime(),
    );
    const intake = new ChatActivityIntake(service, engine, chatListenPolicy({ mode: "all" }));
    await intake.handle(
      envelope({ encoded_event: "missing-key", conversation_key_change_event: undefined }),
    );
    const lines = warn.mock.calls.map((call) => String(call[0]));
    expect(lines.some((line) => line.includes("chat:rotate") && line.includes(GROUP))).toBe(true);
    warn.mockRestore();
    resetDecryptWarningWindow();
  });

  it("reads a stream body of two events", async () => {
    const seen: unknown[] = [];
    let bytes = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const text = `${JSON.stringify(envelope())}\n\n${JSON.stringify({ data: { event_type: "profile.update.bio" } })}\n`;
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    });
    await readActivityBody(
      stream,
      async (body) => {
        seen.push(body);
      },
      { onBytes: () => { bytes += 1; } },
    );
    expect(bytes).toBe(1);
    expect(seen).toHaveLength(2);
    expect(parseActivityChat(seen[0])?.conversationId).toBe(GROUP);
    expect(parseActivityChat(seen[1])).toBeUndefined();
  });

  it("keeps a summarize when Chat history is rate-limited instead of dropping it", async () => {
    const store = new Store(":memory:");
    stores.push(store);
    store.authorizeChat(GROUP);
    const cipher = new FakeCipher();
    cipher.events.set("b64-sum", {
      type: "message",
      sequenceId: "55",
      senderId: "alice-1",
      content: { contentType: "text", text: "!summarize" },
    });
    const http = new FakeHttp();
    http.getConversationEvents = async () => {
      const error = new Error("Rate limited; retry after 40ms") as Error & {
        status: number;
        retryAfterMs: number;
      };
      error.status = 429;
      error.retryAfterMs = 40;
      throw error;
    };
    const slept: number[] = [];
    const llm = new MockLlmClient("should-not-run");
    const service = new ChatService(http, cipher, store);
    const engine = new ModerationEngine(
      store,
      new RoutedXClient(new MockXClient({ id: "bot-1", username: "miladybot" }), service),
      runtime(),
      llm,
      {
        sleep: async (ms) => {
          slept.push(ms);
        },
      },
    );
    const intake = new ChatActivityIntake(service, engine, chatListenPolicy({ allowIds: [GROUP] }));

    await expect(
      intake.handle(envelope({ encoded_event: "b64-sum", id: "evt-sum" })),
    ).resolves.toBeUndefined();
    await engine.waitForBackgroundWork();

    expect(slept).toEqual([40]);
    expect(llm.calls).toHaveLength(0);
    expect(cipher.texts.some((text) => text.includes(LLM_RATE_LIMIT_ACK))).toBe(true);
    expect(store.listLlmRetries()).toHaveLength(1);
    expect(store.listLlmRetries()[0]?.eventId).toBeTruthy();
  });

  it("does not block the activity read loop on a slow LLM reply", async () => {
    const store = new Store(":memory:");
    stores.push(store);
    store.authorizeChat(GROUP);
    const cipher = new FakeCipher();
    cipher.events.set("b64-ask", {
      type: "message",
      sequenceId: "70",
      senderId: "alice-1",
      content: { contentType: "text", text: "@miladybot hello" },
    });
    cipher.events.set("b64-help", {
      type: "message",
      sequenceId: "71",
      senderId: "alice-1",
      content: { contentType: "text", text: "!help" },
    });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const llm: LlmClient = {
      async complete() {
        await gate;
        return "roasted";
      },
    };
    const service = new ChatService(new FakeHttp(), cipher, store);
    const engine = new ModerationEngine(
      store,
      new RoutedXClient(new MockXClient({ id: "bot-1", username: "miladybot" }), service),
      runtime(),
      llm,
    );
    const intake = new ChatActivityIntake(service, engine, chatListenPolicy({ allowIds: [GROUP] }));
    const body = [
      JSON.stringify(envelope({ encoded_event: "b64-ask", id: "evt-ask", event_uuid: "ask" })),
      JSON.stringify(envelope({ encoded_event: "b64-help", id: "evt-help", event_uuid: "help" })),
    ].join("\n");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`${body}\n`));
        controller.close();
      },
    });

    let result: "done" | "timeout" = "timeout";
    try {
      result = await Promise.race([
        readActivityBody(stream, (event) => intake.handle(event)).then(() => "done" as const),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 500)),
      ]);
      expect(result).toBe("done");
      expect(cipher.texts.some((text) => text.includes("CHAT_HELP_OK"))).toBe(true);
      expect(cipher.texts.some((text) => text.includes("roasted"))).toBe(false);
    } finally {
      release();
      await engine.waitForBackgroundWork();
    }
    expect(cipher.texts.some((text) => text.includes("roasted"))).toBe(true);
  });
});

describe("Activity webhook", () => {
  it("answers CRC and accepts a signed POST", async () => {
    const received: unknown[] = [];
    const webhook = await startActivityWebhook({
      port: 0,
      path: "/webhook",
      clientSecret: "secret",
      onEvent: async (body) => {
        received.push(body);
      },
    });
    try {
      const crc = await fetch(`http://127.0.0.1:${webhook.port}/webhook?crc_token=abc`);
      expect(crc.status).toBe(200);
      expect(await crc.json()).toEqual({ response_token: crcResponseToken("abc", "secret") });

      const payload = JSON.stringify(envelope());
      const denied = await fetch(`http://127.0.0.1:${webhook.port}/webhook`, {
        method: "POST",
        headers: { "x-twitter-webhooks-signature-oauth2": "sha256=nope" },
        body: payload,
      });
      expect(denied.status).toBe(401);

      const ok = await fetch(`http://127.0.0.1:${webhook.port}/webhook`, {
        method: "POST",
        headers: { "x-twitter-webhooks-signature-oauth2": signWebhookBody(payload, "secret") },
        body: payload,
      });
      expect(ok.status).toBe(200);
      await vi.waitFor(() => expect(received).toHaveLength(1));
    } finally {
      await webhook.close();
    }
  });
});

describe("Activity subscription", () => {
  const appBearer = "app-only-bearer";

  it("lists with the app bearer and creates chat.received on the user client", async () => {
    const created: Record<string, unknown>[] = [];
    const listed: string[] = [];
    const client = {
      async listActivitySubscriptions(bearer: string) {
        listed.push(bearer);
        return { data: [] };
      },
      async createActivitySubscription(body: Record<string, unknown>) {
        created.push(body);
        return { data: {} };
      },
    };
    await ensureChatActivitySubscription(client, "bot-1", appBearer);
    expect(listed).toEqual([appBearer]);
    expect(created).toEqual([chatReceivedSubscriptionBody("bot-1", true)]);
    expect(hasChatReceivedSubscription({
      data: [{ event_type: "chat.received", filter: { user_id: "bot-1" } }],
    }, "bot-1")).toBe(true);
  });

  it("does not create a duplicate and retries without the group qualifier on 400", async () => {
    const created: Record<string, unknown>[] = [];
    const listed: string[] = [];
    await ensureChatActivitySubscription({
      async listActivitySubscriptions(bearer: string) {
        listed.push(bearer);
        return {
          data: [{ event_type: "chat.received", filter: { user_id: "bot-1" } }],
        };
      },
      async createActivitySubscription(body: Record<string, unknown>) {
        created.push(body);
        return {};
      },
    }, "bot-1", appBearer);
    expect(listed).toEqual([appBearer]);
    expect(created).toHaveLength(0);

    await ensureChatActivitySubscription({
      async listActivitySubscriptions(bearer: string) {
        listed.push(bearer);
        return { data: [] };
      },
      async createActivitySubscription(body: Record<string, unknown>) {
        created.push(body);
        if (created.length === 1) {
          const error = new Error("bad qualifier") as Error & { status?: number };
          error.status = 400;
          throw error;
        }
        return {};
      },
    }, "bot-1", `  ${appBearer}  `);
    expect(listed).toEqual([appBearer, appBearer]);
    expect(created[0]).toEqual(chatReceivedSubscriptionBody("bot-1", true));
    expect(created[1]).toEqual(chatReceivedSubscriptionBody("bot-1", false));
  });

  it("fails list and stream clearly when the app bearer is missing", async () => {
    const calls: string[] = [];
    const client = {
      async listActivitySubscriptions(bearer: string) {
        calls.push(`list:${bearer}`);
        return { data: [] };
      },
      async createActivitySubscription() {
        calls.push("create");
        return {};
      },
    };
    await expect(ensureChatActivitySubscription(client, "bot-1")).rejects.toThrow(
      /ACTIVITY_BEARER_TOKEN is required for GET \/2\/activity\/subscriptions/,
    );
    await expect(ensureChatActivitySubscription(client, "bot-1", "   ")).rejects.toThrow(
      /user access token is forbidden/,
    );
    expect(() => requireActivityAppBearer(undefined, "stream")).toThrow(
      /ACTIVITY_BEARER_TOKEN is required for GET \/2\/activity\/stream/,
    );
    expect(() => requireActivityAppBearer("", "list")).toThrow(/dm\.read/);
    expect(requireActivityAppBearer(` ${appBearer} `, "stream")).toBe(appBearer);
    expect(calls).toEqual([]);
  });
});

describe("decrypt warning rate limit", () => {
  afterEach(() => {
    resetDecryptWarningWindow();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("logs the first decrypt failure and suppresses repeats inside the window", () => {
    resetDecryptWarningWindow();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-23T12:00:00.000Z"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    logDecryptErrors(GROUP, { a: "version 1790176607769 missing" });
    logDecryptErrors(GROUP, { b: "version 1790176607769 missing" });
    expect(warn).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + DECRYPT_WARN_INTERVAL_MS);
    logDecryptErrors(GROUP, { c: "version 1790176607769 missing" });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[1]?.[0])).toContain("suppressed");
  });
});
