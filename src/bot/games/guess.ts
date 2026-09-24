/**
 * The bot picks the range and the secret. Guesses get higher or lower.
 */
import { pickIndex, playerName, type Rng } from "./random.js";
import { GameSessions } from "./sessions.js";

export const GUESS_HELP =
  "The bot picks a range. !guess starts, !guess <number> tries. Replies say higher or lower.";

export const GUESS_RANGES: readonly (readonly [number, number])[] = [
  [1, 10],
  [1, 20],
  [1, 50],
  [1, 100],
];

type GuessRound = {
  low: number;
  high: number;
  secret: number;
  attempts: number;
  maxAttempts: number;
  status: "open" | "won" | "lost";
};

const sessions = new GameSessions<GuessRound>();

export function clearGuessSessions(): void {
  sessions.clear();
}

export function guessAttemptCap(low: number, high: number): number {
  const span = high - low + 1;
  return Math.max(1, Math.ceil(Math.log2(span)) + 1);
}

export function guessReply(input: {
  conversationId: string;
  guess?: string | null;
  player: string;
  nowMs?: number;
  rng?: Rng;
}): string {
  const now = input.nowMs ?? Date.now();
  const rng = input.rng ?? Math.random;
  const who = playerName(input.player);
  const raw = input.guess?.trim() ?? "";
  let round = sessions.get(input.conversationId, now);

  if (!round || round.status !== "open") {
    if (raw && round && round.status !== "open") {
      return `${who} — that round is over. Send !guess for another range.`;
    }
    if (raw && !/^\d+$/.test(raw)) return `${who} — ${GUESS_HELP}`;
    round = deal(rng);
    sessions.set(input.conversationId, round, now);
    if (!raw) return startText(who, round);
    return `${who} — new range. Guess after you see it.\n${startText(who, round)}`;
  }

  if (!raw) {
    sessions.set(input.conversationId, round, now);
    return `${who} — still thinking of a number from ${round.low} to ${round.high}. Guesses used: ${round.attempts} of ${round.maxAttempts}.\n!guess <number>. I'll say higher or lower.`;
  }

  if (!/^\d+$/.test(raw)) {
    sessions.set(input.conversationId, round, now);
    return `${who} — ${GUESS_HELP} Range ${round.low} to ${round.high}.`;
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < round.low || value > round.high) {
    sessions.set(input.conversationId, round, now);
    return `${who} — ${raw} is outside ${round.low} to ${round.high}.`;
  }

  round.attempts += 1;
  if (value === round.secret) {
    round.status = "won";
    sessions.set(input.conversationId, round, now);
    const count = round.attempts;
    return `${who} got it in ${count} ${count === 1 ? "guess" : "guesses"}. The number was ${round.secret}.`;
  }

  if (round.attempts >= round.maxAttempts) {
    round.status = "lost";
    sessions.set(input.conversationId, round, now);
    return `${who} — out of guesses. The number was ${round.secret}.`;
  }

  sessions.set(input.conversationId, round, now);
  const hint = value < round.secret ? "higher" : "lower";
  return `${who} — ${hint} than ${value}. Range ${round.low} to ${round.high}. Guess ${round.attempts} of ${round.maxAttempts}.`;
}

function deal(rng: Rng): GuessRound {
  const range = GUESS_RANGES[pickIndex(GUESS_RANGES.length, rng)]!;
  const [low, high] = range;
  const secret = low + pickIndex(high - low + 1, rng);
  return {
    low,
    high,
    secret,
    attempts: 0,
    maxAttempts: guessAttemptCap(low, high),
    status: "open",
  };
}

function startText(who: string, round: GuessRound): string {
  return `${who} — I'm thinking of a number from ${round.low} to ${round.high}.\n!guess <number>. I'll say higher or lower.`;
}
