/**
 * Fun chips live in memory for this process. XP wagers are optional and
 * never debit a balance that cannot cover them.
 */
import { levelForXp, levelUpAnnouncement } from "../xp.js";
import { playerName, type Rng } from "./random.js";

export const FUN_START = 100;
export const FUN_CAP = 2_000;
export const DEFAULT_BET = 10;
export const MIN_BET = 1;
export const MAX_BET = 100;

export const XP_BET_OFF = "XP bets are off in this group. Use fun chips, like `!slots 10`.";

export type StakeKind = "fun" | "xp";

export type Stake = {
  kind: StakeKind;
  amount: number;
};

export type XpPort = {
  enabled: boolean;
  get: () => number;
  set: (xp: number) => void;
};

export type CasinoContext = {
  conversationId: string;
  userId: string;
  label: string;
  nowMs: number;
  rng: Rng;
  xp: XpPort;
};

export function playerKey(ctx: Pick<CasinoContext, "conversationId" | "userId">): string {
  return `${ctx.conversationId}\u0000${ctx.userId}`;
}

export function wordsOf(args: string | undefined): string[] {
  const trimmed = args?.trim() ?? "";
  if (!trimmed) return [];
  return trimmed.split(/\s+/);
}

export function joinLines(parts: Array<string | undefined>): string {
  return parts.filter((part): part is string => Boolean(part && part.trim())).join("\n");
}

export class FunBank {
  private readonly rows = new Map<string, number>();

  has(key: string): boolean {
    return this.rows.has(key);
  }

  get(key: string): number {
    return this.rows.get(key) ?? 0;
  }

  set(key: string, amount: number): void {
    const next = Number.isFinite(amount) ? Math.max(0, Math.floor(amount)) : 0;
    this.rows.delete(key);
    this.rows.set(key, next);
    while (this.rows.size > FUN_CAP) {
      const oldest = this.rows.keys().next().value;
      if (oldest === undefined) break;
      this.rows.delete(oldest);
    }
  }
}

/**
 * Optional stake words: `10`, `xp 10`, or `10 xp`.
 * An empty list means "use the default later". Anything else is invalid.
 */
export function parseStakeWords(words: string[]): { ok: true; stake?: Stake } | { ok: false } {
  if (words.length === 0) return { ok: true };
  let xp = false;
  let amount: number | undefined;
  for (const word of words) {
    if (word.toLowerCase() === "xp") {
      if (xp) return { ok: false };
      xp = true;
      continue;
    }
    if (!/^\d+$/.test(word)) return { ok: false };
    if (amount !== undefined) return { ok: false };
    const value = Number(word);
    if (!Number.isSafeInteger(value)) return { ok: false };
    amount = value;
  }
  if (xp && amount === undefined) return { ok: false };
  if (amount === undefined) return { ok: true };
  if (amount < MIN_BET || amount > MAX_BET) return { ok: false };
  return { ok: true, stake: { kind: xp ? "xp" : "fun", amount } };
}

export type PlacedBet = {
  stake: Stake;
  /** Balance after a fun-chip refill and before the debit. */
  before: number;
  refilled: boolean;
};

export function betLabel(stake: Stake): string {
  return stake.kind === "xp" ? `${stake.amount} XP` : `${stake.amount} fun chips`;
}

export function expiredBet(game: string, stake: Stake): string {
  return `That ${game} expired, so the ${betLabel(stake)} bet is gone.`;
}

/**
 * Debit a bet. Refuses when the balance cannot cover it.
 * Fun chips start at 100. An empty purse refills to 100 before the next bet.
 */
export function placeBet(
  fun: FunBank,
  ctx: CasinoContext,
  stake: Stake | undefined,
): { ok: true; placed: PlacedBet } | { ok: false; text: string } {
  const chosen: Stake = stake ?? { kind: "fun", amount: DEFAULT_BET };
  const who = playerName(ctx.label);
  if (chosen.kind === "xp") {
    if (!ctx.xp.enabled) return { ok: false, text: XP_BET_OFF };
    const before = safeInt(ctx.xp.get());
    if (before < chosen.amount) {
      return {
        ok: false,
        text: `Not enough XP for a ${chosen.amount} bet (${who} has ${before} XP).`,
      };
    }
    ctx.xp.set(before - chosen.amount);
    return { ok: true, placed: { stake: chosen, before, refilled: false } };
  }

  const key = playerKey(ctx);
  const known = fun.has(key);
  let before = known ? fun.get(key) : FUN_START;
  let refilled = false;
  if (known && before <= 0) {
    before = FUN_START;
    refilled = true;
  }
  if (before < chosen.amount) {
    return {
      ok: false,
      text: `Not enough fun chips for a ${chosen.amount} bet (${who} has ${before}). An empty purse refills to ${FUN_START}.`,
    };
  }
  fun.set(key, before - chosen.amount);
  return { ok: true, placed: { stake: chosen, before, refilled } };
}

/** Balance after the debit, while a hand is still open. Does not return the stake. */
export function heldBalance(placed: PlacedBet): string {
  const after = placed.before - placed.stake.amount;
  if (placed.stake.kind === "xp") return `XP ${placed.before} → ${after}.`;
  const refill = placed.refilled ? `Fun chips were empty and refilled to ${FUN_START}. ` : "";
  return `${refill}Fun chips ${placed.before} → ${after}.`;
}

/** Credit winnings on top of the already-debited balance. `credit` 0 is a loss. */
export function payOut(fun: FunBank, ctx: CasinoContext, placed: PlacedBet, credit: number): string {
  const gain = safeInt(credit);
  const who = playerName(ctx.label);
  if (placed.stake.kind === "xp") {
    const next = safeInt(ctx.xp.get()) + gain;
    ctx.xp.set(next);
    const line = `XP ${placed.before} → ${next}.`;
    const start = levelForXp(placed.before);
    const end = levelForXp(next);
    if (end > start) return `${line} ${levelUpAnnouncement(who, end)}`;
    return line;
  }
  const key = playerKey(ctx);
  const next = fun.get(key) + gain;
  fun.set(key, next);
  const refill = placed.refilled ? `Fun chips were empty and refilled to ${FUN_START}. ` : "";
  return `${refill}Fun chips ${placed.before} → ${next}.`;
}

function safeInt(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}
