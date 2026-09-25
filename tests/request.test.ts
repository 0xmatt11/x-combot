import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ModerationEngine } from "../src/bot/engine.js";
import {
  buildFeatureRequestPayload,
  defaultFeatureRequestPendingDir,
  fallbackFeatureFiling,
  parseFeatureRequestModel,
  parseFeatureRequestSafety,
  postFeatureRequestWebhook,
  readRequestReply,
  writeFeatureRequestFile,
  type FeatureRequestFetch,
  type FeatureRequestPayload,
} from "../src/bot/feature-request.js";
import { parseCommand, parseUnknownBang } from "../src/bot/parser.js";
import { loadDefaults } from "../src/config.js";
import { loadEnv } from "../src/env.js";
import { MockLlmClient } from "../src/llm/mock.js";
import { Store } from "../src/store.js";
import type { BotRuntimeConfig, DefaultsConfig, DmEvent, XUser } from "../src/types.js";
import { MockXClient } from "../src/x/mock-client.js";

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
};

function ask(question: string): string {
  return JSON.stringify({ action: "ask", question });
}

function finalize(fields: {
  summary: string;
  detail: string;
  mvp_scope: string;
  complexity_hint?: "simple" | "medium" | "large";
}): string {
  return JSON.stringify({ action: "finalize", complexity_hint: "simple", ...fields });
}

function safety(fields: {
  risk: "benign" | "suspicious" | "malicious" | "unknown";
  reasons: string[];
  categories?: string[];
}): string {
  return JSON.stringify({ categories: [], ...fields });
}

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function recordingFetch(calls: FetchCall[], status = 200): FeatureRequestFetch {
  return async (url, init) => {
    calls.push({ url, init });
    return new Response(status === 200 ? "ok" : "no", { status });
  };
}

function headersOf(init?: RequestInit): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>;
}

function bodyOf(init?: RequestInit): FeatureRequestPayload {
  return JSON.parse(String(init?.body)) as FeatureRequestPayload;
}

