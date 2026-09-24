/**
 * A short turn-based duel. Each fighter has HP. Attack rolls 1d6 damage.
 * Defend rolls 1d6 and blocks that much of the next hit, then the block is gone.
 */
import { pickIndex, type Rng } from "./random.js";
import type { GamePlayer } from "./players.js";
import type { Seat } from "./tictactoe.js";

export const DUEL_HP = 10;

export const DUEL_HELP =
  "Challenge with !duel @user or by replying. They !duel accept (you go first) or !duel attack / !duel defend to start. !duel resign quits.";

export type DuelAction = "attack" | "defend";

export type DuelState = {
  kind: "duel";
  id: string;
  conversationId: string;
  phase: "pending" | "active";
  challenger: GamePlayer;
  opponent: GamePlayer;
  hp: Record<Seat, number>;
  block: Record<Seat, number>;
  turn?: Seat;
  createdAt: number;
  updatedAt: number;
};

export function emptyDuel(
  id: string,
  conversationId: string,
  challenger: GamePlayer,
  opponent: GamePlayer,
  nowMs: number,
): DuelState {
  return {
    kind: "duel",
    id,
    conversationId,
    phase: "pending",
    challenger,
    opponent,
    hp: { challenger: DUEL_HP, opponent: DUEL_HP },
    block: { challenger: 0, opponent: 0 },
    createdAt: nowMs,
    updatedAt: nowMs,
  };
}

export function parseDuelAction(input: string): DuelAction | undefined {
  const key = input.trim().toLowerCase();
  if (key === "attack" || key === "atk" || key === "a" || key === "hit") return "attack";
  if (key === "defend" || key === "def" || key === "d" || key === "block") return "defend";
  return undefined;
}

/** 1d6. `rng` of 0 is 1, just under 1 is 6. */
export function rollD6(rng: Rng = Math.random): number {
  return pickIndex(6, rng) + 1;
}

export function duelSeat(state: DuelState, playerId: string): Seat | undefined {
  if (playerId === state.challenger.id) return "challenger";
  if (playerId === state.opponent.id) return "opponent";
  return undefined;
}

export function duelPlayer(state: DuelState, seat: Seat): GamePlayer {
  return seat === "challenger" ? state.challenger : state.opponent;
}

export function otherSeat(seat: Seat): Seat {
  return seat === "challenger" ? "opponent" : "challenger";
}

export function duelHpLine(state: DuelState): string {
  return `HP ${state.challenger.label} ${state.hp.challenger}, ${state.opponent.label} ${state.hp.opponent}.`;
}
