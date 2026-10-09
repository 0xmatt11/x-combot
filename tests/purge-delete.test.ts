import { afterEach, describe, expect, it } from "vitest";
import { ModerationEngine } from "../src/bot/engine.js";
import { ChatActivityIntake } from "../src/chat/activity.js";
import type { ChatCipher, DecryptedEvent, EncryptMessageOptions } from "../src/chat/cipher.js";
import { CHAT_DELETE_BATCH_LIMIT } from "../src/chat/delete-batch.js";
import type { ChatHttp, RawChatEventsPage } from "../src/chat/http.js";
import { chatListenPolicy } from "../src/chat/listen.js";
import { ChatService } from "../src/chat/service.js";
import { Store } from "../src/store.js";
import type { BotRuntimeConfig, DefaultsConfig, DmEvent } from "../src/types.js";
import { MockXClient } from "../src/x/mock-client.js";
import { RoutedXClient } from "../src/x/routed-client.js";

const GROUP = "g2029561975647150382";

const defaults: DefaultsConfig = {
  welcome: { enabled: false, text: "Welcome @{username}!" },
  rules: "Be nice.",
  help: "HELP_TEXT",
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
  readonly deleted: string[][] = [];
  readonly events = new Map<string, DecryptedEvent>();

  setSigningKeys(): void {}
  verifyKeyBinding(): boolean {
    return true;
  }
  matchesRegisteredKey(): boolean {
    return false;
  }
  loadedIdentity() {
    return undefined;
  }
  decryptEvents(eventsB64: string[]) {
    const messages = [];
    const errors: Record<string, string> = {};
    for (const b64 of eventsB64) {
      const event = this.events.get(b64);
      if (event) messages.push({ event, originalB64: b64 });
      else errors[b64] = "missing";
    }
    return { messages, errors };
  }
  encryptMessage(_conversationId: string, text: string, _options?: EncryptMessageOptions) {
    this.texts.push(text);
    return {
      messageId: `mid-${this.texts.length}`,
      encryptedContent: `enc:${text}`,
      encodedEventSignature: "sig",
    };
  }
  encryptReply(conversationId: string, text: string, options?: EncryptMessageOptions) {
    return this.encryptMessage(conversationId, text, options);
  }
  encryptStream(plaintext: Uint8Array) {
    return plaintext;
  }
  prepareMessageDelete(_conversationId: string, sequenceIds: string[]) {
    this.deleted.push([...sequenceIds]);
    return {
      messageId: `del-${this.deleted.length}`,
      encodedMessageEventDetail: "detail",
      signature: "sig",
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
  deletes: Record<string, unknown>[] = [];
  sends: Record<string, string>[] = [];
  pages: RawChatEventsPage[] = [];
  deleteError: unknown;
  rejectSequenceIds = new Set<string>();
  rejectStatus = 400;
  sendSequenceId?: string;
  sendEncoded?: string;

  async getConversationEvents(): Promise<RawChatEventsPage> {
    return this.pages.shift() ?? { data: [] };
  }
  async getMemberIds(): Promise<string[]> {
    return [];
  }
  async getUserPublicKeys() {
    return [];
  }
  async sendChatMessage(_conversationId: string, body: Record<string, string>) {
    this.sends.push(body);
    return {
      messageId: body.message_id ?? "",
      ...(this.sendSequenceId ? { sequenceId: this.sendSequenceId } : {}),
      ...(this.sendEncoded ? { encodedMessageEvent: this.sendEncoded } : {}),
    };
  }
  async deleteChatMessages(_conversationId: string, body: Record<string, unknown>) {
    const ids = Array.isArray(body.sequence_ids) ? body.sequence_ids.map(String) : [];
    if (this.deleteError) {
      const error = this.deleteError;
      this.deleteError = undefined;
      throw error;
    }
    if (ids.some((id) => this.rejectSequenceIds.has(id))) {
      throw Object.assign(new Error(`sequence ${ids.join(",")} rejected`), {
        status: this.rejectStatus,
      });
    }
    this.deletes.push(body);
    return { deleted: true };
  }
  async addConversationKeys(): Promise<void> {}
  async addUserPublicKey() {
    return { version: "1" };
  }
  async uploadChatMedia() {
    return "media";
  }
}

function message(
  partial: Partial<DmEvent> & Pick<DmEvent, "id" | "text">,
): DmEvent {
  return {
    eventType: "MessageCreate",
    conversationId: GROUP,
    senderId: "alice-1",
    participantIds: [],
    participants: [],
    mentions: [],
    ...partial,
  };
}

describe("Chat delete batches", () => {
  const stores: Store[] = [];
  afterEach(() => {
    for (const store of stores) store.close();
    stores.length = 0;
  });

  function service() {
    const store = new Store(":memory:");
    stores.push(store);
    const http = new FakeHttp();
    const cipher = new FakeCipher();
    return { store, http, cipher, service: new ChatService(http, cipher, store) };
  }

  it("sends every sequence id in one request with one signature", async () => {
    const { http, cipher, service: chat } = service();
    const targets = ["a", "b", "c"].map((id) => ({ eventId: `evt-${id}`, sequenceId: `seq-${id}` }));
    const result = await chat.deleteMessages(GROUP, targets);
    expect(result.deletedIds).toEqual(["evt-a", "evt-b", "evt-c"]);
    expect(http.deletes).toHaveLength(1);
    expect(http.deletes[0]?.sequence_ids).toEqual(["seq-a", "seq-b", "seq-c"]);
    expect(http.deletes[0]?.delete_message_action).toBe("delete_for_all");
    expect(http.deletes[0]?.action_signatures).toHaveLength(1);
    expect(cipher.deleted).toEqual([["seq-a", "seq-b", "seq-c"]]);
  });

  it("chunks at the batch limit when the list is longer", async () => {
    expect(CHAT_DELETE_BATCH_LIMIT).toBe(100);
    const { http, cipher, service: chat } = service();
    const count = CHAT_DELETE_BATCH_LIMIT + 1;
    const targets = Array.from({ length: count }, (_, index) => ({
      eventId: `evt-${index}`,
      sequenceId: `seq-${index}`,
    }));
    const result = await chat.deleteMessages(GROUP, targets);
    expect(result.deletedIds).toHaveLength(count);
    expect(http.deletes).toHaveLength(2);
    expect(http.deletes[0]?.sequence_ids).toHaveLength(CHAT_DELETE_BATCH_LIMIT);
    expect(http.deletes[1]?.sequence_ids).toEqual([`seq-${CHAT_DELETE_BATCH_LIMIT}`]);
    expect(http.deletes[0]?.action_signatures).toHaveLength(1);
    expect(http.deletes[1]?.action_signatures).toHaveLength(1);
    expect(cipher.deleted[0]).toHaveLength(CHAT_DELETE_BATCH_LIMIT);
    expect(cipher.deleted[1]).toEqual([`seq-${CHAT_DELETE_BATCH_LIMIT}`]);
  });

  it("stops on 429 and a later delete skips X until the backoff ends", async () => {
    let now = 1_000_000;
    const store = new Store(":memory:");
    stores.push(store);
    const http = new FakeHttp();
    const cipher = new FakeCipher();
    const chat = new ChatService(http, cipher, store, { now: () => now });
    http.deleteError = Object.assign(new Error("Rate limited; retry after 900000ms"), {
      status: 429,
      retryAfterMs: 900_000,
    });
    const targets = ["a", "b", "c"].map((id) => ({ eventId: `evt-${id}`, sequenceId: `seq-${id}` }));
    const first = await chat.deleteMessages(GROUP, targets);
    expect(first.deletedIds).toEqual([]);
    expect(first.rateLimited?.retryAfterMs).toBe(900_000);
    expect(first.rateLimited?.skippedIds).toEqual(["evt-a", "evt-b", "evt-c"]);
    expect(first.blocked).toBeUndefined();
    expect(cipher.deleted).toHaveLength(1);
    expect(http.deletes).toHaveLength(0);

    const skipped = await chat.deleteMessages(GROUP, targets);
    expect(cipher.deleted).toHaveLength(1);
    expect(http.deletes).toHaveLength(0);
    expect(skipped.blocked?.retryAfterMs).toBe(900_000);
    expect(skipped.deletedIds).toEqual([]);

    now += 900_000;
    const again = await chat.deleteMessages(GROUP, targets);
    expect(again.deletedIds).toEqual(["evt-a", "evt-b", "evt-c"]);
    expect(http.deletes).toHaveLength(1);
  });

  it("splits a 400 so every id except the bad one is deleted", async () => {
    const { http, service: chat } = service();
    http.rejectSequenceIds.add("seq-bad");
    http.rejectStatus = 400;
    const targets = ["ok-1", "ok-2", "bad", "ok-3"].map((id) => ({
      eventId: `evt-${id}`,
      sequenceId: id === "bad" ? "seq-bad" : `seq-${id}`,
    }));
    const result = await chat.deleteMessages(GROUP, targets);
    expect(result.deletedIds).toEqual(["evt-ok-1", "evt-ok-2", "evt-ok-3"]);
    expect(result.rejectedIds).toEqual(["evt-bad"]);
    expect(result.permissionDenied).toBe(false);
    expect(result.rateLimited).toBeUndefined();
    const posted = http.deletes.flatMap((body) => body.sequence_ids as string[]);
    expect(posted).toEqual(["seq-ok-1", "seq-ok-2", "seq-ok-3"]);
    expect(posted).not.toContain("seq-bad");
  });

  it("stops the whole purge when a split half returns 429", async () => {
    const { http, cipher, service: chat } = service();
    let calls = 0;
    http.deleteChatMessages = async (_conversationId, body) => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("bad batch"), { status: 400 });
      if (calls === 2) {
        throw Object.assign(new Error("Rate limited; retry after 60000ms"), {
          status: 429,
          retryAfterMs: 60_000,
        });
      }
      throw new Error(`unexpected delete ${JSON.stringify(body.sequence_ids)}`);
    };
    const targets = ["a", "b", "c", "d"].map((id) => ({
      eventId: `evt-${id}`,
      sequenceId: `seq-${id}`,
    }));
    const result = await chat.deleteMessages(GROUP, targets);
    expect(calls).toBe(2);
    expect(result.deletedIds).toEqual([]);
    expect(result.rateLimited?.skippedIds).toEqual(["evt-a", "evt-b", "evt-c", "evt-d"]);
    expect(cipher.deleted).toHaveLength(2);
    expect(chat.deleteBackoffMs()).toBeGreaterThan(0);
  });

  it("marks a 403 as a permission failure and still deletes the other ids", async () => {
    const { http, service: chat } = service();
    http.rejectSequenceIds.add("seq-bad");
    http.rejectStatus = 403;
    const result = await chat.deleteMessages(GROUP, [
      { eventId: "evt-ok", sequenceId: "seq-ok" },
      { eventId: "evt-bad", sequenceId: "seq-bad" },
    ]);
    expect(result.deletedIds).toEqual(["evt-ok"]);
    expect(result.rejectedIds).toEqual(["evt-bad"]);
    expect(result.permissionDenied).toBe(true);
    expect(http.deletes.flatMap((body) => body.sequence_ids as string[])).toEqual(["seq-ok"]);
  });
});