function message(partial: Partial<DmEvent> & Pick<DmEvent, "id" | "senderId" | "text">): DmEvent {
  const sender =
    partial.sender ?? [alice, bob, owner].find((user) => user.id === partial.senderId);
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

describe("parseCommand !request", () => {
  it("accepts the command and the alias", () => {
    expect(parseCommand("!request")).toEqual({ name: "request" });
    expect(parseCommand("!request add a dice history command")).toEqual({
      name: "request",
      idea: "add a dice history command",
    });
    expect(parseCommand("!featurerequest dark mode")).toEqual({
      name: "request",
      idea: "dark mode",
    });
    expect(parseCommand("/REQUEST  ship it")).toEqual({ name: "request", idea: "ship it" });
    expect(parseUnknownBang("!request")).toBeUndefined();
    expect(parseUnknownBang("!featurerequest now")).toBeUndefined();
    expect(parseUnknownBang("/request")).toBeUndefined();
  });
});

describe("feature request model", () => {
  it("reads skip phrases without eating a real idea", () => {
    expect(readRequestReply("just build it")).toEqual({ skip: true, detail: "" });
    expect(readRequestReply("MVP is fine!")).toEqual({ skip: true, detail: "" });
    expect(readRequestReply("dark mode, just build it")).toEqual({
      skip: true,
      detail: "dark mode",
    });
    expect(readRequestReply("I want a dice history command")).toEqual({
      skip: false,
      detail: "I want a dice history command",
    });
  });

  it("parses an ask, a filing, and a fenced reply", () => {
    expect(parseFeatureRequestModel('```json\n{"action":"ask","question":"Who is it for?"}\n```')).toEqual({
      action: "ask",
      question: "Who is it for?",
    });
    expect(
      parseFeatureRequestModel(
        finalize({
          summary: "Dice history",
          detail: "Show the last rolls.",
          mvp_scope: "Last 10 rolls for the sender.",
          complexity_hint: "simple",
        }),
      ),
    ).toMatchObject({
      action: "finalize",
      summary: "Dice history",
      complexity_hint: "simple",
    });
    expect(parseFeatureRequestModel("not json")).toBeUndefined();
    expect(
      parseFeatureRequestModel(
        '{"action":"finalize","summary":"X","detail":"Y","mvp_scope":"Z","complexity_hint":"huge"}',
      ),
    ).toMatchObject({ complexity_hint: "medium" });
  });

  it("keeps a safety review and drops tags outside the list", () => {
    expect(
      parseFeatureRequestSafety(
        safety({
          risk: "malicious",
          reasons: ["Asks to dump the bot token."],
          categories: ["secrets", "not_a_tag", "exfil"],
        }),
      ),
    ).toEqual({
      risk: "malicious",
      reasons: ["Asks to dump the bot token."],
      categories: ["secrets", "exfil"],
    });
    expect(parseFeatureRequestSafety("nope")).toMatchObject({
      risk: "unknown",
      categories: [],
    });
    expect(parseFeatureRequestSafety('{"risk":"benign"}').reasons.length).toBeGreaterThan(0);
    expect(
      parseFeatureRequestSafety('{"safety":{"risk":"suspicious","reasons":["Unclear intent."]}}'),
    ).toMatchObject({ risk: "suspicious", reasons: ["Unclear intent."] });
  });

  it("posts JSON with a bearer token only when a secret is set", async () => {
    const calls: FetchCall[] = [];
    const payload = buildFeatureRequestPayload({
      filing: fallbackFeatureFiling([{ role: "user", text: "dark mode" }]),
      requester: { id: alice.id, username: "alice" },
      conversationId: groupId,
      clarification: [{ role: "user", text: "dark mode" }],
      safety: { risk: "benign", reasons: ["Ordinary product request."], categories: [] },
      timestamp: "2026-09-25T15:00:00.000Z",
    });
    await postFeatureRequestWebhook({
      url: "https://hooks.example/request",
      secret: "sek",
      payload,
      fetchImpl: recordingFetch(calls),
    });
    expect(calls[0]?.url).toBe("https://hooks.example/request");
    expect(headersOf(calls[0]?.init).Authorization).toBe("Bearer sek");
    expect(headersOf(calls[0]?.init)["Content-Type"]).toBe("application/json");
    expect(bodyOf(calls[0]?.init)).toMatchObject({
      type: "feature_request",
      summary: "dark mode",
      safety: { risk: "benign", reasons: ["Ordinary product request."], categories: [] },
    });
    expect(JSON.stringify(bodyOf(calls[0]?.init))).not.toContain("sek");

    calls.length = 0;
    await postFeatureRequestWebhook({
      url: "https://hooks.example/request",
      payload,
      fetchImpl: recordingFetch(calls),
    });
    expect(headersOf(calls[0]?.init).Authorization).toBeUndefined();
    await expect(
      postFeatureRequestWebhook({
        url: "https://hooks.example/request",
        payload,
        fetchImpl: recordingFetch([], 500),
      }),
    ).rejects.toThrow(/HTTP 500/);
  });
});

describe("feature request files", () => {
  it("writes the webhook-shaped JSON under the pending folder", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "feature-requests-"));
    try {
      const payload = buildFeatureRequestPayload({
        filing: fallbackFeatureFiling([{ role: "user", text: "dark mode" }]),
        requester: { id: alice.id, username: "alice" },
        conversationId: groupId,
        clarification: [{ role: "user", text: "dark mode" }],
        safety: { risk: "suspicious", reasons: ["Unclear intent."], categories: ["secrets"] },
        timestamp: "2026-09-25T15:00:00.000Z",
      });
      const filePath = await writeFeatureRequestFile({ directory, payload, id: "req-1" });
      expect(filePath).toBe(path.join(directory, "req-1.json"));
      expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toMatchObject({
        type: "feature_request",
        summary: "dark mode",
        safety: { risk: "suspicious", reasons: ["Unclear intent."], categories: ["secrets"] },
      });
      expect(fs.readdirSync(directory).some((name) => name.endsWith(".tmp"))).toBe(false);
      expect(defaultFeatureRequestPendingDir("/var/bot/data/bot.sqlite")).toBe(
        path.join("/var/bot/data", "feature-requests", "pending"),
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("!request", () => {
  const stores: Store[] = [];
  const pendingDirs: string[] = [];

  afterEach(() => {
    for (const store of stores) store.close();
    stores.length = 0;
    for (const dir of pendingDirs) fs.rmSync(dir, { recursive: true, force: true });
    pendingDirs.length = 0;
  });

  function makePendingDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feature-requests-"));
    pendingDirs.push(dir);
    return dir;
  }

  function readPending(dir: string): FeatureRequestPayload[] {
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as FeatureRequestPayload);
  }

  function setup(options?: {
    replies?: string[];
    webhookUrl?: string;
    webhookSecret?: string;
    fetchImpl?: FeatureRequestFetch;
    timeoutMs?: number;
    help?: string;
    pendingDir?: string;
  }): {
    engine: ModerationEngine;
    client: MockXClient;
    store: Store;
    llm: MockLlmClient;
    pendingDir: string;
  } {
    const store = new Store(":memory:");
    stores.push(store);
    const client = new MockXClient();
    client.addUser(alice);
    client.addUser(bob);
    client.addUser(owner);
    const config: BotRuntimeConfig = {
      botUserId: "bot-1",
      ownerId: owner.id,
      globalAdminIds: [],
      defaults: options?.help ? { ...defaults, help: options.help } : defaults,
    };
    const llm = new MockLlmClient(options?.replies ?? [ask("Who is it for?")]);
    const dir = options?.pendingDir ?? makePendingDir();
    const engine = new ModerationEngine(store, client, config, llm, {
      featureRequest: {
        webhookUrl: options?.webhookUrl,
        webhookSecret: options?.webhookSecret,
        fetchImpl: options?.fetchImpl,
        timeoutMs: options?.timeoutMs,
        pendingDir: dir,
      },
    });
    return { engine, client, store, llm, pendingDir: dir };
  }

  it("asks what they want, then one clarifying question", async () => {
    const calls: FetchCall[] = [];
    const { engine, client, llm } = setup({
      replies: [ask("Should it reset daily?")],
      webhookUrl: "https://hooks.example/request",
      fetchImpl: recordingFetch(calls),
    });
    const opened = await engine.processEvent(
      message({
        id: "req-1",
        senderId: alice.id,
        text: "!request",
        sequenceId: "55",
        encodedEvent: "blob-req",
      }),
    );
    expect(llm.calls).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(opened.replies[0]).toMatch(/@alice What feature do you want/);
    expect(client.sent[0]).toMatchObject({
      replyToSequenceId: "55",
      replyToEvent: "blob-req",
    });

    const clarified = await engine.processEvent(
      message({
        id: "req-2",
        senderId: alice.id,
        text: "a command that shows dice history",
        sequenceId: "56",
        encodedEvent: "blob-2",
      }),
    );
    expect(llm.calls).toHaveLength(1);
    expect(clarified.replies[0]).toBe("@alice Should it reset daily?");
    expect(clarified.llm).toBe(true);
    expect(client.sent[1]).toMatchObject({ replyToSequenceId: "56" });
    expect(calls).toHaveLength(0);
  });

  it("stops after three questions even if the model wants another", async () => {
    const calls: FetchCall[] = [];
    const { engine, client, llm, pendingDir } = setup({
      replies: [
        ask("Who is it for?"),
        ask("Any example?"),
        ask("What is the constraint?"),
        ask("Still more?"),
        safety({ risk: "benign", reasons: ["A dice history command."] }),
      ],
      webhookUrl: "https://hooks.example/request",
      webhookSecret: "hook-secret",
      fetchImpl: recordingFetch(calls),
    });
    await engine.processEvent(
      message({ id: "b1", senderId: alice.id, text: "!request per-user dice history" }),
    );
    await engine.processEvent(message({ id: "b2", senderId: alice.id, text: "for regulars" }));
    await engine.processEvent(
      message({ id: "b3", senderId: alice.id, text: "show the last 10" }),
    );
    const filed = await engine.processEvent(
      message({ id: "b4", senderId: alice.id, text: "in this chat" }),
    );

    expect(llm.calls).toHaveLength(5);
    const lastPrompt = llm.calls[3]?.find((message) => message.role === "user")?.content ?? "";
    const safetyPrompt = llm.calls[4]?.find((message) => message.role === "user")?.content ?? "";
    expect(safetyPrompt).toContain("summary:");
    expect(lastPrompt).toContain("must_finalize: true");
    expect(lastPrompt).toContain("questions_asked: 3");
    const texts = client.sent.map((row) => row.text);
    expect(texts.filter((text) => text.includes("Who is it for?"))).toHaveLength(1);
    expect(texts.filter((text) => text.includes("Any example?"))).toHaveLength(1);
    expect(texts.filter((text) => text.includes("What is the constraint?"))).toHaveLength(1);
    expect(texts.join("\n")).not.toContain("Still more?");
    expect(filed.replies[0]).toMatch(/Filed: per-user dice history/);
    expect(filed.replies[0]).toMatch(/Sent that to Chief of Staff/);
    expect(calls).toHaveLength(1);
    expect(headersOf(calls[0]?.init).Authorization).toBe("Bearer hook-secret");
    const body = bodyOf(calls[0]?.init);
    expect(body.type).toBe("feature_request");
    expect(body.summary).toBe("per-user dice history");
    expect(body.safety).toEqual({
      risk: "benign",
      reasons: ["A dice history command."],
      categories: [],
    });
    expect(body.conversationId).toBe(groupId);
    expect(body.requester).toEqual({
      id: alice.id,
      username: "alice",
      displayName: "Alice",
    });
    expect(body.clarification.map((turn) => turn.role)).toEqual([
      "user",
      "bot",
      "user",
      "bot",
      "user",
      "bot",
      "user",
    ]);
    expect(JSON.stringify(body)).not.toContain("hook-secret");
    expect(client.direct).toEqual([]);
    expect(readPending(pendingDir)).toEqual([body]);
  });

  it("files a skipped Q&A to the webhook with the model summary", async () => {
    const calls: FetchCall[] = [];
    const { engine, client, llm } = setup({
      replies: [
        ask("Follow the phone, or a chat toggle?"),
        finalize({
          summary: "Dark mode toggle",
          detail: "A chat command that switches the bot's replies to a dark theme.",
          mvp_scope: "One command that toggles dark mode for the sender.",
          complexity_hint: "simple",
        }),
        safety({ risk: "benign", reasons: ["A display toggle."] }),
      ],
      webhookUrl: "https://hooks.example/request",
      webhookSecret: "hook-secret",
      fetchImpl: recordingFetch(calls),
    });
    await engine.processEvent(
      message({
        id: "f1",
        senderId: alice.id,
        text: "!featurerequest add a dark mode toggle",
        sequenceId: "9",
        encodedEvent: "blob-f",
      }),
    );
    const filed = await engine.processEvent(
      message({
        id: "f2",
        senderId: alice.id,
        text: "MVP is fine",
        sequenceId: "10",
        encodedEvent: "blob-f2",
      }),
    );

    expect(llm.calls).toHaveLength(3);
    expect(llm.calls[1]?.find((message) => message.role === "user")?.content).toContain(
      "must_finalize: true",
    );
    expect(llm.calls[2]?.map((message) => message.content).join("\n")).toContain("Chief of Staff");
    expect(filed.replies).toEqual([
      "@alice Filed: Dark mode toggle\nMVP: One command that toggles dark mode for the sender.\nSent that to Chief of Staff.",
    ]);
    expect(client.sent[1]).toMatchObject({ replyToSequenceId: "10", replyToEvent: "blob-f2" });
    expect(client.direct).toEqual([]);
    const body = bodyOf(calls[0]?.init);
    expect(body).toMatchObject({
      type: "feature_request",
      summary: "Dark mode toggle",
      detail: "A chat command that switches the bot's replies to a dark theme.",
      mvp_scope: "One command that toggles dark mode for the sender.",
      complexity_hint: "simple",
      requester: { id: alice.id, username: "alice", displayName: "Alice" },
      conversationId: groupId,
      safety: { risk: "benign", reasons: ["A display toggle."], categories: [] },
    });
    expect(body.clarification.map((turn) => turn.text)).toEqual([
      "add a dark mode toggle",
      "Follow the phone, or a chat toggle?",
      "MVP is fine",
    ]);
    expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(headersOf(calls[0]?.init).Authorization).toBe("Bearer hook-secret");
  });

  it("does not take another member's message or a different command as the answer", async () => {
    const calls: FetchCall[] = [];
    const { engine, client } = setup({
      replies: [
        ask("Who is it for?"),
        finalize({
          summary: "Dice history",
          detail: "Last rolls.",
          mvp_scope: "Last 10 rolls.",
        }),
        safety({ risk: "benign", reasons: ["Shows recent rolls."] }),
      ],
      webhookUrl: "https://hooks.example/request",
      fetchImpl: recordingFetch(calls),
    });
    await engine.processEvent(
      message({ id: "o1", senderId: alice.id, text: "!request dice history" }),
    );
    await engine.processEvent(message({ id: "o2", senderId: bob.id, text: "a totally different thing" }));
    await engine.processEvent(message({ id: "o3", senderId: alice.id, text: "!rules" }));
    expect(calls).toHaveLength(0);
    expect(client.sent.map((row) => row.text).join("\n")).toMatch(/Be nice/);
    await engine.processEvent(message({ id: "o4", senderId: alice.id, text: "just build it" }));
    expect(calls).toHaveLength(1);
    expect(bodyOf(calls[0]?.init).summary).toBe("Dice history");
    expect(bodyOf(calls[0]?.init).safety.risk).toBe("benign");
  });

  it("records locally and DMs the owner when the webhook is unset", async () => {
    const calls: FetchCall[] = [];
    const { engine, client, store, pendingDir } = setup({
      replies: [
        finalize({
          summary: "Pin a rules message",
          detail: "Keep the group rules at the top of the chat.",
          mvp_scope: "Repost !rules when asked to pin.",
          complexity_hint: "medium",
        }),
        safety({ risk: "benign", reasons: ["Reposts rules that are already public."] }),
      ],
      fetchImpl: recordingFetch(calls),
    });
    const filed = await engine.processEvent(
      message({ id: "m1", senderId: alice.id, text: "!request pin the rules message" }),
    );
    expect(calls).toHaveLength(0);
    expect(filed.replies[0]).toMatch(/Filed: Pin a rules message/);
    expect(filed.replies[0]).toMatch(/Sent that to Chief of Staff/);
    const pending = readPending(pendingDir);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.safety).toEqual({
      risk: "benign",
      reasons: ["Reposts rules that are already public."],
      categories: [],
    });
    expect(fs.readdirSync(pendingDir).some((name) => /^[0-9a-f-]{36}\.json$/.test(name))).toBe(true);
    expect(client.direct).toHaveLength(1);
    expect(client.direct[0]?.participantId).toBe(owner.id);
    expect(client.direct[0]?.text).toContain("Pin a rules message");
    expect(client.direct[0]?.text).toContain("@alice");
    expect(client.direct[0]?.text).toContain(groupId);
    expect(client.direct[0]?.text).toContain("Safety: benign");
    const stored = store.listFeatureRequests(groupId);
    expect(stored).toHaveLength(1);
    const storedPayload = JSON.parse(stored[0]!.payload) as FeatureRequestPayload;
    expect(storedPayload.type).toBe("feature_request");
    expect(storedPayload.safety).toEqual({
      risk: "benign",
      reasons: ["Reposts rules that are already public."],
      categories: [],
    });
  });

  it("falls back to a local record when the webhook rejects the POST", async () => {
    const { engine, client, pendingDir } = setup({
      replies: [
        finalize({
          summary: "Pin a rules message",
          detail: "Keep the rules visible.",
          mvp_scope: "Repost !rules.",
        }),
        safety({ risk: "benign", reasons: ["Reposts rules."] }),
      ],
      webhookUrl: "https://hooks.example/request",
      fetchImpl: recordingFetch([], 500),
    });
    const filed = await engine.processEvent(
      message({ id: "e1", senderId: alice.id, text: "!request pin the rules" }),
    );
    expect(filed.replies[0]).toMatch(/didn't accept it/);
    expect(filed.replies[0]).toMatch(/Saved for Chief of Staff/);
    expect(client.direct[0]?.participantId).toBe(owner.id);
    expect(client.direct[0]?.text).toContain("Pin a rules message");
    expect(client.direct[0]?.text).toContain("Safety: benign");
    expect(readPending(pendingDir)).toHaveLength(1);
    expect(readPending(pendingDir)[0]?.summary).toBe("Pin a rules message");
  });

  it("files an unanswered request when the silence window passes", async () => {
    const calls: FetchCall[] = [];
    const { engine, client, llm } = setup({
      replies: [
        ask("Who is it for?"),
        finalize({
          summary: "Dice history",
          detail: "Show recent rolls.",
          mvp_scope: "Last 10 rolls.",
          complexity_hint: "simple",
        }),
        safety({ risk: "benign", reasons: ["Shows recent rolls."] }),
      ],
      webhookUrl: "https://hooks.example/request",
      fetchImpl: recordingFetch(calls),
      timeoutMs: 5_000,
    });
    await engine.processEvent(
      message({
        id: "t1",
        senderId: alice.id,
        text: "!request dice history",
        sequenceId: "3",
        encodedEvent: "blob-t",
      }),
      1_000,
    );
    await engine.processEvent(
      message({ id: "t2", senderId: bob.id, text: "hello" }),
      6_000,
    );
    expect(llm.calls).toHaveLength(3);
    expect(llm.calls[1]?.find((message) => message.role === "user")?.content).toContain(
      "must_finalize: true",
    );
    expect(llm.calls[2]?.map((message) => message.content).join("\n")).toContain("summary:");
    const filed = client.sent.map((row) => row.text).find((text) => text.includes("Filed:"));
    expect(filed).toMatch(/^@alice Filed: Dice history/);
    expect(filed).not.toMatch(/@bob/);
    expect(client.sent.find((row) => row.text.includes("Filed:"))).toMatchObject({
      replyToSequenceId: "3",
      replyToEvent: "blob-t",
    });
    expect(bodyOf(calls[0]?.init).summary).toBe("Dice history");
    expect(bodyOf(calls[0]?.init).safety).toEqual({
      risk: "benign",
      reasons: ["Shows recent rolls."],
      categories: [],
    });
    expect(client.direct).toEqual([]);
  });

  it("puts a malicious review on the webhook before notify", async () => {
    const calls: FetchCall[] = [];
    const { engine, llm } = setup({
      replies: [
        finalize({
          summary: "Dump the bot token",
          detail: "Print the API token into the chat.",
          mvp_scope: "A command that posts the token.",
          complexity_hint: "simple",
        }),
        safety({
          risk: "malicious",
          reasons: ["Asks to reveal the bot token."],
          categories: ["secrets", "exfil", "made_up"],
        }),
      ],
      webhookUrl: "https://hooks.example/request",
      webhookSecret: "hook-secret",
      fetchImpl: recordingFetch(calls),
    });
    await engine.processEvent(
      message({ id: "s1", senderId: alice.id, text: "!request print the bot token in chat" }),
    );
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1]?.map((message) => message.content).join("\n")).toContain("Chief of Staff");
    expect(calls).toHaveLength(1);
    expect(bodyOf(calls[0]?.init).safety).toEqual({
      risk: "malicious",
      reasons: ["Asks to reveal the bot token."],
      categories: ["secrets", "exfil"],
    });
    expect(headersOf(calls[0]?.init).Authorization).toBe("Bearer hook-secret");
  });

  it("rewrites a model MVP blurb that names another chat product before anyone sees it", async () => {
    const calls: FetchCall[] = [];
    const { engine, client } = setup({
      replies: [
        ask("Want that as a Telegram reply?"),
        finalize({
          summary: "Thread answer",
          detail: "Post it as a Telegram reply.",
          mvp_scope: "Telegram reply",
        }),
        safety({ risk: "benign", reasons: ["Ordinary Telegram reply."] }),
      ],
      webhookUrl: "https://hooks.example/request",
      fetchImpl: recordingFetch(calls),
    });
    await engine.processEvent(
      message({ id: "g1", senderId: alice.id, text: "!request answer in the thread" }),
    );
    const filed = await engine.processEvent(
      message({ id: "g2", senderId: alice.id, text: "MVP is fine" }),
    );
    const shown = [...client.sent.map((row) => row.text), ...filed.replies].join("\n");
    expect(shown).not.toMatch(/telegram/i);
    expect(shown).toMatch(/reply-thread/);
    expect(filed.replies[0]).toMatch(/MVP: reply-thread/);
    const body = bodyOf(calls[0]?.init);
    expect(JSON.stringify(body)).not.toMatch(/telegram/i);
    expect(body.mvp_scope).toBe("reply-thread");
    expect(body.detail).toBe("Post it as a reply-thread.");
    expect(body.safety.reasons).toEqual(["Ordinary reply-thread."]);
    expect(client.direct).toEqual([]);
  });

  it("still notifies when the safety review is unusable and marks it unknown", async () => {
    const calls: FetchCall[] = [];
    const { engine } = setup({
      replies: [
        finalize({
          summary: "Dice history",
          detail: "Show recent rolls.",
          mvp_scope: "Last 10 rolls.",
        }),
        "not json",
      ],
      webhookUrl: "https://hooks.example/request",
      fetchImpl: recordingFetch(calls),
    });
    const filed = await engine.processEvent(
      message({ id: "u1", senderId: alice.id, text: "!request dice history" }),
    );
    expect(filed.replies[0]).toMatch(/Sent that to Chief of Staff/);
    expect(bodyOf(calls[0]?.init).safety.risk).toBe("unknown");
    expect(bodyOf(calls[0]?.init).safety.reasons.length).toBeGreaterThan(0);
    expect(bodyOf(calls[0]?.init).summary).toBe("Dice history");
  });

  it("files with unknown safety when no model is configured", async () => {
    const calls: FetchCall[] = [];
    const store = new Store(":memory:");
    stores.push(store);
    const client = new MockXClient();
    client.addUser(alice);
    client.addUser(owner);
    const dir = makePendingDir();
    const engine = new ModerationEngine(
      store,
      client,
      {
        botUserId: "bot-1",
        ownerId: owner.id,
        globalAdminIds: [],
        defaults,
      },
      undefined,
      {
        featureRequest: {
          webhookUrl: "https://hooks.example/request",
          fetchImpl: recordingFetch(calls),
          pendingDir: dir,
        },
      },
    );
    const filed = await engine.processEvent(
      message({ id: "n1", senderId: alice.id, text: "!request dice history, just build it" }),
    );
    expect(filed.replies[0]).toMatch(/Filed: dice history/);
    expect(filed.replies[0]).toMatch(/Sent that to Chief of Staff/);
    expect(bodyOf(calls[0]?.init).safety).toMatchObject({
      risk: "unknown",
      categories: [],
    });
    expect(bodyOf(calls[0]?.init).safety.reasons[0]).toMatch(/No language model/);
    expect(readPending(dir)[0]?.safety.risk).toBe("unknown");
  });
});

