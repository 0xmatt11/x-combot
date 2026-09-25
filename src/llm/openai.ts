import { log } from "../log.js";
import type {
  ChatMessage,
  LlmClient,
  LlmCompletion,
  LlmToolCall,
  LlmToolDefinition,
  LlmVisionImage,
} from "./client.js";

type WireContent =
  | string
  | null
  | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;

interface WireToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface WireMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: WireContent;
  tool_calls?: WireToolCall[];
  tool_call_id?: string;
}

export interface OpenAiCompatibleOptions {
  apiKey?: string;
  baseUrl?: string;
  model: string;
  timeoutMs?: number;
  /** Tests inject a fetch. Production uses the global fetch. */
  fetchImpl?: typeof fetch;
}

export class OpenAiCompatibleClient implements LlmClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAiCompatibleOptions) {
    this.apiKey = options.apiKey?.trim() ?? "";
    this.baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async complete(messages: ChatMessage[]): Promise<string> {
    const turn = await this.post(messages.map(toWire), 0.4, this.timeoutMs);
    if (!turn.content) throw new Error("LLM returned an empty reply");
    return turn.content;
  }

  /**
   * Chat Completions with function tools. Same endpoint as `complete`.
   * Does not call the image or video APIs.
   */
  async completeWithTools(
    messages: ChatMessage[],
    tools: readonly LlmToolDefinition[],
  ): Promise<LlmCompletion> {
    return this.post(messages.map(toWire), 0.4, this.timeoutMs, tools);
  }

  /**
   * One image plus a text prompt. Uses the same Chat Completions endpoint as
   * `complete`, with an `image_url` data URI. Grok/xAI and OpenAI both accept it.
   * The request body is not logged.
   */
  async completeVision(prompt: string, image: LlmVisionImage): Promise<string> {
    const mime = image.mimeType === "image/jpg" || image.mimeType === "image/pjpeg" ? "image/jpeg" : image.mimeType;
    const turn = await this.post(
      [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: `data:${mime};base64,${image.base64}` } },
          ],
        },
      ],
      0,
      Math.min(this.timeoutMs, 20_000),
    );
    if (!turn.content) throw new Error("LLM returned an empty reply");
    return turn.content;
  }

  private async post(
    messages: WireMessage[],
    temperature: number,
    timeoutMs: number,
    tools?: readonly LlmToolDefinition[],
  ): Promise<LlmCompletion> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      temperature,
    };
    if (tools && tools.length > 0) {
      body.tools = tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));
      body.tool_choice = "auto";
    }

    const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const raw = await response.text();
    if (!response.ok) {
      log.warn(`LLM HTTP ${response.status} from ${this.baseUrl} (${raw.length} bytes)`);
      throw new Error(`LLM request failed (${response.status})`);
    }

    const payload = JSON.parse(raw) as {
      choices?: {
        message?: {
          content?: string | null | Array<{ text?: string }>;
          tool_calls?: {
            id?: string;
            function?: { name?: string; arguments?: string };
          }[];
        };
      }[];
    };
    const message = payload.choices?.[0]?.message;
    const content = message?.content;
    const text = Array.isArray(content)
      ? content.map((part) => part.text ?? "").join("")
      : (content ?? "");
    const toolCalls: LlmToolCall[] = [];
    for (const call of message?.tool_calls ?? []) {
      const name = call.function?.name?.trim();
      if (!call.id || !name) continue;
      toolCalls.push({
        id: call.id,
        name,
        arguments: call.function?.arguments ?? "{}",
      });
    }
    const trimmed = text.trim();
    if (!trimmed && toolCalls.length === 0) {
      throw new Error("LLM returned an empty reply");
    }
    return { content: trimmed, toolCalls };
  }
}

function toWire(message: ChatMessage): WireMessage {
  if (message.role === "tool") {
    return {
      role: "tool",
      content: message.content,
      tool_call_id: message.toolCallId ?? "",
    };
  }
  if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
    return {
      role: "assistant",
      content: message.content || null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      })),
    };
  }
  return { role: message.role, content: message.content };
}
