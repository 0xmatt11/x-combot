/**
 * Shared roll helper for stateless games. Dice keeps its own face mapping.
 * Player text still goes through `diceRollerLabel` so a game cannot print a
 * numeric user id by inventing a second naming path.
 */
import { diceRollerLabel, type Rng } from "./dice.js";

export type { Rng };

/**
 * Map an RNG sample onto `0 .. length-1`. Values outside `[0, 1)` are clamped
 * so a bad generator cannot walk off the list.
 */
export function pickIndex(length: number, rng: Rng = Math.random): number {
  if (length <= 1) return 0;
  const sample = rng();
  const unit = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0;
  const index = unit >= 1 ? length - 1 : Math.floor(unit * length);
  if (index < 0) return 0;
  if (index >= length) return length - 1;
  return index;
}

/** `@handle`, display name, or "someone". A snowflake passed as text is not a name. */
export function playerName(label: string): string {
  return diceRollerLabel({ name: label });
}