describe("!request help and env", () => {
  it("lists the command on public help", () => {
    const loaded = loadDefaults("config/default.yaml");
    expect(loaded.help).toMatch(/!request <idea>/);
    expect(loaded.help).toMatch(/!featurerequest/);
    expect(loaded.help).toMatch(/Chat/);
    const readme = fs.readFileSync("README.md", "utf8");
    expect(readme).toMatch(/REQUEST_WEBHOOK_URL/);
    expect(readme).toMatch(/Authorization: Bearer/);
    expect(readme).toMatch(/safety/);
    expect(readme).toMatch(/not clearly benign/);
    expect(readme).toMatch(/data\/feature-requests\/pending/);
    expect(fs.readFileSync(".env.example", "utf8")).toMatch(/feature-requests\/pending/);
    expect(fs.readFileSync(".env.example", "utf8")).toMatch(/REQUEST_WEBHOOK_SECRET/);
  });

  it("posts !help with the command", async () => {
    const store = new Store(":memory:");
    const client = new MockXClient();
    client.addUser(alice);
    const loaded = loadDefaults("config/default.yaml");
    const engine = new ModerationEngine(
      store,
      client,
      { botUserId: "bot-1", ownerId: owner.id, globalAdminIds: [], defaults: loaded },
    );
    try {
      await engine.processEvent(
        message({ id: "h1", senderId: alice.id, text: "!help" }),
      );
      expect(client.sent[0]?.text).toMatch(/!request <idea>/);
      expect(client.sent[0]?.text).toMatch(/!featurerequest/);
    } finally {
      store.close();
    }
  });

  it("reads the webhook env and rejects a bad URL", () => {
    process.env.BOT_OWNER_ID = process.env.BOT_OWNER_ID ?? "1";
    const previousUrl = process.env.REQUEST_WEBHOOK_URL;
    const previousSecret = process.env.REQUEST_WEBHOOK_SECRET;
    try {
      delete process.env.REQUEST_WEBHOOK_URL;
      delete process.env.REQUEST_WEBHOOK_SECRET;
      expect(loadEnv(true).requestWebhookUrl).toBeUndefined();
      expect(loadEnv(true).requestWebhookSecret).toBeUndefined();
      process.env.REQUEST_WEBHOOK_URL = "https://hooks.example/request";
      process.env.REQUEST_WEBHOOK_SECRET = "sek";
      expect(loadEnv(true).requestWebhookUrl).toBe("https://hooks.example/request");
      expect(loadEnv(true).requestWebhookSecret).toBe("sek");
      process.env.REQUEST_WEBHOOK_URL = "not a url";
      expect(() => loadEnv(true)).toThrow(/REQUEST_WEBHOOK_URL/);
    } finally {
      restoreEnv("REQUEST_WEBHOOK_URL", previousUrl);
      restoreEnv("REQUEST_WEBHOOK_SECRET", previousSecret);
    }
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
