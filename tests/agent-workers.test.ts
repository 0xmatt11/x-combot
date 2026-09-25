import { describe, expect, it } from "vitest";
import { runAgent, splitParallelAsks, type AgentTool } from "../src/llm/agent.js";
import type { ChatMessage, LlmClient, LlmToolDefinition } from "../src/llm/client.js";
import { MockLlmClient } from "../src/llm/mock.js";
import { OpenAiCompatibleClient } from "../src/llm/openai.js";
import { CHAT_TOOL_DEFINITIONS } from "../src/llm/tools.js";
import { LlmWorkerPool, MAX_IN_PROCESS_LLM_WORKERS } from "../src/llm/workers.js";

describe("LlmWorkerPool", () => {
  it("runs at most 5 tasks and queues the rest", async () => {
    expect(MAX_IN_PROCESS_LLM_WORKERS).toBe(5);
    const pool = new LlmWorkerPool(5);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tasks = Array.from({ length: 8 }, () =>
      pool.run(async () => {
        await gate;
        return "ok";
      }),
    );
    expect(pool.running).toBe(5);
    expect(pool.waiting).toBe(3);
    release();
    await expect(Promise.all(tasks)).resolves.toEqual(Array(8).fill("ok"));
    expect(pool.running).toBe(0);
    expect(pool.waiting).toBe(0);
  });

  it("releases a slot when a task throws", async () => {
    const pool = new LlmWorkerPool(1);
    await expect(pool.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(pool.run(async () => "next")).resolves.toBe("next");
  });
});

describe("splitParallelAsks", () => {
  it("keeps a single question together and splits independent parts", () => {
    expect(splitParallelAsks("when is standup?")).toEqual(["when is standup?"]);
    expect(splitParallelAsks("who is @alice?\nwho is @bob?")).toEqual([
      "who is @alice?",
      "who is @bob?",
    ]);
    expect(splitParallelAsks("who is @alice and who is @bob")).toEqual([
      "who is @alice",
      "who is @bob",
    ]);
  });
});

describe("runAgent", () => {
  it("calls a tool and then answers from the tool result", async () => {
    const llm = new MockLlmClient("Bob posts about a car named Kevin.");
    let used = false;
    llm.toolHandler = () => {
      if (used) return [];
      used = true;
      return [{ id: "call-1", name: "lookup_user_timeline", arguments: '{"username":"bob"}' }];
    };
    const seen: unknown[] = [];
    const tools: AgentTool[] = [
      {
        name: "lookup_user_timeline",
        description: "posts",
        parameters: {},
        run: async (args) => {
          seen.push(args);
          return "@bob recent public posts:\n- bought a car named Kevin";
        },
      },
    ];
    const answer = await runAgent({
      llm,
      pool: new LlmWorkerPool(5),
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "who is @bob" },
      ],
      tools,
    });
    expect(answer).toBe("Bob posts about a car named Kevin.");
    expect(seen).toEqual([{ username: "bob" }]);
    expect(llm.calls).toHaveLength(2);
    const followup = llm.calls[1]?.map((message) => message.content).join("\n") ?? "";
    expect(followup).toContain("bought a car named Kevin");
    expect(llm.toolDefs[0]?.map((tool) => tool.name)).toEqual(["lookup_user_timeline"]);
  });

  it("fans a complex ask out through the pool and combines one reply", async () => {
    const llm = new MockLlmClient(["alice posts", "bob posts", "alice and bob"]);
    const answer = await runAgent({
      llm,
      pool: new LlmWorkerPool(5),
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "who is @alice and who is @bob" },
      ],
      tools: [],
      parallelQuestion: "who is @alice and who is @bob",
    });
    expect(answer).toBe("alice and bob");
    expect(llm.calls).toHaveLength(3);
    const synthesis = llm.calls[2]?.map((message) => message.content).join("\n") ?? "";
    expect(synthesis).toContain("alice posts");
    expect(synthesis).toContain("bob posts");
    expect(synthesis).not.toContain("another assistant");
  });

  it("answers without tools when the provider rejects them", async () => {
    const calls: ChatMessage[][] = [];
    const llm: LlmClient = {
      async complete(messages) {
        calls.push(messages);
        return "plain answer";
      },
      async completeWithTools() {
        throw new Error("LLM request failed (400)");
      },
    };
    const answer = await runAgent({
      llm,
      pool: new LlmWorkerPool(1),
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          name: "web_search",
          description: "search",
          parameters: {},
          run: async () => "nope",
        },
      ],
    });
    expect(answer).toBe("plain answer");
    expect(calls).toHaveLength(1);
  });
});

describe("OpenAiCompatibleClient tools", () => {
  it("posts function tools to chat completions and parses tool calls", async () => {
    const bodies: unknown[] = [];
    const client = new OpenAiCompatibleClient({
      apiKey: "test",
      baseUrl: "https://api.x.ai/v1",
      model: "grok-4.6",
      fetchImpl: async (input, init) => {
        const url = String(input);
        expect(url).toBe("https://api.x.ai/v1/chat/completions");
        expect(url).not.toMatch(/images|videos/);
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: "call-9",
                      type: "function",
                      function: { name: "web_search", arguments: '{"query":"milady"}' },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        );
      },
    });
    const turn = await client.completeWithTools(
      [{ role: "user", content: "search milady" }],
      CHAT_TOOL_DEFINITIONS,
    );
    expect(turn.toolCalls).toEqual([
      { id: "call-9", name: "web_search", arguments: '{"query":"milady"}' },
    ]);
    const body = bodies[0] as {
      tools: { type: string; function: { name: string } }[];
      model: string;
    };
    expect(body.model).toBe("grok-4.6");
    expect(body.tools.map((tool) => tool.function.name)).toEqual([
      "lookup_user_timeline",
      "web_search",
    ]);
    expect(body.tools.every((tool) => tool.type === "function")).toBe(true);
  });

  it("does not advertise image or video tools", () => {
    const names = CHAT_TOOL_DEFINITIONS.map((tool: LlmToolDefinition) => tool.name);
    expect(names).toEqual(["lookup_user_timeline", "web_search"]);
  });
});
