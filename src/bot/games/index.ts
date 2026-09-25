/**
 * Group chat games. Each game is a sibling module, wired next to `!dice`
 * in the parser and engine. `!games` prints the catalog.
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
export { HIGHERLOWER_HELP, higherLowerOpen, higherLowerReply } from "./higherlower.js";
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
  wouldYouRatherOpen,
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
export { gameLabel, gameLabelFromText, namedPlayer, splitLeadingMention } from "./players.js";
export type { GamePlayer } from "./players.js";
export { CONNECT4_COLS, CONNECT4_HELP, CONNECT4_ROWS, connect4Winner, parseConnect4Column } from "./connect4.js";
export { DUEL_HELP, DUEL_HP, parseDuelAction, rollD6 } from "./duel.js";
export {
  HANGMAN_HELP,
  HANGMAN_LIVES,
  HANGMAN_WORDS,
  hangmanMask,
  parseHangmanGuess,
  pickHangmanWord,
} from "./hangman.js";
export { STORY_HELP, STORY_MAX_CHARS, oneSentence, parseStoryArgs } from "./story.js";
export { TICTACTOE_HELP, parseTictactoeSquare, renderTictactoe, tictactoeWinner } from "./tictactoe.js";
export { CHALLENGE_TTL_MS, GameRoom, PLAY_TTL_MS, STORY_TTL_MS } from "./room.js";
export type { MultiplayerKind, PlayInput } from "./room.js";
export { CasinoTable, playCasino } from "./casino.js";
export type { CasinoGame } from "./casino.js";
export { BLACKJACK_HELP, playBlackjack } from "./blackjack.js";
export { CRASH_HELP, flyingCents, playCrash, rollCrashCents } from "./crash.js";
export { POKER_HELP, playPoker } from "./poker.js";
export { ROULETTE_HELP, playRoulette, rouletteColor, spinWheel } from "./roulette.js";
export { SLOTS_HELP, playSlots } from "./slots.js";
export { TRIVIA_HELP, TRIVIA_QUESTIONS, playTrivia } from "./trivia.js";
export {
  buildTriviaInterpretMessages,
  deterministicTriviaChoice,
  looksLikeTriviaAttempt,
  looseCasinoVerb,
  looseHigherLowerCall,
  looseWouldChoice,
  parseTriviaInterpret,
} from "./loose.js";
export { SHIP_HELP, compatibility, mergeMembers, resolveShipQuery, shipReply } from "./ship.js";
export { SESSION_TTL_MS, SessionMap } from "./session.js";
export {
  DEFAULT_BET,
  FUN_START,
  MAX_BET,
  MIN_BET,
} from "./stake.js";
export { blackjackTotal, evaluateFive } from "./cards.js";
