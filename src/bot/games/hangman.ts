/**
 * Classic hangman. The word comes from a fixed list so neither player types it.
 * Solo is one guesser. A challenge alternates guesses and shares the lives.
 */
import { pickIndex, type Rng } from "./random.js";
import type { GamePlayer } from "./players.js";
import type { Seat } from "./tictactoe.js";

export const HANGMAN_LIVES = 6;

export const HANGMAN_HELP =
  "Solo: !hangman start. Challenge: !hangman @user or reply. They accept, or guess a letter to start. !hangman status shows lives and the word mask.";

export const HANGMAN_WORDS: readonly string[] = [
  "apple",
  "banana",
  "castle",
  "dragon",
  "engine",
  "forest",
  "garden",
  "hammer",
  "island",
  "jacket",
  "kitten",
  "lemon",
  "mirror",
  "needle",
  "orange",
  "pencil",
  "quartz",
  "rocket",
  "silver",
  "tiger",
  "umbrella",
  "violet",
  "window",
  "yellow",
  "bridge",
  "candle",
  "dolphin",
  "eagle",
  "flower",
  "guitar",
  "harbor",
  "insect",
  "jungle",
  "kettle",
  "lantern",
  "mountain",
  "notebook",
  "ocean",
  "planet",
  "quilt",
  "river",
  "saddle",
  "tunnel",
  "valley",
  "whale",
  "anchor",
  "button",
  "cloud",
];

export type HangmanState = {
  kind: "hangman";
  id: string;
  conversationId: string;
  mode: "solo" | "versus";
  phase: "pending" | "active";
  challenger: GamePlayer;
  opponent?: GamePlayer;
  word: string;
  guessed: string[];
  lives: number;
  turn?: Seat;
  createdAt: number;
  updatedAt: number;
};

export function pickHangmanWord(rng: Rng = Math.random): string {
  return HANGMAN_WORDS[pickIndex(HANGMAN_WORDS.length, rng)] ?? "apple";
}

export function emptyHangman(
  id: string,
  conversationId: string,
  challenger: GamePlayer,
  nowMs: number,
  word: string,
  opponent?: GamePlayer,
): HangmanState {
  return {
    kind: "hangman",
    id,
    conversationId,
    mode: opponent ? "versus" : "solo",
    phase: opponent ? "pending" : "active",
    challenger,
    opponent,
    word,
    guessed: [],
    lives: HANGMAN_LIVES,
    turn: opponent ? undefined : "challenger",
    createdAt: nowMs,
    updatedAt: nowMs,
  };
}

export type HangmanGuess =
  | { kind: "letter"; letter: string }
  | { kind: "word"; word: string };

/** One letter, or a whole word of at least two letters. Anything else is not a guess. */
export function parseHangmanGuess(input: string): HangmanGuess | undefined {
  const key = input.trim().toLowerCase();
  if (/^[a-z]$/.test(key)) return { kind: "letter", letter: key };
  if (/^[a-z]{2,}$/.test(key)) return { kind: "word", word: key };
  return undefined;
}

export function hangmanMask(word: string, guessed: readonly string[]): string {
  const known = new Set(guessed);
  return [...word].map((letter) => (known.has(letter) ? letter : "_")).join(" ");
}

export function hangmanSolved(word: string, guessed: readonly string[]): boolean {
  const known = new Set(guessed);
  return [...word].every((letter) => known.has(letter));
}

export function hangmanSeat(state: HangmanState, playerId: string): Seat | undefined {
  if (playerId === state.challenger.id) return "challenger";
  if (state.opponent && playerId === state.opponent.id) return "opponent";
  return undefined;
}

export function hangmanPlayer(state: HangmanState, seat: Seat): GamePlayer {
  if (seat === "challenger") return state.challenger;
  return state.opponent ?? state.challenger;
}
