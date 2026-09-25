/**
 * Cheap reads of a chat line as a move in an open game.
 * Deterministic forms stay here. The engine calls the chat LLM only when
 * a trivia question is open and the line looks like an answer but is not
 * one of these forms.
 */
import type { ChatMessage } from "../../llm/client.js";

const LETTERS = ["a", "b", "c", "d"] as const;

function normalize(text: string): string {
  return text.trim().replace(/[’‘]/g, "'").replace(/\s+/g, " ");
}

/**
 * Unambiguous trivia choice, or undefined.
 * `a`, `!A`, `!triviac`, `!trivia c`, and short phrases with one letter.
 */
export function deterministicTriviaChoice(text: string): number | undefined {
  const line = normalize(text);
  if (!line || line.length > 80) return undefined;

  const single = line.match(/^[!/]?([a-d])[.!?]*$/i);
  if (single?.[1]) return LETTERS.indexOf(single[1].toLowerCase() as (typeof LETTERS)[number]);

  const numbered = line.match(/^[!/]?([1-4])[.!?]*$/);
  if (numbered?.[1]) return Number(numbered[1]) - 1;

  const glued = line.match(/^[!/]?(?:trivia|quiz)\s*([a-d1-4])[.!?]*$/i);
  if (glued?.[1]) {
    const token = glued[1].toLowerCase();
    const letter = LETTERS.indexOf(token as (typeof LETTERS)[number]);
    if (letter >= 0) return letter;
    return Number(token) - 1;
  }

  const phrase = line.match(
    /^(?:i\s+)?(?:think|guess|reckon|say)\s+(?:it'?s|its|the answer is)\s+([a-d])\b[.!?]*$/i,
  );
  if (phrase?.[1]) return LETTERS.indexOf(phrase[1].toLowerCase() as (typeof LETTERS)[number]);

  const go = line.match(
    /^(?:go\s+with|going\s+with|i(?:'ll| will)\s+go\s+with|pick|choose|answer(?:\s+is)?|it'?s|its)\s+([a-d])\b[.!?]*$/i,
  );
  if (go?.[1]) return LETTERS.indexOf(go[1].toLowerCase() as (typeof LETTERS)[number]);

  return undefined;
}

const ATTEMPT_RE =
  /\b(think|guess|reckon|answer|option|choice|pick|choose|go with|going with)\b/i;
const ORDINAL_RE = /\b(first|second|third|fourth|last)\b/i;
const SKIP_RE =
  /^(?:lol|lmao|haha|hey|hi|hello|yo|sup|ok|okay|thanks|thank you|gg|nice|wow|what|why|who|huh)[.!?]*$/i;

/**
 * Short line that might be answering the open question, after the
 * deterministic forms have already missed. Not every chat message.
 */
export function looksLikeTriviaAttempt(text: string): boolean {
  const line = normalize(text);
  if (line.length < 3 || line.length > 80) return false;
  if (SKIP_RE.test(line)) return false;
  if (deterministicTriviaChoice(line) !== undefined) return false;
  if (ATTEMPT_RE.test(line)) return true;
  return line.length <= 40 && ORDINAL_RE.test(line);
}

export function buildTriviaInterpretMessages(params: {
  utterance: string;
  prompt: string;
  choices: readonly string[];
}): ChatMessage[] {
  const choices = params.choices
    .map((choice, index) => `${LETTERS[index] ?? "?"}) ${choice}`)
    .join("\n");
  return [
    {
      role: "system",
      content: [
        "You map one chat message onto an open multiple-choice trivia question.",
        "Reply with one token only: A, B, C, D, or NONE.",
        "NONE means the message is not an attempt to answer this question.",
        "Do not explain.",
      ].join(" "),
    },
    {
      role: "user",
      content: [`Question: ${params.prompt}`, choices, `Message: ${params.utterance}`].join("\n"),
    },
  ];
}

/** A letter index, "none" when the model opts out, or undefined when the reply is unusable. */
export function parseTriviaInterpret(reply: string): number | "none" | undefined {
  const cleaned = reply.trim();
  if (!cleaned) return undefined;
  if (/\bNONE\b/i.test(cleaned)) return "none";
  const letter = cleaned.toUpperCase().match(/\b([ABCD])\b/);
  if (!letter?.[1]) return undefined;
  return "ABCD".indexOf(letter[1]);
}

/** `a` / `!b` while a would-you-rather round is open. */
export function looseWouldChoice(text: string): "A" | "B" | undefined {
  const match = normalize(text).match(/^[!/]?([ab])[.!?]*$/i);
  if (!match?.[1]) return undefined;
  return match[1].toUpperCase() as "A" | "B";
}

const HIGHER = new Set(["higher", "high", "h", "up"]);
const LOWER = new Set(["lower", "low", "l", "down"]);

/** A whole-message higher/lower call, with an optional bang. */
export function looseHigherLowerCall(text: string): "higher" | "lower" | undefined {
  const match = normalize(text).match(/^[!/]?([a-z]+)$/i);
  const word = match?.[1]?.toLowerCase();
  if (!word) return undefined;
  if (HIGHER.has(word)) return "higher";
  if (LOWER.has(word)) return "lower";
  return undefined;
}

/** Bare `hit` or `stand` for an open casino hand. Known `!hit` / `!stand` never reach this. */
export function looseCasinoVerb(text: string): "hit" | "stand" | undefined {
  const match = normalize(text).match(/^[!/]?(hit|stand)$/i);
  const word = match?.[1]?.toLowerCase();
  if (word === "hit" || word === "stand") return word;
  return undefined;
}
