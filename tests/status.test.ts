import { afterEach, describe, expect, it } from "vitest";
import { ModerationEngine } from "../src/bot/engine.js";
import {
  formatStatusReport,
  readBuildVersion,
  RuntimeHealth,
  statusMediaCounts,
  type StatusSnapshot,
} from "../src/bot/status.js";
import { loadDefaults } from "../src/config.js";
import { ChatPoller } from "../src/chat/poller.js";
import type { ChatService } from "../src/chat/service.js";
import { Store } from "../src/store.js";
import type { BotRuntimeConfig, DefaultsConfig, DmEvent, XUser } from "../src/types.js";
import { MockXClient } from "../src/x/mock-client.js";

const alice: XUser = { id: "u-alice", username: "alice", name: "Alice" };
const bob: XUser = { id: "u-bob", username: "bob", name: "Bob" };
const owner: XUser = { id: "owner-1", username: "0xMatt66", name: "Matt" };
const globalAdmin: XUser = { id: "u-admin", username: "admin", name: "Admin" };
const convoAdmin: XUser = { id: "u-convo", username: "convo", name: "Convo" };
const groupId = "1578398451921985538";
const startedAtMs = 1_699_992_620_000;
const nowMs = 1_700_000_000_000;

const CHEST = "https://imagine-public.x.ai/imagine-public/images/8f99def9-25a9-4803-b281-873fd4564123.jpg";
const BOOTY = "https://imagine-public.x.ai/imagine-public/images/11111111-2222-4333-8444-555555555555.jpg";
const CLIP = "https://imagine-public.x.ai/imagine-public/videos/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.mp4";

const defaults: DefaultsConfig = {
  welcome: { enabled: true, text: "Welcome @{username}!" },
  rules: "Be nice.",
  help: "Type !status",
  flood: { max_messages: 5, window_ms: 10_000, mute_ms: 60_000, warn_on_flood: false },
  warns: { limit: 3, auto_mute_ms: 60_000, notify_admins: false },
  filters: [],
  poll: { interval_ms: 1000, max_results: 50 },
  delete: { attempt_on_filter: false, attempt_on_flood: false, attempt_on_mute: false },
};

function runtime(): BotRuntimeConfig {
  return {
    botUserId: "12345",
    botUsername: "milady",
    ownerId: "owner-1",
    globalAdminIds: [],
    defaults,
  };
}

function message(partial: Partial<DmEvent> & Pick<DmEvent, "id" | "text">): DmEvent {
  return {
    eventType: "MessageCreate",
    conversationId: groupId,
    senderId: alice.id,
    sender: alice,
    participantIds: [],
    participants: [],
    mentions: [],
    ...partial,
  };
}

function snapshot(overrides: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return {
    username: "milady",
    userId: "12345",
    startedAtMs,
    nowMs,
    pipeline: {
      chat: { phase: "degraded", detail: "backoff 45s" },
      activity: { phase: "ok", detail: "stream" },
    },
    keys: { cachedUsers: 3, signingKeys: 8, conversationKeys: 1, backoffMs: 45_000 },
    llm: "grok grok-4.6",
    imagine: "api, video",
    welcome: true,
    troll: "@bob",
    linkroast: false,
    media: { chest: 1, booty: 1, videos: 1 },
    version: "1.2.3",
    sha: "abc1234",
    ...overrides,
  };
}

