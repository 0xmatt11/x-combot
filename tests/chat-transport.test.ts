import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModerationEngine } from "../src/bot/engine.js";
import { parseChatConversationIds } from "../src/chat/ids.js";
import { chatEventToDm } from "../src/chat/normalize.js";
import { ChatPoller } from "../src/chat/poller.js";
import { ChatService } from "../src/chat/service.js";
import type { ChatCipher, DecryptedEvent } from "../src/chat/cipher.js";
import type { ChatHttp, RawChatEventsPage } from "../src/chat/http.js";
import {
  memberIdsFromConversation,
  normalizePublicKeys,
  publicKeyRegistrationBody,
  sendMessageBody,
} from "../src/chat/wire.js";
import { nextPollDelayMs } from "../src/poller.js";
import { Store } from "../src/store.js";
import type { BotRuntimeConfig, DefaultsConfig } from "../src/types.js";
import { MockXClient } from "../src/x/mock-client.js";
import { RoutedXClient } from "../src/x/routed-client.js";

const GROUP = "g2029561975647150382";

const defaults: DefaultsConfig = {
  welcome: { enabled: true, text: "Welcome @{username}!" },
  rules: "Be nice.",
  help: "CHAT_HELP_OK",
  flood: { max_messages: 5, window_ms: 10_000, mute_ms: 60_000, warn_on_flood: false },
  warns: { limit: 3, auto_mute_ms: 60_000, notify_admins: false },
  filters: [],
  poll: { interval_ms: 1000, max_results: 50 },
  delete: { attempt_on_filter: true, attempt_on_flood: true, attempt_on_mute: true },
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
  readonly deleted: string[][] = [];
  readonly events = new Map<string, DecryptedEvent>();

  setSigningKeys(): void {}

  decryptEvents(eventsB64: string[]) {
    const messages = [];
    for (const b64 of eventsB64) {
      const event = this.events.get(b64);
      if (event) messages.push({ event, originalB64: b64 });
    }
    return { messages, errors: {} };
  }

  encryptMessage(_conversationId: string, text: string) {
    this.texts.push(text);
    return {
      messageId: `mid-${this.texts.length}`,
      encryptedContent: `enc:${text}`,
      encodedEventSignature: "sig",
    };
  }

  prepareMessageDelete(_conversationId: string, sequenceIds: string[]) {
    this.deleted.push(sequenceIds);
    return {
      messageId: "del-1",
      encodedMessageEventDetail: "detail",
      signature: "sig",
      signatureVersion: "7",
      publicKeyVersion: "1",
      signaturePayload: "payload",
    };
  }

  prepareConversationKeyChange(params: { conversationId: string }) {
    return {
      conversationId: params.conversationId,
      conversationKeyVersion: "100",
      participantKeys: [],
      actionSignatures: [],
    };
  }

  signingPublicKey(): string {
    return "bot-signing-key";
  }
}

class FakeHttp implements ChatHttp {
  pages: RawChatEventsPage[] = [];
  sends: Record<string, string>[] = [];
  deletes: Record<string, unknown>[] = [];
  failNext: unknown;

  async getConversationEvents(): Promise<RawChatEventsPage> {
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = undefined;
      throw error;
    }
    return this.pages.shift() ?? { data: [] };
  }

  async getMemberIds(): Promise<string[]> {
    return ["alice-1"];
  }

  async getUserPublicKeys() {
    return [
      {
        userId: "alice-1",
        publicKeyVersion: "1",
        publicKey: "identity",
        signingPublicKey: "signing",
        identityPublicKeySignature: "bind",
      },
    ];
  }

  async sendChatMessage(_conversationId: string, body: Record<string, string>) {
    this.sends.push(body);
    return { messageId: body.message_id ?? "" };
  }

  async deleteChatMessages(_conversationId: string, body: Record<string, unknown>) {
    this.deletes.push(body);
    return { deleted: true };
  }

  async addConversationKeys(): Promise<void> {}

  async addUserPublicKey(): Promise<{ version?: string }> {
    return { version: "1" };
  }
}

