import { afterEach, describe, expect, it } from "vitest";
import { leaveAnnouncementText, ModerationEngine } from "../src/bot/engine.js";
import { loadDefaults } from "../src/config.js";
import { collectNewEvents } from "../src/poller.js";
import { Store } from "../src/store.js";
import type { BotRuntimeConfig, DefaultsConfig, DmEvent, XUser } from "../src/types.js";
import { MockXClient } from "../src/x/mock-client.js";

const alice: XUser = { id: "u-alice", username: "alice", name: "Alice" };
const bob: XUser = { id: "u-bob", username: "bob", name: "Bob" };
const owner: XUser = { id: "u-owner", username: "owner", name: "Owner" };
const groupId = "1578398451921985538";

const defaults: DefaultsConfig = {
  welcome: { enabled: true, text: "Welcome @{username}!" },
  rules: "Be nice.",
  help: "Type !rules",
  flood: { max_messages: 3, window_ms: 10_000, mute_ms: 60_000, warn_on_flood: true },
  warns: { limit: 2, auto_mute_ms: 60_000, notify_admins: true },
  filters: [{ type: "keyword", pattern: "spamlink", case_insensitive: true, warn: true }],
  poll: { interval_ms: 1000, max_results: 50 },
  delete: { attempt_on_filter: true, attempt_on_flood: true, attempt_on_mute: true },
};

function runtime(): BotRuntimeConfig {
  return {
    botUserId: "bot-1",
    ownerId: owner.id,
    globalAdminIds: [],
    defaults,
  };
}

function message(partial: Partial<DmEvent> & Pick<DmEvent, "id" | "senderId" | "text">): DmEvent {
  const sender =
    partial.sender ??
    [alice, bob, owner].find((user) => user.id === partial.senderId);
  return {
    eventType: "MessageCreate",
    conversationId: groupId,
    participantIds: [],
    participants: [],
    mentions: [],
    sender,
    ...partial,
  };
}

