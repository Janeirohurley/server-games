import type { PieceType } from "./types.js";

export const BOARD_WIDTH = 10;
export const BOARD_HEIGHT = 20;
export const QUEUE_MIN = 5;

/**
 * Formes de départ, copiées telles quelles de `chvin/react-tetris`
 * (`blockShape` dans `unit/const.js`). Ce sont des matrices RECTANGULAIRES :
 * la rotation n'est donc pas un quart de tour autour d'un centre carré, mais
 * une rotation suivie d'un décalage de pivot propre à la pièce (voir
 * `PIECE_ORIGINS`). On reproduit volontairement l'original au pixel près.
 */
export const PIECE_SHAPES: Record<PieceType, number[][]> = {
  I: [[1, 1, 1, 1]],
  L: [
    [0, 0, 1],
    [1, 1, 1],
  ],
  J: [
    [1, 0, 0],
    [1, 1, 1],
  ],
  Z: [
    [1, 1, 0],
    [0, 1, 1],
  ],
  S: [
    [0, 1, 1],
    [1, 1, 0],
  ],
  O: [
    [1, 1],
    [1, 1],
  ],
  T: [
    [0, 1, 0],
    [1, 1, 1],
  ],
};

/**
 * Table de pivots de l'original (`origin` dans `unit/const.js`). À chaque
 * rotation, on décale la pièce de `PIECE_ORIGINS[type][rotation % taille]`
 * avant de tester la collision. Comme dans l'original, une rotation qui
 * entre en collision est REFUSÉE (aucun « wall kick »).
 *
 * `I` et `T` ont plusieurs entrées ; les autres n'en ont qu'une (pivot fixe).
 */
export const PIECE_ORIGINS: Record<PieceType, ReadonlyArray<readonly [number, number]>> = {
  I: [
    [-1, 1],
    [1, -1],
  ],
  J: [[0, 0]],
  L: [[0, 0]],
  O: [[0, 0]],
  S: [[0, 0]],
  T: [
    [0, 0],
    [1, 0],
    [-1, 1],
    [0, -1],
  ],
  Z: [[0, 0]],
};

/** Position d'apparition (coin haut-gauche de la matrice) par pièce, comme `Block.xy`. */
export const PIECE_SPAWN: Record<PieceType, { x: number; y: number }> = {
  I: { x: 3, y: 0 },
  J: { x: 4, y: -1 },
  L: { x: 4, y: -1 },
  O: { x: 4, y: -1 },
  S: { x: 4, y: -1 },
  T: { x: 4, y: -1 },
  Z: { x: 4, y: -1 },
};

export const PIECE_TYPES: PieceType[] = ["I", "J", "L", "O", "S", "T", "Z"];

/** Valeur stockée dans le plateau pour chaque type (1..7). */
export const PIECE_CELL_VALUE: Record<PieceType, 1 | 2 | 3 | 4 | 5 | 6 | 7> = {
  I: 1,
  J: 2,
  L: 3,
  O: 4,
  S: 5,
  T: 6,
  Z: 7,
};

/**
 * Délai de chute en ms par niveau (niveau 1 = index 0).
 * Repris tel quel du jeu d'origine (`speeds` dans `unit/const.js`).
 */
export const FALL_DELAYS_MS = [800, 650, 500, 370, 250, 160] as const;

/** Points pour 1, 2, 3 ou 4 lignes d'un coup (`clearPoints` d'origine). */
export const CLEAR_POINTS = [100, 300, 700, 1500] as const;

/** Toutes les 20 lignes, le niveau monte (`eachLines` d'origine). */
export const LINES_PER_LEVEL = 20;
export const MAX_LEVEL = FALL_DELAYS_MS.length;
export const MAX_SCORE = 999_999;
