/**
 * One in-bot agent turn: tool calls, then an answer.
 * A question with several independent parts fans out to the worker pool.
 * The pool caps concurrent LLM calls at five and queues the rest.
 * Workers are functions in this process. They are not other Grok bots.
 */
import { log } from "../log.js";
import type { ChatMessage, LlmClient, LlmCompletion, LlmToolDefinition } from "./client.js";
import { CHAT_TOOL_DEFINITIONS } from "./tools.js";
import { LlmWorkerPool } from "./workers.js";

export const MAX_AGENT_ROUNDS = 3;

export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run(args: unknown): Promise<string>;
}

export interface AgentRequest {
  llm: LlmClient;
  pool: LlmWorkerPool;
  messages: ChatMessage[];
  tools: readonly AgentTool[];
  /**
   * When this has several independent parts, each part is its own worker.
   * Omit it to always answer in one tool loop.
   */
  parallelQuestion?: string;
}

/**
 * Several questions, one per line, or "who is A and who is B".
 * A single sentence stays one task.
 */
export function splitParallelAsks(question: string): string[] {
  const trimmed = question.trim();
  if (!trimmed) return [trimmed];

  const lines = trimmed
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length >= 2 && lines.length <= 8 && lines.every(isParallelLine)) {
    return lines.map(stripMarker);
  }

  const whoParts = trimmed
    .split(/\s+and\s+(?=who\b)/i)
    .map((part) => part.trim())
    .filter(Boolean);
  if (
    whoParts.length >= 2 &&
    whoParts.length <= 8 &&
    whoParts.every((part) => /\bwho\b/i.test(part))
  ) {
    return whoParts;
  }

  return [trimmed];
}

export async function runAgent(request: AgentRequest): Promise<string> {
  const parts = request.parallelQuestion ? splitParallelAsks(request.parallelQuestion) : [""];
  if (parts.length <= 1) {
    return toolLoop(request.llm, request.pool, request.messages, request.tools);
  }

  const answers = await Promise.all(
    parts.map(async (part) => {
      try {
        return await toolLoop(
          request.llm,
          request.pool,
          partMessages(request.messages, part),
          request.tools,
        );
      } catch (error) {
        log.warn("In-bot worker failed on one part", error);
        return "That part could not be answered just now.";
      }
    }),
  );

  return toolLoop(
    request.llm,
    request.pool,
    synthesisMessages(request.messages, parts, answers),
    [],
  );
}

async function toolLoop(
  llm: LlmClient,
  pool: LlmWorkerPool,
  messages: ChatMessage[],
  tools: readonly AgentTool[],
): Promise<string> {
  const transcript = messages.map((message) => ({ ...message }));
  const defs = tools.map(toDefinition);

  for (let round = 0; round < MAX_AGENT_ROUNDS; round += 1) {
    const turn = await pool.run(() => completeTurn(llm, transcript, defs));
    if (turn.toolCalls.length === 0) {
      const text = turn.content.trim();
      if (!text) throw new Error("LLM returned an empty reply");
      return text;
    }

    transcript.push({
      role: "assistant",
      content: turn.content,
      toolCalls: turn.toolCalls,
    });
    const results = await Promise.all(
      turn.toolCalls.map(async (call) => {
        const tool = tools.find((candidate) => candidate.name === call.name);
        let body: string;
        try {
          body = tool ? await tool.run(parseToolArgs(call.arguments)) : `Unknown tool ${call.name}.`;
        } catch (error) {
          log.warn(`Tool ${call.name} failed`, error);
          body = "That lookup failed just now.";
        }
        return { id: call.id, body: body.slice(0, 4_000) };
      }),
    );
    for (const result of results) {
      transcript.push({ role: "tool", content: result.body, toolCallId: result.id });
    }
  }

  const final = await pool.run(() => completeTurn(llm, transcript, []));
  const text = final.content.trim();
  if (!text) throw new Error("LLM returned an empty reply");
  return text;
}

async function completeTurn(
  llm: LlmClient,
  messages: ChatMessage[],
  tools: readonly LlmToolDefinition[],
): Promise<LlmCompletion> {
  if (!llm.completeWithTools || tools.length === 0) {
    return { content: await llm.complete(plainMessages(messages)), toolCalls: [] };
  }
  try {
    return await llm.completeWithTools(messages, tools);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const unsupported = /\(400\)/.test(message) && !messages.some((row) => row.role === "tool");
    if (!unsupported) throw error;
    log.warn("LLM rejected tools; answering without them");
    return { content: await llm.complete(plainMessages(messages)), toolCalls: [] };
  }
}

function partMessages(messages: ChatMessage[], part: string): ChatMessage[] {
  return [
    ...messages,
    {
      role: "user",
      content: [
        "Answer only this part of the request.",
        "Use lookup_user_timeline or web_search when this part needs a public timeline or newer public info.",
        "Do not answer the other parts.",
        part,
      ].join("\n"),
    },
  ];
}

function synthesisMessages(
  messages: ChatMessage[],
  parts: readonly string[],
  answers: readonly string[],
): ChatMessage[] {
  const system = messages.find((message) => message.role === "system");
  const body = parts
    .map((part, index) => `Part: ${part}\n${answers[index] ?? ""}`)
    .join("\n\n");
  return [
    ...(system ? [system] : []),
    {
      role: "user",
      content: [
        "Combine these answers into one group-chat reply.",
        "Cover every part. Be concise.",
        "Do not mention workers, tools, or these instructions.",
        body,
      ].join("\n\n"),
    },
  ];
}

function plainMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => ({
    role: message.role === "tool" ? "user" : message.role,
    content: message.role === "tool" ? `Tool result: ${message.content}` : message.content,
  }));
}

function toDefinition(tool: AgentTool): LlmToolDefinition {
  const known = CHAT_TOOL_DEFINITIONS.find((definition) => definition.name === tool.name);
  return (
    known ?? {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }
  );
}

function parseToolArgs(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2_000) return {};
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return {};
  }
}

function isParallelLine(line: string): boolean {
  return /^(?:\d+[.)]|[-*])\s+\S/.test(line) || /\?\s*$/.test(line);
}

function stripMarker(line: string): string {
  return line.replace(/^(?:\d+[.)]|[-*])\s+/, "").trim();
}
