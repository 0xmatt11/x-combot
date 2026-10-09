import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createChatHistory,
  LOCAL_ASK_RECENT_MESSAGES,
  type ChatHistory,
} from "../src/bot/chat-history.js";
import { ModerationEngine } from "../src/bot/engine.js";
import { chatEventToDm } from "../src/chat/normalize.js";
import { ChatPoller } from "../src/chat/poller.js";
import { chatListenPolicy } from "../src/chat/listen.js";
import type { ChatService } from "../src/chat/service.js";
import { DEFAULT_LLM_CONFIG } from "../src/config.js";
import { loadEnv } from "../src/env.js";
import { MockLlmClient } from "../src/llm/mock.js";
import { Store } from "../src/store.js";
import type { BotRuntimeConfig, DefaultsConfig, DmEvent, XUser } from "../src/types.js";
import { MockXClient } from "../src/x/mock-client.js";

const GROUP = "g2029561975647150382";
const OTHER = "g2029561975647150999";
const alice: XUser = { id: "u-alice", username: "alice", name: "Alice" };
const owner: XUser = { id: "u-owner", username: "owner", name: "Owner" };
const grok: XUser = { id: "u-grok", username: "grok", name: "Grok" };

const defaults: DefaultsConfig = {
  welcome: { enabled: false, text: "Welcome @{username}!" },
  rules: "Be nice.",
  help: "Type !rules",
  flood: { max_messages: 0, window_ms: 10_000, mute_ms: 60_000, warn_on_flood: false },
  warns: { limit: 3, auto_mute_ms: 60_000, notify_admins: false },
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
    rate_limit_per_user: 20,
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

function message(partial: Partial<DmEvent> & Pick<DmEvent, "id">): DmEvent {
  const senderId = partial.senderId ?? alice.id;
  const sender = partial.sender ?? [alice, owner, grok].find((user) => user.id === senderId);
  return {
    eventType: "MessageCreate",
    conversationId: GROUP,
    participantIds: [],
    participants: [],
    mentions: [],
    senderId,
    sender,
    createdAt: "2026-10-08T12:00:00.000Z",
    text: "",
    ...partial,
  };
}

function promptOf(llm: MockLlmClient): string {
  const call = llm.calls.at(-1) ?? [];
  return call.map((item) => item.content ?? "").join("\n");
}

describe("chat history store", () => {
  const stores: Store[] = [];
  const dirs: string[] = [];

  afterEach(() => {
    for (const store of stores) store.close();
    stores.length = 0;
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  function memoryStore(): Store {
    const store = new Store(":memory:");
    stores.push(store);
    return store;
  }

  function fileStore(): { store: Store; file: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-hist-"));
    dirs.push(dir);
    const file = path.join(dir, "bot.sqlite");
    const store = new Store(file);
    stores.push(store);
    return { store, file };
  }

  function history(store: Store, options?: Parameters<typeof createChatHistory>[1]): ChatHistory {
    return createChatHistory(store.db, options);
  }

  it("appends once for the same message id and the same sequence id", () => {
    const log = history(memoryStore());
    const first = message({
      id: "activity-1",
      sequenceId: "seq-9",
      text: "hello from alice",
      aliasIds: ["activity-1", "cipher:abc"],
    });
    expect(log.observe(first).messages).toBe(1);
    expect(log.observe({ ...first, id: "replay-1" }).messages).toBe(0);
    expect(
      log.observe(message({ id: "events-list-1", sequenceId: "seq-9", text: "hello from alice" })).messages,
    ).toBe(0);
    const rows = log.listMessages(GROUP);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text).toBe("hello from alice");
    expect(rows[0]?.sequence_id).toBe("seq-9");
    expect(rows[0]?.sender_label).toBe("@alice");
    expect(rows[0]?.media).toBeNull();
  });

  it("reloads the same rows after the database is closed and opened again", () => {
    const { store, file } = fileStore();
    const log = history(store);
    log.observe(
      message({
        id: "m-restart",
        sequenceId: "seq-r",
        text: "still here after restart",
        media: "image",
        replyTo: { eventId: "parent-1" },
      }),
    );
    store.close();
    stores.pop();
    const again = new Store(file);
    stores.push(again);
    const rows = history(again).listMessages(GROUP);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text).toBe("still here after restart");
    expect(rows[0]?.media).toBe("image");
    expect(rows[0]?.reply_to_id).toBe("parent-1");
    expect(rows[0]?.sequence_id).toBe("seq-r");
  });

  it("chmods the sqlite file and its wal and shm sidecars to 0600", () => {
    const { store, file } = fileStore();
    history(store).observe(message({ id: "perm-1", text: "plaintext stays in sqlite" }));
    store.restrictFilePermissions();
    for (const suffix of ["", "-wal", "-shm"]) {
      const target = `${file}${suffix}`;
      expect(fs.existsSync(target), target).toBe(true);
      expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    }
  });

  it("prunes by message count and by age when a cap is set", () => {
    const log = history(memoryStore(), { maxMessages: 2, maxDays: 10 });
    const now = Date.parse("2026-10-09T00:00:00.000Z");
    log.observe(message({ id: "old", text: "ancient", createdAt: new Date(now - 40 * 86400000).toISOString() }));
    log.observe(message({ id: "a", text: "a", createdAt: new Date(now - 3 * 86400000).toISOString() }));
    log.observe(message({ id: "b", text: "b", createdAt: new Date(now - 2 * 86400000).toISOString() }));
    log.observe(message({ id: "c", text: "c", createdAt: new Date(now - 86400000).toISOString() }));
    const removed = log.prune(now);
    expect(removed.messages).toBeGreaterThanOrEqual(2);
    expect(log.listMessages(GROUP).map((row) => row.message_id)).toEqual(["b", "c"]);
  });

  it("keeps every row when the retention defaults are left unset", () => {
    const store = memoryStore();
    const log = history(store);
    const now = Date.parse("2026-10-09T00:00:00.000Z");
    expect(log.hasRetentionLimit()).toBe(false);
    for (let index = 0; index < 5; index += 1) {
      log.observe(
        message({
          id: `kept-${index}`,
          text: `kept-${index}`,
          createdAt: new Date(now - (400 + index) * 86400000).toISOString(),
        }),
      );
    }
    log.observe(
      message({
        id: "join-old",
        eventType: "ParticipantsJoin",
        membershipKind: "add",
        participantIds: [grok.id],
        participants: [grok],
        createdAt: new Date(now - 500 * 86400000).toISOString(),
        text: undefined,
      }),
    );
    expect(log.prune(now)).toEqual({ messages: 0, membership: 0 });
    expect(log.listMessages(GROUP).map((row) => row.message_id).sort()).toEqual([
      "kept-0",
      "kept-1",
      "kept-2",
      "kept-3",
      "kept-4",
    ]);
    expect(log.listMembership(GROUP)).toHaveLength(1);

    new ModerationEngine(store, new MockXClient(), runtime());
    expect(log.prune(now)).toEqual({ messages: 0, membership: 0 });
    expect(log.listMessages(GROUP)).toHaveLength(5);
    expect(log.listMembership(GROUP)).toHaveLength(1);

    const explicitZero = history(store, { maxMessages: 0, maxDays: 0 });
    expect(explicitZero.hasRetentionLimit()).toBe(false);
    expect(explicitZero.prune(now)).toEqual({ messages: 0, membership: 0 });
    expect(explicitZero.listMessages(GROUP)).toHaveLength(5);
    expect(explicitZero.listMembership(GROUP)).toHaveLength(1);
  });

  it("keeps an edit's new text and the original body", () => {
    const log = history(memoryStore());
    log.observe(message({ id: "m1", sequenceId: "seq-1", text: "original banana wording" }));
    log.observe(
      message({
        id: "edit-1",
        eventType: "MessageEdit",
        text: "revised banana wording",
        targetSequenceId: "seq-1",
        sequenceId: "seq-edit",
      }),
    );
    const row = log.listMessages(GROUP)[0];
    expect(row?.text).toBe("revised banana wording");
    expect(row?.original_text).toBe("original banana wording");
    expect(row?.edited).toBe(1);
  });

  it("applies an edit that arrives before the original message", () => {
    const log = history(memoryStore());
    log.observe(
      message({
        id: "edit-early",
        eventType: "MessageEdit",
        text: "revised first",
        targetSequenceId: "seq-early",
      }),
    );
    log.observe(message({ id: "create-later", sequenceId: "seq-early", text: "original first" }));
    const row = log.listMessages(GROUP)[0];
    expect(row?.text).toBe("revised first");
    expect(row?.original_text).toBe("original first");
  });

  it("stamps an X delete without clearing the text, including a tombstone seen first", () => {
    const log = history(memoryStore());
    log.markDeleted(GROUP, ["seq-future"], "x", "2026-10-08T11:00:00.000Z");
    log.observe(message({ id: "later", sequenceId: "seq-future", text: "deleted but kept" }));
    log.observe(message({ id: "live", sequenceId: "seq-live", text: "still in the log" }));
    log.observe(
      message({
        id: "del-1",
        eventType: "MessageDelete",
        targetSequenceIds: ["seq-live"],
        createdAt: "2026-10-08T13:00:00.000Z",
      }),
    );
    const rows = log.listMessages(GROUP);
    expect(rows.map((row) => row.text)).toEqual(["deleted but kept", "still in the log"]);
    expect(rows.every((row) => row.deleted_by === "x" && row.deleted_in_x_at)).toBe(true);
    expect(rows[0]?.text).toBe("deleted but kept");
  });

  it("stores a membership add and finds it from a when-was-added question", () => {
    const log = history(memoryStore());
    const when = "2026-10-07T15:30:00.000Z";
    expect(
      log.observe(
        message({
          id: "join-1",
          eventType: "ParticipantsJoin",
          membershipKind: "add",
          senderId: owner.id,
          sender: owner,
          participantIds: [grok.id],
          participants: [grok],
          createdAt: when,
          text: undefined,
        }),
      ).membership,
    ).toBe(1);
    const members = log.listMembership(GROUP);
    expect(members).toHaveLength(1);
    expect(members[0]?.kind).toBe("add");
    expect(members[0]?.subject_label).toBe("@grok");
    const found = log.searchContext(GROUP, "when was grok added", Date.parse("2026-10-09T00:00:00.000Z"));
    expect(found).toContain("@grok");
    expect(found).toContain("was added");
    expect(found).toContain(when);
  });

  it("searches by keyword, sender, and last week", () => {
    const now = Date.parse("2026-10-09T12:00:00.000Z");
    const log = history(memoryStore());
    log.observe(
      message({
        id: "hit",
        text: "the bananas plan is friday",
        createdAt: new Date(now - 2 * 86400000).toISOString(),
      }),
    );
    log.observe(
      message({
        id: "old",
        text: "bananas last month",
        createdAt: new Date(now - 20 * 86400000).toISOString(),
      }),
    );
    log.observe(
      message({
        id: "other",
        senderId: owner.id,
        text: "bananas from the owner",
        createdAt: new Date(now - 86400000).toISOString(),
      }),
    );
    const found = log.searchContext(GROUP, "what did @alice say about bananas last week", now);
    expect(found).toContain("the bananas plan is friday");
    expect(found).not.toContain("bananas last month");
    expect(found).not.toContain("bananas from the owner");
    const like = history(memoryStore(), { forceLike: true });
    like.observe(
      message({
        id: "like-1",
        text: "the bananas plan is friday",
        createdAt: new Date(now - 2 * 86400000).toISOString(),
      }),
    );
    expect(like.usesFts()).toBe(false);
    expect(like.searchContext(GROUP, "bananas", now)).toContain("the bananas plan is friday");
  });

  it("leaves deleted rows in search when includeDeleted is on and omits them when it is off", () => {
    const now = Date.parse("2026-10-09T12:00:00.000Z");
    const store = memoryStore();
    const shown = history(store, { includeDeleted: true });
    shown.observe(message({ id: "gone", sequenceId: "seq-gone", text: "secret bananas leftover" }));
    shown.markDeleted(GROUP, ["seq-gone"], "x", "2026-10-08T12:00:00.000Z");
    expect(shown.listMessages(GROUP)[0]?.text).toBe("secret bananas leftover");
    const visible = shown.searchContext(GROUP, "bananas", now);
    expect(visible).toContain("secret bananas leftover");
    expect(visible).toContain("deleted in X");
    expect(shown.recentTurns(GROUP, 10).map((turn) => turn.text)).toContain("secret bananas leftover");

    const hidden = history(store, { includeDeleted: false });
    expect(hidden.searchContext(GROUP, "bananas", now)).toBeUndefined();
    expect(hidden.recentTurns(GROUP, 10)).toEqual([]);
    expect(hidden.listMessages(GROUP)[0]?.text).toBe("secret bananas leftover");
  });
});

describe("chat history decrypt mapping", () => {
  it("maps a decrypted message edit onto the target sequence", () => {
    const event = chatEventToDm(
      GROUP,
      { id: "raw-edit", conversation_id: GROUP, sequence_id: "seq-of-edit" },
      {
        type: "message",
        content: {
          contentType: "messageEdit",
          updated_text: "after the edit",
          message_sequence_id: "seq-target",
        } as never,
      },
    );
    expect(event?.eventType).toBe("MessageEdit");
    expect(event?.text).toBe("after the edit");
    expect(event?.targetSequenceId).toBe("seq-target");
    expect(event?.sequenceId).toBe("seq-of-edit");
  });

  it("maps a messageDelete payload onto the target ids and not the event sequence", () => {
    const event = chatEventToDm(
      GROUP,
      { id: "raw-del", conversation_id: GROUP, sequence_id: "seq-of-delete-event" },
      {
        type: "messageDelete",
        sequenceIds: ["seq-target-a", "seq-target-b"],
      } as never,
    );
    expect(event?.eventType).toBe("MessageDelete");
    expect(event?.targetSequenceIds).toEqual(["seq-target-a", "seq-target-b"]);
    expect(event?.sequenceId).toBe("seq-of-delete-event");
    expect(event?.targetSequenceId).not.toBe("seq-of-delete-event");
  });
});

describe("chat history in the engine", () => {
  const stores: Store[] = [];

  afterEach(() => {
    for (const store of stores) store.close();
    stores.length = 0;
  });

  function setup(options?: { includeDeleted?: boolean; enabled?: boolean }) {
    const store = new Store(":memory:");
    stores.push(store);
    store.authorizeChat(GROUP);
    const client = new MockXClient();
    client.addUser(alice);
    client.addUser(owner);
    const llm = new MockLlmClient("local answer");
    const engine = new ModerationEngine(store, client, runtime(), llm, {
      chatHistory: {
        ...(options?.includeDeleted === false ? { includeDeleted: false } : {}),
        ...(options?.enabled === false ? { enabled: false } : {}),
      },
    });
    return { store, client, llm, engine, log: createChatHistory(store.db) };
  }

  it("answers !ask from the local store and does not call X history", async () => {
    const { engine, client, llm } = setup();
    for (let index = 0; index < 25; index += 1) {
      const label = `m${String(index).padStart(2, "0")}`;
      await engine.processEvent(
        message({
          id: `h-${label}`,
          text: label,
          createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index)).toISOString(),
        }),
      );
    }
    const result = await engine.processEvent(
      message({ id: "ask-1", senderId: alice.id, text: "!ask what is going on" }),
    );
    expect(result.llm).toBe(true);
    expect(client.conversationListCalls).toHaveLength(0);
    const prompt = promptOf(llm);
    expect(prompt).toContain("m00");
    expect(prompt).toContain("m24");
    expect(LOCAL_ASK_RECENT_MESSAGES).toBe(100);
  });

  it("answers an empty local store without calling X", async () => {
    const { engine, client, llm } = setup();
    const result = await engine.processEvent(
      message({ id: "ask-empty", text: "!ask what is going on" }),
    );
    expect(result.llm).toBe(true);
    expect(client.conversationListCalls).toHaveLength(0);
    expect(promptOf(llm)).toContain("what is going on");
  });

  it("still reads X when chat history is disabled", async () => {
    const { engine, client, store } = setup({ enabled: false });
    client.events.push(message({ id: "x-1", text: "from x only" }));
    await engine.processEvent(message({ id: "ask-x", text: "!ask what is going on" }));
    expect(client.conversationListCalls.length).toBeGreaterThan(0);
    expect(createChatHistory(store.db).listMessages(GROUP)).toEqual([]);
  });

  it("leaves !purge text in the database and still feeds it to the LLM", async () => {
    const { engine, client, llm, log } = setup();
    await engine.processEvent(
      message({ id: "keep-1", sequenceId: "seq-keep-1", text: "secret-purged-body" }),
    );
    await engine.processEvent(
      message({ id: "keep-2", sequenceId: "seq-keep-2", text: "second-purged-body" }),
    );
    const callsBefore = client.conversationListCalls.length;
    await engine.processEvent(
      message({
        id: "purge-1",
        senderId: owner.id,
        sequenceId: "seq-purge",
        text: "!purge 2",
      }),
    );
    expect(client.deleted.sort()).toEqual(["keep-1", "keep-2"]);
    expect(client.conversationListCalls.length).toBe(callsBefore);
    const kept = log.listMessages(GROUP).filter((row) => row.message_id.startsWith("keep-"));
    expect(kept.map((row) => row.text).sort()).toEqual(["second-purged-body", "secret-purged-body"]);
    expect(kept.every((row) => row.deleted_by === "purge" && row.deleted_in_x_at)).toBe(true);

    await engine.processEvent(message({ id: "ask-purged", text: "!ask what is going on" }));
    const prompt = promptOf(llm);
    expect(prompt).toContain("secret-purged-body");
    expect(prompt).toContain("second-purged-body");
    expect(client.conversationListCalls).toHaveLength(0);
  });

  it("omits deleted-in-X rows from the LLM prompt when CHAT_HISTORY_INCLUDE_DELETED is false", async () => {
    const visible = setup();
    await visible.engine.processEvent(
      message({ id: "vis", sequenceId: "seq-vis", text: "visible-apple-line" }),
    );
    await visible.engine.processEvent(
      message({ id: "hid", sequenceId: "seq-hid", text: "hidden-banana-line" }),
    );
    await visible.engine.processEvent(
      message({
        id: "del-hid",
        eventType: "MessageDelete",
        targetSequenceIds: ["seq-hid"],
        createdAt: "2026-10-08T18:00:00.000Z",
      }),
    );
    expect(visible.log.listMessages(GROUP).find((row) => row.message_id === "hid")?.text).toBe(
      "hidden-banana-line",
    );

    const hidden = new ModerationEngine(visible.store, visible.client, runtime(), visible.llm, {
      chatHistory: { includeDeleted: false },
    });
    await hidden.processEvent(message({ id: "ask-hidden", text: "!ask what did @alice say about banana" }));
    const omitted = promptOf(visible.llm);
    expect(omitted).not.toContain("hidden-banana-line");
    expect(omitted).toContain("visible-apple-line");

    const shownLlm = new MockLlmClient("shown");
    const shown = new ModerationEngine(visible.store, new MockXClient(), runtime(), shownLlm, {
      chatHistory: { includeDeleted: true },
    });
    await shown.processEvent(message({ id: "ask-shown", text: "!ask what did @alice say about banana" }));
    expect(promptOf(shownLlm)).toContain("hidden-banana-line");
  });

  it("stores an edit and an X delete that arrive as events", async () => {
    const { engine, log } = setup();
    await engine.processEvent(message({ id: "body", sequenceId: "seq-body", text: "before edit" }));
    await engine.processEvent(
      message({
        id: "edit-evt",
        eventType: "MessageEdit",
        text: "after edit",
        targetSequenceId: "seq-body",
      }),
    );
    await engine.processEvent(
      message({
        id: "delete-evt",
        eventType: "MessageDelete",
        targetSequenceIds: ["seq-body"],
      }),
    );
    const row = log.listMessages(GROUP)[0];
    expect(row?.text).toBe("after edit");
    expect(row?.original_text).toBe("before edit");
    expect(row?.deleted_by).toBe("x");
    expect(row?.deleted_in_x_at).toBeTruthy();
  });

  it("records the bot's own reply and a membership event", async () => {
    const { engine, log } = setup();
    await engine.processEvent(message({ id: "rules-1", senderId: owner.id, text: "!rules" }));
    await engine.processEvent(
      message({
        id: "add-grok",
        eventType: "ParticipantsJoin",
        membershipKind: "add",
        senderId: owner.id,
        participantIds: [grok.id],
        participants: [grok],
        text: undefined,
      }),
    );
    const texts = log.listMessages(GROUP).map((row) => row.text);
    expect(texts.some((text) => text.includes("Be nice."))).toBe(true);
    expect(log.listMembership(GROUP)[0]?.subject_label).toBe("@grok");
  });

  it("pages a backfill, resumes after a 429, and never walks a finished chat again", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { engine, client, log } = setup();
      const secret = "SECRET_PLAINTEXT_XYZ";
      const pages = [
        {
          events: [message({ id: "p1", sequenceId: "s1", text: secret, createdAt: "2026-10-08T03:00:00.000Z" })],
          nextToken: "cursor-2",
        },
        {
          events: [
            message({
              id: "p2",
              sequenceId: "s2",
              text: "older page",
              createdAt: "2026-10-01T03:00:00.000Z",
            }),
            message({
              id: "join-page",
              eventType: "ParticipantsJoin" as const,
              membershipKind: "add" as const,
              participantIds: [grok.id],
              participants: [grok],
              senderId: owner.id,
              text: undefined,
              createdAt: "2026-09-01T00:00:00.000Z",
            }),
          ],
          nextToken: undefined as string | undefined,
        },
      ];
      let listed = 0;
      let failOnce = true;
      client.listConversationDmEvents = async (params) => {
        client.conversationListCalls.push({
          conversationId: params.conversationId,
          maxResults: params.maxResults,
        });
        listed += 1;
        if (listed === 2 && failOnce) {
          failOnce = false;
          const rate = new Error("HTTP 429") as Error & { status: number; retryAfterMs: number };
          rate.status = 429;
          rate.retryAfterMs = 60_000;
          throw rate;
        }
        const page = params.paginationToken === "cursor-2" ? pages[1]! : pages[0]!;
        return { events: page.events, nextToken: page.nextToken };
      };

      engine.noteChatForHistory(GROUP);
      expect(log.backfillOf(GROUP)?.done).toBe(false);

      const t0 = 1_700_000_000_000;
      await engine.backfillChatHistory(t0);
      expect(log.backfillOf(GROUP)).toMatchObject({ cursor: "cursor-2", done: false, pages: 1, stored: 1 });
      expect(log.listMessages(GROUP)[0]?.text).toBe(secret);

      await expect(engine.backfillChatHistory(t0 + 1)).rejects.toMatchObject({ status: 429 });
      expect(log.backfillOf(GROUP)?.cursor).toBe("cursor-2");
      expect(log.backfillOf(GROUP)?.pages).toBe(1);
      expect(client.conversationListCalls).toHaveLength(2);

      await engine.backfillChatHistory(t0 + 2);
      expect(client.conversationListCalls).toHaveLength(2);

      await engine.backfillChatHistory(t0 + 61_000);
      expect(log.backfillOf(GROUP)?.done).toBe(true);
      expect(log.listMessages(GROUP).map((row) => row.message_id).sort()).toEqual(["p1", "p2"]);
      expect(log.listMembership(GROUP)).toHaveLength(1);

      const callsAtDone = client.conversationListCalls.length;
      engine.noteChatForHistory(GROUP);
      await engine.processEvent(message({ id: "live-after", text: "after done" }));
      await engine.backfillChatHistory(t0 + 120_000);
      expect(client.conversationListCalls).toHaveLength(callsAtDone);
      expect(log.backfillOf(GROUP)?.done).toBe(true);

      const logged = [...info.mock.calls, ...warn.mock.calls, ...error.mock.calls]
        .map((call) => call.map((part) => String(part)).join(" "))
        .join("\n");
      expect(logged).not.toContain(secret);
      expect(logged).toContain("done=true");
    } finally {
      info.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it("queues backfill for a chat the bot sees for the first time", async () => {
    const { engine, log } = setup();
    await engine.processEvent(message({ id: "first-sight", conversationId: OTHER, text: "new room" }));
    expect(log.backfillOf(OTHER)).toMatchObject({ done: false, pages: 0, cursor: null });
    expect(log.listMessages(OTHER)[0]?.text).toBe("new room");
  });
});

