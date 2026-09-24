/**
 * Text minesweeper for one group chat. One board per conversation, kept in
 * memory and dropped after MINESWEEPER_TIMEOUT_MS without a move. Player
 * text goes through `playerName`, the same label path as `!dice`.
 */
import { pickIndex, playerName, type Rng } from "./random.js";

export const MINESWEEPER_TIMEOUT_MS = 15 * 60 * 1000;

export const MINESWEEPER_HELP =
  "Start with !minesweeper easy (5×5) or !minesweeper medium (7×7). Reveal with !minesweeper r B3. Flag with !minesweeper f B3.";

export const MINESWEEPER_SIZES = {
  easy: { rows: 5, cols: 5, mines: 4 },
  medium: { rows: 7, cols: 7, mines: 8 },
} as const;

export type MinesweeperDifficulty = keyof typeof MINESWEEPER_SIZES;
export type MinesweeperStatus = "playing" | "won" | "lost";

const DIFFICULTY_WORDS: Record<string, MinesweeperDifficulty> = {
  easy: "easy",
  e: "easy",
  small: "easy",
  "5": "easy",
  "5x5": "easy",
  "5×5": "easy",
  medium: "medium",
  med: "medium",
  m: "medium",
  "7": "medium",
  "7x7": "medium",
  "7×7": "medium",
};

const REVEAL_WORDS = new Set(["r", "reveal", "open", "dig"]);
const FLAG_WORDS = new Set(["f", "flag", "mark"]);
const UNFLAG_WORDS = new Set(["u", "unflag"]);
const SHOW_WORDS = new Set(["show", "board", "map"]);

export type MinesweeperCommand =
  | { kind: "start"; difficulty: MinesweeperDifficulty }
  | { kind: "reveal"; row: number; col: number }
  | { kind: "flag"; row: number; col: number; clear: boolean }
  | { kind: "show" }
  | { kind: "help" };

type Cell = {
  mine: boolean;
  revealed: boolean;
  flagged: boolean;
  adjacent: number;
};

type Board = {
  difficulty: MinesweeperDifficulty;
  rows: number;
  cols: number;
  mineCount: number;
  cells: Cell[];
  minesPlaced: boolean;
  status: MinesweeperStatus;
  updatedAt: number;
};

export type MinesweeperSnapshot = {
  difficulty: MinesweeperDifficulty;
  rows: number;
  cols: number;
  mineCount: number;
  status: MinesweeperStatus;
  minesPlaced: boolean;
  mines: string[];
  flags: string[];
  revealed: string[];
};

const boards = new Map<string, Board>();

export function resetMinesweeperBoards(): void {
  boards.clear();
}

/** In-memory board for tests and a later move in the same chat. */
export function minesweeperSnapshot(conversationId: string): MinesweeperSnapshot | undefined {
  const board = boards.get(conversationId);
  if (!board) return undefined;
  const mines: string[] = [];
  const flags: string[] = [];
  const revealed: string[] = [];
  for (let row = 0; row < board.rows; row += 1) {
    for (let col = 0; col < board.cols; col += 1) {
      const cell = cellAt(board, row, col);
      const label = cellLabel(row, col);
      if (board.minesPlaced && cell.mine) mines.push(label);
      if (cell.flagged) flags.push(label);
      if (cell.revealed) revealed.push(label);
    }
  }
  return {
    difficulty: board.difficulty,
    rows: board.rows,
    cols: board.cols,
    mineCount: board.mineCount,
    status: board.status,
    minesPlaced: board.minesPlaced,
    mines,
    flags,
    revealed,
  };
}

export function parseMinesweeperCommand(input: string | undefined | null): MinesweeperCommand {
  const parts = (input?.trim() ?? "").split(/\s+/).filter((part) => part.length > 0);
  if (parts.length === 0) return { kind: "show" };

  const head = parts[0]!.toLowerCase();
  if (parts.length === 1) {
    const difficulty = DIFFICULTY_WORDS[head];
    if (difficulty) return { kind: "start", difficulty };
    if (SHOW_WORDS.has(head)) return { kind: "show" };
    const cell = parseCell(head);
    if (cell) return { kind: "reveal", ...cell };
    return { kind: "help" };
  }

  const cell = parseCell(parts.slice(1).join(""));
  if (!cell) return { kind: "help" };
  if (REVEAL_WORDS.has(head)) return { kind: "reveal", ...cell };
  if (UNFLAG_WORDS.has(head)) return { kind: "flag", ...cell, clear: true };
  if (FLAG_WORDS.has(head)) return { kind: "flag", ...cell, clear: false };
  return { kind: "help" };
}

