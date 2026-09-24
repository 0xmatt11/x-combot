/**
 * Three-reel slot machine. A pair returns the bet. Three of a kind pays
 * the multiplier below. Bets are fun chips unless the player says `xp`.
 */
import { pickIndex, playerName, type Rng } from "./random.js";
import {
  joinLines,
  parseStakeWords,
  payOut,
  placeBet,
  wordsOf,
  type CasinoContext,
  type FunBank,
} from "./stake.js";

export const SLOTS_HELP =
  "Spin with !slots, !slots 10 (fun chips), or !slots xp 10. Bets are 1–100. The default bet is 10 fun chips. A pair pushes. Three of a kind pays 4×, grapes 5×, diamonds 8×, sevens 10×.";

const REEL = [
  { face: "🍒", weight: 5, three: 4, name: "cherries" },
  { face: "🍋", weight: 4, three: 4, name: "lemons" },
  { face: "🍊", weight: 3, three: 4, name: "oranges" },
  { face: "🍇", weight: 2, three: 5, name: "grapes" },
  { face: "💎", weight: 1, three: 8, name: "diamonds" },
  { face: "7️⃣", weight: 1, three: 10, name: "sevens" },
] as const;

const WEIGHT = REEL.reduce((sum, row) => sum + row.weight, 0);

type Symbol = (typeof REEL)[number];

export function spinReel(rng: Rng): Symbol {
  const index = pickIndex(WEIGHT, rng);
  let cursor = 0;
  for (const row of REEL) {
    cursor += row.weight;
    if (index < cursor) return row;
  }
  return REEL[REEL.length - 1]!;
}

export function playSlots(fun: FunBank, ctx: CasinoContext, args: string): string {
  const parsed = parseStakeWords(wordsOf(args));
  if (!parsed.ok) return SLOTS_HELP;
  const placed = placeBet(fun, ctx, parsed.stake);
  if (!placed.ok) return placed.text;

  const reels = [spinReel(ctx.rng), spinReel(ctx.rng), spinReel(ctx.rng)];
  const faces = reels.map((row) => row.face);
  const counts = new Map<string, number>();
  for (const face of faces) counts.set(face, (counts.get(face) ?? 0) + 1);
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  const who = playerName(ctx.label);
  const shown = `🎰 ${who}  ${faces.join(" | ")}`;

  if (best && best[1] === 3) {
    const symbol = reels[0]!;
    const credit = placed.placed.stake.amount * symbol.three;
    return joinLines([
      shown,
      `Three ${symbol.name} — ${symbol.three}×.`,
      payOut(fun, ctx, placed.placed, credit),
    ]);
  }
  if (best && best[1] === 2) {
    const symbol = reels.find((row) => row.face === best[0])!;
    return joinLines([
      shown,
      `Pair of ${symbol.name} — push.`,
      payOut(fun, ctx, placed.placed, placed.placed.stake.amount),
    ]);
  }
  return joinLines([shown, "No match.", payOut(fun, ctx, placed.placed, 0)]);
}
