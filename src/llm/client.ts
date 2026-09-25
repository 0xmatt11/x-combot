export interface LlmToolCall {
  id: string;
  name: string;
  /** JSON object string. Callers parse it. */
  arguments: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Set on an assistant turn that requested tools. */
  toolCalls?: LlmToolCall[];
  /** Set on a tool result. Matches `LlmToolCall.id`. */
  toolCallId?: string;
}

/** Image bytes already encoded. Callers must not log this payload. */
export interface LlmVisionImage {
  mimeType: string;
  base64: string;
}

/** JSON-schema parameters for one function tool. */
export interface LlmToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmCompletion {
  content: string;
  toolCalls: LlmToolCall[];
}

export interface LlmClient {
  complete(messages: ChatMessage[]): Promise<string>;
  /**
   * Optional multimodal check. OpenAI-compatible providers (OpenAI, Grok/xAI, local)
   * implement this. Text chat does not require it.
   */
  completeVision?(prompt: string, image: LlmVisionImage): Promise<string>;
  /**
   * Chat completion that may request tool calls. Absent on clients that only
   * speak plain text. A turn with tool calls may have an empty `content`.
   */
  completeWithTools?(
    messages: ChatMessage[],
    tools: readonly LlmToolDefinition[],
  ): Promise<LlmCompletion>;
}
