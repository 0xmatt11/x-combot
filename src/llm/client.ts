export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmClient {
  complete(messages: ChatMessage[]): Promise<string>;
}
