/**
 * A random PG-13 truth or dare. The prompt list is fixed. Extra text that
 * mentions minors is refused, and the command will not take a custom dare.
 */
import { containsBannedAgeTerm } from "../adult-filter.js";
import { pickIndex, playerName, type Rng } from "./random.js";
import { GameSessions } from "./sessions.js";

export const TRUTH_OR_DARE_HELP =
  "PG-13 only. !truthordare, !truthordare truth, or !truthordare dare.";

export const TRUTH_OR_DARE_MINOR =
  "I won't give a truth or dare about minors. Try !truthordare, !truthordare truth, or !truthordare dare.";

export const TRUTH_OR_DARE_LIMIT =
  "Truth or dare stays PG-13 and non-criminal. Try !truthordare, !truthordare truth, or !truthordare dare.";

export const TRUTH_PROMPTS = [
  "What's a song you know every word to?",
  "What's a food you pretend to like?",
  "What's the last harmless thing you searched?",
  "What's a harmless opinion you'll defend?",
  "What's your most-used emoji?",
  "Who in this chat would you trust with a secret recipe?",
  "What's a movie you can quote from memory?",
  "What's the kindest thing a stranger did for you?",
  "What's a hobby you dropped?",
  "What's your go-to late-night snack?",
  "What's a skill you wish you had?",
  "What's the worst haircut you ever had?",
  "What's a place you want to visit?",
  "What game did you play too much?",
  "What's a compliment you still remember?",
  "What's your most unpopular food opinion?",
] as const;

export const DARE_PROMPTS = [
  "Send a message using only three words.",
  "Describe your day as a weather report.",
  "Compliment the last person who spoke.",
  "Type a chorus you like without naming the artist.",
  "Describe the sky where you are in one sentence.",
  "Give yourself a fruit nickname for the next message.",
  "Tell a two-sentence story that includes a penguin.",
  "Make your next message rhyme.",
  "Recommend a book, show, or album.",
  "Say one sentence like a pirate.",
  "Write a haiku about coffee or tea.",
  "Share a harmless autocorrect fail.",
  "Invent a silly handshake using only words.",
  "Rate today from 1 to 10 in one line.",
  "Invent a team name for this chat.",
  "Share a joke that would be fine in a classroom.",
] as const;

const CRIME_RE =
  /\b(?:steal(?:ing|s)?|rob(?:bery|bing|bed)?|hack(?:ing|s|ed)?|drugs?|murder(?:s|ed|ing)?|assault(?:s|ed|ing)?|bombs?|fraud|scam(?:s|med|ming)?|kill(?:s|ed|ing)?)\b/i;

type Kind = "truth" | "dare";

const sessions = new GameSessions<{ last: string }>();

export function clearTruthOrDareSessions(): void {
  sessions.clear();
}

export function truthOrDareReply(input: {
  conversationId: string;
  mode?: string | null;
  player: string;
  nowMs?: number;
  rng?: Rng;
}): string {
  const now = input.nowMs ?? Date.now();
  const rng = input.rng ?? Math.random;
  const who = playerName(input.player);
  const raw = input.mode?.trim() ?? "";

  if (containsBannedAgeTerm(raw)) return `${who} — ${TRUTH_OR_DARE_MINOR}`;

  const parsed = parseMode(raw);
  if (parsed === "help") return `${who} — ${TRUTH_OR_DARE_HELP}`;
  if (parsed === "limit") return `${who} — ${TRUTH_OR_DARE_LIMIT}`;

  const kind: Kind = parsed === "random" ? (pickIndex(2, rng) === 0 ? "truth" : "dare") : parsed;
  const list = kind === "truth" ? TRUTH_PROMPTS : DARE_PROMPTS;
  const previous = sessions.get(input.conversationId, now)?.last;
  let index = pickIndex(list.length, rng);
  let prompt = list[index]!;
  if (previous === prompt) {
    index = (index + 1) % list.length;
    prompt = list[index]!;
  }
  sessions.set(input.conversationId, { last: prompt }, now);
  const title = kind === "truth" ? "Truth" : "Dare";
  return `${who} — ${title}: ${prompt}`;
}

function parseMode(raw: string): Kind | "random" | "help" | "limit" {
  if (!raw) return "random";
  const key = raw.toLowerCase();
  if (key === "truth" || key === "t") return "truth";
  if (key === "dare" || key === "d") return "dare";
  if (CRIME_RE.test(key)) return "limit";
  return "help";
}
