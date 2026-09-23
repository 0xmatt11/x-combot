import { log } from "../log.js";
import type { ChatMessage, LlmClient, LlmVisionImage } from "./client.js";

type WireContent =
  | string
  | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;

interface WireMessage {
  role: "system" | "user" | "assistant";
  content: WireContent;
}

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
    return this.request(messages, 0.4, this.timeoutMs);
  }

  /**
   * One image plus a text prompt. Uses the same Chat Completions endpoint as
   * `complete`, with an `image_url` data URI. Grok/xAI and OpenAI both accept it.
   * The request body is not logged.
   */
  async completeVision(prompt: string, image: LlmVisionImage): Promise<string> {
    const mime = image.mimeType === "image/jpg" || image.mimeType === "image/pjpeg" ? "image/jpeg" : image.mimeType;
    return this.request(
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
  }

  private async request(messages: WireMessage[], temperature: number, timeoutMs: number): Promise<string> {
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
        temperature,
      }),
      signal: AbortSignal.timeout(timeoutMs),
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
