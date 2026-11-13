import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  PIECE_CELL_VALUE,
  PIECE_SHAPES,
} from "./constants.js";
import { nextRandom } from "./rng.js";
import type { ActivePiece, Board, Cell, PieceType } from "./types.js";

export function createEmptyBoard(): Board {
  return Array.from({ length: BOARD_HEIGHT }, () =>
    Array<Cell>(BOARD_WIDTH).fill(0),
  );
}

/**
 * Une ligne de « débris » : `count` cases allumées (count entre min et max),
 * le reste en trous placés au hasard. Porté de `getLine()` de `getStartMatrix`
 * (`chvin/react-tetris`, `unit/states.js`), mais le hasard vient de notre
 * graine pour que la partie reste reproductible.
 */
function garbageLine(
  min: number,
  max: number,
  rngState: number,
): { line: Cell[]; rngState: number } {
  let rng = rngState;
  let draw = 0;
  [draw, rng] = nextRandom(rng);
  const count = Math.floor((max - min + 1) * draw) + min;

  const line: Cell[] = [];
  for (let i = 0; i < count; i++) line.push(PIECE_CELL_VALUE.I);
  for (let blanks = BOARD_WIDTH - count; blanks > 0; blanks--) {
    [draw, rng] = nextRandom(rng);
    const index = Math.floor((line.length + 1) * draw);
    line.splice(index, 0, 0);
  }
  return { line, rngState: rng };
}

/**
 * Plateau de départ quand on a choisi des lignes de débris (`startLines`,
 * 0 a 10) : les lignes sont empilées en bas du plateau, les plus hautes ayant
 * le plus de trous. Porté de `getStartMatrix` de l'original — les trois
 * premières lignes du bloc ont 5 a 8 cases, les suivantes 4 a 9, les toutes
 * dernières 3 a 9. `rngState` avance au passage.
 */
export function getStartMatrix(
  startLines: number,
  rngState: number,
): { board: Board; rngState: number } {
  const board = createEmptyBoard();
  const rows = Math.min(Math.max(Math.trunc(startLines), 0), BOARD_HEIGHT);
  let rng = rngState;

  for (let i = 0; i < rows; i++) {
    const [min, max] = i <= 2 ? [5, 8] : i <= 6 ? [4, 9] : [3, 9];
    const { line, rngState: next } = garbageLine(min, max, rng);
    board[BOARD_HEIGHT - rows + i] = line;
    rng = next;
  }
  return { board, rngState: rng };
}

/**
 * Quart de tour d'une matrice RECTANGULAIRE, copié de `Block.rotate()`
 * (`chvin/react-tetris`, `unit/block.js`). On empile chaque colonne d'origine
 * à l'envers : le résultat fait largeur x hauteur.
 */
function rotateMatrix(matrix: number[][]): number[][] {
  const result: number[][] = [];
  matrix.forEach((row) =>
    row.forEach((value, column) => {
      const index = row.length - column - 1;
      if (result[index] === undefined) result[index] = [];
      result[index].push(value);
    }),
  );
  return result;
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
