/**
 * One longer word, several tries. Score starts at 10 per letter and drops
 * 5 on each miss. Not the short-word streak in scramble.ts.
 */
import { scrambleLetters, spacedLetters, pickDifferent } from "./letters.js";
import { playerName, type Rng } from "./random.js";
import { GameSessions } from "./sessions.js";

export const ANAGRAM_POINTS_PER_LETTER = 10;
export const ANAGRAM_MISS_PENALTY = 5;
export const ANAGRAM_MAX_MISSES = 5;

export const ANAGRAM_HELP =
  "Unscramble a longer word with !anagram, then !anagram <word>. Score starts at 10 per letter and drops 5 per miss.";

/** Seven or more letters. Disjoint from the scramble list. */
export const ANAGRAM_WORDS = [
  "diamond",
  "picture",
  "weather",
  "morning",
  "evening",
  "holiday",
  "captain",
  "balance",
  "crystal",
  "dolphin",
  "emperor",
  "fantasy",
  "gravity",
  "harvest",
  "journey",
  "kingdom",
  "library",
  "mystery",
  "organic",
  "passion",
  "rainbow",
  "silence",
  "thunder",
  "village",
  "whisper",
  "champion",
  "festival",
  "notebook",
  "umbrella",
  "volcano",
] as const;

type AnagramRound = {
  word: string;
  scrambled: string;
  misses: number;
  status: "open" | "won" | "lost";
};

const sessions = new GameSessions<AnagramRound>();

export function clearAnagramSessions(): void {
  sessions.clear();
}

export function anagramScore(word: string, misses: number): number {
  return Math.max(0, word.length * ANAGRAM_POINTS_PER_LETTER - misses * ANAGRAM_MISS_PENALTY);
}

export function anagramReply(input: {
  conversationId: string;
  guess?: string | null;
  player: string;
  nowMs?: number;
  rng?: Rng;
}): string {
  const now = input.nowMs ?? Date.now();
  const rng = input.rng ?? Math.random;
  const who = playerName(input.player);
  const raw = input.guess?.trim().toLowerCase() ?? "";
  let round = sessions.get(input.conversationId, now);

  if (!round || round.status !== "open") {
    if (raw && round && round.status !== "open") {
      return `${who} — that round is over. Send !anagram for another.`;
    }
    if (raw && !/^[a-z]+$/.test(raw)) return `${who} — ${ANAGRAM_HELP}`;
    round = deal(rng, round?.word);
    sessions.set(input.conversationId, round, now);
    if (!raw) return dealText(who, round);
    return `${who} — new anagram. Guess after you see the letters.\n${dealText(who, round)}`;
  }

  if (!raw) {
    sessions.set(input.conversationId, round, now);
    return dealText(who, round);
  }

  if (!/^[a-z]+$/.test(raw)) {
    sessions.set(input.conversationId, round, now);
    return `${who} — ${ANAGRAM_HELP}\n${dealText(who, round)}`;
  }

  if (raw === round.word) {
    round.status = "won";
    const score = anagramScore(round.word, round.misses);
    sessions.set(input.conversationId, round, now);
    return `${who} unscrambled ${round.word.toUpperCase()} for ${score} points.`;
  }

  round.misses += 1;
  if (round.misses >= ANAGRAM_MAX_MISSES) {
    round.status = "lost";
    sessions.set(input.conversationId, round, now);
    return `${who} — out of tries. The word was ${round.word.toUpperCase()}. 0 points.\nSend !anagram for another.`;
  }

  sessions.set(input.conversationId, round, now);
  const left = ANAGRAM_MAX_MISSES - round.misses;
  const score = anagramScore(round.word, round.misses);
  return `${who} — nope. ${left} ${left === 1 ? "try" : "tries"} left. Score ${score}.\n${spacedLetters(round.scrambled)}`;
}

function deal(rng: Rng, avoid?: string): AnagramRound {
  const word = pickDifferent(ANAGRAM_WORDS, rng, avoid);
  return {
    word,
    scrambled: scrambleLetters(word, rng),
    misses: 0,
    status: "open",
  };
}

function dealText(who: string, round: AnagramRound): string {
  const score = anagramScore(round.word, round.misses);
  return `${who} — anagram: ${spacedLetters(round.scrambled)}\n${round.word.length} letters. Score ${score}, minus ${ANAGRAM_MISS_PENALTY} per miss. !anagram <word>`;
}
