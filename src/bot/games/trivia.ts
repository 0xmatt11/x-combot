/**
 * Multiple-choice trivia. One open question per conversation, so anyone
 * in the chat can answer the question that was just posted. The score stays
 * per player, in memory, and is printed with labels, never ids.
 */
import { pickIndex, playerName } from "./random.js";
import type { SessionMap } from "./session.js";
import { joinLines, playerKey, wordsOf, type CasinoContext } from "./stake.js";

export const TRIVIA_TTL_MS = 2 * 60 * 1000;

export const TRIVIA_HELP =
  "Ask with !trivia. One question is open for the chat, and anyone can answer with a, !a, !trivia c, or a short phrase. !trivia score shows the score for this chat.";

export type TriviaQuestion = {
  prompt: string;
  choices: readonly [string, string, string, string];
  answer: 0 | 1 | 2 | 3;
};

export const TRIVIA_QUESTIONS: readonly TriviaQuestion[] = [
  { prompt: "How many sides does a standard die have?", choices: ["4", "6", "8", "12"], answer: 1 },
  { prompt: "What is 2 + 2?", choices: ["3", "4", "5", "22"], answer: 1 },
  { prompt: "Which planet is closest to the sun?", choices: ["Venus", "Mars", "Mercury", "Earth"], answer: 2 },
  { prompt: "How many minutes are in an hour?", choices: ["30", "60", "90", "100"], answer: 1 },
  { prompt: "What color is a clear daytime sky?", choices: ["Green", "Blue", "Red", "Yellow"], answer: 1 },
  { prompt: "How many letters are in the English alphabet?", choices: ["24", "25", "26", "27"], answer: 2 },
  { prompt: "Which month has 28 days in a common year?", choices: ["January", "February", "April", "June"], answer: 1 },
  { prompt: "What is the boiling point of water in Celsius?", choices: ["0", "32", "100", "212"], answer: 2 },
  { prompt: "How many degrees are in a right angle?", choices: ["45", "90", "180", "360"], answer: 1 },
  { prompt: "Which animal says meow?", choices: ["Dog", "Cow", "Cat", "Duck"], answer: 2 },
  { prompt: "What is the capital of France?", choices: ["Lyon", "Paris", "Nice", "Lille"], answer: 1 },
  { prompt: "How many cards are in a standard deck?", choices: ["36", "48", "52", "54"], answer: 2 },
  { prompt: "Which way does a compass needle point?", choices: ["South", "East", "West", "North"], answer: 3 },
  { prompt: "What is 10 × 10?", choices: ["20", "100", "1000", "110"], answer: 1 },
  { prompt: "How many wheels does a bicycle have?", choices: ["1", "2", "3", "4"], answer: 1 },
  {
    prompt: "Which gas do plants take in for photosynthesis?",
    choices: ["Oxygen", "Nitrogen", "Carbon dioxide", "Helium"],
    answer: 2,
  },
];

const LETTERS = ["a", "b", "c", "d"] as const;

export type TriviaRound = {
  index: number;
  /** Label of the player who asked. Reprints keep this name. */
  askerLabel: string;
};

export type TriviaScore = {
  correct: number;
  wrong: number;
  label: string;
  lastIndex?: number;
};

export class TriviaBook {
  private readonly scores = new Map<string, TriviaScore>();

  get(key: string): TriviaScore | undefined {
    return this.scores.get(key);
  }

  put(key: string, score: TriviaScore): void {
    this.scores.delete(key);
    this.scores.set(key, score);
    while (this.scores.size > 2_000) {
      const oldest = this.scores.keys().next().value;
      if (oldest === undefined) break;
      this.scores.delete(oldest);
    }
  }

  /** Scores in one conversation, highest correct first. Skips anyone still at 0–0. */
  board(conversationId: string): { label: string; correct: number; wrong: number }[] {
    const prefix = `${conversationId}\u0000`;
    const rows: { label: string; correct: number; wrong: number }[] = [];
    for (const [key, score] of this.scores) {
      if (!key.startsWith(prefix)) continue;
      if (score.correct === 0 && score.wrong === 0) continue;
      rows.push({ label: playerName(score.label), correct: score.correct, wrong: score.wrong });
    }
    rows.sort((a, b) => b.correct - a.correct || a.wrong - b.wrong || a.label.localeCompare(b.label));
    return rows.slice(0, 8);
  }
}