describe("chat history backfill on the poller", () => {
  const stores: Store[] = [];
  const pollers: ChatPoller[] = [];

  afterEach(() => {
    for (const poller of pollers) poller.stop();
    pollers.length = 0;
    for (const store of stores) store.close();
    stores.length = 0;
  });

  function rateLimit(): Error {
    const error = new Error("HTTP 429") as Error & { status: number; retryAfterMs: number };
    error.status = 429;
    error.retryAfterMs = 60_000;
    return error;
  }

  it("skips backfill when the tick's read was rate-limited and fetches one page per successful tick", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const store = new Store(":memory:");
    stores.push(store);
    store.authorizeChat(GROUP);
    const client = new MockXClient();
    const engine = new ModerationEngine(store, client, runtime());
    const pages = [
      { events: [message({ id: "b1", text: "page-one" })], nextToken: "next-1" as string | undefined },
      { events: [message({ id: "b2", text: "page-two" })], nextToken: undefined },
    ];
    client.listConversationDmEvents = async (params) => {
      client.conversationListCalls.push({
        conversationId: params.conversationId,
        maxResults: params.maxResults,
      });
      const page = params.paginationToken === "next-1" ? pages[1]! : pages[0]!;
      return { events: page.events, nextToken: page.nextToken };
    };

    const limited = vi.fn().mockRejectedValue(rateLimit());
    const blocked = new ChatPoller(
      { pullNew: limited } as unknown as ChatService,
      store,
      engine,
      1000,
      [GROUP],
      50,
      1000,
      { historyBackfill: true },
    );
    pollers.push(blocked);
    await blocked.tick();
    expect(limited).toHaveBeenCalled();
    expect(client.conversationListCalls).toHaveLength(0);
    blocked.stop();

    const pull = vi.fn().mockResolvedValue({ events: [], newestId: "n1", watermarkId: "n1" });
    const live = new ChatPoller(
      { pullNew: pull } as unknown as ChatService,
      store,
      engine,
      1000,
      [GROUP],
      50,
      1000,
      { historyBackfill: true },
    );
    pollers.push(live);
    await live.tick();
    expect(client.conversationListCalls).toHaveLength(1);
    expect(client.conversationListCalls[0]?.maxResults).toBe(100);
    await live.tick();
    expect(client.conversationListCalls).toHaveLength(2);
    await live.tick();
    expect(client.conversationListCalls).toHaveLength(2);
    expect(createChatHistory(store.db).backfillOf(GROUP)?.done).toBe(true);
    live.stop();
    vi.useRealTimers();
  });

  it("queues a new chat for backfill the first time the poller sees it", () => {
    const store = new Store(":memory:");
    stores.push(store);
    const engine = new ModerationEngine(store, new MockXClient(), runtime());
    const poller = new ChatPoller(
      { pullNew: vi.fn() } as unknown as ChatService,
      store,
      engine,
      1000,
      [GROUP],
      50,
      1000,
      { historyBackfill: true, policy: chatListenPolicy({ mode: "all" }) },
    );
    pollers.push(poller);
    const log = createChatHistory(store.db);
    expect(log.backfillOf(GROUP)?.done).toBe(false);
    poller.observeFromActivity(OTHER, "seed-1");
    expect(log.backfillOf(OTHER)).toMatchObject({ done: false, pages: 0 });
  });
});

