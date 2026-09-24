/**
 * Short-word letter round. One try per word. A solve adds length × streak
 * to the round score; a miss resets the streak and deals the next word.
 * Different list and score from anagram.ts.
 */
import { pickDifferent, scrambleLetters, spacedLetters } from "./letters.js";
import { playerName, type Rng } from "./random.js";
import { GameSessions } from "./sessions.js";

export const SCRAMBLE_HELP =
  "Short-word round: !scramble, then !scramble <word>. A solve builds a streak; a miss resets it. Separate list and score from !anagram.";

/** Four-letter words only, so this list cannot overlap anagram or Wordle. */
export const SCRAMBLE_WORDS = [
  "frog",
  "duck",
  "lion",
  "bear",
  "wolf",
  "fish",
  "crab",
  "deer",
  "goat",
  "hawk",
  "moon",
  "star",
  "tree",
  "rock",
  "sand",
  "lake",
  "rain",
  "snow",
  "wind",
  "leaf",
  "book",
  "lamp",
  "desk",
  "door",
  "ship",
  "boat",
  "cake",
  "milk",
  "corn",
  "bean",
  "blue",
  "gold",
  "pink",
  "gray",
  "mint",
  "drum",
  "bell",
  "coin",
  "rope",
  "kite",
] as const;

type ScrambleRound = {
  word: string;
  scrambled: string;
  streak: number;
  score: number;
};

const sessions = new GameSessions<ScrambleRound>();

export function clearScrambleSessions(): void {
  sessions.clear();
}

export function scrambleReply(input: {
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

  if (!round) {
    if (raw && !/^[a-z]+$/.test(raw)) return `${who} — ${SCRAMBLE_HELP}`;
    round = deal(rng, 0, 0);
    sessions.set(input.conversationId, round, now);
    if (!raw) return dealText(who, round);
    return `${who} — new scramble. Guess after you see the letters.\n${dealText(who, round)}`;
  }

  if (!raw) {
    sessions.set(input.conversationId, round, now);
    return dealText(who, round);
  }

  if (!/^[a-z]+$/.test(raw)) {
    sessions.set(input.conversationId, round, now);
    return `${who} — ${SCRAMBLE_HELP}\n${dealText(who, round)}`;
  }

  if (raw === round.word) {
    const streak = round.streak + 1;
    const score = round.score + round.word.length * streak;
    const solved = round.word;
    round = deal(rng, streak, score, solved);
    sessions.set(input.conversationId, round, now);
    return `${who} solved ${solved.toUpperCase()}. Streak ${streak}. Round score ${score}.\nNext: ${spacedLetters(round.scrambled)}`;
  }

  const missed = round.word;
  const score = round.score;
  round = deal(rng, 0, score, missed);
  sessions.set(input.conversationId, round, now);
  return `${who} missed. It was ${missed.toUpperCase()}. Streak reset. Round score ${score}.\nNext: ${spacedLetters(round.scrambled)}`;
}

function deal(rng: Rng, streak: number, score: number, avoid?: string): ScrambleRound {
  const word = pickDifferent(SCRAMBLE_WORDS, rng, avoid);
  return {
    word,
    scrambled: scrambleLetters(word, rng),
    streak,
    score,
  };
}

function dealText(who: string, round: ScrambleRound): string {
  return `${who} — scramble: ${spacedLetters(round.scrambled)}\n${round.word.length} letters. Streak ${round.streak}. Round score ${round.score}. !scramble <word>`;
}