describe("Chat ids and wire shapes", () => {
  it("accepts g… ids and rejects classic group snowflakes", () => {
    expect(parseChatConversationIds(undefined)).toEqual([]);
    expect(parseChatConversationIds(` ${GROUP}, g1 `)).toEqual([GROUP, "g1"]);
    expect(() => parseChatConversationIds("1578398451921985538")).toThrow(/g plus digits/);
  });

  it("normalizes snake_case public keys and registration bodies", () => {
    const keys = normalizePublicKeys(
      {
        data: [
          {
            public_key: "ID",
            signing_public_key: "SIGN",
            identity_public_key_signature: "BIND",
            public_key_version: 7,
            juicebox_config: { token_map: [] },
          },
        ],
      },
      "bot",
    );
    expect(keys[0]).toMatchObject({
      userId: "bot",
      publicKey: "ID",
      signingPublicKey: "SIGN",
      publicKeyVersion: "7",
    });
    const body = publicKeyRegistrationBody({
      publicKey: {
        publicKey: "ID",
        signingPublicKey: "SIGN",
        identityPublicKeySignature: "BIND",
        registrationMethod: "custom",
      },
      version: 9,
      generateVersion: true,
    });
    expect(body.version).toBe("9");
    expect(body.public_key.public_key).toBe("ID");
    expect(body.generate_version).toBe(true);
  });

  it("reads member ids from a conversation payload", () => {
    expect(
      memberIdsFromConversation({
        data: { member_ids: ["1", "2"], admin_ids: ["2"] },
      }),
    ).toEqual(["1", "2"]);
  });

  it("maps decrypted text and member adds onto the DM event shape", () => {
    const message = chatEventToDm(
      GROUP,
      { id: "evt-9", sender_id: "alice-1", encoded_event: "b64" },
      {
        type: "message",
        sequenceId: "55",
        content: { contentType: "text", text: "!help @miladybot" },
      },
    );
    expect(message).toMatchObject({
      id: "evt-9",
      eventType: "MessageCreate",
      text: "!help @miladybot",
      sequenceId: "55",
      conversationId: GROUP,
      mentions: [{ username: "miladybot" }],
    });

    const join = chatEventToDm(
      GROUP,
      { id: "evt-join" },
      { type: "groupChange", changeType: "membersAdded", memberIds: ["new-1"] },
    );
    expect(join?.eventType).toBe("ParticipantsJoin");
    expect(join?.participantIds).toEqual(["new-1"]);

    expect(
      chatEventToDm(GROUP, { id: "evt-k" }, { type: "keyChange" }),
    ).toBeUndefined();
  });
});

describe("Chat transport into the moderation engine", () => {
  const stores: Store[] = [];

  afterEach(() => {
    for (const store of stores) store.close();
    stores.length = 0;
  });

  function setup() {
    const store = new Store(":memory:");
    stores.push(store);
    const http = new FakeHttp();
    const cipher = new FakeCipher();
    cipher.events.set("b64-old", {
      type: "message",
      sequenceId: "10",
      senderId: "alice-1",
      content: { contentType: "text", text: "history" },
    });
    cipher.events.set("b64-help", {
      type: "message",
      sequenceId: "55",
      senderId: "alice-1",
      content: { contentType: "text", text: "!help" },
    });
    const service = new ChatService(http, cipher, store);
    const dm = new MockXClient({ id: "bot-1", username: "miladybot" });
    const routed = new RoutedXClient(dm, service);
    const engine = new ModerationEngine(store, routed, runtime());
    const poller = new ChatPoller(service, store, engine, 12_000, [GROUP], 50);
    return { store, http, cipher, service, dm, poller };
  }

  it("seeds a watermark without replaying, then answers !help through Chat send", async () => {
    const { http, cipher, dm, poller } = setup();
    http.pages.push({
      data: [{ id: "evt-1", sender_id: "alice-1", encoded_event: "b64-old" }],
    });
    await poller.pollOnce();
    expect(http.sends).toHaveLength(0);
    expect(dm.sent).toHaveLength(0);

    http.pages.push({
      data: [
        {
          id: "evt-2",
          sender_id: "alice-1",
          encoded_event: "b64-help",
          conversation_token: "tok",
        },
        { id: "evt-1", sender_id: "alice-1", encoded_event: "b64-old" },
      ],
      meta: { conversation_key_events: ["key-change"] },
    });
    await poller.pollOnce();

    expect(cipher.texts).toEqual(["CHAT_HELP_OK"]);
    expect(http.sends).toHaveLength(1);
    expect(http.sends[0]).toMatchObject({
      encoded_message_create_event: "enc:CHAT_HELP_OK",
      encoded_message_event_signature: "sig",
      conversation_token: "tok",
    });
    expect(dm.sent).toHaveLength(0);
    expect(sendMessageBody({
      messageId: "mid-1",
      encryptedContent: "enc:CHAT_HELP_OK",
      encodedEventSignature: "sig",
    }, "tok").conversation_token).toBe("tok");
  });

  it("deletes with the decrypted sequence id", async () => {
    const { http, service, poller } = setup();
    http.pages.push({
      data: [{ id: "evt-1", sender_id: "alice-1", encoded_event: "b64-old" }],
    });
    await poller.pollOnce();
    http.pages.push({
      data: [
        { id: "evt-2", sender_id: "alice-1", encoded_event: "b64-help" },
        { id: "evt-1", sender_id: "alice-1", encoded_event: "b64-old" },
      ],
    });
    await poller.pollOnce();

    const result = await service.deleteEvent("evt-2", { conversationId: GROUP });
    expect(result.deleted).toBe(true);
    expect(http.deletes[0]).toMatchObject({
      sequence_ids: ["55"],
      delete_message_action: "delete_for_all",
    });
  });

  it("backs off the Chat poll on 429 the same way as the DM poller", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { http, poller } = setup();
    const error = Object.assign(new Error("Rate limited; retry after 60000ms"), {
      status: 429,
      retryAfterMs: 60_000,
    });
    http.failNext = error;
    await poller.tick();
    expect(nextPollDelayMs(12_000, error)).toBe(60_000);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(http.pages).toHaveLength(0);
    http.pages.push({ data: [] });
    await vi.advanceTimersByTimeAsync(48_000);
    expect(http.failNext).toBeUndefined();
    poller.stop();
    vi.useRealTimers();
  });
});
