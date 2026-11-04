/**
 * Types du moteur Tetris — couche de règles PURE, sans dépendance.
 *
 * Ce dossier est conçu pour être copié tel quel dans `server-games`
 * (duplication volontaire entre les deux dépôts, comme `checkers/engine`).
 * Ne jamais y importer React, Colyseus ni quoi que ce soit du DOM.
 */

export type PieceType = "I" | "J" | "L" | "O" | "S" | "T" | "Z";

/** 0 = case vide, 1..7 = type de pièce posée (sert à colorer le plateau). */
export type Cell = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export type Board = Cell[][];

export type GameStatus = "playing" | "over";

export interface ActivePiece {
  type: PieceType;
  /** 0..3 : nombre de quarts de tour horaires depuis la forme de départ. */
  rotation: number;
  /** Coin haut-gauche de la matrice de la pièce, en coordonnées plateau. */
  x: number;
  y: number;
}

export interface TetrisState {
  board: Board;
  current: ActivePiece;
  /** File des prochaines pièces (toujours >= 5 éléments). */
  queue: PieceType[];
  /** État du générateur pseudo-aléatoire : le moteur reste déterministe. */
  rngState: number;
  score: number;
  lines: number;
  /** Niveau de départ choisi (1..6) ; le niveau courant ne descend jamais dessous. */
  startLevel: number;
  /** 1..6, comme `speedRun` dans le Tetris d'origine. */
  level: number;
  status: GameStatus;
}

/** Les seules entrées possibles : des INTENTIONS, jamais un état. */
export type TetrisInput =
  | "left"
  | "right"
  | "rotate"
  | "softDrop"
  | "hardDrop"
  | "tick";
