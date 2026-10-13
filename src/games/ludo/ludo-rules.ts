/**
 * Server-authoritative Ludo rules.
 *
 * Pure functions over plain snapshots — no Colyseus imports, no React,
 * no clocks. The room validates client intents through these before
 * mutating the synchronized state. Kept dependency-free so it can be
 * unit-tested directly and later shared with the platform if needed.
 *
 * Anything that depends on WHERE a player enters the ring takes the
 * table's `LudoTrack` as its first argument. The track is a per-table
 * value, never module state, so two tables of different sizes can be
 * simulated side by side without interfering.
 */

import {
  FINISHED_POSITION,
  PIECES_PER_PLAYER,
  type LudoColor,
  type LudoTrack,
} from "./ludo-state.js";

/** Minimal piece snapshot the rules operate on. */
export interface RulePiece {
  index: number;
  position: number;
}

/** A seated player's pieces, for capture resolution. */
export interface SeatedPlayer {
  color: LudoColor;
  pieces: readonly RulePiece[];
}

/** A validated move the room may apply to its state. */
export interface ResolvedMove {
  pieceIndex: number;
  fromPosition: number;
  toPosition: number;
  /** Ring index of the destination when it lands on the shared ring, else -1. */
  destinationRing: number;
  /** Ring indexes of opponent pieces captured by this move. */
  captures: number[];
  /** True when the move reaches the center. */
  finishes: boolean;
  /** True when a 6 rolls the piece out of its base. */
  releaseFromBase: boolean;
  /** True when the destination is a safe ring cell (or off the ring). */
  safe: boolean;
  /** True when the destination enters the private home column. */
  entersHome: boolean;
}

/**
 * Compute the destination path index for a piece, or null when the move
 * is illegal (needs a 6 to leave base, or would overshoot the finish).
 *
 * Pure arithmetic on the piece's own path: independent of the table, so
 * it needs no track.
 */
export function destinationOf(
  piece: RulePiece,
  dice: number,
  finishedPosition: number = FINISHED_POSITION,
): number | null {
  if (dice < 1 || dice > 6) return null;

  if (piece.position === -1) {
    // Only a 6 brings a piece out of base, landing on path index 0.
    return dice === 6 ? 0 : null;
  }
  if (piece.position === finishedPosition) return null;

  const target = piece.position + dice;
  if (target > finishedPosition) return null; // exact count required
  return target;
}

/** All legal moves for a player given their color, pieces and dice roll. */
export function legalMoves(
  track: LudoTrack,
  color: LudoColor,
  pieces: readonly RulePiece[],
  dice: number,
): ResolvedMove[] {
  const moves: ResolvedMove[] = [];
  for (const piece of pieces) {
    if (piece.position === track.finishedPosition) continue;
    const destination = destinationOf(piece, dice, track.finishedPosition);
    if (destination === null) continue;
    const destinationRing =
      destination < track.homeColumnStart
        ? track.ringIndexOf(color, destination)
        : -1;
    moves.push({
      pieceIndex: piece.index,
      fromPosition: piece.position,
      toPosition: destination,
      destinationRing,
      captures: [],
      finishes: destination === track.finishedPosition,
      releaseFromBase: piece.position === -1,
      safe: destinationRing === -1 || track.isSafeCell(destinationRing),
      entersHome: destinationRing === -1 && destination !== track.finishedPosition,
    });
  }
  return moves;
}

/**
 * Resolve captures for a move landing on the shared ring.
 *
 * Pieces entering their home column (path index >= track.homeColumnStart)
 * or finishing can never capture; pieces on safe ring cells can never be
 * captured.
 *
 * Two pieces only share a ring cell when their PATHS meet there: the
 * mover's own home column is private, and so is each opponent's, so the
 * comparison is done on ring indexes, never on path indexes.
 */
export function resolveCaptures(
  track: LudoTrack,
  moverColor: LudoColor,
  destination: number,
  opponents: readonly SeatedPlayer[],
): number[] {
  if (destination < 0 || destination >= track.homeColumnStart) return [];

  const ringIndex = track.ringIndexOf(moverColor, destination);
  if (track.isSafeCell(ringIndex)) return [];

  const captured: number[] = [];
  for (const opponent of opponents) {
    if (opponent.color === moverColor) continue;
    for (const piece of opponent.pieces) {
      if (piece.position < 0 || piece.position >= track.homeColumnStart) continue;
      if (track.ringIndexOf(opponent.color, piece.position) === ringIndex) {
        captured.push(piece.index);
      }
    }
  }
  return captured;
}

/**
 * Whether the mover may roll again: rolling a 6, capturing, or finishing
 * a piece each grant another turn (classic ruleset).
 */
export function grantsExtraTurn(
  dice: number,
  move: Pick<ResolvedMove, "captures" | "finishes">,
): boolean {
  return dice === 6 || move.captures.length > 0 || move.finishes;
}

/** Next player in seat order, skipping finished players. */
export function nextTurnUserId(
  currentUserId: string,
  players: ReadonlyArray<{ userId: string; finished: boolean }>,
): string {
  if (players.length === 0) return "";
  const currentIndex = players.findIndex((p) => p.userId === currentUserId);
  for (let step = 1; step <= players.length; step++) {
    const candidate = players[(currentIndex + step + players.length) % players.length];
    if (candidate && !candidate.finished) return candidate.userId;
  }
  return "";
}

/** A player wins when every piece is home. */
export function hasWon(
  pieces: readonly RulePiece[],
  finishedPosition: number = FINISHED_POSITION,
): boolean {
  return (
    pieces.length === PIECES_PER_PLAYER &&
    pieces.every((piece) => piece.position === finishedPosition)
  );
}
