/**
 * One 5-letter puzzle per chat. The first round of a UTC day is the daily
 * word. After a win or a full board, `!wordle` deals a practice round.
 * Marks are the words correct, present, and absent.
 */
import { pickIndex, playerName, type Rng } from "./random.js";
import { GameSessions, utcDay } from "./sessions.js";

export const WORDLE_GUESSES = 6;

export const WORDLE_HELP =
  "Daily 5-letter puzzle: !wordle, then !wordle <word>. After it ends, !wordle starts a practice round. Marks are correct, present, or absent.";

export const WORDLE_ANSWERS = [
  "crane",
  "slate",
  "brick",
  "pound",
  "flame",
  "crisp",
  "ghost",
  "maple",
  "pride",
  "stone",
  "brave",
  "climb",
  "dwarf",
  "elbow",
  "fjord",
  "grape",
  "honey",
  "ivory",
  "jumbo",
  "knack",
  "light",
  "moist",
  "nymph",
  "olive",
  "plush",
  "queen",
  "ridge",
  "shark",
  "tiger",
  "ultra",
  "vivid",
  "whale",
  "xenon",
  "yacht",
  "zebra",
  "audio",
  "blush",
  "cabin",
  "dance",
  "eagle",
  "fancy",
  "giant",
  "house",
  "inbox",
  "jolly",
  "apple",
  "puppy",
  "wheel",
  "baker",
  "candy",
  "delta",
  "ember",
  "frost",
  "globe",
  "habit",
  "trace",
] as const;

const ANSWERS = new Set<string>(WORDLE_ANSWERS);

export type LetterMark = "correct" | "present" | "absent";

type GuessRow = {
  player: string;
  guess: string;
  marks: LetterMark[];
};

type WordleRound = {
  mode: "daily" | "practice";
  day: string;
  word: string;
  guesses: GuessRow[];
  status: "open" | "won" | "lost";
};

const sessions = new GameSessions<WordleRound>();

export function clearWordleSessions(): void {
  sessions.clear();
}

export function dailyWordleWord(conversationId: string, nowMs: number): string {
  const index = hashIndex(`${utcDay(nowMs)}:${conversationId}`, WORDLE_ANSWERS.length);
  return WORDLE_ANSWERS[index]!;
}

/**
 * Greens are taken first. A later repeat is present only while the answer
 * still has an unused copy of that letter.
 */
export function markWordleGuess(guess: string, answer: string): LetterMark[] {
  const marks: LetterMark[] = Array.from({ length: guess.length }, () => "absent");
  const remaining = new Map<string, number>();
  for (let i = 0; i < answer.length; i += 1) {
    const letter = answer[i]!;
    if (guess[i] === letter) marks[i] = "correct";
    else remaining.set(letter, (remaining.get(letter) ?? 0) + 1);
  }
  for (let i = 0; i < guess.length; i += 1) {
    if (marks[i] === "correct") continue;
    const letter = guess[i]!;
    const left = remaining.get(letter) ?? 0;
    if (left > 0) {
      remaining.set(letter, left - 1);
      marks[i] = "present";
    }
  }
  return marks;
}

export function formatWordleMarks(guess: string, marks: readonly LetterMark[]): string {
  return [...guess.toUpperCase()].map((letter, index) => `${letter}=${marks[index]}`).join(" ");
}

export function wordleReply(input: {
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
  let round = currentRound(input.conversationId, now);

  if (!round || (round.mode === "daily" && round.day !== utcDay(now))) {
    if (raw && !/^[a-z]{5}$/.test(raw)) return `${who} — ${WORDLE_HELP}`;
    round = startDaily(input.conversationId, now);
    sessions.set(input.conversationId, round, now);
    if (!raw) return openText(who, round);
  }

  if (round.status !== "open") {
    if (raw) return `${who} — that round is over. Send !wordle for a practice round.`;
    round = startPractice(now, rng, round.word);
    sessions.set(input.conversationId, round, now);
    return openText(who, round);
  }

  if (!raw) {
    sessions.set(input.conversationId, round, now);
    return boardText(who, round);
  }

  if (!/^[a-z]{5}$/.test(raw)) {
    sessions.set(input.conversationId, round, now);
    return `${who} — guess a 5-letter word. Example: !wordle crane\n${boardText(who, round)}`;
  }

  if (!ANSWERS.has(raw)) {
    sessions.set(input.conversationId, round, now);
    return `${who} — ${raw} isn't in the word list.\n${boardText(who, round)}`;
  }

  const marks = markWordleGuess(raw, round.word);
  round.guesses.push({ player: who, guess: raw, marks });
  if (marks.every((mark) => mark === "correct")) round.status = "won";
  else if (round.guesses.length >= WORDLE_GUESSES) round.status = "lost";
  sessions.set(input.conversationId, round, now);

  if (round.status === "won") {
    const count = round.guesses.length;
    const kind = round.mode === "daily" ? "daily Wordle" : "practice Wordle";
    return `${who} solved the ${kind} in ${count} ${count === 1 ? "guess" : "guesses"}. The word was ${round.word.toUpperCase()}.`;
  }
  if (round.status === "lost") {
    return `${who} — out of guesses. The word was ${round.word.toUpperCase()}.\nSend !wordle for a practice round.`;
  }
  const kind = round.mode === "daily" ? "daily" : "practice";
  return `${who} — ${kind} Wordle ${round.guesses.length}/${WORDLE_GUESSES}\n${formatWordleMarks(raw, marks)}`;
}

function currentRound(conversationId: string, nowMs: number): WordleRound | undefined {
  return sessions.get(conversationId, nowMs);
}

function startDaily(conversationId: string, nowMs: number): WordleRound {
  return {
    mode: "daily",
    day: utcDay(nowMs),
    word: dailyWordleWord(conversationId, nowMs),
    guesses: [],
    status: "open",
  };
}

function startPractice(nowMs: number, rng: Rng, avoid: string): WordleRound {
  const index = pickIndex(WORDLE_ANSWERS.length, rng);
  let word = WORDLE_ANSWERS[index]!;
  if (word === avoid) word = WORDLE_ANSWERS[(index + 1) % WORDLE_ANSWERS.length]!;
  return {
    mode: "practice",
    day: utcDay(nowMs),
    word,
    guesses: [],
    status: "open",
  };
}

function openText(who: string, round: WordleRound): string {
  const kind = round.mode === "daily" ? "daily" : "practice";
  return `${who} — ${kind} Wordle. ${WORDLE_GUESSES} guesses, 5 letters.\nGuess with !wordle <word>. Marks: correct, present, absent.`;
}

function boardText(who: string, round: WordleRound): string {
  const kind = round.mode === "daily" ? "daily" : "practice";
  const lines = [`${who} — ${kind} Wordle ${round.guesses.length}/${WORDLE_GUESSES}`];
  for (const row of round.guesses) {
    lines.push(`${row.player} ${formatWordleMarks(row.guess, row.marks)}`);
  }
  lines.push("Guess with !wordle <word>. Marks: correct, present, absent.");
  return lines.join("\n");
}

function hashIndex(key: string, length: number): number {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % length;
}
