/**
 * European roulette, 0–36. Color pays 1:1. A single number, 0, or green
 * pays 35:1. There is no session; the spin is the whole turn.
 */
import { pickIndex, playerName } from "./random.js";
import {
  joinLines,
  parseStakeWords,
  payOut,
  placeBet,
  wordsOf,
  type CasinoContext,
  type FunBank,
} from "./stake.js";

export const ROULETTE_HELP =
  "Bet with !roulette red, !roulette black, !roulette 17, or !roulette 0. Add a stake: !roulette red 10 or !roulette 17 xp 5. Color pays 1:1. A number pays 35:1. Bets are 1–100. The default is 10 fun chips.";

const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

export type RouletteColor = "red" | "black" | "green";

export function rouletteColor(n: number): RouletteColor {
  if (n === 0) return "green";
  return RED.has(n) ? "red" : "black";
}

export function spinWheel(rng: () => number): number {
  return pickIndex(37, rng);
}

type Target =
  | { kind: "color"; color: "red" | "black" }
  | { kind: "number"; n: number };

export function playRoulette(fun: FunBank, ctx: CasinoContext, args: string): string {
  const words = wordsOf(args);
  if (words.length === 0 || words[0]!.toLowerCase() === "help") return ROULETTE_HELP;
  const target = parseTarget(words[0]!);
  if (!target) return ROULETTE_HELP;
  const stake = parseStakeWords(words.slice(1));
  if (!stake.ok) return ROULETTE_HELP;
  const opened = placeBet(fun, ctx, stake.stake);
  if (!opened.ok) return opened.text;

  const spin = spinWheel(ctx.rng);
  const color = rouletteColor(spin);
  const who = playerName(ctx.label);
  const win = target.kind === "color" ? color === target.color : spin === target.n;
  const multiplier = win ? (target.kind === "color" ? 2 : 36) : 0;
  const credit = opened.placed.stake.amount * multiplier;
  const named = target.kind === "color" ? target.color : String(target.n);
  const outcome = win
    ? `${who} wins${target.kind === "number" ? " 35:1" : ""}.`
    : "No win.";
  return joinLines([
    `🎡 ${who} bet ${named}. Spin: ${swatch(color)} ${spin} ${color}.`,
    outcome,
    payOut(fun, ctx, opened.placed, credit),
  ]);
}

function parseTarget(word: string): Target | undefined {
  const key = word.toLowerCase();
  if (key === "red" || key === "r") return { kind: "color", color: "red" };
  if (key === "black" || key === "b") return { kind: "color", color: "black" };
  if (key === "green" || key === "g" || key === "zero" || key === "0") return { kind: "number", n: 0 };
  if (!/^\d+$/.test(key)) return undefined;
  const n = Number(key);
  if (!Number.isSafeInteger(n) || n < 0 || n > 36) return undefined;
  return { kind: "number", n };
}

function swatch(color: RouletteColor): string {
  if (color === "red") return "🔴";
  if (color === "black") return "⚫";
  return "🟢";
}
