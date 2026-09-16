import { afterEach, describe, expect, it } from "vitest";
import { ModerationEngine } from "../src/bot/engine.js";
import { DEFAULT_LLM_CONFIG } from "../src/config.js";
import { MockLlmClient } from "../src/llm/mock.js";
import { Store } from "../src/store.js";
import type { BotRuntimeConfig, DefaultsConfig, DmEvent, XUser } from "../src/types.js";
import { MockXClient } from "../src/x/mock-client.js";

const alice: XUser = { id: "u-alice", username: "alice", name: "Alice" };
const owner: XUser = { id: "u-owner", username: "owner", name: "Owner" };
const groupId = "1578398451921985538";

const defaults: DefaultsConfig = {
  welcome: { enabled: true, text: "Welcome @{username}!" },
  rules: "Be nice.",
  help: "Type !rules",
  flood: { max_messages: 8, window_ms: 10_000, mute_ms: 60_000, warn_on_flood: true },
  warns: { limit: 2, auto_mute_ms: 60_000, notify_admins: true },
  filters: [],
  poll: { interval_ms: 1000, max_results: 50 },
  delete: { attempt_on_filter: true, attempt_on_flood: true, attempt_on_mute: true },
  llm: {
    ...DEFAULT_LLM_CONFIG,
    enabled: true,
    allow: "everyone",
    context_mode: "recent",
    recent_messages: 2,
    none_recent_messages: 1,
    rate_limit_per_user: 8,
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

function message(partial: Partial<DmEvent> & Pick<DmEvent, "id" | "senderId" | "text">): DmEvent {
  const sender =
    partial.sender ?? [alice, owner].find((user) => user.id === partial.senderId);
  return {
    eventType: "MessageCreate",
    conversationId: groupId,
    participantIds: [],
    participants: [],
    mentions: [],
    sender,
    createdAt: partial.createdAt ?? `2026-01-01T00:00:0${partial.id?.replace(/\D/g, "") ?? "0"}Z`,
    ...partial,
  };
}

describe("LLM engine", () => {
  const stores: Store[] = [];

  afterEach(() => {
    for (const store of stores) store.close();
    stores.length = 0;
  });

  function setup(llm: MockLlmClient, extra?: Partial<DefaultsConfig["llm"]>) {
    const store = new Store(":memory:");
    stores.push(store);
    const client = new MockXClient();
    client.addUser(alice);
    client.addUser(owner);
    const engine = new ModerationEngine(
      store,
      client,
      {
        ...runtime(),
        defaults: { ...defaults, llm: { ...defaults.llm!, ...extra } },
      },
      llm,
    );
    return { engine, client, store, llm };
  }

  it("replies to !ask with mock LLM and recent context", async () => {
    const llm = new MockLlmClient("standup is at 10");
    const { engine, client } = setup(llm);
    client.events.push(
      message({ id: "h2", senderId: owner.id, text: "lets meet at 10", createdAt: "2026-01-01T00:00:02Z" }),
      message({ id: "h1", senderId: alice.id, text: "when is standup?", createdAt: "2026-01-01T00:00:01Z" }),
    );
    const result = await engine.processEvent(
      message({ id: "q1", senderId: alice.id, text: "!ask when is standup?" }),
    );
    expect(result.llm).toBe(true);
    expect(client.sent.at(-1)?.text).toBe("standup is at 10");
    expect(client.conversationListCalls[0]?.conversationId).toBe(groupId);
    const userContent = llm.calls[0]?.[1]?.content ?? "";
    expect(userContent).toContain("when is standup?");
    expect(userContent).toContain("lets meet at 10");
    expect(userContent).toContain("mode=recent");
  });

  it("treats @botname as a wake prefix", async () => {
    const llm = new MockLlmClient("hi alice");
    const { engine, client } = setup(llm);
    await engine.processEvent(
      message({ id: "q2", senderId: alice.id, text: "@modbot hello" }),
    );
    expect(client.sent.at(-1)?.text).toBe("hi alice");
    expect(llm.calls).toHaveLength(1);
  });

  it("summarize loads full history via the conversation events endpoint", async () => {
    const llm = new MockLlmClient("thread summary");
    const { engine, client } = setup(llm, { full_max_messages: 50 });
    client.events.push(
      message({ id: "h3", senderId: owner.id, text: "ship friday", createdAt: "2026-01-01T00:00:03Z" }),
      message({ id: "h2", senderId: alice.id, text: "status?", createdAt: "2026-01-01T00:00:02Z" }),
      message({ id: "h1", senderId: owner.id, text: "kicking off", createdAt: "2026-01-01T00:00:01Z" }),
    );
    await engine.processEvent(
      message({ id: "s1", senderId: alice.id, text: "!summarize" }),
    );
    expect(client.sent.at(-1)?.text).toBe("thread summary");
    const userContent = llm.calls[0]?.[1]?.content ?? "";
    expect(userContent).toMatch(/mode=full/);
    expect(userContent).toContain("ship friday");
    expect(userContent).toContain("kicking off");
    expect(client.conversationListCalls).toHaveLength(1);
  });

  it("rejects LLM commands when allow=admins", async () => {
    const llm = new MockLlmClient("secret");
    const { engine, client } = setup(llm, { allow: "admins" });
    await engine.processEvent(message({ id: "q3", senderId: alice.id, text: "!ask ping" }));
    expect(client.sent[0]?.text).toMatch(/limited to configured admins/);
    expect(llm.calls).toHaveLength(0);
  });

  it("rate-limits LLM requests per user", async () => {
    const llm = new MockLlmClient("ok");
    const { engine, client } = setup(llm, { rate_limit_per_user: 1, rate_limit_window_ms: 60_000 });
    await engine.processEvent(message({ id: "r1", senderId: alice.id, text: "!ask one" }), 1000);
    await engine.processEvent(message({ id: "r2", senderId: alice.id, text: "!ask two" }), 1001);
    expect(client.sent.at(-1)?.text).toMatch(/rate limit/i);
    expect(llm.calls).toHaveLength(1);
  });

  it("explains when the LLM client is missing", async () => {
    const store = new Store(":memory:");
    stores.push(store);
    const client = new MockXClient();
    const engine = new ModerationEngine(store, client, runtime());
    await engine.processEvent(message({ id: "q4", senderId: alice.id, text: "!ask hello" }));
    expect(client.sent[0]?.text).toMatch(/LLM_PROVIDER/);
  });
});
