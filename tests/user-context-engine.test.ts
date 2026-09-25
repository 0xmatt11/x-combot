import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { ModerationEngine } from "../src/bot/engine.js";
import { TIMELINE_NOT_FOUND } from "../src/bot/timeline.js";
import { WEB_SEARCH_UNAVAILABLE } from "../src/bot/web-search.js";
import { TROLL_COOLDOWN_MS } from "../src/bot/troll.js";
import { DEFAULT_LLM_CONFIG, loadDefaults } from "../src/config.js";
import { MockLlmClient } from "../src/llm/mock.js";
import { Store } from "../src/store.js";
import type { BotRuntimeConfig, DefaultsConfig, DmEvent, XUser } from "../src/types.js";
import { MockXClient } from "../src/x/mock-client.js";
import type { WebSearch } from "../src/bot/web-search.js";

const alice: XUser = { id: "u-alice", username: "alice", name: "Alice" };
const bob: XUser = { id: "u-bob", username: "bob", name: "Bob" };
const owner: XUser = { id: "u-owner", username: "owner", name: "Owner" };
const groupId = "1578398451921985538";

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
    context_mode: "none",
    none_recent_messages: 0,
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
  const sender = partial.sender ?? [alice, bob, owner].find((user) => user.id === partial.senderId);
  return {
    eventType: "MessageCreate",
    conversationId: groupId,
    participantIds: [],
    participants: [],
    mentions: [],
    sender,
    createdAt: "2026-01-01T00:00:01Z",
    ...partial,
  };
}

