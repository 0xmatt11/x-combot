import { log } from "../log.js";
import type { ChatMessage, LlmClient } from "./client.js";

export interface OpenAiCompatibleOptions {
  apiKey?: string;
  baseUrl?: string;
  model: string;
  timeoutMs?: number;
}

export class OpenAiCompatibleClient implements LlmClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(options: OpenAiCompatibleOptions) {
    this.apiKey = options.apiKey?.trim() ?? "";
    this.baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  async complete(messages: ChatMessage[]): Promise<string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: 0.4,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const raw = await response.text();
    if (!response.ok) {
      log.warn(`LLM HTTP ${response.status} from ${this.baseUrl} (${raw.length} bytes)`);
      throw new Error(`LLM request failed (${response.status})`);
    }

    const payload = JSON.parse(raw) as {
      choices?: { message?: { content?: string | Array<{ text?: string }> } }[];
    };
    const content = payload.choices?.[0]?.message?.content;
    const text = Array.isArray(content)
      ? content.map((part) => part.text ?? "").join("")
      : (content ?? "");
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error("LLM returned an empty reply");
    }
    return trimmed;
  }
}
