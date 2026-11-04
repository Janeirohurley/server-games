import { PIECE_TYPES } from "./constants.js";
import type { PieceType } from "./types.js";

/**
 * Générateur mulberry32 : petit, rapide, déterministe.
 * Pourquoi pas `Math.random()` comme le jeu d'origine ? Parce que, en ligne,
 * le serveur devra tirer UNE suite de pièces à partir d'une graine et la
 * donner à tous les joueurs : deux joueurs avec la même graine voient les
 * mêmes pièces. Le rejeu d'une partie devient aussi possible pour les tests.
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
 * Tire un « sac » de 7 pièces mélangées (Fisher-Yates). Chaque sac contient
 * exactement une fois chaque pièce : on n'attend jamais plus de 12 pièces
 * avant de revoir un I, contrairement à un tirage uniforme pur.
 */
export function drawBag(rngState: number): [PieceType[], number] {
  const bag = [...PIECE_TYPES];
  let state = rngState;
  for (let i = bag.length - 1; i > 0; i--) {
    const [r, s] = nextRandom(state);
    state = s;
    const j = Math.floor(r * (i + 1));
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }
  return [bag, state];
}
