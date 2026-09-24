/**
 * 3x3 tic-tac-toe. Squares are 1-9, left to right, top to bottom.
 * `a1` is the top left, `c3` the bottom right.
 */
import type { GamePlayer } from "./players.js";

export const TICTACTOE_HELP =
  "Challenge with !tictactoe @user or by replying. They !tictactoe accept (you go first) or play 1-9 to accept and move. !tictactoe resign quits.";

export type Mark = "X" | "O";
export type Cell = Mark | null;
export type Seat = "challenger" | "opponent";

export type TictactoeState = {
  kind: "tictactoe";
  id: string;
  conversationId: string;
  phase: "pending" | "active";
  challenger: GamePlayer;
  opponent: GamePlayer;
  cells: Cell[];
  /** Who plays X. Set when the game leaves the pending challenge. */
  xSeat?: Seat;
  turn?: Seat;
  createdAt: number;
  updatedAt: number;
};

const LINES: readonly (readonly [number, number, number])[] = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

export function emptyTictactoe(
  id: string,
  conversationId: string,
  challenger: GamePlayer,
  opponent: GamePlayer,
  nowMs: number,
): TictactoeState {
  return {
    kind: "tictactoe",
    id,
    conversationId,
    phase: "pending",
    challenger,
    opponent,
    cells: Array.from({ length: 9 }, () => null),
    createdAt: nowMs,
    updatedAt: nowMs,
  };
}

/** `1`-`9`, `a1`-`c3`, or `play 5`. The whole argument must be one square. */
export function parseTictactoeSquare(input: string): number | undefined {
  const match = input.trim().toLowerCase().match(/^(?:(?:play|move|square)\s+)?([1-9]|[abc][123])$/);
  const token = match?.[1];
  if (!token) return undefined;
  if (/^[1-9]$/.test(token)) return Number(token) - 1;
  const row = token.charCodeAt(0) - "a".charCodeAt(0);
  const col = Number(token[1]) - 1;
  return row * 3 + col;
}

export function tictactoeWinner(cells: readonly Cell[]): Mark | "draw" | undefined {
  for (const [a, b, c] of LINES) {
    const mark = cells[a];
    if (mark && mark === cells[b] && mark === cells[c]) return mark;
  }
  if (cells.every((cell) => cell !== null)) return "draw";
  return undefined;
}

export function renderTictactoe(cells: readonly Cell[]): string {
  const glyph = (index: number): string => cells[index] ?? "·";
  return [0, 3, 6]
    .map((start) => `${glyph(start)} ${glyph(start + 1)} ${glyph(start + 2)}`)
    .join("\n");
}

export function tictactoeSeat(state: TictactoeState, playerId: string): Seat | undefined {
  if (playerId === state.challenger.id) return "challenger";
  if (playerId === state.opponent.id) return "opponent";
  return undefined;
}

export function tictactoePlayer(state: TictactoeState, seat: Seat): GamePlayer {
  return seat === "challenger" ? state.challenger : state.opponent;
}

export function tictactoeMark(state: TictactoeState, seat: Seat): Mark | undefined {
  if (!state.xSeat) return undefined;
  if (seat === state.xSeat) return "X";
  return "O";
}