describe("formatStatusReport", () => {
  it("shows public_keys backoff without secrets", () => {
    const text = formatStatusReport(snapshot());
    expect(text).toBe(
      [
        "Bot: @milady",
        "Up: 2h 3m",
        "Chat: degraded (backoff 45s)",
        "Activity: ok (stream)",
        "Keys: BACKOFF 45s — GET /2/users/…/public_keys rate-limited. 3 users cached, 8 signing keys, 1 chat key. Decrypt stalls until this clears.",
        "LLM: grok grok-4.6",
        "Imagine: api, video",
        "This chat: welcome on · troll @bob · linkroast off",
        "Media: chest 1 · booty 1 · video 1",
        "Version: 1.2.3 abc1234",
      ].join("\n"),
    );
    expect(text.split("\n")).toHaveLength(10);
    expect(text).not.toMatch(/bearer|api[_-]?key|sk-|token|secret/i);
  });

  it("says when signing keys are cached and when Chat is not loaded", () => {
    const healthy = formatStatusReport(
      snapshot({
        pipeline: undefined,
        keys: { cachedUsers: 2, signingKeys: 2, conversationKeys: 0, backoffMs: 0 },
        llm: "off",
        imagine: "off",
        welcome: false,
        troll: "off",
        linkroast: true,
        media: undefined,
        version: undefined,
        sha: "deadbee",
      }),
    );
    expect(healthy).toContain("Chat: n/a");
    expect(healthy).toContain("Activity: n/a");
    expect(healthy).toContain("Keys: ok — 2 users cached, 2 signing keys, 0 chat keys");
    expect(healthy).toContain("LLM: off");
    expect(healthy).toContain("Imagine: off");
    expect(healthy).toContain("This chat: welcome off · troll off · linkroast on");
    expect(healthy).not.toContain("Media:");
    expect(healthy).toContain("Version: deadbee");
    expect(healthy.split("\n").length).toBeLessThanOrEqual(15);

    const empty = formatStatusReport(
      snapshot({
        keys: { cachedUsers: 0, signingKeys: 0, conversationKeys: 0, backoffMs: 0 },
        media: undefined,
      }),
    );
    expect(empty).toContain("Keys: no signing keys cached (0 users cached, 0 signing keys, 0 chat keys)");

    const unloaded = formatStatusReport(snapshot({ keys: undefined, username: undefined, userId: "12345" }));
    expect(unloaded).toContain("Bot: 12345");
    expect(unloaded).toContain("Keys: n/a (Chat not loaded)");
  });

  it("keeps a multiline pipeline detail on one line and hides numeric troll ids", () => {
    const health = new RuntimeHealth();
    health.noteChat("degraded", "backoff 12s\nextra");
    const text = formatStatusReport(
      snapshot({
        pipeline: health.view(),
        troll: "on",
        media: undefined,
        version: undefined,
        sha: undefined,
      }),
    );
    expect(text).toContain("Chat: degraded (backoff 12s extra)");
    expect(text).toContain("troll on");
    expect(text.split("\n").length).toBeLessThanOrEqual(15);
    expect(text).not.toContain("\nextra");
  });

  it("names the Imagine backend when that field is set", () => {
    expect(formatStatusReport(snapshot({ imagine: "browser" }))).toContain("Imagine: browser");
    expect(formatStatusReport(snapshot({ imagine: "api off", media: undefined }))).toContain("Imagine: api off");
    const browser = formatStatusReport(snapshot({ imagine: "browser" }));
    expect(browser).not.toContain("Imagine: api");
  });

  it("counts media banks already in memory", () => {
    expect(
      statusMediaCounts({
        chestUrl: CHEST,
        bootyUrls: [BOOTY],
        boobsVideoUrls: [CLIP],
      }),
    ).toEqual({ chest: 1, booty: 1, videos: 1 });
    expect(statusMediaCounts(undefined)).toBeUndefined();
  });
});

describe("RuntimeHealth", () => {
  it("reports activity degraded when the stream is backing off", () => {
    const health = new RuntimeHealth();
    expect(health.view()).toEqual({
      chat: { phase: "off" },
      activity: { phase: "off" },
    });
    health.markChatRunning();
    health.markActivityEnabled();
    expect(health.view().chat.phase).toBe("starting");
    expect(health.view().activity.phase).toBe("starting");
    health.noteActivityWebhook("ok", "webhook");
    health.noteActivityStream("degraded", "retry 12s");
    const activity = health.view().activity;
    expect(activity.phase).toBe("degraded");
    expect(activity.detail).toContain("stream retry 12s");
    expect(activity.detail).toContain("webhook");
    health.noteChat("ok");
    health.noteActivityStream("ok", "stream");
    expect(health.view().chat.phase).toBe("ok");
    expect(health.view().activity.phase).toBe("ok");
  });
});

