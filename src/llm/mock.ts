import type {
  ChatMessage,
  LlmClient,
  LlmCompletion,
  LlmToolCall,
  LlmToolDefinition,
} from "./client.js";

export class MockLlmClient implements LlmClient {
  readonly calls: ChatMessage[][] = [];
  readonly toolDefs: LlmToolDefinition[][] = [];
  replies: string[];
  /**
   * When this returns tool calls, that turn does not consume a text reply.
   * The next turn uses the reply queue.
   */
  toolHandler?: (
    messages: ChatMessage[],
    tools: readonly LlmToolDefinition[],
  ) => LlmToolCall[] | undefined;

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

  async completeWithTools(
    messages: ChatMessage[],
    tools: readonly LlmToolDefinition[],
  ): Promise<LlmCompletion> {
    this.toolDefs.push([...tools]);
    const toolCalls = this.toolHandler?.(messages, tools) ?? [];
    if (toolCalls.length > 0) {
      this.calls.push(messages);
      return { content: "", toolCalls };
    }
    return { content: await this.complete(messages), toolCalls: [] };
  }
}