describe("!purge replies", () => {
  const stores: Store[] = [];
  afterEach(() => {
    for (const store of stores) store.close();
    stores.length = 0;
  });

  function stack(now?: () => number) {
    const store = new Store(":memory:");
    stores.push(store);
    store.authorizeChat(GROUP);
    store.patchSettings(GROUP, { flood_max_messages: 0 });
    const http = new FakeHttp();
    const cipher = new FakeCipher();
    const chat = new ChatService(http, cipher, store, now ? { now } : undefined);
    const dm = new MockXClient({ id: "bot-1", username: "miladybot" });
    dm.addUser({ id: "owner-1", username: "owner", name: "Owner" });
    const engine = new ModerationEngine(store, new RoutedXClient(dm, chat), runtime());
    const intake = new ChatActivityIntake(
      chat,
      engine,
      chatListenPolicy({ allowIds: [GROUP] }),
    );
    return { store, http, cipher, chat, engine, intake };
  }

  async function seed(engine: ModerationEngine, count: number, sequenced: boolean) {
    for (let index = 0; index < count; index += 1) {
      await engine.processEvent(
        message({
          id: `msg-${index}`,
          text: `m${index}`,
          senderId: "alice-1",
          createdAt: new Date(Date.UTC(2024, 0, 1, 0, 0, index)).toISOString(),
          ...(sequenced ? { sequenceId: `seq-${index}` } : {}),
        }),
      );
    }
  }

  async function purge(engine: ModerationEngine, count: number, id: string) {
    await engine.processEvent(
      message({
        id,
        text: `!purge ${count}`,
        senderId: "owner-1",
        sequenceId: `seq-${id}`,
        createdAt: new Date(Date.UTC(2024, 0, 2)).toISOString(),
      }),
    );
  }

  function reply(cipher: FakeCipher): string {
    return cipher.texts.at(-1) ?? "";
  }

  it("says X rate-limited the delete and does not blame admin permissions", async () => {
    let now = 1_000_000;
    const { http, cipher, engine } = stack(() => now);
    http.sendSequenceId = "seq-reply";
    await seed(engine, 4, true);
    http.deleteError = Object.assign(new Error("Rate limited; retry after 900000ms"), {
      status: 429,
      retryAfterMs: 900_000,
    });
    await purge(engine, 4, "purge-1");
    expect(http.deletes).toHaveLength(0);
    expect(cipher.deleted).toHaveLength(1);
    expect(cipher.deleted[0]).toHaveLength(4);
    expect(reply(cipher)).toMatch(/Deleted 0 of 4\. X rate-limited deletes; try again in about 15 min\./);
    expect(reply(cipher)).not.toMatch(/group admin/);
    expect(reply(cipher)).not.toMatch(/messages\/delete/);
    expect(reply(cipher)).not.toMatch(/\/2\/chat/);

    now += 3 * 60 * 1000;
    await purge(engine, 4, "purge-2");
    expect(cipher.deleted).toHaveLength(1);
    expect(http.deletes).toHaveLength(0);
    expect(reply(cipher)).toMatch(
      /Deleted 0 of 4: deletes are rate-limited for about 12 more min\./,
    );
    expect(reply(cipher)).not.toMatch(/group admin/);
    expect(reply(cipher)).not.toMatch(/messages\/delete/);
  });

  it("counts messages with no sequence id and does not call that a permission error", async () => {
    const { http, cipher, engine } = stack();
    const rows: { id: string; sequenceId?: string; createdAt: string }[] = [
      { id: "kept-0", sequenceId: "seq-kept-0", createdAt: "2024-01-01T00:00:01.000Z" },
      { id: "kept-1", sequenceId: "seq-kept-1", createdAt: "2024-01-01T00:00:02.000Z" },
      { id: "noseq-0", createdAt: "2024-01-01T00:00:03.000Z" },
      { id: "noseq-1", createdAt: "2024-01-01T00:00:04.000Z" },
      { id: "noseq-2", createdAt: "2024-01-01T00:00:05.000Z" },
    ];
    for (const row of rows) {
      await engine.processEvent(
        message({
          id: row.id,
          text: row.id,
          createdAt: row.createdAt,
          ...(row.sequenceId ? { sequenceId: row.sequenceId } : {}),
        }),
      );
    }
    await purge(engine, 5, "purge-missing");
    expect(reply(cipher)).toMatch(/Deleted 2 of 5\./);
    expect(reply(cipher)).toMatch(/3 couldn't be deleted because the bot never saw their X id/);
    expect(reply(cipher)).not.toMatch(/group admin/);
    expect(reply(cipher)).not.toMatch(/messages\/delete/);
    const posted = http.deletes.flatMap((body) => body.sequence_ids as string[]);
    expect(posted).toHaveLength(2);
  });

  it("keeps deleting after a 400 and says how many could not be deleted", async () => {
    const { http, cipher, engine } = stack();
    await seed(engine, 4, true);
    http.rejectSequenceIds.add("seq-1");
    http.rejectStatus = 400;
    await purge(engine, 4, "purge-bad");
    const posted = http.deletes.flatMap((body) => body.sequence_ids as string[]);
    expect(posted.sort()).toEqual(["seq-0", "seq-2", "seq-3"]);
    expect(posted).not.toContain("seq-1");
    expect(reply(cipher)).toMatch(/Deleted 3 of 4\./);
    expect(reply(cipher)).toMatch(/1 couldn't be deleted\./);
    expect(reply(cipher)).not.toMatch(/group admin/);
    expect(reply(cipher)).not.toMatch(/messages\/delete/);
  });

  it("mentions admin permissions only when X returns 403", async () => {
    const { cipher, http, engine } = stack();
    await seed(engine, 2, true);
    http.rejectSequenceIds.add("seq-0");
    http.rejectStatus = 403;
    await purge(engine, 2, "purge-403");
    expect(reply(cipher)).toMatch(/Deleted 1 of 2\./);
    expect(reply(cipher)).toMatch(/group admin/);
    expect(reply(cipher)).toMatch(/1 couldn't be deleted/);
    expect(reply(cipher)).not.toMatch(/messages\/delete/);
    expect(http.deletes.flatMap((body) => body.sequence_ids as string[])).toEqual(["seq-1"]);
  });

  it("records a sequence id from the send response so the reply can be purged", async () => {
    const { http, cipher, engine } = stack();
    http.sendSequenceId = "seq-from-send";
    await engine.processEvent(
      message({
        id: "help-1",
        text: "!help",
        senderId: "owner-1",
        sequenceId: "seq-help",
        createdAt: "2024-02-01T00:00:00.000Z",
      }),
    );
    await purge(engine, 1, "purge-own");
    expect(http.deletes[0]?.sequence_ids).toEqual(["seq-from-send"]);
    expect(reply(cipher)).toMatch(/Deleted 1 of 1\./);
  });

  it("reads a sequence id out of the send response's encoded event", async () => {
    const { http, cipher, engine } = stack();
    cipher.events.set("echo-blob", {
      type: "message",
      id: "mid-1",
      sequenceId: "seq-from-blob",
      content: { contentType: "text", text: "HELP_TEXT" },
    });
    http.sendEncoded = "echo-blob";
    await engine.processEvent(
      message({
        id: "help-blob",
        text: "!help",
        senderId: "owner-1",
        sequenceId: "seq-help",
        createdAt: "2024-02-02T00:00:00.000Z",
      }),
    );
    await purge(engine, 1, "purge-blob");
    expect(http.deletes[0]?.sequence_ids).toEqual(["seq-from-blob"]);
  });

  it("records a sequence id from Activity chat.sent and does not run the echo", async () => {
    const { http, cipher, engine, intake } = stack();
    await engine.processEvent(
      message({
        id: "help-sent",
        text: "!help",
        senderId: "owner-1",
        sequenceId: "seq-help",
        createdAt: "2024-02-03T00:00:00.000Z",
      }),
    );
    expect(cipher.texts).toHaveLength(1);
    const messageId = http.sends[0]?.message_id;
    expect(messageId).toBe("mid-1");
    await intake.handle({
      data: {
        event_type: "chat.sent",
        payload: {
          id: "server-evt",
          message_id: messageId,
          sender_id: "bot-1",
          conversation_id: GROUP,
          sequence_id: "4242",
          encoded_event: "b64-own",
        },
      },
    });
    expect(cipher.texts).toHaveLength(1);
    await purge(engine, 1, "purge-echo");
    expect(http.deletes[0]?.sequence_ids).toEqual(["4242"]);
    expect(reply(cipher)).toMatch(/Deleted 1 of 1\./);
  });
});