describe("CHAT_HISTORY env", () => {
  it("defaults history on, include-deleted on, and retention unlimited", () => {
    process.env.BOT_OWNER_ID = process.env.BOT_OWNER_ID ?? "1";
    const names = [
      "CHAT_HISTORY_ENABLED",
      "CHAT_HISTORY_MAX_MESSAGES",
      "CHAT_HISTORY_MAX_DAYS",
      "CHAT_HISTORY_INCLUDE_DELETED",
    ] as const;
    const previous = new Map(names.map((name) => [name, process.env[name]]));
    try {
      for (const name of names) delete process.env[name];
      const env = loadEnv(true);
      expect(env.chatHistoryEnabled).toBe(true);
      expect(env.chatHistoryIncludeDeleted).toBe(true);
      expect(env.chatHistoryMaxMessages).toBe(0);
      expect(env.chatHistoryMaxDays).toBe(0);

      process.env.CHAT_HISTORY_MAX_MESSAGES = "0";
      process.env.CHAT_HISTORY_MAX_DAYS = "0";
      const zeros = loadEnv(true);
      expect(zeros.chatHistoryMaxMessages).toBe(0);
      expect(zeros.chatHistoryMaxDays).toBe(0);

      process.env.CHAT_HISTORY_ENABLED = "false";
      process.env.CHAT_HISTORY_INCLUDE_DELETED = "false";
      process.env.CHAT_HISTORY_MAX_MESSAGES = "10";
      process.env.CHAT_HISTORY_MAX_DAYS = "7";
      const set = loadEnv(true);
      expect(set.chatHistoryEnabled).toBe(false);
      expect(set.chatHistoryIncludeDeleted).toBe(false);
      expect(set.chatHistoryMaxMessages).toBe(10);
      expect(set.chatHistoryMaxDays).toBe(7);

      process.env.CHAT_HISTORY_INCLUDE_DELETED = "maybe";
      expect(() => loadEnv(true)).toThrow(/CHAT_HISTORY_INCLUDE_DELETED/);
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});