describe("!status command", () => {
  const stores: Store[] = [];

  afterEach(() => {
    for (const store of stores) store.close();
    stores.length = 0;
  });

  it("replies with mocked health and does not call Imagine", async () => {
    const store = new Store(":memory:");
    stores.push(store);
    store.setTrollTarget(groupId, bob.id, "bob");
    store.setLinkroastEnabled(groupId, true);
    const health = new RuntimeHealth();
    health.noteChat("degraded", "backoff 45s");
    health.markActivityEnabled();
    health.noteActivityStream("ok", "stream");
    const now = health.startedAtMs + 7_380_000;
    let keyReads = 0;
    let imagined = 0;
    const client = new MockXClient({ id: "12345", username: "milady" });
    client.addUser(alice);
    const engine = new ModerationEngine(store, client, runtime(), undefined, {
      health,
      publicKeys: {
        publicKeyHealth(at) {
          keyReads += 1;
          expect(at).toBe(now);
          return { cachedUsers: 3, signingKeys: 8, conversationKeys: 1, backoffMs: 45_000 };
        },
      },
      llmMode: "grok grok-4.6",
      imagineBackend: "browser",
      buildVersion: { version: "1.2.3", sha: "abc1234" },
      imagine: {
        async generate() {
          imagined += 1;
          throw new Error("status must not generate");
        },
      },
      video: {
        async generate() {
          imagined += 1;
          throw new Error("status must not generate");
        },
      },
      imaginePublic: { chestUrl: CHEST, bootyUrls: [BOOTY], boobsVideoUrls: [CLIP] },
    });

    await engine.processEvent(
      message({ id: "s1", senderId: owner.id, sender: owner, text: "!STATUS please" }),
      now,
    );
    await engine.processEvent(
      message({ id: "s2", senderId: owner.id, sender: owner, text: "/status" }),
      now,
    );
    expect(keyReads).toBe(2);
    expect(imagined).toBe(0);
    expect(client.sent).toHaveLength(2);
    expect(client.sent[0]?.text).toBe(client.sent[1]?.text);
    const text = client.sent[0]?.text ?? "";
    expect(text).toContain("Bot: @milady");
    expect(text).toContain("Up: 2h 3m");
    expect(text).toContain("Chat: degraded (backoff 45s)");
    expect(text).toContain("Activity: ok (stream)");
    expect(text).toContain("Keys: BACKOFF 45s — GET /2/users/…/public_keys rate-limited.");
    expect(text).toContain("3 users cached, 8 signing keys, 1 chat key");
    expect(text).toContain("Decrypt stalls until this clears.");
    expect(text).toContain("LLM: grok grok-4.6");
    expect(text).toContain("Imagine: browser");
    expect(text).not.toContain("Imagine: api");
    expect(text).toContain("This chat: welcome on · troll @bob · linkroast on");
    expect(text).toContain("Media: chest 1 · booty 1 · video 1");
    expect(text).toContain("Version: 1.2.3 abc1234");
    expect(text.split("\n").length).toBeLessThanOrEqual(15);
    expect(text).not.toMatch(/bearer|api[_-]?key|sk-|secret/i);
  });

  it("reports api off when the API backend has no client", async () => {
    const store = new Store(":memory:");
    stores.push(store);
    const client = new MockXClient();
    client.addUser(alice);
    const health = new RuntimeHealth();
    const engine = new ModerationEngine(store, client, runtime(), undefined, {
      health,
      imagineBackend: "api",
      buildVersion: { version: "1.2.3" },
    });
    await engine.processEvent(
      message({ id: "api-off", senderId: owner.id, sender: owner, text: "!status" }),
      health.startedAtMs,
    );
    expect(client.sent.at(-1)?.text).toContain("Imagine: api off");
  });

  it("records Chat poll backoff on the health object the command reads", async () => {
    const store = new Store(":memory:");
    stores.push(store);
    const health = new RuntimeHealth();
    health.markChatRunning();
    const client = new MockXClient();
    client.addUser(alice);
    const engine = new ModerationEngine(store, client, runtime(), undefined, {
      health,
      buildVersion: { version: "1.2.3" },
    });
    let pulls = 0;
    const chat = {
      async pullNew() {
        pulls += 1;
        throw Object.assign(new Error("rate limit"), { status: 429, retryAfterMs: 30_000 });
      },
    };
    const poller = new ChatPoller(chat as unknown as ChatService, store, engine, 1_000, ["g1"], 10, 1_000, {
      onPipeline: (state, detail) => health.noteChat(state, detail),
    });
    await poller.tick();
    poller.stop();
    expect(pulls).toBe(1);
    expect(health.view().chat).toEqual({ phase: "degraded", detail: "backoff 30s" });

    await engine.processEvent(
      message({ id: "s4", senderId: owner.id, sender: owner, text: "!status" }),
      health.startedAtMs,
    );
    expect(client.sent.at(-1)?.text).toContain("Chat: degraded (backoff 30s)");
    expect(client.sent.at(-1)?.text).toContain("Keys: n/a (Chat not loaded)");
    expect(pulls).toBe(1);
  });

  it("ignores !status from everyone except BOT_OWNER_ID", async () => {
    const store = new Store(":memory:");
    stores.push(store);
    store.addConversationAdmin(groupId, convoAdmin.id);
    const client = new MockXClient();
    client.addUser(alice);
    client.addUser(globalAdmin);
    client.addUser(convoAdmin);
    client.addUser(owner);
    const engine = new ModerationEngine(store, client, {
      ...runtime(),
      globalAdminIds: [globalAdmin.id],
    });

    await engine.processEvent(message({ id: "stranger", text: "!status" }), nowMs);
    await engine.processEvent(
      message({ id: "gadmin", senderId: globalAdmin.id, sender: globalAdmin, text: "!STATUS please" }),
      nowMs,
    );
    await engine.processEvent(
      message({ id: "cadmin", senderId: convoAdmin.id, sender: convoAdmin, text: "/status" }),
      nowMs,
    );
    expect(client.sent).toEqual([]);

    await engine.processEvent(
      message({ id: "owner", senderId: owner.id, sender: owner, text: "!status" }),
      nowMs,
    );
    expect(client.sent).toHaveLength(1);
    expect(client.sent[0]?.text).toContain("Bot:");
    expect(client.sent[0]?.text).toContain("@0xMatt66");
  });

  it("lists !status as owner-only in the default !help reply", async () => {
    const loaded = loadDefaults("config/default.yaml");
    expect(loaded.help).toMatch(/!status — owner only \(BOT_OWNER_ID\)/);
    expect(loaded.help).toMatch(/same gate as !auth/);
    expect(loaded.help).toMatch(/ADMIN_IDS and per-group admins are ignored/);
    expect(loaded.help).toMatch(/public_keys/);
    expect(loaded.help).toMatch(/browser or api/);
    expect(loaded.help).toMatch(/!linkroast/);
    const store = new Store(":memory:");
    stores.push(store);
    const client = new MockXClient();
    client.addUser(alice);
    const engine = new ModerationEngine(store, client, { ...runtime(), defaults: loaded });
    await engine.processEvent(message({ id: "help", text: "!HELP" }), nowMs);
    expect(client.sent.at(-1)?.text).toMatch(/!status — owner only \(BOT_OWNER_ID\)/);
    expect(client.sent.at(-1)?.text).toMatch(/public_keys backoff/);
    expect(client.sent.at(-1)?.text).toMatch(/browser or api/);
    expect(client.sent.at(-1)?.text).toMatch(/grok.com\/imagine/);
  });
});

describe("readBuildVersion", () => {
  it("reads the package version and does not throw when git metadata is odd", () => {
    const build = readBuildVersion();
    expect(build.version).toBe("1.0.0");
    if (build.sha) expect(build.sha).toMatch(/^[0-9a-f]{7}$/);
  });
});
