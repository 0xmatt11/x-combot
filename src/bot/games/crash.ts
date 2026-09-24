/**
 * Crash multiplier. A live round climbs with wall-clock time; `!crash out`
 * cashes the current multiplier if the round has not crashed yet.
 * `!crash auto 2.50` resolves in one message. The crash point is hidden
 * until the round ends. You win only when your multiplier is below it.
 */
import { playerName, type Rng } from "./random.js";
import type { SessionMap } from "./session.js";
import {
  expiredBet,
  heldBalance,
  joinLines,
  parseStakeWords,
  payOut,
  placeBet,
  playerKey,
  wordsOf,
  type CasinoContext,
  type FunBank,
  type PlacedBet,
  type Stake,
} from "./stake.js";

export const CRASH_HELP =
  "Launch with !crash, !crash 10, or !crash xp 10. Cash out with !crash out. Or settle now: !crash auto 2.50. The multiplier starts at 1.00× and climbs. Bets are 1–100. The default is 10 fun chips.";

export const CRASH_EDGE = 0.97;
export const CRASH_MAX = 100;

export type CrashRound = {
  pointCents: number;
  startedAt: number;
  stake: Stake;
};

export function rollCrashCents(rng: Rng): number {
  const sample = rng();
  const unit = Number.isFinite(sample) ? Math.min(0.999999, Math.max(0.000001, sample)) : 0.5;
  const raw = Math.floor((CRASH_EDGE / unit) * 100 + 1e-6);
  return Math.min(CRASH_MAX * 100, Math.max(100, raw));
}

/** Multiplier in cents. 1.00× at the start, then exponential, capped at 100×. */
export function flyingCents(elapsedMs: number): number {
  const elapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  const cents = Math.floor(Math.exp(elapsed / 8_000) * 100);
  return Math.min(CRASH_MAX * 100, Math.max(100, cents));
}

export function playCrash(
  sessions: SessionMap<CrashRound>,
  fun: FunBank,
  ctx: CasinoContext,
  args: string,
): string {
  const action = parseCrashArgs(args);
  if (action.kind === "help") return CRASH_HELP;
  const key = playerKey(ctx);
  const existing = sessions.take(key, ctx.nowMs);

  if (action.kind === "out") {
    if (existing.status === "expired") {
      return `${expiredBet("crash round", existing.value.stake)} Launch again with !crash.`;
    }
    if (existing.status === "missing") return "No crash round. Start with !crash.";
    return cashOut(sessions, fun, ctx, key, existing.value);
  }

  if (existing.status === "live") {
    sessions.touch(key, ctx.nowMs);
    return `🚀 ${playerName(ctx.label)} is still flying. Cash out with !crash out.`;
  }

  const note = existing.status === "expired" ? expiredBet("crash round", existing.value.stake) : undefined;
  const opened = placeBet(fun, ctx, action.stake);
  if (!opened.ok) return joinLines([note, opened.text]);

  const pointCents = rollCrashCents(ctx.rng);
  if (action.kind === "auto") {
    return joinLines([note, settle(fun, ctx, opened.placed, action.targetCents, pointCents, "auto")]);
  }

  sessions.set(
    key,
    { pointCents, startedAt: ctx.nowMs, stake: opened.placed.stake },
    ctx.nowMs,
  );
  return joinLines([
    note,
    `🚀 ${playerName(ctx.label)} — flying from 1.00×. Cash out with !crash out.`,
    heldBalance(opened.placed),
  ]);
}

function cashOut(
  sessions: SessionMap<CrashRound>,
  fun: FunBank,
  ctx: CasinoContext,
  key: string,
  round: CrashRound,
): string {
  sessions.delete(key);
  const current = flyingCents(ctx.nowMs - round.startedAt);
  const placed = settlement(fun, ctx, round.stake);
  return settle(fun, ctx, placed, current, round.pointCents, "live");
}

function settle(
  fun: FunBank,
  ctx: CasinoContext,
  placed: PlacedBet,
  cashCents: number,
  pointCents: number,
  mode: "auto" | "live",
): string {
  const who = playerName(ctx.label);
  const crashed = cashCents >= pointCents;
  if (crashed) {
    const when = mode === "auto" ? `at ${formatCents(cashCents)}×` : `before ${formatCents(cashCents)}×`;
    return joinLines([
      `🚀 ${who} — crashed at ${formatCents(pointCents)}× ${when}.`,
      payOut(fun, ctx, placed, 0),
    ]);
  }
  const credit = Math.floor((placed.stake.amount * cashCents) / 100);
  return joinLines([
    `🚀 ${who} cashed out at ${formatCents(cashCents)}× (crashed at ${formatCents(pointCents)}×).`,
    payOut(fun, ctx, placed, credit),
  ]);
}

function settlement(fun: FunBank, ctx: CasinoContext, stake: Stake): PlacedBet {
  if (stake.kind === "xp") {
    return {
      stake,
      before: Math.max(0, Math.floor(ctx.xp.get())) + stake.amount,
      refilled: false,
    };
  }
  return { stake, before: fun.get(playerKey(ctx)) + stake.amount, refilled: false };
}

function formatCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

function parseCrashArgs(
  args: string,
):
  | { kind: "launch"; stake?: Stake }
  | { kind: "out" }
  | { kind: "auto"; targetCents: number; stake?: Stake }
  | { kind: "help" } {
  const words = wordsOf(args);
  if (words.length === 0) return { kind: "launch" };
  const head = words[0]!.toLowerCase();
  if (head === "help") return { kind: "help" };
  if (head === "out" || head === "cashout" || head === "cash") {
    return words.length === 1 ? { kind: "out" } : { kind: "help" };
  }
  if (head === "auto" || head === "x") {
    const target = words[1] ? parseTarget(words[1]) : undefined;
    if (target === undefined) return { kind: "help" };
    const stake = parseStakeWords(words.slice(2));
    if (!stake.ok) return { kind: "help" };
    return { kind: "auto", targetCents: target, stake: stake.stake };
  }
  const stake = parseStakeWords(words);
  if (!stake.ok) return { kind: "help" };
  return { kind: "launch", stake: stake.stake };
}

/** 1.01× through 100×, at most two decimal places. */
function parseTarget(raw: string): number | undefined {
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) return undefined;
  const cents = Math.round(value * 100);
  if (cents < 101 || cents > CRASH_MAX * 100) return undefined;
  return cents;
}
