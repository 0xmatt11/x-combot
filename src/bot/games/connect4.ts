/**
 * Connect Four. 7 columns, 6 rows. A piece falls to the lowest open cell.
 * Columns are numbered 1-7 from the left.
 */
import type { GamePlayer } from "./players.js";
import type { Cell, Mark, Seat } from "./tictactoe.js";

export const CONNECT4_HELP =
  "Challenge with !connect4 @user or by replying. They !connect4 accept (you go first) or drop a column 1-7 to accept and move. !connect4 resign quits.";

export const CONNECT4_ROWS = 6;
export const CONNECT4_COLS = 7;

export type Connect4State = {
  kind: "connect4";
  id: string;
  conversationId: string;
  phase: "pending" | "active";
  challenger: GamePlayer;
  opponent: GamePlayer;
  /** Row 0 is the top. Each row has 7 cells. */
  grid: Cell[][];
  xSeat?: Seat;
  turn?: Seat;
  createdAt: number;
  updatedAt: number;
};

const DIRECTIONS: readonly (readonly [number, number])[] = [
  [0, 1],
  [1, 0],
  [1, 1],
  [1, -1],
];

export function emptyConnect4(
  id: string,
  conversationId: string,
  challenger: GamePlayer,
  opponent: GamePlayer,
  nowMs: number,
): Connect4State {
  return {
    kind: "connect4",
    id,
    conversationId,
    phase: "pending",
    challenger,
    opponent,
    grid: Array.from({ length: CONNECT4_ROWS }, () =>
      Array.from({ length: CONNECT4_COLS }, () => null),
    ),
    createdAt: nowMs,
    updatedAt: nowMs,
  };
}

/** `1`-`7`, or `drop 4` / `col 4`. */
export function parseConnect4Column(input: string): number | undefined {
  const match = input.trim().toLowerCase().match(/^(?:(?:drop|play|col|column)\s+)?([1-7])$/);
  const token = match?.[1];
  if (!token) return undefined;
  return Number(token) - 1;
}

export function connect4At(grid: readonly (readonly Cell[])[], row: number, col: number): Cell {
  return grid[row]?.[col] ?? null;
}

/** Drop `mark` into a 0-based column. Returns the landing row, or undefined if full. */
export function dropConnect4(grid: Cell[][], col: number, mark: Mark): number | undefined {
  if (col < 0 || col >= CONNECT4_COLS) return undefined;
  for (let row = CONNECT4_ROWS - 1; row >= 0; row -= 1) {
    if (connect4At(grid, row, col) === null) {
      const line = grid[row];
      if (!line) return undefined;
      line[col] = mark;
      return row;
    }
  }
  return undefined;
}

export function connect4Winner(grid: readonly (readonly Cell[])[]): Mark | "draw" | undefined {
  for (let row = 0; row < CONNECT4_ROWS; row += 1) {
    for (let col = 0; col < CONNECT4_COLS; col += 1) {
      const mark = connect4At(grid, row, col);
      if (!mark) continue;
      for (const [dr, dc] of DIRECTIONS) {
        if (dr === undefined || dc === undefined) continue;
        if (lineLength(grid, row, col, dr, dc, mark) >= 4) return mark;
      }
    }
  }
  for (let row = 0; row < CONNECT4_ROWS; row += 1) {
    for (let col = 0; col < CONNECT4_COLS; col += 1) {
      if (connect4At(grid, row, col) === null) return undefined;
    }
  }
  return "draw";
}

export function renderConnect4(grid: readonly (readonly Cell[])[]): string {
  const rows: string[] = [];
  for (let row = 0; row < CONNECT4_ROWS; row += 1) {
    const glyphs: string[] = [];
    for (let col = 0; col < CONNECT4_COLS; col += 1) {
      glyphs.push(connect4At(grid, row, col) ?? "·");
    }
    rows.push(glyphs.join(" "));
  }
  rows.push("1 2 3 4 5 6 7");
  return rows.join("\n");
}

export function connect4Seat(state: Connect4State, playerId: string): Seat | undefined {
  if (playerId === state.challenger.id) return "challenger";
  if (playerId === state.opponent.id) return "opponent";
  return undefined;
}

export function connect4Player(state: Connect4State, seat: Seat): GamePlayer {
  return seat === "challenger" ? state.challenger : state.opponent;
}

export function connect4Mark(state: Connect4State, seat: Seat): Mark | undefined {
  if (!state.xSeat) return undefined;
  return seat === state.xSeat ? "X" : "O";
}

function lineLength(
  grid: readonly (readonly Cell[])[],
  row: number,
  col: number,
  dr: number,
  dc: number,
  mark: Mark,
): number {
  let count = 0;
  let r = row;
  let c = col;
  while (connect4At(grid, r, c) === mark) {
    count += 1;
    r += dr;
    c += dc;
  }
  return count;
}
