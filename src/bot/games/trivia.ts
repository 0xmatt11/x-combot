/**
 * Multiple-choice trivia. One open question per conversation, so anyone
 * in the chat can answer the question that was just posted. The score stays
 * per player. The difficulty stays with the conversation: one shared
 * question cannot be a different tier for each player. Both live in memory
 * until the process restarts.
 *
 * The first `!trivia` in a chat asks for a tier before it deals. After that,
 * a new round uses the saved tier. `!trivia` while a question is open
 * reprints it. `!trivia difficulty` asks again. `!trivia hard` switches the
 * tier for the next question.
 */
import { pickIndex, playerName } from "./random.js";
import type { SessionMap } from "./session.js";
import { joinLines, playerKey, wordsOf, type CasinoContext } from "./stake.js";
import {
  TRIVIA_DIFFICULTIES,
  TRIVIA_DIFFICULTY_WORDS,
  TRIVIA_QUESTIONS,
  triviaDifficultyByRank,
  triviaDifficultyLabel,
  type TriviaDifficulty,
  type TriviaQuestion,
} from "./trivia-bank.js";

export {
  TRIVIA_DIFFICULTIES,
  TRIVIA_DIFFICULTY_WORDS,
  TRIVIA_QUESTIONS,
  triviaDifficultyByRank,
  triviaDifficultyLabel,
};
export type { TriviaDifficulty, TriviaQuestion };

export const TRIVIA_TTL_MS = 2 * 60 * 1000;

export const TRIVIA_HELP =
  "Ask with !trivia. The first time in a chat, pick Easy, Medium, Hard, Expert, Master, or Insane (1–6 or !trivia hard). One question is open for the chat, and anyone can answer with a, !a, !trivia c, or a short phrase. !trivia score shows the score. !trivia difficulty changes the tier.";

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

type TriviaChat = {
  difficulty?: TriviaDifficulty;
  awaiting: boolean;
  lastIndex?: number;
};

type TriviaAction =
  | { kind: "ask" | "score" | "help" | "menu" }
  | { kind: "answer"; choice: number }
  | { kind: "digit"; digit: number }
  | { kind: "difficulty"; difficulty: TriviaDifficulty };

export class TriviaBook {
  private readonly scores = new Map<string, TriviaScore>();
  private readonly chats = new Map<string, TriviaChat>();

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

  difficultyOf(conversationId: string): TriviaDifficulty | undefined {
    return this.chats.get(conversationId)?.difficulty;
  }

  /** True after the bot asked for a tier and nobody has picked yet. */
  awaitingDifficulty(conversationId: string): boolean {
    return this.chats.get(conversationId)?.awaiting === true;
  }

  lastIndex(conversationId: string): number | undefined {
    return this.chats.get(conversationId)?.lastIndex;
  }

  markAwaiting(conversationId: string): void {
    const prior = this.chats.get(conversationId);
    this.putChat(conversationId, {
      difficulty: prior?.difficulty,
      awaiting: true,
      lastIndex: prior?.lastIndex,
    });
  }

  setDifficulty(conversationId: string, difficulty: TriviaDifficulty): void {
    const prior = this.chats.get(conversationId);
    this.putChat(conversationId, {
      difficulty,
      awaiting: false,
      lastIndex: prior?.lastIndex,
    });
  }

