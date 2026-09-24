/**
 * A two-sided coin. No call just reports the flip. A call is heads or tails.
 */
import { pickIndex, playerName, type Rng } from "./random.js";

export const COIN_HELP =
  "Flip with !coinflip, or call it: !coinflip heads or !coinflip tails. !flip works too.";

export const COIN_SIDES = ["heads", "tails"] as const;
export type CoinSide = (typeof COIN_SIDES)[number];

const ALIASES: Record<string, CoinSide> = {
  heads: "heads",
  head: "heads",
  h: "heads",
  tails: "tails",
  tail: "tails",
  t: "tails",
};

export type CoinCallResult =
  | { ok: true; call?: CoinSide }
  | { ok: false; help: string };

/** Blank is a plain flip. Anything other than one side word is usage. */
export function parseCoinCall(input: string | undefined | null): CoinCallResult {
  const key = input?.trim().toLowerCase() ?? "";
  if (!key) return { ok: true };
  if (/\s/.test(key)) return { ok: false, help: COIN_HELP };
  const call = ALIASES[key];
  if (!call) return { ok: false, help: COIN_HELP };
  return { ok: true, call };
}

export function coinflipReply(
  call: string | undefined | null,
  player: string,
  rng: Rng = Math.random,
): string {
  const parsed = parseCoinCall(call);
  if (!parsed.ok) return parsed.help;
  const side = COIN_SIDES[pickIndex(COIN_SIDES.length, rng)]!;
  const who = playerName(player);
  if (!parsed.call) return `🪙 ${who} flipped ${side}.`;
  const result = parsed.call === side ? `${who} wins.` : "I win.";
  return `🪙 ${who} called ${parsed.call}. It's ${side}. ${result}`;
}
