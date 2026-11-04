import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  PIECE_CELL_VALUE,
  PIECE_SHAPES,
} from "./constants.js";
import type { ActivePiece, Board, Cell, PieceType } from "./types.js";

export function createEmptyBoard(): Board {
  return Array.from({ length: BOARD_HEIGHT }, () =>
    Array<Cell>(BOARD_WIDTH).fill(0),
  );
}

/** Quart de tour horaire d'une matrice carrée. */
function rotateMatrix(matrix: number[][]): number[][] {
  const size = matrix.length;
  return matrix.map((_, row) =>
    matrix.map((__, col) => matrix[size - 1 - col][row]),
  );
}

/** Matrice d'une pièce pour une rotation donnée (0..3). */
export function getShape(type: PieceType, rotation: number): number[][] {
  let shape = PIECE_SHAPES[type];
  const turns = ((rotation % 4) + 4) % 4;
  for (let i = 0; i < turns; i++) shape = rotateMatrix(shape);
  return shape;
}

/** Cases (x, y) occupées par la pièce, en coordonnées plateau. */
export function getCells(piece: ActivePiece): Array<[number, number]> {
  const shape = getShape(piece.type, piece.rotation);
  const cells: Array<[number, number]> = [];
  shape.forEach((row, dy) =>
    row.forEach((filled, dx) => {
      if (filled) cells.push([piece.x + dx, piece.y + dy]);
    }),
  );
  return cells;
}

/**
 * Vrai si la pièce sort du plateau (côtés, bas) ou chevauche une case posée.
 * Une case au-dessus du plateau (y < 0) est tolérée : une pièce peut
 * apparaître partiellement hors-champ (comme dans l'original, « la
 * coordonnée verticale peut être négative »).
 */
export function collides(board: Board, piece: ActivePiece): boolean {
  return getCells(piece).some(([x, y]) => {
    if (x < 0 || x >= BOARD_WIDTH || y >= BOARD_HEIGHT) return true;
    if (y < 0) return false;
    return board[y][x] !== 0;
  });
}

/** Copie du plateau avec la pièce figée dedans. Ne modifie pas l'original. */
export function lockPiece(board: Board, piece: ActivePiece): Board {
  const next = board.map((row) => [...row]);
  const value = PIECE_CELL_VALUE[piece.type];
  for (const [x, y] of getCells(piece)) {
    if (y >= 0) next[y][x] = value;
  }
  return next;
}

/** Retire les lignes pleines ; renvoie le nouveau plateau et le nombre retiré. */
export function clearFullLines(board: Board): { board: Board; cleared: number } {
  const kept = board.filter((row) => row.some((cell) => cell === 0));
  const cleared = board.length - kept.length;
  const padding = Array.from({ length: cleared }, () =>
    Array<Cell>(BOARD_WIDTH).fill(0),
  );
  return { board: [...padding, ...kept], cleared };
}

/** Ligne où la pièce s'arrêterait si on la lâchait (pour le « fantôme »). */
export function dropDistance(board: Board, piece: ActivePiece): number {
  let distance = 0;
  while (!collides(board, { ...piece, y: piece.y + distance + 1 })) distance++;
  return distance;
}
