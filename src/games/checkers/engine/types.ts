/**
 * Checkers domain types.
 *
 * Deliberately free of React, Colyseus and any I/O: the same engine runs
 * in the browser for local games and on the realtime server, which stays
 * authoritative for online games.
 *
 * Ruleset (mirrors theninthsky/checkers, the reference implementation):
 *   - 8x8 board, 12 men per side, dark squares only;
 *   - men step forward diagonally but capture in all four diagonals;
 *   - kings move and capture one square in any diagonal (not flying);
 *   - capturing is mandatory and the longest capture must be played;
 *   - a man promotes when its move ENDS on the far rank.
 */

export type Color = "white" | "black";

export type PieceKind = "man" | "king";

export interface Piece {
  readonly color: Color;
  readonly kind: PieceKind;
}

/** A board square: a piece, or null when empty. Non-playable squares stay null. */
export type Square = Piece | null;

/** Row-major 8x8 board, 64 entries, index = row * 8 + col. */
export type Board = readonly Square[];

/**
 * A fully described move.
 *
 * `path` matters: with the longest-capture rule two different capture
 * sequences can share the same origin and destination, so `from`/`to`
 * alone do not identify a move. Clients send the whole path and the
 * server matches on it.
 */
export interface Move {
  readonly from: number;
  readonly to: number;
  /** Squares landed on, in order, excluding `from`. */
  readonly path: readonly number[];
  /** Squares of the captured pieces, in capture order. */
  readonly captures: readonly number[];
  /** True when this move ends with a man reaching the far rank. */
  readonly promotes: boolean;
}

export type GameOutcome =
  | { readonly kind: "playing" }
  | {
      readonly kind: "win";
      readonly winner: Color;
      /** `captured-all`: no enemy pieces left. `no-moves`: enemy is stuck. */
      readonly reason: "captured-all" | "no-moves";
    }
  | { readonly kind: "draw"; readonly reason: "idle-plies" };

export interface GameState {
  readonly board: Board;
  readonly turn: Color;
  /**
   * Plies since the last capture or promotion. Drives the draw rule, the
   * only one this engine enforces on its own; repetition is left to the
   * caller, which can count `positionKey` values it has seen.
   */
  readonly idlePlies: number;
  readonly outcome: GameOutcome;
}
