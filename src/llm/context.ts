import { displayName } from "../x/client.js";
import type { DmEvent, LlmContextMode, TruncateStrategy } from "../types.js";

export interface ChatTurn {
  eventId: string;
  senderLabel: string;
  senderId?: string;
  text: string;
  createdAt?: string;
}

export interface AssembledContext {
  mode: LlmContextMode;
  turns: ChatTurn[];
  truncated: boolean;
  dropped: number;
}

export function eventToTurn(event: DmEvent): ChatTurn | undefined {
  const text = event.text?.trim();
  if (event.eventType !== "MessageCreate" || !text) return undefined;
  return {
    eventId: event.id,
    senderLabel: displayName(event.sender, event.senderId),
    senderId: event.senderId,
    text,
    createdAt: event.createdAt,
  };
}

export function selectContextTurns(
  historyOldestFirst: ChatTurn[],
  mode: LlmContextMode,
  options: {
    noneRecentMessages: number;
    recentMessages: number;
    fullMaxMessages: number;
    fullMaxChars: number;
    truncate: TruncateStrategy;
  },
): AssembledContext {
  const normalized: LlmContextMode =
    mode === "conversation" ? "full" : mode;

  if (normalized === "none") {
    return clipTurns(historyOldestFirst, {
      maxMessages: Math.max(0, options.noneRecentMessages),
      maxChars: options.fullMaxChars,
      truncate: "oldest",
      mode,
    });
  }

  if (normalized === "recent") {
    return clipTurns(historyOldestFirst, {
      maxMessages: options.recentMessages,
      maxChars: options.fullMaxChars,
      truncate: "oldest",
      mode,
    });
  }

  return clipTurns(historyOldestFirst, {
    maxMessages: options.fullMaxMessages,
    maxChars: options.fullMaxChars,
    truncate: options.truncate,
    mode,
  });
}

export function clipTurns(
  historyOldestFirst: ChatTurn[],
  options: {
    maxMessages: number;
    maxChars: number;
    truncate: TruncateStrategy;
    mode: LlmContextMode;
  },
): AssembledContext {
  let turns = [...historyOldestFirst];
  let dropped = 0;

  if (turns.length > options.maxMessages) {
    const extra = turns.length - options.maxMessages;
    dropped += extra;
    turns =
      options.truncate === "newest"
        ? turns.slice(0, options.maxMessages)
        : turns.slice(extra);
  }

  const charCount = (items: ChatTurn[]) =>
    items.reduce((sum, turn) => sum + turn.text.length, 0);

  while (turns.length > 0 && charCount(turns) > options.maxChars) {
    dropped += 1;
    if (options.truncate === "newest") {
      turns.pop();
    } else {
      turns.shift();
    }
  }

  return {
    mode: options.mode,
    turns,
    truncated: dropped > 0,
    dropped,
  };
}

export function formatContextBlock(assembled: AssembledContext): string {
  if (assembled.turns.length === 0) {
    return `(no prior group messages in context; mode=${assembled.mode})`;
  }
  const lines = assembled.turns.map((turn) => {
    const when = turn.createdAt ? ` ${turn.createdAt}` : "";
    return `[${turn.senderLabel}${when}] ${turn.text}`;
  });
  const note = assembled.truncated
    ? `\n(context truncated; dropped ${assembled.dropped} older/newer messages to fit limits)`
    : "";
  return `Group DM context (mode=${assembled.mode}, ${assembled.turns.length} messages):${note}\n${lines.join("\n")}`;
}

export function buildLlmMessages(params: {
  systemPrompt: string;
  context: AssembledContext;
  question: string;
  askerLabel: string;
  kind: "ask" | "summarize" | "analyze";
}): { role: "system" | "user"; content: string }[] {
  const instruction =
    params.kind === "summarize"
      ? "Summarize this group Direct Message thread. Call out decisions, open questions, and action items. If a focus was given, weight that."
      : params.kind === "analyze"
        ? "Answer about this group Direct Message thread using the conversation context. If the user gave a prompt, follow it."
        : "Answer the current question. Use the group context when it helps; say when the thread does not contain enough information.";

  const user = [
    instruction,
    formatContextBlock(params.context),
    `Current ${params.kind === "ask" ? "question" : "request"} from ${params.askerLabel}:`,
    params.question || "(no extra prompt)",
  ].join("\n\n");

  return [
    { role: "system", content: params.systemPrompt },
    { role: "user", content: user },
  ];
}

export function splitReply(text: string, maxChars: number): string[] {
  if (maxChars <= 0 || text.length <= maxChars) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxChars) {
      chunks.push(remaining);
      break;
    }
    let slice = remaining.slice(0, maxChars);
    const lastBreak = slice.lastIndexOf("\n");
    const lastSpace = slice.lastIndexOf(" ");
    const cut = lastBreak >= maxChars / 2 ? lastBreak : lastSpace >= maxChars / 2 ? lastSpace : maxChars;
    slice = remaining.slice(0, cut).trimEnd();
    chunks.push(slice);
    remaining = remaining.slice(cut).trimStart();
  }
  return chunks.filter(Boolean);
}