export function playTrivia(
  sessions: SessionMap<TriviaRound>,
  book: TriviaBook,
  ctx: CasinoContext,
  args: string,
): string {
  const action = parseTriviaArgs(args);
  if (action.kind === "help") return TRIVIA_HELP;
  const scoreKey = playerKey(ctx);
  if (action.kind === "score") return scoreText(book, ctx, scoreKey);

  const sessionKey = ctx.conversationId;
  const existing = sessions.take(sessionKey, ctx.nowMs);
  if (action.kind === "answer") {
    if (existing.status === "expired") {
      return "That question expired. Ask again with !trivia.";
    }
    if (existing.status === "missing") return "No trivia question. Ask with !trivia.";
    sessions.delete(sessionKey);
    return answer(book, ctx, scoreKey, existing.value.index, action.choice);
  }

  if (existing.status === "live") {
    sessions.touch(sessionKey, ctx.nowMs);
    return askText(existing.value.askerLabel, existing.value.index);
  }
  const last = book.get(scoreKey)?.lastIndex;
  let index = pickIndex(TRIVIA_QUESTIONS.length, ctx.rng);
  if (last !== undefined && index === last && TRIVIA_QUESTIONS.length > 1) {
    index = (index + 1) % TRIVIA_QUESTIONS.length;
  }
  const prior = book.get(scoreKey);
  book.put(scoreKey, {
    correct: prior?.correct ?? 0,
    wrong: prior?.wrong ?? 0,
    label: ctx.label,
    lastIndex: index,
  });
  sessions.set(sessionKey, { index, askerLabel: ctx.label }, ctx.nowMs);
  const expired = existing.status === "expired" ? "That question expired." : undefined;
  return joinLines([expired, askText(ctx.label, index)]);
}

function answer(
  book: TriviaBook,
  ctx: CasinoContext,
  key: string,
  index: number,
  choice: number,
): string {
  const question = TRIVIA_QUESTIONS[index] ?? TRIVIA_QUESTIONS[0]!;
  const prior = book.get(key);
  const correct = prior?.correct ?? 0;
  const wrong = prior?.wrong ?? 0;
  const right = choice === question.answer;
  const next = {
    correct: correct + (right ? 1 : 0),
    wrong: wrong + (right ? 0 : 1),
    label: ctx.label,
    lastIndex: index,
  };
  book.put(key, next);
  const letter = LETTERS[question.answer]!;
  const who = playerName(ctx.label);
  const verdict = right
    ? `${who} — correct.`
    : `${who} — nope. The answer was ${letter}) ${question.choices[question.answer]}.`;
  return joinLines([verdict, `${who}: ${next.correct} right, ${next.wrong} wrong.`]);
}

function askText(label: string, index: number): string {
  const question = TRIVIA_QUESTIONS[index] ?? TRIVIA_QUESTIONS[0]!;
  const lines = [`❓ ${playerName(label)}`, question.prompt];
  question.choices.forEach((choice, i) => {
    lines.push(`${LETTERS[i]}) ${choice}`);
  });
  lines.push("Reply a, !a, or a short phrase.");
  return lines.join("\n");
}

function scoreText(book: TriviaBook, ctx: CasinoContext, key: string): string {
  const mine = book.get(key);
  const who = playerName(ctx.label);
  const self = mine
    ? `${who}: ${mine.correct} right, ${mine.wrong} wrong.`
    : `${who}: no trivia score yet.`;
  const board = book.board(ctx.conversationId);
  if (board.length === 0) return self;
  const lines = [self, "This chat:"];
  board.forEach((row, index) => {
    lines.push(`${index + 1}. ${row.label} — ${row.correct} right, ${row.wrong} wrong`);
  });
  return lines.join("\n");
}

function parseTriviaArgs(
  args: string,
): { kind: "ask" | "score" | "help" } | { kind: "answer"; choice: number } {
  const words = wordsOf(args);
  if (words.length === 0) return { kind: "ask" };
  if (words.length !== 1) return { kind: "help" };
  const word = words[0]!.toLowerCase();
  if (word === "help") return { kind: "help" };
  if (word === "score" || word === "scores") return { kind: "score" };
  const letter = LETTERS.indexOf(word as (typeof LETTERS)[number]);
  if (letter >= 0) return { kind: "answer", choice: letter };
  if (/^[1-4]$/.test(word)) return { kind: "answer", choice: Number(word) - 1 };
  return { kind: "help" };
}