describe("user context in chat", () => {
  const stores: Store[] = [];

  afterEach(() => {
    for (const store of stores) store.close();
    stores.length = 0;
  });

  function setup(llm: MockLlmClient, options?: { webSearch?: WebSearch }) {
    const store = new Store(":memory:");
    stores.push(store);
    const client = new MockXClient();
    client.addUser(alice);
    client.addUser(bob);
    client.addUser(owner);
    let postReads = 0;
    const original = client.listRecentPosts.bind(client);
    client.listRecentPosts = async (userId: string) => {
      postReads += 1;
      return original(userId);
    };
    const engine = new ModerationEngine(store, client, runtime(), llm, {
      webSearch: options?.webSearch,
    });
    return {
      engine,
      client,
      llm,
      reads: () => postReads,
    };
  }

  it("puts a mentioned account's public posts on an !ask", async () => {
    const llm = new MockLlmClient("Bob names cars.");
    const { engine, client } = setup(llm);
    client.posts.set(bob.id, ["bought a car and named it Kevin"]);
    const result = await engine.processEvent(
      message({ id: "q1", senderId: alice.id, text: "!ask who is @bob" }),
    );
    expect(result.llm).toBe(true);
    expect(client.sent.at(-1)?.text).toBe("@alice Bob names cars.");
    const prompt = llm.calls[0]?.map((row) => row.content).join("\n") ?? "";
    expect(prompt).toContain("@bob recent public posts:");
    expect(prompt).toContain("bought a car and named it Kevin");
    expect(prompt).toContain("lookup_user_timeline");
    expect(prompt).not.toContain(bob.id);
  });

  it("reuses the timeline cache for a second ask and for a later roast", async () => {
    const llm = new MockLlmClient("@bob still naming cars.");
    const { engine, client, reads } = setup(llm);
    client.posts.set(bob.id, ["Kevin the car"]);
    await engine.processEvent(message({ id: "q1", senderId: alice.id, text: "!ask who is @bob" }));
    await engine.processEvent(message({ id: "q2", senderId: alice.id, text: "!ask who is @bob again" }));
    expect(reads()).toBe(1);
    await engine.processEvent(message({ id: "r1", senderId: alice.id, text: "!roast @bob" }));
    expect(reads()).toBe(1);
    const roast = llm.calls.at(-1)?.map((row) => row.content).join("\n") ?? "";
    expect(roast).toContain("Kevin the car");
  });

  it("tells the model when an outside handle has no public account", async () => {
    const llm = new MockLlmClient("I could not find them.");
    const { engine, client } = setup(llm);
    await engine.processEvent(
      message({
        id: "q1",
        senderId: alice.id,
        text: "!ask who is @naval",
        mentions: [{ username: "naval" }],
      }),
    );
    const prompt = llm.calls[0]?.map((row) => row.content).join("\n") ?? "";
    expect(prompt).toContain(TIMELINE_NOT_FOUND);
    expect(client.sent.at(-1)?.text).toBe("@alice I could not find them.");
  });

  it("loads the replied-to person for who is this", async () => {
    const llm = new MockLlmClient("That is Bob.");
    const { engine, client } = setup(llm);
    client.posts.set(bob.id, ["Kevin again"]);
    await engine.processEvent(
      message({
        id: "q1",
        senderId: alice.id,
        text: "@modbot who is this?",
        replyTo: { senderId: bob.id, verified: true },
      }),
    );
    const prompt = llm.calls[0]?.map((row) => row.content).join("\n") ?? "";
    expect(prompt).toContain("Kevin again");
    expect(prompt).toContain("@bob");
  });

  it("matches a display name already seen in the group", async () => {
    const llm = new MockLlmClient("Owner posts rarely.");
    const { engine, client } = setup(llm);
    client.posts.set(owner.id, ["shipping friday"]);
    await engine.processEvent(
      message({
        id: "q1",
        senderId: alice.id,
        text: "!ask who is Owner",
        participants: [owner],
      }),
    );
    const prompt = llm.calls[0]?.map((row) => row.content).join("\n") ?? "";
    expect(prompt).toContain("shipping friday");
  });

  it("calls web_search when the model asks and keeps a short failure", async () => {
    const llm = new MockLlmClient("Search says milady.");
    let used = false;
    llm.toolHandler = () => {
      if (used) return [];
      used = true;
      return [{ id: "s1", name: "web_search", arguments: '{"query":"milady maker"}' }];
    };
    const queries: string[] = [];
    const { engine, client } = setup(llm, {
      webSearch: {
        async search(query: string) {
          queries.push(query);
          return {
            query,
            results: [{ title: "Milady", url: "https://example.com/m", snippet: "a public note" }],
            fromCache: false,
          };
        },
      },
    });
    await engine.processEvent(message({ id: "q1", senderId: alice.id, text: "!ask what is milady" }));
    expect(queries).toEqual(["milady maker"]);
    expect(client.sent.at(-1)?.text).toBe("@alice Search says milady.");
    const followup = llm.calls[1]?.map((row) => row.content).join("\n") ?? "";
    expect(followup).toContain("https://example.com/m");

    const failed = new MockLlmClient("Search is down.");
    let failedOnce = false;
    failed.toolHandler = () => {
      if (failedOnce) return [];
      failedOnce = true;
      return [{ id: "s2", name: "web_search", arguments: '{"query":"milady"}' }];
    };
    const down = setup(failed, {
      webSearch: {
        async search() {
          return { query: "milady", results: [], error: WEB_SEARCH_UNAVAILABLE, fromCache: false };
        },
      },
    });
    await down.engine.processEvent(
      message({ id: "q2", senderId: alice.id, text: "!ask search milady" }),
    );
    const downPrompt = failed.calls[1]?.map((row) => row.content).join("\n") ?? "";
    expect(downPrompt).toContain(WEB_SEARCH_UNAVAILABLE);
  });

  it("runs parallel who-is parts and still posts one reply", async () => {
    const llm = new MockLlmClient(["alice side", "bob side", "both of them"]);
    const { engine, client } = setup(llm);
    await engine.processEvent(
      message({
        id: "q1",
        senderId: alice.id,
        text: "!ask who is @alice and who is @bob",
      }),
    );
    expect(llm.calls.length).toBeGreaterThanOrEqual(3);
    expect(client.sent.at(-1)?.text).toBe("@alice both of them");
  });

  it("adds the linked account's posts to a link roast and skips /i/web/status", async () => {
    const llm = new MockLlmClient("@alice that flyer energy again.");
    const { engine, client, reads } = setup(llm);
    client.posts.set(bob.id, ["come to my space"]);
    await engine.processEvent(message({ id: "on", senderId: alice.id, text: "!linkroast on" }));
    await engine.processEvent(
      message({
        id: "link",
        senderId: alice.id,
        text: "look https://x.com/bob/status/123",
      }),
    );
    const prompt = llm.calls[0]?.map((row) => row.content).join("\n") ?? "";
    expect(prompt).toContain("come to my space");
    expect(reads()).toBe(1);

    const quiet = new MockLlmClient("@alice still a flyer.");
    const second = setup(quiet);
    await second.engine.processEvent(message({ id: "on2", senderId: alice.id, text: "!linkroast on" }));
    await second.engine.processEvent(
      message({
        id: "web",
        senderId: alice.id,
        text: "https://twitter.com/i/web/status/55",
      }),
    );
    expect(second.reads()).toBe(0);
    expect(quiet.calls[0]?.map((row) => row.content).join("\n") ?? "").not.toContain(
      "Public posts from the linked account",
    );
  });

  it("shares one timeline read across two troll roasts inside the cache window", async () => {
    const llm = new MockLlmClient(["@bob first.", "@bob second."]);
    const { engine, client, reads } = setup(llm);
    client.posts.set(bob.id, ["Kevin"]);
    await engine.processEvent(message({ id: "on", senderId: alice.id, text: "!troll @bob" }));
    const start = 4_000_000;
    await engine.processEvent(message({ id: "b1", senderId: bob.id, text: "one" }), start);
    await engine.processEvent(
      message({ id: "b2", senderId: bob.id, text: "two" }),
      start + TROLL_COOLDOWN_MS,
    );
    await engine.processEvent(
      message({ id: "b3", senderId: bob.id, text: "three" }),
      start + TROLL_COOLDOWN_MS * 2,
    );
    await engine.processEvent(
      message({ id: "b4", senderId: bob.id, text: "four" }),
      start + TROLL_COOLDOWN_MS * 3,
    );
    expect(reads()).toBe(1);
    expect(llm.calls).toHaveLength(2);
  });

  it("documents timeline lookup, web search, and five workers in help and the readme", () => {
    const loaded = loadDefaults("config/default.yaml");
    expect(loaded.help).toMatch(/Timeline/);
    expect(loaded.help).toMatch(/outside handle/);
    expect(loaded.help).toMatch(/Web search/);
    expect(loaded.help).toMatch(/5 in-bot workers/);
    const readme = fs.readFileSync("README.md", "utf8");
    expect(readme).toContain("lookup_user_timeline");
    expect(readme).toContain("web_search");
    expect(readme).toMatch(/five in-process LLM workers|up to 5 in-bot workers|At most five workers/);
    expect(readme).toMatch(/not other Grok bots/i);
  });
});
