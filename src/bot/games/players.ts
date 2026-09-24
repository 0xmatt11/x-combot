/**
 * Players in a chat game. The id stays inside the process.
 * Anything printed goes through `diceRollerLabel`, then a numeric-id check,
 * so a reply can only say `@handle`, a display name, or "someone".
 */
import { diceRollerLabel, type DiceIdentity } from "./dice.js";

export type GamePlayer = {
  /** Process-local identity. Never interpolate this into a chat reply. */
  id: string;
  label: string;
};

/** `@handle`, display name, or "someone". A numeric API user id is "someone". */
export function gameLabel(user: DiceIdentity | undefined): string {
  return hideNumericId(diceRollerLabel(user));
}

/** A label that was already resolved, checked again before it is stored. */
export function gameLabelFromText(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) return "someone";
  if (trimmed.startsWith("@")) return hideNumericId(diceRollerLabel({ username: trimmed }));
  return hideNumericId(diceRollerLabel({ name: trimmed }));
}

export function namedPlayer(id: string, label: string): GamePlayer {
  return { id, label: gameLabelFromText(label) };
}

/**
 * `@username` at the start of a game argument. The rest of the line is kept
 * so `!tictactoe @user` is a challenge and `!tictactoe 5` is a move.
 */
export function splitLeadingMention(args: string | undefined): {
  username?: string;
  rest: string;
} {
  const trimmed = args?.trim() ?? "";
  const match = trimmed.match(/^@([A-Za-z0-9_]{1,15})(?:\s+([\s\S]*))?$/);
  if (!match?.[1]) return { rest: trimmed };
  return { username: match[1], rest: match[2]?.trim() ?? "" };
}

function hideNumericId(label: string): string {
  const bare = label.trim().replace(/^@/, "");
  if (!bare || /^\d+$/.test(bare)) return "someone";
  return label;
}
