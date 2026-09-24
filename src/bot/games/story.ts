/**
 * One shared story per conversation. Each line is a single sentence,
 * and the same person cannot write two lines in a row.
 */
import type { GamePlayer } from "./players.js";

export const STORY_HELP =
  "Start with !story start. Add one sentence with !story <sentence>. !story status shows progress. !story stop ends it.";

export const STORY_MAX_CHARS = 140;
export const STORY_MAX_LINES = 30;

export type StoryLine = {
  player: GamePlayer;
  text: string;
};

export type StoryState = {
  kind: "story";
  id: string;
  conversationId: string;
  starter: GamePlayer;
  lines: StoryLine[];
  createdAt: number;
  updatedAt: number;
};

export function emptyStory(
  id: string,
  conversationId: string,
  starter: GamePlayer,
  nowMs: number,
): StoryState {
  return {
    kind: "story",
    id,
    conversationId,
    starter,
    lines: [],
    createdAt: nowMs,
    updatedAt: nowMs,
  };
}

/**
 * One sentence, collapsed whitespace, at most `STORY_MAX_CHARS`.
 * Two sentence breaks (`.!?` then more text) are rejected. An ellipsis is fine.
 */
export function oneSentence(input: string): string | undefined {
  const text = input.trim().replace(/\s+/g, " ");
  if (!text || text.length > STORY_MAX_CHARS) return undefined;
  if (!/[A-Za-z]/.test(text)) return undefined;
  const parts = text.split(/(?<=[.!?])\s+/).filter((part) => part.length > 0);
  if (parts.length > 1) return undefined;
  return text;
}

export type StoryIntent =
  | { type: "usage" }
  | { type: "start"; sentence?: string }
  | { type: "stop" }
  | { type: "status" }
  | { type: "line"; text: string }
  | { type: "bad-sentence" };

export function parseStoryArgs(args: string): StoryIntent {
  const trimmed = args.trim();
  if (!trimmed) return { type: "usage" };
  const match = trimmed.match(/^(start|stop|end|status|show)\b\s*([\s\S]*)$/i);
  if (match) {
    const verb = match[1]!.toLowerCase();
    const rest = match[2]?.trim() ?? "";
    if (verb === "start") {
      if (!rest) return { type: "start" };
      const sentence = oneSentence(rest);
      if (!sentence) return { type: "bad-sentence" };
      return { type: "start", sentence };
    }
    if (verb === "stop" || verb === "end") {
      if (rest) return { type: "usage" };
      return { type: "stop" };
    }
    if (rest) return { type: "usage" };
    return { type: "status" };
  }
  const sentence = oneSentence(trimmed);
  if (!sentence) return { type: "bad-sentence" };
  return { type: "line", text: sentence };
}