export function minesweeperReply(
  conversationId: string,
  args: string | undefined | null,
  player: string,
  options?: { now?: number; rng?: Rng },
): string {
  const now = options?.now ?? Date.now();
  const rng = options?.rng ?? Math.random;
  const who = playerName(player);
  const command = parseMinesweeperCommand(args);
  if (command.kind === "help") return MINESWEEPER_HELP;

  const key = conversationId;
  if (command.kind === "start") {
    return startBoard(key, command.difficulty, who, now);
  }

  const existing = boards.get(key);
  const expired = existing !== undefined && now - existing.updatedAt >= MINESWEEPER_TIMEOUT_MS;
  if (expired) boards.delete(key);
  sweep(now);

  if (command.kind === "show") {
    const board = boards.get(key);
    if (!board) return startBoard(key, "easy", who, now);
    board.updatedAt = now;
    return render(board, `💣 ${who} — ${summary(board)}`);
  }

  const board = boards.get(key);
  if (!board) {
    if (expired) {
      return "That minesweeper board timed out. Start again with !minesweeper easy or !minesweeper medium.";
    }
    return "No minesweeper board in this chat. Start with !minesweeper easy (5×5) or !minesweeper medium (7×7).";
  }
  if (board.status !== "playing") {
    return "That game is over. Start another with !minesweeper easy or !minesweeper medium.";
  }

  if (!onBoard(board, command.row, command.col)) {
    return `That cell is off this board. Columns are A–${columnLetter(board.cols - 1)} and rows are 1–${board.rows}.`;
  }

  if (command.kind === "flag") {
    const cell = cellAt(board, command.row, command.col);
    const where = cellLabel(command.row, command.col);
    if (cell.revealed) {
      board.updatedAt = now;
      return `${where} is already open.\n${render(board, `💣 ${who} — ${summary(board)}`)}`;
    }
    if (command.clear) {
      if (!cell.flagged) return `${where} is not flagged.`;
      cell.flagged = false;
    } else if (cell.flagged) {
      cell.flagged = false;
    } else {
      cell.flagged = true;
    }
    board.updatedAt = now;
    const verb = cell.flagged ? "flagged" : "unflagged";
    return render(board, `💣 ${who} ${verb} ${where}.`);
  }

  const opened = revealCell(board, command.row, command.col, rng);
  const where = cellLabel(command.row, command.col);
  if (opened === "flagged") {
    board.updatedAt = now;
    return `${where} is flagged. Unflag it with !minesweeper f ${where}.`;
  }
  if (opened === "already") {
    board.updatedAt = now;
    return `${where} is already open.\n${render(board, `💣 ${who} — ${summary(board)}`)}`;
  }
  board.updatedAt = now;
  if (opened === "mine") {
    board.status = "lost";
    return render(board, `💣 ${who} hit a mine.`);
  }
  if (cleared(board)) {
    board.status = "won";
    return render(board, `💣 ${who} cleared the field.`);
  }
  return render(board, `💣 ${who} opened ${where}.`);
}

function startBoard(
  key: string,
  difficulty: MinesweeperDifficulty,
  who: string,
  now: number,
): string {
  const board = createBoard(difficulty, now);
  boards.set(key, board);
  sweep(now);
  return render(board, `💣 ${who} — ${summary(board)}`);
}

function createBoard(difficulty: MinesweeperDifficulty, now: number): Board {
  const size = MINESWEEPER_SIZES[difficulty];
  return {
    difficulty,
    rows: size.rows,
    cols: size.cols,
    mineCount: size.mines,
    cells: Array.from({ length: size.rows * size.cols }, () => ({
      mine: false,
      revealed: false,
      flagged: false,
      adjacent: 0,
    })),
    minesPlaced: false,
    status: "playing",
    updatedAt: now,
  };
}

function revealCell(board: Board, row: number, col: number, rng: Rng): "ok" | "mine" | "flagged" | "already" {
  const cell = cellAt(board, row, col);
  if (cell.revealed) return "already";
  if (cell.flagged) return "flagged";
  if (!board.minesPlaced) placeMines(board, row, col, rng);
  if (cell.mine) {
    cell.revealed = true;
    return "mine";
  }
  flood(board, row, col);
  return "ok";
}

/**
 * Mines are placed on the first reveal. The opened cell and its neighbors
 * stay empty so the first click is a real opening, not an instant loss.
 */
function placeMines(board: Board, safeRow: number, safeCol: number, rng: Rng): void {
  const safe = new Set<number>();
  for (let dr = -1; dr <= 1; dr += 1) {
    for (let dc = -1; dc <= 1; dc += 1) {
      const row = safeRow + dr;
      const col = safeCol + dc;
      if (onBoard(board, row, col)) safe.add(indexOf(board, row, col));
    }
  }
  const safeIndex = indexOf(board, safeRow, safeCol);
  let candidates = board.cells.map((_, index) => index).filter((index) => !safe.has(index));
  if (candidates.length < board.mineCount) {
    candidates = board.cells.map((_, index) => index).filter((index) => index !== safeIndex);
  }
  const mines = shuffle(candidates, rng).slice(0, board.mineCount);
  for (const index of mines) {
    const cell = board.cells[index];
    if (cell) cell.mine = true;
  }
  for (let row = 0; row < board.rows; row += 1) {
    for (let col = 0; col < board.cols; col += 1) {
      const cell = cellAt(board, row, col);
      if (cell.mine) continue;
      cell.adjacent = neighborIndexes(board, row, col).filter((index) => board.cells[index]?.mine).length;
    }
  }
  board.minesPlaced = true;
}

