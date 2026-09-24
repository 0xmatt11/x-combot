/**
 * Group chat games. Each game is a sibling module. Wire its command next to
 * `!dice` in the parser and engine. `!games` is the catalog, including games
 * that are not registered yet.
 */
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
export { pickIndex, playerName } from "./random.js";
export { RPS_CHOICES, RPS_HELP, parseRpsChoice, rpsOutcome, rpsReply } from "./rps.js";
export type { RpsChoice, RpsOutcome } from "./rps.js";
