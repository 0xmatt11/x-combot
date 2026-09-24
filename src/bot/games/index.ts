/**
 * Group chat games. Dice is the first one; add the next game as a sibling
 * module and wire its command next to `!dice` in the parser and engine.
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
