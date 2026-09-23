export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Image bytes already encoded. Callers must not log this payload. */
export interface LlmVisionImage {
  mimeType: string;
  base64: string;
}

export interface LlmClient {
  complete(messages: ChatMessage[]): Promise<string>;
  /**
   * Optional multimodal check. OpenAI-compatible providers (OpenAI, Grok/xAI, local)
   * implement this. Text chat does not require it.
   */
  completeVision?(prompt: string, image: LlmVisionImage): Promise<string>;
}
