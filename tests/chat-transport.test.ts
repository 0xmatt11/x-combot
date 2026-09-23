import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModerationEngine } from "../src/bot/engine.js";
import { parseChatConversationIds } from "../src/chat/ids.js";
import { chatEventToDm } from "../src/chat/normalize.js";
import { ChatPoller } from "../src/chat/poller.js";
import { ChatService } from "../src/chat/service.js";
import type {
  ChatCipher,
  ChatMediaAttachment,
  DecryptedEvent,
  EncryptMessageOptions,
  LoadedChatIdentity,
  PublicKeyMaterial,
} from "../src/chat/cipher.js";
import type { ChatHttp, RawChatEventsPage } from "../src/chat/http.js";
import {
  memberIdsFromConversation,
  normalizePublicKeys,
  publicKeyRegistrationBody,
  sendMessageBody,
} from "../src/chat/wire.js";
import { nextPollDelayMs, shouldPollClassicDms } from "../src/poller.js";
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
  readonly batches: string[][] = [];
  readonly wrapped: PublicKeyMaterial[] = [];
  readonly events = new Map<string, DecryptedEvent>();
  conversationKeys: { keys: Record<string, Uint8Array>; latestVersion: string | null } | undefined;
  identity: LoadedChatIdentity | undefined;
  signingKeySets = 0;

  setSigningKeys(): void {
    this.signingKeySets += 1;
  }

  verifyKeyBinding(): boolean {
    return true;
  }

  matchesRegisteredKey(publicKey: string): boolean {
    return publicKey === this.identity?.publicKey;
  }

  loadedIdentity(): LoadedChatIdentity | undefined {
    return this.identity;
  }

  decryptEvents(eventsB64: string[]) {
    this.batches.push([...eventsB64]);
    const messages = [];
    const errors: Record<string, string> = {};
    for (const b64 of eventsB64) {
      const event = this.events.get(b64);
      if (event) messages.push({ event, originalB64: b64 });
      else errors[b64] = "Conversation key version 1790176607769 is not in available versions";
    }
    return { messages, errors, conversationKeys: this.conversationKeys };
  }

  encryptMessage(_conversationId: string, text: string, _options?: EncryptMessageOptions) {
    this.texts.push(text);
    return {
      messageId: `mid-${this.texts.length}`,
      encryptedContent: `enc:${text}`,
      encodedEventSignature: "sig",
    };
  }

  encryptStream(plaintext: Uint8Array, _conversationKey: Uint8Array) {
    return plaintext;
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

  prepareConversationKeyChange(params: { conversationId: string; publicKeys: PublicKeyMaterial[] }) {
    this.wrapped.push(...params.publicKeys);
    return {
      conversationId: params.conversationId,
      conversationKeyVersion: "100",
      participantKeys: params.publicKeys.map((key) => ({
        userId: key.userId,
        encryptedKey: "enc",
        publicKeyVersion: key.keyVersion,
      })),
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
  gets = 0;
  keyGets: string[] = [];
  keyError: unknown;
  keysByUser = new Map<string, ReturnType<FakeHttp["defaultKeys"]>>();
  postedKeys: unknown[] = [];
  memberIds = ["alice-1"];

  async getConversationEvents(): Promise<RawChatEventsPage> {
    this.gets += 1;
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = undefined;
      throw error;
    }
    return this.pages.shift() ?? { data: [] };
  }

  async getMemberIds(): Promise<string[]> {
    return this.memberIds;
  }

  defaultKeys(userId: string) {
    return [
      {
        userId,
        publicKeyVersion: "1",
        publicKey: "identity",
        signingPublicKey: "signing",
        identityPublicKeySignature: "bind",
      },
    ];
  }

  async getUserPublicKeys(userId: string) {
    this.keyGets.push(userId);
    if (this.keyError) {
      const error = this.keyError;
      this.keyError = undefined;
      throw error;
    }
    return this.keysByUser.get(userId) ?? this.defaultKeys(userId);
  }

  async sendChatMessage(_conversationId: string, body: Record<string, string>) {
    this.sends.push(body);
    return { messageId: body.message_id ?? "" };
  }

  async deleteChatMessages(_conversationId: string, body: Record<string, unknown>) {
    this.deletes.push(body);
    return { deleted: true };
  }

  async addConversationKeys(_conversationId: string, body: Record<string, unknown>): Promise<void> {
    this.postedKeys.push(body);
  }

  async addUserPublicKey(): Promise<{ version?: string }> {
    return { version: "1" };
  }

  async uploadChatMedia(_conversationId: string, ciphertext: Uint8Array) {
    return `media-hash-${ciphertext.byteLength}`;
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

  it("accepts a version field and a nested public_key object", () => {
    const keys = normalizePublicKeys(
      {
        data: [
          {
            version: "1790180984855",
            public_key: {
              public_key: "ID",
              signing_public_key: "SIGN",
              identity_public_key_signature: "BIND",
            },
          },
        ],
      },
      "bot",
    );
    expect(keys[0]?.publicKeyVersion).toBe("1790180984855");
    expect(keys[0]?.publicKey).toBe("ID");
    expect(keys[0]?.signingPublicKey).toBe("SIGN");
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

  it("reads a validated reply sender and drops an untrusted preview", () => {
    const valid = chatEventToDm(
      GROUP,
      { id: "evt-reply", sender_id: "admin-1" },
      {
        type: "message",
        senderId: "admin-1",
        replyPreviewValidation: "valid",
        content: {
          contentType: "text",
          text: "/warn",
          replyingToPreview: { senderId: "u-bob" },
        },
      },
    );
    expect(valid?.replyToSenderId).toBe("u-bob");
    expect(valid?.senderId).toBe("admin-1");
    expect(valid?.replyTo).toEqual({
      senderId: "u-bob",
      sequenceId: undefined,
      eventId: undefined,
      verified: true,
    });

    const wasmShape = chatEventToDm(
      GROUP,
      { id: "evt-wasm" },
      {
        type: "message",
        replyPreviewValidation: "Valid",
        content: {
          content_type: "text",
          text: "!kick",
          replying_to_preview: { sender_id: "u-carol" },
        },
      },
    );
    expect(wasmShape?.replyToSenderId).toBe("u-carol");
    expect(wasmShape?.replyTo?.verified).toBe(true);
    expect(wasmShape?.replyTo?.senderId).toBe("u-carol");

    const forged = chatEventToDm(
      GROUP,
      { id: "evt-forged" },
      {
        type: "message",
        replyPreviewValidation: "invalid",
        content: {
          contentType: "text",
          text: "/warn",
          replyingToPreview: { senderId: "u-bob" },
        },
      },
    );
    expect(forged?.text).toBe("/warn");
    expect(forged?.replyToSenderId).toBeUndefined();
    expect(forged?.replyTo?.verified).toBe(false);
    expect(forged?.replyTo?.senderId).toBe("u-bob");

    const unsigned = chatEventToDm(
      GROUP,
      { id: "evt-unsigned" },
      {
        type: "message",
        content: {
          contentType: "text",
          text: "/kick",
          replyingToPreview: { senderId: "u-bob" },
        },
      },
    );
    expect(unsigned?.replyToSenderId).toBeUndefined();
    expect(unsigned?.replyTo?.verified).toBe(false);

    const numeric = chatEventToDm(
      GROUP,
      { id: "evt-num" },
      {
        type: "message",
        replyPreviewValidation: "valid",
        content: {
          contentType: "text",
          text: "/warn",
          replyingToPreview: { senderId: 1578398451921985538 as unknown as string },
        },
      },
    );
    expect(numeric?.replyToSenderId).toBeUndefined();
    expect(numeric?.replyTo).toBeUndefined();

    const reply = chatEventToDm(
      GROUP,
      { id: "evt-plus", sender_id: "alice-1" },
      {
        type: "message",
        sequenceId: "56",
        replyPreviewValidation: "valid",
        content: {
          contentType: "text",
          text: "+",
          replyingToPreview: {
            senderId: "bob-1",
            replyingToMessageSequenceId: "55",
            replyingToMessageId: "evt-9",
          },
        },
      },
    );
    expect(reply?.replyToSenderId).toBe("bob-1");
    expect(reply?.replyTo).toEqual({
      senderId: "bob-1",
      sequenceId: "55",
      eventId: "evt-9",
      verified: true,
    });

    const spoof = chatEventToDm(
      GROUP,
      { id: "evt-spoof" },
      {
        type: "message",
        replyPreviewValidation: "invalid",
        content: {
          contentType: "text",
          text: "+",
          replying_to_preview: {
            sender_id: "victim",
            replying_to_message_sequence_id: "9",
          },
        },
      },
    );
    expect(spoof?.replyToSenderId).toBeUndefined();
    expect(spoof?.replyTo?.verified).toBe(false);
    expect(spoof?.replyTo?.senderId).toBe("victim");
    expect(spoof?.replyTo?.sequenceId).toBe("9");
  });

  it("maps a reaction add for XP and does not treat it as a command", () => {
    const reaction = chatEventToDm(
      GROUP,
      { id: "evt-react", sender_id: "alice-1" },
      {
        type: "message",
        sequenceId: "70",
        content: {
          contentType: "reaction",
          emoji: "🔥",
          targetMessageId: "55",
        },
      },
    );
    expect(reaction).toMatchObject({
      eventType: "ReactionAdd",
      senderId: "alice-1",
      reactionTargetSequenceId: "55",
      text: "🔥",
    });

    const disguised = chatEventToDm(GROUP, { id: "evt-react-cmd" }, {
      type: "message",
      content: { content_type: "reaction", text: "!warn" },
    });
    expect(disguised?.eventType).toBe("ReactionAdd");
    expect(disguised?.text).toBeUndefined();

    expect(
      chatEventToDm(
        GROUP,
        { id: "evt-unreact" },
        {
          type: "message",
          content: { contentType: "reactionRemoved", targetMessageId: "55", emoji: "🔥" },
        },
      ),
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
    const helpBatch = cipher.batches.at(-1) ?? [];
    expect(helpBatch).toContain("b64-help");
    expect(helpBatch).not.toContain("b64-old");
  });

  it("does not advance the watermark when decrypt fails", async () => {
    const { http, cipher, poller, store } = setup();
    http.pages.push({
      data: [{ id: "evt-1", sender_id: "alice-1", encoded_event: "b64-old" }],
      meta: { conversation_key_events: ["key-old"] },
    });
    await poller.pollOnce();
    expect(cipher.batches[0]).toEqual(["key-old"]);
    expect(store.getWatermark(`chat_events:${GROUP}`)).toBe("evt-1");

    http.pages.push({
      data: [
        { id: "evt-dead", sender_id: "alice-1", encoded_event: "b64-dead" },
        { id: "evt-1", sender_id: "alice-1", encoded_event: "b64-old" },
      ],
      meta: { conversation_key_events: ["key-old"] },
    });
    await poller.pollOnce();
    expect(cipher.batches[1]).toEqual(["key-old", "b64-dead"]);
    expect(store.getWatermark(`chat_events:${GROUP}`)).toBe("evt-1");
    expect(cipher.texts).toEqual([]);

    http.pages.push({
      data: [
        { id: "evt-2", sender_id: "alice-1", encoded_event: "b64-help" },
        { id: "evt-dead", sender_id: "alice-1", encoded_event: "b64-dead" },
        { id: "evt-1", sender_id: "alice-1", encoded_event: "b64-old" },
      ],
    });
    await poller.pollOnce();
    expect(cipher.batches[2]).toEqual(["b64-help", "b64-dead"]);
    expect(cipher.texts).toEqual(["CHAT_HELP_OK"]);
    expect(store.getWatermark(`chat_events:${GROUP}`)).toBe("evt-1");

    cipher.events.set("b64-dead", {
      type: "message",
      sequenceId: "40",
      senderId: "alice-1",
      content: { contentType: "text", text: "now-open" },
    });
    cipher.events.set("key-old", { type: "keyChange" });
    http.pages.push({
      data: [
        { id: "evt-2", sender_id: "alice-1", encoded_event: "b64-help" },
        { id: "evt-dead", sender_id: "alice-1", encoded_event: "b64-dead" },
      ],
      meta: { conversation_key_events: ["key-old"] },
    });
    await poller.pollOnce();
    expect(cipher.batches[3]?.[0]).toBe("key-old");
    expect(store.getWatermark(`chat_events:${GROUP}`)).toBe("evt-2");
  });

  it("advances a watermark that has fallen off the latest pages", async () => {
    const { http, poller, store } = setup();
    store.setWatermark(`chat_events:${GROUP}`, "evt-ancient");
    http.pages.push({
      data: [{ id: "evt-9", sender_id: "alice-1", encoded_event: "b64-help" }],
    });
    await poller.pollOnce();
    expect(store.getWatermark(`chat_events:${GROUP}`)).toBe("evt-9");
    expect(http.pages).toHaveLength(0);

    http.pages.push({
      data: [{ id: "evt-9", sender_id: "alice-1", encoded_event: "b64-help" }],
    });
    await poller.pollOnce();
    expect(http.pages).toHaveLength(0);
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

  it("stretches idle Chat polls and returns to the base interval after a new event", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const store = new Store(":memory:");
    stores.push(store);
    const http = new FakeHttp();
    const cipher = new FakeCipher();
    cipher.events.set("b64-help", {
      type: "message",
      sequenceId: "55",
      senderId: "alice-1",
      content: { contentType: "text", text: "!help" },
    });
    const service = new ChatService(http, cipher, store);
    const engine = new ModerationEngine(
      store,
      new RoutedXClient(new MockXClient({ id: "bot-1", username: "miladybot" }), service),
      runtime(),
    );
    const poller = new ChatPoller(service, store, engine, 12_000, [GROUP], 50, 48_000);

    http.pages.push({ data: [{ id: "evt-1", sender_id: "alice-1", encoded_event: "b64-old" }] });
    await poller.tick();
    expect(http.gets).toBe(1);

    http.pages.push({ data: [{ id: "evt-1", sender_id: "alice-1", encoded_event: "b64-old" }] });
    await vi.advanceTimersByTimeAsync(12_000);
    expect(http.gets).toBe(2);

    await vi.advanceTimersByTimeAsync(12_000);
    expect(http.gets).toBe(2);
    http.pages.push({ data: [{ id: "evt-1", sender_id: "alice-1", encoded_event: "b64-old" }] });
    await vi.advanceTimersByTimeAsync(12_000);
    expect(http.gets).toBe(3);

    http.pages.push({
      data: [
        { id: "evt-2", sender_id: "alice-1", encoded_event: "b64-help" },
        { id: "evt-1", sender_id: "alice-1", encoded_event: "b64-old" },
      ],
    });
    await vi.advanceTimersByTimeAsync(48_000);
    expect(http.gets).toBe(4);
    expect(cipher.texts).toEqual(["CHAT_HELP_OK"]);

    http.pages.push({ data: [] });
    await vi.advanceTimersByTimeAsync(12_000);
    expect(http.gets).toBe(5);
    poller.stop();
    vi.useRealTimers();
  });

  it("does not cache an empty signing-key list when public_keys returns 429", async () => {
    const { http, cipher, service } = setup();
    http.keyError = Object.assign(new Error("Rate limited"), { status: 429, retryAfterMs: 40 });
    http.pages.push({ data: [{ id: "evt-1", sender_id: "alice-1", encoded_event: "b64-old" }] });
    await expect(service.pullNew(GROUP, undefined, 10)).rejects.toThrow(/Rate limited/);
    expect(cipher.signingKeySets).toBe(0);
    expect(http.keyGets).toEqual(["alice-1"]);

    http.pages.push({ data: [{ id: "evt-1", sender_id: "alice-1", encoded_event: "b64-old" }] });
    await expect(service.pullNew(GROUP, undefined, 10)).rejects.toThrow(/backoff/);
    expect(http.keyGets).toEqual(["alice-1"]);

    await new Promise((resolve) => setTimeout(resolve, 50));
    http.pages.push({ data: [{ id: "evt-1", sender_id: "alice-1", encoded_event: "b64-old" }] });
    await service.pullNew(GROUP, undefined, 10);
    expect(cipher.signingKeySets).toBe(1);
    expect(http.keyGets).toEqual(["alice-1", "alice-1"]);
  });

  it("wraps the loaded identity and refuses a newer account key without --force", async () => {
    const { http, cipher, service } = setup();
    cipher.identity = { userId: "bot-1", version: "1790180984855", publicKey: "FILE_SPKI" };
    http.memberIds = ["bot-1", "alice-1"];
    http.keysByUser.set("bot-1", [
      {
        userId: "bot-1",
        publicKeyVersion: "1790180984855",
        publicKey: "FILE_SPKI",
        signingPublicKey: "file-sign",
        identityPublicKeySignature: "bind-file",
      },
      {
        userId: "bot-1",
        publicKeyVersion: "1790182715573",
        publicKey: "BROWSER_SPKI",
        signingPublicKey: "browser-sign",
        identityPublicKeySignature: "bind-browser",
      },
    ]);
    http.keysByUser.set("alice-1", [
      {
        userId: "alice-1",
        publicKeyVersion: "7",
        publicKey: "ALICE",
        signingPublicKey: "alice-sign",
        identityPublicKeySignature: "bind-alice",
      },
    ]);

    await expect(service.rotateConversationKey(GROUP)).rejects.toThrow(/1790180984855/);
    expect(http.postedKeys).toHaveLength(0);
    expect(cipher.wrapped).toHaveLength(0);

    await service.rotateConversationKey(GROUP, { force: true });
    expect(cipher.wrapped.map((key) => `${key.userId}:${key.keyVersion}`)).toEqual([
      "bot-1:1790180984855",
      "alice-1:7",
    ]);
    expect(cipher.wrapped.some((key) => key.keyVersion === "1790182715573")).toBe(false);
    expect(http.postedKeys).toHaveLength(1);
  });
});

describe("ChatService.sendImage", () => {
  function page(encoded: string): RawChatEventsPage {
    return { data: [{ id: encoded, encoded_event: encoded, sender_id: "alice-1" }] };
  }

  it("encrypts bytes, uploads chat media, and omits media_type on the inline attachment", async () => {
    const cipher = new FakeCipher();
    const key = new Uint8Array(32).fill(7);
    cipher.events.set("blob-99", { type: "message", id: "e1", content: { text: "hi" } });
    cipher.conversationKeys = { keys: { "99": key }, latestVersion: "99" };
    const http = new FakeHttp();
    http.pages.push(page("blob-99"));
    const uploads: Uint8Array[] = [];
    http.uploadChatMedia = async (_id, ciphertext) => {
      uploads.push(Uint8Array.from(ciphertext));
      return "hash-inline";
    };
    const encrypted: { conversationId: string; text: string; options?: EncryptMessageOptions }[] = [];
    const streamed: Uint8Array[] = [];
    cipher.encryptStream = (plaintext, conversationKey) => {
      streamed.push(Uint8Array.from(conversationKey));
      return plaintext;
    };
    cipher.encryptMessage = (conversationId, text, options) => {
      encrypted.push({ conversationId, text, options });
      return {
        messageId: "mid-img",
        encryptedContent: "enc:",
        encodedEventSignature: "sig",
      };
    };
    const store = new Store(":memory:");
    const service = new ChatService(http, cipher, store);
    await service.listHistory({ conversationId: "g1" });

    const bytes = Uint8Array.from([1, 2, 3, 4]);
    const result = await service.sendImage("g1", {
      url: "https://cdn.example/a.jpg",
      bytes,
      mimeType: "image/png",
    });
    store.close();

    expect(uploads).toHaveLength(1);
    expect(Array.from(uploads[0]!)).toEqual(Array.from(bytes));
    expect(Array.from(streamed[0]!)).toEqual(Array.from(key));
    expect(encrypted).toHaveLength(1);
    expect(encrypted[0]).toMatchObject({ conversationId: "g1", text: "" });
    expect(encrypted[0]?.text).not.toMatch(/18\+/);
    const attachment = encrypted[0]?.options?.attachments?.[0] as ChatMediaAttachment;
    expect(attachment.mediaHashKey).toBe("hash-inline");
    expect(attachment.filename).toBe("image.png");
    expect(attachment.filesizeBytes).toBe(4);
    expect(attachment.width).toBe(1024);
    expect(attachment.height).toBe(1024);
    expect(attachment.mediaType).toBeUndefined();
    expect(encrypted[0]?.options?.conversationKeyVersion).toBe("99");
    expect(http.sends).toHaveLength(1);
    expect(http.sends[0]?.encoded_message_create_event).toBe("enc:");
    expect(result).toEqual({ dmEventId: "mid-img", dmConversationId: "g1" });
    expect(JSON.stringify(encrypted[0]?.options?.attachments)).not.toContain("media_type");
    expect(JSON.stringify(encrypted[0]?.options?.attachments)).not.toContain("mediaType");
  });

  it("does not replace a newer conversation key with an older decrypt", async () => {
    const cipher = new FakeCipher();
    cipher.events.set("new", { type: "message", id: "new" });
    cipher.events.set("old", { type: "message", id: "old" });
    const older = new Uint8Array(32).fill(1);
    const newer = new Uint8Array(32).fill(2);
    const http = new FakeHttp();
    http.pages.push(page("new"), page("old"));
    const versions: string[] = [];
    cipher.encryptMessage = (_conversationId, _text, options) => {
      versions.push(options?.conversationKeyVersion ?? "");
      return { messageId: "m", encryptedContent: "e", encodedEventSignature: "s" };
    };
    const store = new Store(":memory:");
    const service = new ChatService(http, cipher, store);
    cipher.conversationKeys = { keys: { "2": newer }, latestVersion: "2" };
    await service.listHistory({ conversationId: "g1" });
    cipher.conversationKeys = { keys: { "1": older }, latestVersion: "1" };
    await service.listHistory({ conversationId: "g1" });
    await service.sendImage("g1", {
      url: "https://cdn.example/a.jpg",
      bytes: Uint8Array.from([9]),
      mimeType: "image/jpeg",
    });
    store.close();
    expect(versions).toEqual(["2"]);
  });

  it("throws before upload when no conversation key is cached", async () => {
    const cipher = new FakeCipher();
    const http = new FakeHttp();
    let uploads = 0;
    http.uploadChatMedia = async () => {
      uploads += 1;
      return "should-not-upload";
    };
    const store = new Store(":memory:");
    const service = new ChatService(http, cipher, store);
    await expect(
      service.sendImage("g1", {
        url: "https://cdn.example/a.jpg",
        bytes: Uint8Array.from([1]),
        mimeType: "image/jpeg",
      }),
    ).rejects.toThrow(/conversation key/);
    store.close();
    expect(uploads).toBe(0);
    expect(http.sends).toHaveLength(0);
  });
});