function flood(board: Board, row: number, col: number): void {
  const stack: Array<{ row: number; col: number }> = [{ row, col }];
  while (stack.length > 0) {
    const next = stack.pop();
    if (!next || !onBoard(board, next.row, next.col)) continue;
    const cell = cellAt(board, next.row, next.col);
    if (cell.revealed || cell.flagged || cell.mine) continue;
    cell.revealed = true;
    if (cell.adjacent !== 0) continue;
    for (let dr = -1; dr <= 1; dr += 1) {
      for (let dc = -1; dc <= 1; dc += 1) {
        if (dr === 0 && dc === 0) continue;
        stack.push({ row: next.row + dr, col: next.col + dc });
      }
    }
  }
}

function cleared(board: Board): boolean {
  return board.cells.every((cell) => cell.mine || cell.revealed);
}

function render(board: Board, headline: string): string {
  const letters = Array.from({ length: board.cols }, (_, col) => columnLetter(col)).join(" ");
  const lines = [headline, `  ${letters}`];
  const finished = board.status !== "playing";
  for (let row = 0; row < board.rows; row += 1) {
    const glyphs: string[] = [];
    for (let col = 0; col < board.cols; col += 1) {
      glyphs.push(glyph(cellAt(board, row, col), finished));
    }
    lines.push(`${row + 1} ${glyphs.join(" ")}`);
  }
  if (!finished) lines.push("Reveal !minesweeper r B3 · flag !minesweeper f B3");
  return lines.join("\n");
}

function glyph(cell: Cell, finished: boolean): string {
  if (cell.revealed && cell.mine) return "X";
  if (finished && cell.mine) return cell.flagged ? "F" : "*";
  if (cell.flagged) return "F";
  if (!cell.revealed) return "#";
  if (cell.adjacent === 0) return "·";
  return String(cell.adjacent);
}

function summary(board: Board): string {
  const flags = board.cells.filter((cell) => cell.flagged).length;
  const size = `${board.cols}×${board.rows}`;
  const flagged = flags === 0 ? "" : `, ${flags} ${flags === 1 ? "flag" : "flags"}`;
  return `${board.difficulty} ${size}, ${board.mineCount} mines${flagged}`;
}

function sweep(now: number): void {
  for (const [id, board] of boards) {
    if (now - board.updatedAt >= MINESWEEPER_TIMEOUT_MS) boards.delete(id);
  }
}

function shuffle(items: number[], rng: Rng): number[] {
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = pickIndex(i + 1, rng);
    const left = copy[i];
    const right = copy[j];
    if (left === undefined || right === undefined) continue;
    copy[i] = right;
    copy[j] = left;
  }
  return copy;
}

function parseCell(token: string): { row: number; col: number } | undefined {
  const compact = token.replace(/[\s-]+/g, "");
  const letterFirst = compact.match(/^([A-Ga-g])([1-7])$/);
  const numberFirst = compact.match(/^([1-7])([A-Ga-g])$/);
  const match = letterFirst ?? numberFirst;
  if (!match) return undefined;
  const letter = (letterFirst ? match[1] : match[2])!.toUpperCase();
  const number = letterFirst ? match[2] : match[1];
  return { col: letter.charCodeAt(0) - 65, row: Number(number) - 1 };
}

function onBoard(board: Board, row: number, col: number): boolean {
  return row >= 0 && col >= 0 && row < board.rows && col < board.cols;
}

function indexOf(board: Board, row: number, col: number): number {
  return row * board.cols + col;
}

function cellAt(board: Board, row: number, col: number): Cell {
  const cell = board.cells[indexOf(board, row, col)];
  if (!cell) throw new Error(`minesweeper cell ${row},${col} missing`);
  return cell;
}

function neighborIndexes(board: Board, row: number, col: number): number[] {
  const indexes: number[] = [];
  for (let dr = -1; dr <= 1; dr += 1) {
    for (let dc = -1; dc <= 1; dc += 1) {
      if (dr === 0 && dc === 0) continue;
      const nextRow = row + dr;
      const nextCol = col + dc;
      if (onBoard(board, nextRow, nextCol)) indexes.push(indexOf(board, nextRow, nextCol));
    }
  }
  return indexes;
}

function cellLabel(row: number, col: number): string {
  return `${columnLetter(col)}${row + 1}`;
}

function columnLetter(col: number): string {
  return String.fromCharCode(65 + col);
}