describe("ModerationEngine", () => {
  const stores: Store[] = [];

  afterEach(() => {
    for (const store of stores) store.close();
    stores.length = 0;
  });

  function setup(
    flood?: Partial<DefaultsConfig["flood"]>,
  ): { engine: ModerationEngine; client: MockXClient; store: Store } {
    const store = new Store(":memory:");
    stores.push(store);
    const client = new MockXClient();
    client.addUser(alice);
    client.addUser(bob);
    client.addUser(owner);
    const config = runtime();
    if (flood) config.defaults = { ...defaults, flood: { ...defaults.flood, ...flood } };
    const engine = new ModerationEngine(store, client, config);
    return { engine, client, store };
  }

  function floodEventCount(store: Store): number {
    const row = store.db.prepare("SELECT COUNT(*) AS count FROM flood_events").get() as {
      count: number;
    };
    return row.count;
  }

  it("tags the requester and replies to their command", async () => {
    const { engine, client } = setup();
    const actions = await engine.processEvent(
      message({
        id: "help-reply",
        senderId: alice.id,
        text: "!help",
        sequenceId: "55",
        encodedEvent: "blob-help",
      }),
    );
    expect(actions.replies).toEqual(["@alice Type !rules"]);
    expect(client.sent).toEqual([
      {
        conversationId: groupId,
        text: "@alice Type !rules",
        replyToSequenceId: "55",
        replyToEvent: "blob-help",
      },
    ]);
    expect(JSON.stringify(client.sent)).not.toContain("18+");
  });

  it("sends a welcome on ParticipantsJoin", async () => {
    const { engine, client } = setup();
    await engine.processEvent({
      id: "join-1",
      eventType: "ParticipantsJoin",
      conversationId: groupId,
      senderId: owner.id,
      participantIds: [alice.id],
      participants: [alice],
      mentions: [],
    });
    expect(client.sent[0]?.text).toBe("Welcome @alice!");
  });

  it("welcomes a joiner known only by id, and never prints that id", async () => {
    const { engine, client } = setup();
    const snowflake = "1712950172873809920";
    await engine.processEvent({
      id: "join-id",
      eventType: "ParticipantsJoin",
      conversationId: groupId,
      participantIds: [alice.id],
      participants: [{ id: alice.id }],
      mentions: [],
    });
    await engine.processEvent({
      id: "join-unknown",
      eventType: "ParticipantsJoin",
      conversationId: groupId,
      participantIds: [snowflake],
      participants: [{ id: snowflake }],
      mentions: [],
    });
    expect(client.sent.map((row) => row.text)).toEqual(["Welcome @alice!", "Welcome someone!"]);
    expect(client.sent.some((row) => row.text.includes(snowflake))).toBe(false);
  });

  it("announces a classic ParticipantsLeave with the @handle", async () => {
    const { engine, client } = setup();
    const actions = await engine.processEvent({
      id: "leave-1",
      eventType: "ParticipantsLeave",
      conversationId: groupId,
      participantIds: [alice.id],
      participants: [alice],
      mentions: [],
    });
    expect(actions.replies).toEqual(["@alice has left"]);
    expect(client.sent).toEqual([{ conversationId: groupId, text: "@alice has left" }]);
  });

  it("uses the same has-left line for a removal and looks up a handle from an id", async () => {
    const { engine, client } = setup();
    await engine.processEvent({
      id: "kick-1",
      eventType: "ParticipantsLeave",
      conversationId: groupId,
      senderId: owner.id,
      participantIds: [bob.id, bob.id],
      participants: [],
      mentions: [],
    });
    expect(client.sent.map((row) => row.text)).toEqual(["@bob has left"]);
  });

  it("does not announce the bot leaving, including when someone else leaves with it", async () => {
    const { engine, client } = setup();
    await engine.processEvent({
      id: "bot-left",
      eventType: "ParticipantsLeave",
      conversationId: groupId,
      senderId: "bot-1",
      participantIds: ["bot-1"],
      participants: [{ id: "bot-1", username: "modbot" }],
      mentions: [],
    });
    await engine.processEvent({
      id: "bot-and-alice",
      eventType: "ParticipantsLeave",
      conversationId: groupId,
      senderId: owner.id,
      participantIds: ["bot-1", alice.id],
      participants: [{ id: "bot-1" }, alice],
      mentions: [],
    });
    expect(client.sent.map((row) => row.text)).toEqual(["@alice has left"]);
  });

  it("stays quiet when leave announcements are turned off", async () => {
    const { engine, client } = setup();
    await engine.processEvent(
      message({ id: "set-leave", senderId: owner.id, text: "!set leave_enabled off" }),
    );
    await engine.processEvent({
      id: "leave-off",
      eventType: "ParticipantsLeave",
      conversationId: groupId,
      participantIds: [alice.id],
      participants: [alice],
      mentions: [],
    });
    expect(client.sent.map((row) => row.text)).toEqual(["@owner Updated leave_enabled."]);
  });

  it("uses a per-conversation leave_text", async () => {
    const { engine, client } = setup();
    await engine.processEvent(
      message({ id: "set-text", senderId: owner.id, text: "!set leave_text {name} has left" }),
    );
    await engine.processEvent({
      id: "leave-name",
      eventType: "ParticipantsLeave",
      conversationId: groupId,
      participantIds: [alice.id],
      participants: [alice],
      mentions: [],
    });
    expect(client.sent.at(-1)?.text).toBe("Alice has left");
  });

  it("announces a leave only once for the same event id", async () => {
    const { engine, client } = setup();
    const event: DmEvent = {
      id: "leave-dup",
      eventType: "ParticipantsLeave",
      conversationId: groupId,
      participantIds: [alice.id],
      participants: [alice],
      mentions: [],
    };
    await engine.processEvent(event);
    await engine.processEvent(event);
    expect(client.sent).toHaveLength(1);
  });

  it("announces once when Activity and the poll use different ids for one sequence", async () => {
    const { engine, client } = setup();
    const base = {
      eventType: "ParticipantsLeave" as const,
      conversationId: groupId,
      sequenceId: "77",
      participantIds: [alice.id],
      participants: [alice],
      mentions: [],
    };
    await engine.processEvent({ ...base, id: "activity-uuid" });
    await engine.processEvent({ ...base, id: "poll-message-id" });
    expect(client.sent.map((row) => row.text)).toEqual(["@alice has left"]);
  });

  it("runs a command once when the same Chat sequence arrives under two ids", async () => {
    const { engine, client } = setup();
    await engine.processEvent(
      message({ id: "activity-uuid", senderId: alice.id, text: "!dice", sequenceId: "88" }),
    );
    const rolled = client.sent[0]?.text;
    await engine.processEvent(
      message({ id: "poll-message-id", senderId: alice.id, text: "!dice", sequenceId: "88" }),
    );
    expect(client.sent.map((row) => row.text)).toEqual([rolled]);
    expect(rolled).toMatch(/rolled/);

    await engine.processEvent(
      message({ id: "help-2", senderId: alice.id, text: "!help", sequenceId: "89" }),
    );
    expect(client.sent.map((row) => row.text)).toEqual([rolled, "@alice Type !rules"]);
  });

  it("posts the unresolved +/− error once when that reply is delivered twice", async () => {
    const { engine, client } = setup();
    const vote = {
      senderId: alice.id,
      text: "+",
      sequenceId: "91",
      replyTo: { sequenceId: "missing-target", verified: false },
    };
    await engine.processEvent(message({ id: "activity-plus", ...vote }));
    await engine.processEvent(message({ id: "poll-plus", ...vote }));
    expect(client.sent).toHaveLength(1);
    expect(client.sent[0]?.text).toContain("Couldn't tell who that reply is for");
  });

  it("does not rerun a command already handled under another id for the same sequence", async () => {
    const { engine, client, store } = setup();
    store.markProcessed("activity-uuid");
    store.rememberChatMessage("activity-uuid", groupId, "88");
    await engine.processEvent(
      message({ id: "poll-message-id", senderId: alice.id, text: "!dice", sequenceId: "88" }),
    );
    expect(client.sent).toHaveLength(0);
  });

  it("replies once when two raw ids share a ciphertext or decrypted message id", async () => {
    const { engine, client } = setup();
    await engine.processEvent(
      message({
        id: "activity-uuid",
        senderId: alice.id,
        text: "!rules",
        aliasIds: ["cipher:same-blob", "msg-rules"],
      }),
    );
    await engine.processEvent(
      message({
        id: "reconnect-uuid",
        senderId: alice.id,
        text: "!rules",
        aliasIds: ["cipher:same-blob"],
      }),
    );
    await engine.processEvent(
      message({ id: "msg-rules", senderId: alice.id, text: "!rules" }),
    );
    expect(client.sent.map((row) => row.text)).toEqual(["@alice Be nice."]);
  });

  it("says someone when a leaver cannot be resolved", async () => {
    const { engine, client } = setup();
    client.getUserById = async () => {
      throw new Error("rate limited");
    };
    await engine.processEvent({
      id: "leave-ghost",
      eventType: "ParticipantsLeave",
      conversationId: groupId,
      participantIds: ["u-ghost"],
      participants: [],
      mentions: [],
    });
    expect(client.sent[0]?.text).toBe("someone has left");
    expect(client.sent[0]?.text).not.toContain("u-ghost");
  });

  it("ignores a leave in a one-to-one conversation", async () => {
    const { engine, client } = setup();
    await engine.processEvent({
      id: "dm-leave",
      eventType: "ParticipantsLeave",
      conversationId: "111-222",
      participantIds: [alice.id],
      participants: [alice],
      mentions: [],
    });
    expect(client.sent).toHaveLength(0);
  });

  it("replies to !rules and !help in the group", async () => {
    const { engine, client } = setup();
    await engine.processEvent(message({ id: "m1", senderId: alice.id, text: "!rules" }));
    await engine.processEvent(message({ id: "m2", senderId: alice.id, text: "!help" }));
    expect(client.sent.map((row) => row.text)).toEqual(["@alice Be nice.", "@alice Type !rules"]);
  });

  it("rejects mod commands from non-admins", async () => {
    const { engine, client, store } = setup();
    await engine.processEvent(
      message({ id: "m3", senderId: alice.id, text: "!warn @bob" }),
    );
    expect(client.sent[0]?.text).toMatch(/limited to configured admins/);
    expect(store.getWarnCount(groupId, bob.id)).toBe(0);
  });

  it("shows the admin list to admins and denies everyone else", async () => {
    const adminHelp = "Admin commands.\n!warn @user — add a warning";
    const store = new Store(":memory:");
    stores.push(store);
    const client = new MockXClient();
    client.addUser(alice);
    client.addUser(bob);
    client.addUser(owner);
    const engine = new ModerationEngine(store, client, {
      ...runtime(),
      globalAdminIds: [bob.id],
      defaults: { ...defaults, admin_help: adminHelp },
    });

    await engine.processEvent(message({ id: "a1", senderId: alice.id, text: "!admin" }));
    expect(client.sent.at(-1)?.text).toBe(
      "@alice That command is limited to configured admins.",
    );

    await engine.processEvent(message({ id: "a2", senderId: owner.id, text: "/admin" }));
    expect(client.sent.at(-1)?.text).toBe(`@owner ${adminHelp}`);

    await engine.processEvent(message({ id: "a3", senderId: bob.id, text: "!ADMIN help" }));
    expect(client.sent.at(-1)?.text).toBe(`@bob ${adminHelp}`);

    store.addConversationAdmin(groupId, alice.id);
    await engine.processEvent(message({ id: "a4", senderId: alice.id, text: "!admin" }));
    expect(client.sent.at(-1)?.text).toBe(`@alice ${adminHelp}`);

    await engine.processEvent(
      message({
        id: "a5",
        senderId: owner.id,
        text: "!admin add @bob",
        mentions: [{ username: "bob", id: bob.id }],
      }),
    );
    expect(client.sent.at(-1)?.text).toMatch(/@bob can now run mod commands/);
  });

  it("tracks warns and auto-mutes at the limit", async () => {
    const { engine, client, store } = setup();
    await engine.processEvent(
      message({
        id: "w1",
        senderId: owner.id,
        text: "!warn @bob spam",
        mentions: [{ username: "bob", id: bob.id }],
      }),
    );
    await engine.processEvent(
      message({
        id: "w2",
        senderId: owner.id,
        text: "!warn @bob again",
        mentions: [{ username: "bob", id: bob.id }],
      }),
    );
    expect(store.getWarnCount(groupId, bob.id)).toBe(2);
    expect(store.isMuted(groupId, bob.id)).toBe(true);
    expect(client.sent.some((row) => /warn limit/i.test(row.text))).toBe(true);
    expect(client.direct.some((row) => row.participantId === owner.id)).toBe(true);
  });

  it("stores and retrieves admin notes", async () => {
    const { engine, client } = setup();
    await engine.processEvent(
      message({ id: "n1", senderId: owner.id, text: "!note topic meetup friday" }),
    );
    await engine.processEvent(message({ id: "n2", senderId: owner.id, text: "!get topic" }));
    expect(client.sent.map((row) => row.text)).toEqual([
      '@owner Saved note "topic".',
      "@owner topic: meetup friday",
    ]);
  });

  it("attempts delete on !del and reports X ownership limitation", async () => {
    const { engine, client } = setup();
    await engine.processEvent(message({ id: "user-msg", senderId: bob.id, text: "hello" }));
    await engine.processEvent(message({ id: "del-1", senderId: owner.id, text: "!del" }));
    expect(client.sent.at(-1)?.text).toMatch(/Could not delete/);
    expect(client.deleted).toEqual([]);
  });

  it("rejects !purge from non-admins and allows the same admin gate", async () => {
    const store = new Store(":memory:");
    stores.push(store);
    const client = new MockXClient();
    client.addUser(alice);
    client.addUser(bob);
    client.addUser(owner);
    const engine = new ModerationEngine(store, client, {
      ...runtime(),
      globalAdminIds: [bob.id],
    });

    await engine.processEvent(message({ id: "p-deny", senderId: alice.id, text: "!purge 25" }));
    expect(client.sent.at(-1)?.text).toMatch(/limited to configured admins/);
    expect(client.deleted).toEqual([]);
    expect(client.conversationListCalls).toHaveLength(0);

    await engine.processEvent(message({ id: "p-global", senderId: bob.id, text: "/purge 50" }));
    expect(client.sent.at(-1)?.text).toMatch(/No recent messages to purge/);
    expect(client.conversationListCalls).toHaveLength(1);

    store.addConversationAdmin(groupId, alice.id);
    await engine.processEvent(message({ id: "p-local", senderId: alice.id, text: "!purge 100" }));
    expect(client.sent.at(-1)?.text).toMatch(/No recent messages to purge/);
    expect(client.deleted).toEqual([]);
  });

  it("purges newest messages and reports classic deletes the bot does not own", async () => {
    const { engine, client } = setup();
    const stamp = (seconds: number) =>
      new Date(Date.UTC(2024, 0, 1, 0, 0, seconds)).toISOString();
    client.events.push(
      message({
        id: "purge-cmd",
        senderId: owner.id,
        text: "!purge 10",
        createdAt: stamp(50),
      }),
      {
        id: "join-mid",
        eventType: "ParticipantsJoin",
        conversationId: groupId,
        createdAt: stamp(40),
        participantIds: [alice.id],
        participants: [alice],
        mentions: [],
      },
      message({
        id: "bot-new",
        senderId: "bot-1",
        text: "newest reply",
        createdAt: stamp(30),
      }),
      message({
        id: "user-new",
        senderId: bob.id,
        text: "member",
        createdAt: stamp(20),
      }),
      message({
        id: "bot-old",
        senderId: "bot-1",
        text: "older reply",
        createdAt: stamp(10),
      }),
      message({
        id: "user-old",
        senderId: alice.id,
        text: "older member",
        createdAt: stamp(0),
      }),
    );

    const actions = await engine.processEvent(
      message({ id: "purge-cmd", senderId: owner.id, text: "!purge 10" }),
    );
    expect(client.conversationListCalls[0]?.maxResults).toBe(100);
    expect(client.deleted).toEqual(["bot-new", "bot-old"]);
    expect(actions.deletes).toEqual(["bot-new", "bot-old"]);
    expect(client.sent.at(-1)?.text).toMatch(
      /Deleted 2 of 4 recent messages \(asked for 10\)\. X only lets the bot delete its own events \(DELETE \/2\/dm_events\/:id\)/,
    );
    expect(client.sent.at(-1)?.text).not.toMatch(/Capped at/);
  });

  it("deletes exactly the last N messages for a count that is not 25, 50, or 100", async () => {
    const { engine, client } = setup();
    const total = 20;
    const count = 17;
    client.events.push(
      message({
        id: "purge-cmd",
        senderId: owner.id,
        text: `!purge ${count}`,
        createdAt: new Date(Date.UTC(2024, 3, 1) + total * 1000).toISOString(),
      }),
    );
    for (let i = 0; i < total; i += 1) {
      client.events.push(
        message({
          id: `bot-n-${i}`,
          senderId: "bot-1",
          text: `m${i}`,
          createdAt: new Date(Date.UTC(2024, 3, 1) + i * 1000).toISOString(),
        }),
      );
    }

    await engine.processEvent(
      message({ id: "purge-cmd", senderId: owner.id, text: `!purge ${count}` }),
    );

    const expected = Array.from({ length: count }, (_, index) => `bot-n-${total - 1 - index}`);
    expect(client.deleted).toEqual(expected);
    expect(client.deleted).not.toContain("bot-n-2");
    expect(client.deleted).not.toContain("purge-cmd");
    expect(client.sent.at(-1)?.text).toMatch(/Deleted 17 of 17\./);
    expect(client.sent.at(-1)?.text).not.toMatch(/Capped at/);
  });

  it("purges encrypted Chat with sequence ids and states the delete-for-all limit", async () => {
    const { engine, client, store } = setup();
    const chatId = "g2029561975647150382";
    store.authorizeChat(chatId);
    const stamp = (seconds: number) =>
      new Date(Date.UTC(2024, 0, 1, 0, 1, seconds)).toISOString();
    client.failDeleteIds.add("member-kept");
    client.events.push(
      message({
        id: "history-command",
        senderId: owner.id,
        text: "!purge 4",
        conversationId: chatId,
        sequenceId: "seq-cmd",
        createdAt: stamp(40),
      }),
      message({
        id: "own-1",
        senderId: "bot-1",
        text: "bot",
        conversationId: chatId,
        sequenceId: "seq-1",
        createdAt: stamp(30),
      }),
      message({
        id: "member-kept",
        senderId: bob.id,
        text: "nope",
        conversationId: chatId,
        sequenceId: "seq-2",
        createdAt: stamp(20),
      }),
      message({
        id: "member-ok",
        senderId: alice.id,
        text: "yes",
        conversationId: chatId,
        sequenceId: "seq-3",
        createdAt: stamp(10),
      }),
      message({
        id: "no-seq",
        senderId: alice.id,
        text: "missing sequence",
        conversationId: chatId,
        createdAt: stamp(0),
      }),
    );

    await engine.processEvent(
      message({
        id: "live-cmd",
        senderId: owner.id,
        text: "!purge 4",
        conversationId: chatId,
        sequenceId: "seq-cmd",
      }),
    );
    expect(client.deleted).toEqual(["own-1", "member-ok"]);
    expect(client.sent.at(-1)?.text).toMatch(/Deleted 2 of 4\./);
    expect(client.sent.at(-1)?.text).toMatch(/delete-for-all/);
    expect(client.sent.at(-1)?.text).toMatch(/group admin/);
    expect(client.sent.at(-1)?.text).not.toMatch(/own events/);
  });

  it("caps !purge at 100 and does not read another page once that many are selected", async () => {
    const { engine, client } = setup();
    const pageOne = [
      message({
        id: "purge-cap",
        senderId: owner.id,
        text: "!purge 500",
        createdAt: "2024-06-01T00:00:00.000Z",
      }),
    ];
    for (let i = 0; i < 100; i += 1) {
      pageOne.push(
        message({
          id: `bot-page-${i}`,
          senderId: "bot-1",
          text: `m${i}`,
          createdAt: new Date(Date.UTC(2024, 5, 2) + i * 1000).toISOString(),
        }),
      );
    }
    let calls = 0;
    client.listConversationDmEvents = async (params) => {
      calls += 1;
      expect(params.maxResults).toBe(100);
      expect(params.conversationId).toBe(groupId);
      if (calls === 1) return { events: pageOne, nextToken: "more" };
      throw new Error("purge read past the cap");
    };

    await engine.processEvent(
      message({ id: "purge-cap", senderId: owner.id, text: "!purge 500" }),
    );
    expect(calls).toBe(1);
    expect(client.deleted).toHaveLength(100);
    expect(client.deleted[0]).toBe("bot-page-99");
    expect(client.deleted).not.toContain("purge-cap");
    expect(client.sent.at(-1)?.text).toMatch(/Capped at 100\. Deleted 100 of 100\./);
  });

  it("deletes nothing when history cannot be loaded", async () => {
    const { engine, client } = setup();
    client.listConversationDmEvents = async () => {
      throw new Error("history down");
    };
    await engine.processEvent(message({ id: "purge-err", senderId: owner.id, text: "!purge 25" }));
    expect(client.deleted).toEqual([]);
    expect(client.sent.at(-1)?.text).toMatch(/nothing was deleted/);
  });

  it("tells an admin how to use !purge", async () => {
    const { engine, client } = setup();
    await engine.processEvent(message({ id: "purge-usage", senderId: owner.id, text: "!purge" }));
    await engine.processEvent(message({ id: "purge-bad", senderId: owner.id, text: "!purge nope" }));
    expect(client.sent[0]?.text).toMatch(/Usage: !purge <n>/);
    expect(client.sent[1]?.text).toMatch(/hard cap 100/);
    expect(client.sent[1]?.text).toMatch(/how many of the last messages to delete/);
    expect(client.deleted).toEqual([]);
    expect(client.conversationListCalls).toHaveLength(0);
  });

  it("keeps !purge off public help", () => {
    const loaded = loadDefaults("config/default.yaml");
    expect(loaded.help).not.toMatch(/!purge/);
    expect(loaded.admin_help).toMatch(/!purge <n>/);
    expect(loaded.admin_help).toMatch(/hard cap 100/);
    expect(loaded.admin_help).toMatch(/the last n messages/);
    expect(loaded.admin_help).toMatch(/not a fixed size/);
    expect(loaded.admin_help).toMatch(/this account's events only/);
  });

  it("detects flood, attempts delete, and soft-mutes", async () => {
    const { engine, client, store } = setup();
    const now = 1_000_000;
    await engine.processEvent(message({ id: "f1", senderId: bob.id, text: "a" }), now);
    await engine.processEvent(message({ id: "f2", senderId: bob.id, text: "b" }), now + 1);
    await engine.processEvent(message({ id: "f3", senderId: bob.id, text: "c" }), now + 2);
    const result = await engine.processEvent(
      message({ id: "f4", senderId: bob.id, text: "d" }),
      now + 3,
    );
    expect(result.muted).toBe(true);
    expect(store.isMuted(groupId, bob.id, now + 4)).toBe(true);
    expect(client.sent.some((row) => /flooding/i.test(row.text))).toBe(true);
    expect(floodEventCount(store)).toBe(4);
  });

  it("does not mute when flood max_messages is 0", async () => {
    const { engine, client, store } = setup({ max_messages: 0 });
    const now = 1_000_000;
    for (let i = 0; i < 6; i++) {
      const result = await engine.processEvent(
        message({ id: `off-${i}`, senderId: bob.id, text: `m${i}` }),
        now + i,
      );
      expect(result.muted).toBe(false);
    }
    expect(store.isMuted(groupId, bob.id, now + 10)).toBe(false);
    expect(store.getWarnCount(groupId, bob.id)).toBe(0);
    expect(client.sent.some((row) => /flooding/i.test(row.text))).toBe(false);
    expect(floodEventCount(store)).toBe(0);
  });

  it("does not mute when flood window_ms is 0 or max_messages is negative", async () => {
    const now = 1_000_000;
    for (const flood of [{ window_ms: 0 }, { max_messages: -1 }] as const) {
      const { engine, client, store } = setup(flood);
      for (let i = 0; i < 6; i++) {
        const result = await engine.processEvent(
          message({ id: `skip-${flood.window_ms ?? "max"}-${i}`, senderId: bob.id, text: `m${i}` }),
          now + i,
        );
        expect(result.muted).toBe(false);
      }
      expect(store.isMuted(groupId, bob.id, now + 10)).toBe(false);
      expect(store.getWarnCount(groupId, bob.id)).toBe(0);
      expect(client.sent.some((row) => /flooding/i.test(row.text))).toBe(false);
      expect(floodEventCount(store)).toBe(0);
    }
  });

  it.each([
    { key: "flood_max_messages", value: "0" },
    { key: "flood_max_messages", value: "-1" },
    { key: "flood_window_ms", value: "0" },
  ])("!set $key $value disables flood for that conversation", async ({ key, value }) => {
    const { engine, client, store } = setup();
    const now = 2_000_000;
    await engine.processEvent(
      message({ id: `set-${key}-${value}`, senderId: owner.id, text: `!set ${key} ${value}` }),
      now,
    );
    for (let i = 0; i < 6; i++) {
      const result = await engine.processEvent(
        message({ id: `set-off-${key}-${value}-${i}`, senderId: bob.id, text: `m${i}` }),
        now + 1 + i,
      );
      expect(result.muted).toBe(false);
    }
    expect(store.isMuted(groupId, bob.id, now + 20)).toBe(false);
    expect(store.getWarnCount(groupId, bob.id)).toBe(0);
    expect(client.sent.some((row) => /flooding/i.test(row.text))).toBe(false);
    expect(floodEventCount(store)).toBe(0);
  });

  it("says that 0 disables flood in !settings", async () => {
    const enabled = setup();
    await enabled.engine.processEvent(
      message({ id: "settings-on", senderId: owner.id, text: "!settings" }),
    );
    expect(enabled.client.sent.at(-1)?.text).toMatch(/flood: 3 msgs \/ 10000ms, mute 60000ms \(0 disables flood\)/);

    const disabled = setup({ max_messages: 0 });
    await disabled.engine.processEvent(
      message({ id: "settings-off", senderId: owner.id, text: "!settings" }),
    );
    expect(disabled.client.sent.at(-1)?.text).toMatch(
      /flood: off \(max_messages 0, window_ms 10000; 0 disables flood\)/,
    );
  });

  it("still filters and warns when flood is disabled", async () => {
    const { engine, store } = setup({ max_messages: 0 });
    await engine.processEvent(
      message({ id: "spam-off", senderId: bob.id, text: "buy spamlink now" }),
    );
    expect(store.getWarnCount(groupId, bob.id)).toBe(1);
    expect(store.isMuted(groupId, bob.id)).toBe(false);
  });

  it("filters keyword messages and warns", async () => {
    const { engine, store } = setup();
    await engine.processEvent(
      message({ id: "spam-1", senderId: bob.id, text: "buy spamlink now" }),
    );
    expect(store.getWarnCount(groupId, bob.id)).toBe(1);
  });

  it("ignores one-to-one conversations", async () => {
    const { engine, client } = setup();
    await engine.processEvent({
      id: "dm-1",
      eventType: "ParticipantsJoin",
      conversationId: "111-222",
      participantIds: [alice.id],
      participants: [alice],
      mentions: [],
    });
    expect(client.sent).toHaveLength(0);
  });

  it("skips the bot's own messages", async () => {
    const { engine, client } = setup();
    await engine.processEvent(
      message({ id: "bot-msg", senderId: "bot-1", text: "!rules" }),
    );
    expect(client.sent).toHaveLength(0);
  });
});

describe("leave announcement text", () => {
  it("uses the @handle, the display name, or someone", () => {
    expect(leaveAnnouncementText(alice)).toBe("@alice has left");
    expect(leaveAnnouncementText({ id: "9", name: "Nine" }, "{name} has left")).toBe(
      "Nine has left",
    );
    expect(leaveAnnouncementText({ id: "9", name: "Nine" })).toBe("Nine has left");
    expect(leaveAnnouncementText({ id: "1712950172873809920" })).toBe("someone has left");
    expect(leaveAnnouncementText({ id: "1712950172873809920" })).not.toContain("1712950172873809920");
  });

  it("loads leave announcements on by default", () => {
    const loaded = loadDefaults("config/default.yaml");
    expect(loaded.leave?.enabled).toBe(true);
    expect(loaded.leave?.text).toBe("@{username} has left");
  });

  it("loads flood off by default and documents that 0 disables it", () => {
    const loaded = loadDefaults("config/default.yaml");
    expect(loaded.flood.max_messages).toBe(0);
    expect(loaded.flood.window_ms).toBe(8000);
    expect(loaded.flood.mute_ms).toBe(300_000);
    expect(loaded.help).not.toMatch(/flood_max_messages 0/);
    expect(loaded.admin_help).toMatch(/flood_max_messages 0 \(or negative\) disables flood/);
    expect(loaded.admin_help).toMatch(/flood_window_ms 0 does too/);
  });
});

describe("collectNewEvents", () => {
  it("returns oldest-first events newer than the watermark", () => {
    const events: DmEvent[] = ["3", "2", "1"].map((id) => ({
      id,
      eventType: "MessageCreate",
      conversationId: groupId,
      participantIds: [],
      participants: [],
      mentions: [],
    }));
    expect(collectNewEvents(events, "1").map((event) => event.id)).toEqual(["2", "3"]);
    expect(collectNewEvents(events, "3")).toEqual([]);
  });
});
