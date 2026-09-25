/**
 * Checkers rules: move generation, validation and outcome detection.
 *
 * Every function is pure — give it a state, get a new one. That is what
 * lets the browser run a local game and the realtime server replay the
 * exact same logic while staying authoritative online.
 */

import {
  colOf,
  countPieces,
  createInitialBoard,
  forwardStep,
  isOnBoard,
  opponentOf,
  promotionRow,
  rowOf,
  squareIndex,
} from "./board.js";
import type { Board, Color, GameState, Move, Piece, Square } from "./types.js";

/** Diagonals, as [rowDelta, colDelta]. Captures may use any of them. */
const DIAGONALS: readonly (readonly [number, number])[] = [
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1],
];

/**
 * Plies without a capture or a promotion after which the game is a draw.
 * 50 plies is 25 moves each — long enough that it only fires on a genuinely
 * dead position.
 */
export const DRAW_IDLE_PLIES = 50;

export function createInitialState(firstPlayer: Color = "white"): GameState {
  return {
    board: createInitialBoard(),
    turn: firstPlayer,
    idlePlies: 0,
    outcome: { kind: "playing" },
  };
}

/** Simple, non-capturing moves for the piece on `from`. */
function stepMoves(board: Board, from: number, piece: Piece): Move[] {
  const row = rowOf(from);
  const col = colOf(from);
  const forward = forwardStep(piece.color);
  const moves: Move[] = [];

  for (const [rowDelta, colDelta] of DIAGONALS) {
    // A man only steps forward; a king steps in any diagonal.
    if (piece.kind === "man" && rowDelta !== forward) continue;

    const targetRow = row + rowDelta;
    const targetCol = col + colDelta;
    if (!isOnBoard(targetRow, targetCol)) continue;

    const target = squareIndex(targetRow, targetCol);
    if (board[target]) continue;

    moves.push({
      from,
      to: target,
      path: [target],
      captures: [],
      promotes: piece.kind === "man" && targetRow === promotionRow(piece.color),
    });
  }

  return moves;
}

/**
 * All maximal capture sequences starting from `from`.
 *
 * Captured pieces stay on the board until the whole move resolves, so a
 * sequence can neither jump the same piece twice nor land on one. The
 * moving piece is treated as lifted, which is why it may return to its
 * own starting square on a circular capture.
 */
function captureMoves(board: Board, from: number, piece: Piece): Move[] {
  const results: Move[] = [];
  const captured: number[] = [];
  const path: number[] = [];

  const explore = (square: number): void => {
    const row = rowOf(square);
    const col = colOf(square);
    let extended = false;

    for (const [rowDelta, colDelta] of DIAGONALS) {
      const overRow = row + rowDelta;
      const overCol = col + colDelta;
      const landRow = row + rowDelta * 2;
      const landCol = col + colDelta * 2;
      if (!isOnBoard(landRow, landCol)) continue;

      const over = squareIndex(overRow, overCol);
      const land = squareIndex(landRow, landCol);

      const victim = board[over];
      if (!victim || victim.color === piece.color) continue;
      if (captured.includes(over)) continue;

      // The landing square must be free. `from` counts as free because the
      // moving piece has been lifted off it.
      if (board[land] && land !== from) continue;

      extended = true;
      captured.push(over);
      path.push(land);
      explore(land);
      path.pop();
      captured.pop();
    }

    if (!extended && path.length > 0) {
      const landing = path[path.length - 1];
      results.push({
        from,
        to: landing,
        path: [...path],
        captures: [...captured],
        promotes:
          piece.kind === "man" &&
          rowOf(landing) === promotionRow(piece.color),
      });
    }
  };

  explore(from);
  return results;
}

/**
 * Every legal move for the side to move.
 *
 * Capturing is mandatory across the whole board, and among the captures
 * only the longest ones may be played.
 */
export function legalMoves(state: GameState): Move[] {
  if (state.outcome.kind !== "playing") return [];

  const captures: Move[] = [];
  const steps: Move[] = [];

  for (let square = 0; square < state.board.length; square++) {
    const piece = state.board[square];
    if (!piece || piece.color !== state.turn) continue;

    const pieceCaptures = captureMoves(state.board, square, piece);
    if (pieceCaptures.length > 0) {
      captures.push(...pieceCaptures);
    } else if (captures.length === 0) {
      steps.push(...stepMoves(state.board, square, piece));
    }
  }

  if (captures.length === 0) return steps;

  const longest = captures.reduce(
    (best, move) => Math.max(best, move.captures.length),
    0,
  );
  return captures.filter((move) => move.captures.length === longest);
}

/** Legal moves for the piece on `from` only — what the UI highlights. */
export function legalMovesFrom(state: GameState, from: number): Move[] {
  return legalMoves(state).filter((move) => move.from === from);
}

const samePath = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

/**
 * Resolve a requested move against the legal ones.
 *
 * `path` disambiguates sequences that share an origin and a destination;
 * without it, a request is only accepted when exactly one move matches.
 * Returns undefined when the request is illegal — never trust the caller.
 */
export function findLegalMove(
  state: GameState,
  from: number,
  to: number,
  path?: readonly number[],
): Move | undefined {
  const candidates = legalMoves(state).filter(
    (move) => move.from === from && move.to === to,
  );

  if (path) return candidates.find((move) => samePath(move.path, path));
  return candidates.length === 1 ? candidates[0] : undefined;
}

function outcomeAfter(
  board: Board,
  nextTurn: Color,
  idlePlies: number,
): GameState["outcome"] {
  if (countPieces(board, nextTurn) === 0) {
    return { kind: "win", winner: opponentOf(nextTurn), reason: "captured-all" };
  }

  const probe: GameState = {
    board,
    turn: nextTurn,
    idlePlies,
    outcome: { kind: "playing" },
  };
  if (legalMoves(probe).length === 0) {
    return { kind: "win", winner: opponentOf(nextTurn), reason: "no-moves" };
  }

  if (idlePlies >= DRAW_IDLE_PLIES) return { kind: "draw", reason: "idle-plies" };

  return { kind: "playing" };
}

/**
 * Apply a move that has already been resolved by `findLegalMove`.
 *
 * Callers must not build a Move by hand: go through `findLegalMove` or
 * `legalMoves`, otherwise an illegal move would be applied verbatim.
 */
export function applyMove(state: GameState, move: Move): GameState {
  const board: Square[] = [...state.board];
  const piece = board[move.from];
  if (!piece) return state;

  board[move.from] = null;
  for (const captured of move.captures) board[captured] = null;

  board[move.to] = move.promotes ? { ...piece, kind: "king" } : piece;

  const reset = move.captures.length > 0 || move.promotes;
  const idlePlies = reset ? 0 : state.idlePlies + 1;
  const turn = opponentOf(state.turn);

  return {
    board,
    turn,
    idlePlies,
    outcome: outcomeAfter(board, turn, idlePlies),
  };
}

/**
 * Validate and apply in one step. Returns the unchanged state when the
 * move is illegal, so the caller can tell nothing happened.
 */
export function tryMove(
  state: GameState,
  from: number,
  to: number,
  path?: readonly number[],
): { state: GameState; move: Move | undefined } {
  const move = findLegalMove(state, from, to, path);
  return move ? { state: applyMove(state, move), move } : { state, move: undefined };
}
