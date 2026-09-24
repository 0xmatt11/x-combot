/**
 * Group chat games. Each game is a sibling module. Wire its command next to
 * `!dice` in the parser and engine. `!games` is the catalog, including games
 * that are not registered yet.
 */
import { clearAnagramSessions } from "./anagram.js";
import { clearGuessSessions } from "./guess.js";
import { clearHigherLowerSessions } from "./higherlower.js";
import { clearScrambleSessions } from "./scramble.js";
import { clearTruthOrDareSessions } from "./truthordare.js";
import { clearWordleSessions } from "./wordle.js";
import { clearWouldYouRatherSessions } from "./wouldyourather.js";
export {
  DICE_HELP,
  MAX_DICE,
  MAX_MODIFIER,
  MAX_SIDES,
  diceReply,
  diceRollerLabel,
  formatDiceRoll,
  parseDiceNotation,
  resolveDiceRoller,
  rollDice,
} from "./dice.js";
export type { DiceIdentity, DiceParseResult, DiceRoll, DiceSpec, Rng } from "./dice.js";
export { COIN_HELP, COIN_SIDES, coinflipReply, parseCoinCall } from "./coinflip.js";
export type { CoinCallResult, CoinSide } from "./coinflip.js";
export { EIGHT_BALL_ANSWERS, EIGHT_BALL_HELP, eightBallReply } from "./eightball.js";
export type { EightBallAnswer, EightBallTone } from "./eightball.js";
export { GAME_CATALOG, gamesMenu } from "./menu.js";
export type { GameCatalogEntry, GameCatalogGroup } from "./menu.js";
export {
  MINESWEEPER_HELP,
  MINESWEEPER_SIZES,
  MINESWEEPER_TIMEOUT_MS,
  minesweeperReply,
  minesweeperSnapshot,
  parseMinesweeperCommand,
  resetMinesweeperBoards,
} from "./minesweeper.js";
export type {
  MinesweeperCommand,
  MinesweeperDifficulty,
  MinesweeperSnapshot,
  MinesweeperStatus,
} from "./minesweeper.js";
export { pickIndex, playerName } from "./random.js";
export { RPS_CHOICES, RPS_HELP, parseRpsChoice, rpsOutcome, rpsReply } from "./rps.js";
export type { RpsChoice, RpsOutcome } from "./rps.js";
export {
  ANAGRAM_HELP,
  ANAGRAM_MAX_MISSES,
  ANAGRAM_MISS_PENALTY,
  ANAGRAM_POINTS_PER_LETTER,
  ANAGRAM_WORDS,
  anagramReply,
  anagramScore,
} from "./anagram.js";
export {
  GUESS_HELP,
  GUESS_RANGES,
  guessAttemptCap,
  guessReply,
} from "./guess.js";
export { HIGHERLOWER_HELP, higherLowerReply } from "./higherlower.js";
export { scrambleLetters, spacedLetters } from "./letters.js";
export { SCRAMBLE_HELP, SCRAMBLE_WORDS, scrambleReply } from "./scramble.js";
export { GAME_IDLE_MS } from "./sessions.js";
export {
  DARE_PROMPTS,
  TRUTH_OR_DARE_HELP,
  TRUTH_OR_DARE_LIMIT,
  TRUTH_OR_DARE_MINOR,
  TRUTH_PROMPTS,
  truthOrDareReply,
} from "./truthordare.js";
export {
  WORDLE_ANSWERS,
  WORDLE_GUESSES,
  WORDLE_HELP,
  dailyWordleWord,
  formatWordleMarks,
  markWordleGuess,
  wordleReply,
} from "./wordle.js";
export type { LetterMark } from "./wordle.js";
export {
  WOULD_YOU_RATHER,
  WOULD_YOU_RATHER_HELP,
  wouldYouRatherReply,
} from "./wouldyourather.js";

export {
  clearAnagramSessions,
  clearGuessSessions,
  clearHigherLowerSessions,
  clearScrambleSessions,
  clearTruthOrDareSessions,
  clearWordleSessions,
  clearWouldYouRatherSessions,
};

export function clearWordGameSessions(): void {
  clearWordleSessions();
  clearAnagramSessions();
  clearScrambleSessions();
  clearGuessSessions();
  clearHigherLowerSessions();
  clearWouldYouRatherSessions();
  clearTruthOrDareSessions();
}
