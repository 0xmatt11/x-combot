/**
 * XP and casino games. Sessions and fun chips belong to one engine.
 * A numeric user id is scrubbed if it ever reaches a reply.
 */
import { playBlackjack, type BlackjackHand } from "./blackjack.js";
import { playCrash, type CrashRound } from "./crash.js";
import { playPoker, type PokerHand } from "./poker.js";
import { playRoulette } from "./roulette.js";
import { SessionMap } from "./session.js";
import { playSlots } from "./slots.js";
import { expiredBet, FunBank, joinLines, type CasinoContext, type XpPort } from "./stake.js";
import { playTrivia, TriviaBook, TRIVIA_TTL_MS, type TriviaRound } from "./trivia.js";

export type CasinoGame =
  | "slots"
  | "blackjack"
  | "poker"
  | "roulette"
  | "crash"
  | "trivia"
  | "hit"
  | "stand";

export class CasinoTable {
  readonly fun = new FunBank();
  readonly blackjack = new SessionMap<BlackjackHand>();
  readonly poker = new SessionMap<PokerHand>();
  readonly crash = new SessionMap<CrashRound>();
  readonly trivia = new SessionMap<TriviaRound>(TRIVIA_TTL_MS);
  readonly triviaBook = new TriviaBook();

  sweep(now: number): void {
    this.blackjack.sweep(now);
    this.poker.sweep(now);
    this.crash.sweep(now);
    this.trivia.sweep(now);
  }
}

export function playCasino(
  table: CasinoTable,
  input: CasinoContext & { game: CasinoGame; args: string },
): string {
  const ctx = sanitize(input);
  const text = dispatch(table, ctx, input.game, input.args);
  table.sweep(ctx.nowMs);
  return scrubIds(text, [input.userId, input.conversationId]);
}

function dispatch(table: CasinoTable, ctx: CasinoContext, game: CasinoGame, args: string): string {
  switch (game) {
    case "slots":
      return playSlots(table.fun, ctx, args);
    case "blackjack":
      return playBlackjack(table.blackjack, table.fun, ctx, args);
    case "poker":
      return playPoker(table.poker, table.fun, ctx, args);
    case "roulette":
      return playRoulette(table.fun, ctx, args);
    case "crash":
      return playCrash(table.crash, table.fun, ctx, args);
    case "trivia":
      return playTrivia(table.trivia, table.triviaBook, ctx, args);
    case "hit":
      return args.trim()
        ? playBlackjack(table.blackjack, table.fun, ctx, "help")
        : playBlackjack(table.blackjack, table.fun, ctx, "hit");
    case "stand":
      return stand(table, ctx, args);
    default:
      return playSlots(table.fun, ctx, "help");
  }
}

function stand(table: CasinoTable, ctx: CasinoContext, args: string): string {
  if (args.trim()) return "Stand on one hand: !blackjack stand or !poker stand.";
  const key = `${ctx.conversationId}\u0000${ctx.userId}`;
  const blackjack = table.blackjack.take(key, ctx.nowMs);
  const poker = table.poker.take(key, ctx.nowMs);
  const blackjackLive = blackjack.status === "live";
  const pokerLive = poker.status === "live";
  if (blackjackLive && pokerLive) {
    table.blackjack.set(key, blackjack.value, ctx.nowMs);
    table.poker.set(key, poker.value, ctx.nowMs);
    return "You have a blackjack hand and a poker hand. Use !blackjack stand or !poker stand.";
  }
  if (blackjackLive) {
    table.blackjack.set(key, blackjack.value, ctx.nowMs);
    const note =
      poker.status === "expired" ? expiredBet("poker hand", poker.value.stake) : undefined;
    return joinLines([note, playBlackjack(table.blackjack, table.fun, ctx, "stand")]);
  }
  if (pokerLive) {
    table.poker.set(key, poker.value, ctx.nowMs);
    const note =
      blackjack.status === "expired"
        ? expiredBet("blackjack hand", blackjack.value.stake)
        : undefined;
    return joinLines([note, playPoker(table.poker, table.fun, ctx, "stand")]);
  }
  const notes: string[] = [];
  if (blackjack.status === "expired") notes.push(expiredBet("blackjack hand", blackjack.value.stake));
  if (poker.status === "expired") notes.push(expiredBet("poker hand", poker.value.stake));
  if (notes.length > 0) {
    return joinLines([...notes, "Deal again with !blackjack or !poker."]);
  }
  return "No hand to stand on. Start with !blackjack or !poker.";
}

function sanitize(input: CasinoContext): CasinoContext {
  return {
    ...input,
    xp: {
      enabled: input.xp.enabled,
      get: () => {
        const value = input.xp.get();
        return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
      },
      set: (xp: number) => {
        const next = Number.isFinite(xp) ? Math.max(0, Math.floor(xp)) : 0;
        input.xp.set(next);
      },
    },
  };
}

function scrubIds(text: string, ids: string[]): string {
  let next = text;
  for (const id of ids) {
    if (/^\d{15,}$/.test(id) && next.includes(id)) {
      next = next.split(id).join("someone");
    }
  }
  return next;
}

export type { XpPort };