  rememberQuestion(conversationId: string, index: number): void {
    const prior = this.chats.get(conversationId);
    this.putChat(conversationId, {
      difficulty: prior?.difficulty,
      awaiting: false,
      lastIndex: index,
    });
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

  private putChat(conversationId: string, chat: TriviaChat): void {
    this.chats.delete(conversationId);
    this.chats.set(conversationId, chat);
    while (this.chats.size > 2_000) {
      const oldest = this.chats.keys().next().value;
      if (oldest === undefined) break;
      this.chats.delete(oldest);
    }
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

  if (action.kind === "menu") {
    book.markAwaiting(ctx.conversationId);
    return difficultyMenu(book.difficultyOf(ctx.conversationId));
  }

  if (action.kind === "digit") {
    if (existing.status === "live" && action.digit <= 4) {
      sessions.delete(sessionKey);
      return answer(book, ctx, scoreKey, existing.value.index, action.digit - 1);
    }
    const difficulty = triviaDifficultyByRank(action.digit);
    if (!difficulty) return TRIVIA_HELP;
    return applyDifficulty(sessions, book, ctx, scoreKey, sessionKey, existing, difficulty);
  }

  if (action.kind === "difficulty") {
    return applyDifficulty(sessions, book, ctx, scoreKey, sessionKey, existing, action.difficulty);
  }

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

  const saved = book.difficultyOf(ctx.conversationId);
  if (!saved) {
    book.markAwaiting(ctx.conversationId);
    const expired = existing.status === "expired" ? "That question expired." : undefined;
    return joinLines([expired, difficultyMenu()]);
  }
  return deal(sessions, book, ctx, scoreKey, sessionKey, existing, saved);
}

function applyDifficulty(
  sessions: SessionMap<TriviaRound>,
  book: TriviaBook,
  ctx: CasinoContext,
  scoreKey: string,
  sessionKey: string,
  existing: ReturnType<SessionMap<TriviaRound>["take"]>,
  difficulty: TriviaDifficulty,
): string {
  book.setDifficulty(ctx.conversationId, difficulty);
  if (existing.status === "live") {
    const label = triviaDifficultyLabel(difficulty);
    return `This chat is now on ${label}. The next question uses it.`;
  }
  return deal(sessions, book, ctx, scoreKey, sessionKey, existing, difficulty);
}

function deal(
  sessions: SessionMap<TriviaRound>,
  book: TriviaBook,
  ctx: CasinoContext,
  scoreKey: string,
  sessionKey: string,
  existing: ReturnType<SessionMap<TriviaRound>["take"]>,
  difficulty: TriviaDifficulty,
): string {
  const index = pickQuestionIndex(difficulty, ctx, book.lastIndex(ctx.conversationId));
  const prior = book.get(scoreKey);
  book.put(scoreKey, {
    correct: prior?.correct ?? 0,
    wrong: prior?.wrong ?? 0,
    label: ctx.label,
    lastIndex: index,
  });
  book.rememberQuestion(ctx.conversationId, index);
  sessions.set(sessionKey, { index, askerLabel: ctx.label }, ctx.nowMs);
  const expired = existing.status === "expired" ? "That question expired." : undefined;
  return joinLines([expired, askText(ctx.label, index)]);
}

function pickQuestionIndex(difficulty: TriviaDifficulty, ctx: CasinoContext, last?: number): number {
  const pool: number[] = [];
  TRIVIA_QUESTIONS.forEach((question, index) => {
    if (question.difficulty === difficulty) pool.push(index);
  });
  if (pool.length === 0) return 0;
  let index = pool[pickIndex(pool.length, ctx.rng)]!;
  if (last !== undefined && index === last && pool.length > 1) {
    const at = pool.indexOf(last);
    const from = at >= 0 ? at : 0;
    index = pool[(from + 1) % pool.length]!;
  }
  return index;
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
  const tier = triviaDifficultyLabel(question.difficulty);
  const lines = [`❓ ${playerName(label)} · ${tier}`, question.prompt];
  question.choices.forEach((choice, i) => {
    lines.push(`${LETTERS[i]}) ${choice}`);
  });
  lines.push("Reply a, !a, or a short phrase.");
  return lines.join("\n");
}

function difficultyMenu(current?: TriviaDifficulty): string {
  const lead = current
    ? `This chat is on ${triviaDifficultyLabel(current)}. Pick a tier. The next question uses it.`
    : "How hard? This chat keeps the tier.";
  const lines = [lead];
  for (const row of TRIVIA_DIFFICULTIES) {
    lines.push(`${row.rank} ${row.label}`);
  }
  lines.push("Reply 1–6, a name, or !trivia easy.");
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

function parseTriviaArgs(args: string): TriviaAction {
  const words = wordsOf(args);
  if (words.length === 0) return { kind: "ask" };
  if (words.length !== 1) return { kind: "help" };
  const word = words[0]!.toLowerCase();
  if (word === "help") return { kind: "help" };
  if (word === "score" || word === "scores") return { kind: "score" };
  if (word === "difficulty" || word === "level" || word === "diff") return { kind: "menu" };
  const letter = LETTERS.indexOf(word as (typeof LETTERS)[number]);
  if (letter >= 0) return { kind: "answer", choice: letter };
  if (/^[1-6]$/.test(word)) return { kind: "digit", digit: Number(word) };
  const named = TRIVIA_DIFFICULTY_WORDS[word];
  if (named) return { kind: "difficulty", difficulty: named };
  return { kind: "help" };
}
