/**
 * Board geometry and setup. Pure index arithmetic, no game rules.
 *
 * Squares are numbered row-major from the top-left of the board as White
 * sees it: index = row * 8 + col, row 0 is Black's back rank, row 7 is
 * White's. White therefore advances towards row 0.
 */

import type { Board, Color, Piece, Square } from "./types.js";

export const BOARD_SIZE = 8;
export const SQUARE_COUNT = BOARD_SIZE * BOARD_SIZE;

/** Rows each side fills at the start. */
const BLACK_ROWS = [0, 1, 2];
const WHITE_ROWS = [5, 6, 7];

export const rowOf = (index: number): number => Math.floor(index / BOARD_SIZE);
export const colOf = (index: number): number => index % BOARD_SIZE;

export const squareIndex = (row: number, col: number): number =>
  row * BOARD_SIZE + col;

export const isOnBoard = (row: number, col: number): boolean =>
  row >= 0 && row < BOARD_SIZE && col >= 0 && col < BOARD_SIZE;

/** Only dark squares are playable. */
export const isPlayable = (row: number, col: number): boolean =>
  (row + col) % 2 === 1;

/** The row a man of `color` must reach to be crowned. */
export const promotionRow = (color: Color): number =>
  color === "white" ? 0 : BOARD_SIZE - 1;

/** The row delta a man of `color` advances by. */
export const forwardStep = (color: Color): number =>
  color === "white" ? -1 : 1;

export function createInitialBoard(): Board {
  const board: Square[] = new Array<Square>(SQUARE_COUNT).fill(null);

  for (let row = 0; row < BOARD_SIZE; row++) {
    for (let col = 0; col < BOARD_SIZE; col++) {
      if (!isPlayable(row, col)) continue;

      const piece: Piece | null = BLACK_ROWS.includes(row)
        ? { color: "black", kind: "man" }
        : WHITE_ROWS.includes(row)
          ? { color: "white", kind: "man" }
          : null;

      board[squareIndex(row, col)] = piece;
    }
  }

  return board;
}

export const opponentOf = (color: Color): Color =>
  color === "white" ? "black" : "white";

export function countPieces(board: Board, color: Color): number {
  let count = 0;
  for (const square of board) {
    if (square?.color === color) count++;
  }
  return count;
}

/**
 * Compact board encoding, one character per square:
 *
 *   "." empty · "w"/"W" white man/king · "b"/"B" black man/king
 *
 * This is also the wire format the realtime server synchronizes, which
 * is why it lives in the engine rather than in either UI.
 */
export const EMPTY_SQUARE = ".";

export function encodeBoard(board: Board): string {
  let encoded = "";
  for (const square of board) {
    encoded += !square
      ? EMPTY_SQUARE
      : square.color === "white"
        ? square.kind === "king"
          ? "W"
          : "w"
        : square.kind === "king"
          ? "B"
          : "b";
  }
  return encoded;
}

const ENCODED_PIECES: Record<string, Piece> = {
  w: { color: "white", kind: "man" },
  W: { color: "white", kind: "king" },
  b: { color: "black", kind: "man" },
  B: { color: "black", kind: "king" },
};

export function decodeBoard(encoded: string): Board {
  const board: Square[] = new Array<Square>(SQUARE_COUNT).fill(null);
  for (let index = 0; index < SQUARE_COUNT; index++) {
    board[index] = ENCODED_PIECES[encoded[index]] ?? null;
  }
  return board;
}

/**
 * Stable key for a position — board plus side to move. Callers that want
 * a repetition rule can tally these.
 */
export function positionKey(board: Board, turn: Color): string {
  return (turn === "white" ? "w" : "b") + encodeBoard(board);
}
