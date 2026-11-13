import { PIECE_TYPES } from "./constants.js";
import type { PieceType } from "./types.js";

/**
 * Générateur mulberry32 : petit, rapide, déterministe.
 * Pourquoi pas `Math.random()` comme le jeu d'origine ? Parce que, en ligne,
 * le serveur doit tirer UNE suite de pièces à partir d'une graine et la
 * donner à tous les joueurs : deux joueurs avec la même graine voient les
 * mêmes pièces. Le rejeu d'une partie est aussi possible pour les tests.
 *
 * Retourne [valeur dans [0,1), nouvel état].
 */
export function nextRandom(state: number): [number, number] {
  const next = (state + 0x6d2b79f5) >>> 0;
  let t = next;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, next];
}

/**
 * Tire UNE pièce au hasard uniforme parmi les sept, comme `getNextType()` de
 * l'original (`unit/index.js`) — donc SANS sac de 7 : une même pièce peut
 * sortir plusieurs fois d'affilée. On garde seulement la graine pour rendre
 * le tirage reproductible (en ligne, tous les joueurs voient la même suite).
 */
export function drawPiece(rngState: number): [PieceType, number] {
  const [r, state] = nextRandom(rngState);
  const index = Math.floor(r * PIECE_TYPES.length);
  return [PIECE_TYPES[Math.min(index, PIECE_TYPES.length - 1)], state];
}
