/**
 * Dice notation and rolls. RNG is injectable so tests can pin every face.
 * More games should live as siblings of this file, not inside it.
 */

export const MAX_DICE = 20;
export const MAX_SIDES = 100;
export const MAX_MODIFIER = 1000;

export const DICE_HELP =
  "Roll with !dice (1d6), !dice 2d20, !dice d20, or !dice 1d6+2. Up to 20 dice and 100 sides.";

export type DiceSpec = {
  count: number;
  sides: number;
  modifier: number;
};

export type DiceRoll = {
  spec: DiceSpec;
  rolls: number[];
  total: number;
};

export type DiceParseResult =
  | { ok: true; spec: DiceSpec }
  | { ok: false; help: string };

export type Rng = () => number;

/** `NdM`, `dM` (N = 1), `N` (M = 6), optional `+K` / `-K`. Blank is 1d6. */
const NOTATION_RE = /^(?:(\d*)d(\d+)|(\d+))(?:\s*([+-])\s*(\d+))?$/i;

export function parseDiceNotation(input: string | undefined | null): DiceParseResult {
  const raw = input?.trim() ?? "";
  if (!raw) {
    return { ok: true, spec: { count: 1, sides: 6, modifier: 0 } };
  }

  const match = raw.match(NOTATION_RE);
  if (!match) return invalid();

  const count = readInt(match[1] && match[1].length > 0 ? match[1] : match[3], 1);
  const sides = readInt(match[2], 6);
  const modifier = readModifier(match[4], match[5]);
  if (count === undefined || sides === undefined || modifier === undefined) return invalid();
  if (count < 1 || count > MAX_DICE) return invalid();
  if (sides < 1 || sides > MAX_SIDES) return invalid();
  if (Math.abs(modifier) > MAX_MODIFIER) return invalid();

  return { ok: true, spec: { count, sides, modifier } };
}

export function rollDice(spec: DiceSpec, rng: Rng = Math.random): DiceRoll {
  const rolls: number[] = [];
  for (let i = 0; i < spec.count; i += 1) {
    rolls.push(rollFace(spec.sides, rng));
  }
  const subtotal = rolls.reduce((sum, face) => sum + face, 0);
  return { spec, rolls, total: subtotal + spec.modifier };
}

/**
 * `roller` is the same label other announcements use (`@handle`, display
 * name, or user id). A blank label becomes "someone".
 */
export function formatDiceRoll(roll: DiceRoll, roller: string): string {
  const { spec, rolls, total } = roll;
  const who = roller.trim() || "someone";
  const only = rolls[0];
  if (rolls.length === 1 && spec.modifier === 0 && only !== undefined) {
    return `🎲 ${who} rolled ${article(only)} ${only}`;
  }
  const shown = rolls.join(", ");
  const mod =
    spec.modifier === 0 ? "" : spec.modifier > 0 ? ` +${spec.modifier}` : ` ${spec.modifier}`;
  return `🎲 ${who} rolled ${shown}${mod} (total ${total})`;
}

/** Parse, roll, and format. Invalid notation returns the short usage line. */
export function diceReply(
  notation: string | undefined | null,
  roller: string,
  rng: Rng = Math.random,
): string {
  const parsed = parseDiceNotation(notation);
  if (!parsed.ok) return parsed.help;
  return formatDiceRoll(rollDice(parsed.spec, rng), roller);
}

function invalid(): DiceParseResult {
  return { ok: false, help: DICE_HELP };
}

function readInt(raw: string | undefined, fallback: number): number | undefined {
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) return undefined;
  return value;
}

function readModifier(sign: string | undefined, raw: string | undefined): number | undefined {
  if (!sign && (raw === undefined || raw === "")) return 0;
  if ((sign !== "+" && sign !== "-") || raw === undefined) return undefined;
  const magnitude = readInt(raw, Number.NaN);
  if (magnitude === undefined) return undefined;
  return sign === "-" ? -magnitude : magnitude;
}

/**
 * Map an RNG sample onto `1..sides`. Values outside `[0, 1)` are clamped
 * so a bad generator cannot produce a face past the die.
 */
function rollFace(sides: number, rng: Rng): number {
  const sample = rng();
  const unit = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0;
  const face = unit >= 1 ? sides : Math.floor(unit * sides) + 1;
  if (face < 1) return 1;
  if (face > sides) return sides;
  return face;
}

function article(n: number): "a" | "an" {
  if (n === 8 || (n >= 11 && n <= 18) || (n >= 80 && n <= 89)) return "an";
  return "a";
}
