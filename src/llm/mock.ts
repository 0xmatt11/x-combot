import type { ChatMessage, LlmClient } from "./client.js";

export class MockLlmClient implements LlmClient {
  readonly calls: ChatMessage[][] = [];
  replies: string[];

  constructor(replies: string | string[] = "mock llm reply") {
    this.replies = Array.isArray(replies) ? [...replies] : [replies];
  }

  async complete(messages: ChatMessage[]): Promise<string> {
    this.calls.push(messages);
    const next = this.replies.length > 1 ? this.replies.shift() : this.replies[0];
    if (!next) {
      throw new Error("Mock LLM has no replies");
    }
    return next;
  }
}
