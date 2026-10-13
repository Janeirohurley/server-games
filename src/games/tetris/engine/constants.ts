import type { PieceType } from "./types.js";

export const BOARD_WIDTH = 10;
export const BOARD_HEIGHT = 20;
export const QUEUE_MIN = 5;

/**
 * Formes de départ. Matrices carrées pour que la rotation reste un simple
 * quart de tour autour du centre (I : 4x4, O : 2x2, le reste : 3x3).
 * Le Tetris d'origine (chvin/react-tetris) utilisait des matrices rectangulaires
 * avec une table de « pivots » par pièce ; on préfère des matrices carrées,
 * plus simples à tester et à dupliquer côté serveur.
 */
export const PIECE_SHAPES: Record<PieceType, number[][]> = {
  I: [
    [0, 0, 0, 0],
    [1, 1, 1, 1],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ],
  J: [
    [1, 0, 0],
    [1, 1, 1],
    [0, 0, 0],
  ],
  L: [
    [0, 0, 1],
    [1, 1, 1],
    [0, 0, 0],
  ],
  O: [
    [1, 1],
    [1, 1],
  ],
  S: [
    [0, 1, 1],
    [1, 1, 0],
    [0, 0, 0],
  ],
  T: [
    [0, 1, 0],
    [1, 1, 1],
    [0, 0, 0],
  ],
  Z: [
    [1, 1, 0],
    [0, 1, 1],
    [0, 0, 0],
  ],
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

/**
 * Décalages tentés quand une rotation entre en collision (« wall kick »
 * simplifié, identique pour toutes les pièces) : on essaie sur place, puis
 * on pousse la pièce d'une ou deux cases de chaque côté, puis vers le haut.
 */
export const KICK_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [-1, 0],
  [1, 0],
  [-2, 0],
  [2, 0],
  [0, -1],
];
