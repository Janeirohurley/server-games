/**
 * Server-authoritative Ludo rules.
 *
 * Pure functions over plain snapshots — no Colyseus imports, no React,
 * no clocks. The room validates client intents through these before
 * mutating the synchronized state. Kept dependency-free so it can be
 * unit-tested directly and later shared with the platform if needed.
 */

import {
  COLORS,
  FINISHED_POSITION,
  HOME_COLUMN_START,
  PIECES_PER_PLAYER,
  isSafeRingCell,
  ringIndexOf,
  type LudoColor,
} from "./ludo-state.js";

/** Minimal piece snapshot the rules operate on. */
export interface RulePiece {
  index: number;
  position: number;
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
  /** True when the piece reached the center. */
  finishes: boolean;
}

/**
 * Compute the destination path index for a piece, or null when the move
 * is illegal (needs a 6 to leave base, or would overshoot the finish).
 */
export function destinationOf(
  piece: RulePiece,
  dice: number,
): number | null {
  if (dice < 1 || dice > 6) return null;

  if (piece.position === -1) {
    // Only a 6 brings a piece out of base, landing on path index 0.
    return dice === 6 ? 0 : null;
  }
  if (piece.position === FINISHED_POSITION) return null;

  const target = piece.position + dice;
  if (target > FINISHED_POSITION) return null; // exact count required
  return target;
}

/** All legal moves for a player given their color, pieces and dice roll. */
export function legalMoves(
  color: LudoColor,
  pieces: readonly RulePiece[],
  dice: number,
): ResolvedMove[] {
  const moves: ResolvedMove[] = [];
  for (const piece of pieces) {
    if (piece.position === FINISHED_POSITION) continue;
    const destination = destinationOf(piece, dice);
    if (destination === null) continue;
    moves.push({
      pieceIndex: piece.index,
      fromPosition: piece.position,
      toPosition: destination,
      destinationRing:
        destination < HOME_COLUMN_START ? ringIndexOf(color, destination) : -1,
      captures: [],
      finishes: destination === FINISHED_POSITION,
    });
  }
  return moves;
}

/**
 * Resolve captures for a move landing on the shared ring.
 * `allPieces` maps color → that player's pieces (any state).
 *
 * Pieces entering their home column (path index ≥ 51) or finishing can
 * never capture; pieces on safe ring cells can never be captured.
 */
export function resolveCaptures(
  moverColor: LudoColor,
  destination: number,
  allPieces: Readonly<Record<LudoColor, readonly RulePiece[]>>,
): number[] {
  if (destination < 0 || destination >= HOME_COLUMN_START) return [];

  const ringIndex = ringIndexOf(moverColor, destination);
  if (isSafeRingCell(ringIndex)) return [];

  const captured: number[] = [];
  for (const color of COLORS) {
    if (color === moverColor) continue;
    for (const piece of allPieces[color]) {
      if (piece.position < 0 || piece.position >= HOME_COLUMN_START) continue;
      if (ringIndexOf(color, piece.position) === ringIndex) {
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
export function hasWon(pieces: readonly RulePiece[]): boolean {
  return (
    pieces.length === PIECES_PER_PLAYER &&
    pieces.every((piece) => piece.position === FINISHED_POSITION)
  );
}
