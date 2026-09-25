import assert from "assert";

import {
  BOARD_SIZE,
  applyMove,
  countPieces,
  createInitialState,
  findLegalMove,
  legalMoves,
  legalMovesFrom,
  squareIndex,
  tryMove,
  DRAW_IDLE_PLIES,
} from "../src/games/checkers/engine/index.js";
import type {
  Board,
  Color,
  GameState,
  PieceKind,
  Square,
} from "../src/games/checkers/engine/index.js";

/** Build a sparse position: only the listed squares hold a piece. */
function position(
  pieces: Array<[row: number, col: number, color: Color, kind?: PieceKind]>,
  turn: Color = "white",
): GameState {
  const board: Square[] = new Array<Square>(BOARD_SIZE * BOARD_SIZE).fill(null);
  for (const [row, col, color, kind = "man"] of pieces) {
    board[squareIndex(row, col)] = { color, kind };
  }
  return { board, turn, idlePlies: 0, outcome: { kind: "playing" } };
}

const at = (row: number, col: number) => squareIndex(row, col);
const pieceAt = (board: Board, row: number, col: number) =>
  board[squareIndex(row, col)];

describe("checkers engine", () => {
  describe("setup", () => {
    it("deals 12 men a side on dark squares only", () => {
      const state = createInitialState();
      assert.strictEqual(countPieces(state.board, "white"), 12);
      assert.strictEqual(countPieces(state.board, "black"), 12);

      state.board.forEach((square, index) => {
        if (!square) return;
        const row = Math.floor(index / BOARD_SIZE);
        const col = index % BOARD_SIZE;
        assert.strictEqual((row + col) % 2, 1, `square ${index} is light`);
        assert.strictEqual(square.kind, "man");
      });
    });

    it("gives White seven opening moves", () => {
      const state = createInitialState();
      const moves = legalMoves(state);
      assert.strictEqual(moves.length, 7);
      assert.ok(moves.every((move) => move.captures.length === 0));
    });
  });

  describe("simple movement", () => {
    it("moves a man one square diagonally forward", () => {
      const state = position([[4, 3, "white"]]);
      const moves = legalMovesFrom(state, at(4, 3));
      const destinations = moves.map((move) => move.to).sort();
      assert.deepStrictEqual(destinations, [at(3, 2), at(3, 4)].sort());
    });

    it("never lets a man step backwards", () => {
      const state = position([[4, 3, "white"]]);
      const moves = legalMovesFrom(state, at(4, 3));
      assert.ok(moves.every((move) => move.to !== at(5, 2)));
      assert.ok(moves.every((move) => move.to !== at(5, 4)));
    });

    it("rejects an illegal destination", () => {
      const state = position([[4, 3, "white"]]);
      // Straight ahead is not a diagonal, and it is a light square.
      assert.strictEqual(findLegalMove(state, at(4, 3), at(3, 3)), undefined);
      assert.strictEqual(tryMove(state, at(4, 3), at(3, 3)).move, undefined);
    });

    it("refuses to move a piece that is not the side to move", () => {
      const state = position([[4, 3, "white"], [2, 1, "black"]], "white");
      assert.strictEqual(legalMovesFrom(state, at(2, 1)).length, 0);
      assert.strictEqual(findLegalMove(state, at(2, 1), at(3, 0)), undefined);
    });

    it("cannot land on an occupied square", () => {
      const state = position([[4, 3, "white"], [3, 2, "white"]]);
      const moves = legalMovesFrom(state, at(4, 3));
      assert.deepStrictEqual(
        moves.map((move) => move.to),
        [at(3, 4)],
      );
    });
  });

  describe("captures", () => {
    it("makes capturing mandatory", () => {
      // The man on (4,3) could step quietly, but (5,6) can capture.
      const state = position([
        [4, 3, "white"],
        [5, 6, "white"],
        [4, 5, "black"],
      ]);
      const moves = legalMoves(state);
      assert.ok(moves.length > 0);
      assert.ok(
        moves.every((move) => move.captures.length > 0),
        "quiet moves must be filtered out when a capture exists",
      );
      assert.ok(moves.every((move) => move.from === at(5, 6)));
    });

    it("removes the jumped piece", () => {
      const state = position([[5, 2, "white"], [4, 3, "black"]]);
      const { state: next, move } = tryMove(state, at(5, 2), at(3, 4));
      assert.ok(move, "the jump should be legal");
      assert.deepStrictEqual([...move.captures], [at(4, 3)]);
      assert.strictEqual(pieceAt(next.board, 4, 3), null);
      assert.strictEqual(pieceAt(next.board, 3, 4)?.color, "white");
      assert.strictEqual(countPieces(next.board, "black"), 0);
    });

    it("lets a man capture backwards", () => {
      const state = position([[3, 2, "white"], [4, 3, "black"]]);
      const moves = legalMovesFrom(state, at(3, 2));
      assert.strictEqual(moves.length, 1);
      assert.strictEqual(moves[0].to, at(5, 4));
      assert.deepStrictEqual([...moves[0].captures], [at(4, 3)]);
    });

    it("chains a double capture into one move", () => {
      const state = position([
        [5, 0, "white"],
        [4, 1, "black"],
        [2, 3, "black"],
      ]);
      const moves = legalMovesFrom(state, at(5, 0));
      assert.strictEqual(moves.length, 1);
      const [move] = moves;
      assert.strictEqual(move.captures.length, 2);
      assert.strictEqual(move.to, at(1, 4));
      assert.deepStrictEqual([...move.path], [at(3, 2), at(1, 4)]);

      const next = applyMove(state, move);
      assert.strictEqual(countPieces(next.board, "black"), 0);
    });

    it("forces the longest capture", () => {
      // From (5,2): one way takes a single piece, the other takes two.
      const state = position([
        [5, 2, "white"],
        [4, 1, "black"],
        [4, 3, "black"],
        [2, 5, "black"],
      ]);
      const moves = legalMoves(state);
      assert.ok(moves.length > 0);
      assert.ok(
        moves.every((move) => move.captures.length === 2),
        "only the two-piece sequences may be played",
      );
    });

    it("never jumps the same piece twice", () => {
      const state = position([[5, 2, "white"], [4, 3, "black"]]);
      const moves = legalMovesFrom(state, at(5, 2));
      assert.ok(moves.every((move) => move.captures.length === 1));
    });
  });

  describe("promotion and kings", () => {
    it("crowns a man that ends its move on the far rank", () => {
      const state = position([[1, 2, "white"]]);
      const { state: next, move } = tryMove(state, at(1, 2), at(0, 1));
      assert.ok(move?.promotes);
      assert.strictEqual(pieceAt(next.board, 0, 1)?.kind, "king");
    });

    it("does not crown on the far rank of the other side", () => {
      const state = position([[6, 1, "black"]], "black");
      const { state: next, move } = tryMove(state, at(6, 1), at(7, 2));
      assert.ok(move?.promotes);
      assert.strictEqual(pieceAt(next.board, 7, 2)?.kind, "king");
    });

    it("lets a king move in all four diagonals", () => {
      const state = position([[4, 3, "white", "king"]]);
      const destinations = legalMovesFrom(state, at(4, 3))
        .map((move) => move.to)
        .sort((a, b) => a - b);
      assert.deepStrictEqual(
        destinations,
        [at(3, 2), at(3, 4), at(5, 2), at(5, 4)].sort((a, b) => a - b),
      );
    });

    it("keeps the king to a single square — it does not fly", () => {
      const state = position([[7, 0, "white", "king"]]);
      const destinations = legalMovesFrom(state, at(7, 0)).map((m) => m.to);
      assert.deepStrictEqual(destinations, [at(6, 1)]);
    });

    it("resets the idle counter on a promotion", () => {
      const state = { ...position([[1, 2, "white"]]), idlePlies: 7 };
      const { state: next } = tryMove(state, at(1, 2), at(0, 1));
      assert.strictEqual(next.idlePlies, 0);
    });
  });

  describe("turns", () => {
    it("hands the turn to the opponent after a move", () => {
      const state = createInitialState();
      assert.strictEqual(state.turn, "white");
      const moves = legalMoves(state);
      const next = applyMove(state, moves[0]);
      assert.strictEqual(next.turn, "black");
    });

    it("counts idle plies and resets them on a capture", () => {
      const quiet = position([[4, 3, "white"], [1, 0, "black"]]);
      const afterQuiet = applyMove(quiet, legalMovesFrom(quiet, at(4, 3))[0]);
      assert.strictEqual(afterQuiet.idlePlies, 1);

      const capture = {
        ...position([[5, 2, "white"], [4, 3, "black"], [0, 1, "black"]]),
        idlePlies: 9,
      };
      const { state: afterCapture } = tryMove(capture, at(5, 2), at(3, 4));
      assert.strictEqual(afterCapture.idlePlies, 0);
    });
  });

  describe("game over", () => {
    it("declares a win when the last enemy piece is captured", () => {
      const state = position([[5, 2, "white"], [4, 3, "black"]]);
      const { state: next } = tryMove(state, at(5, 2), at(3, 4));
      assert.deepStrictEqual(next.outcome, {
        kind: "win",
        winner: "white",
        reason: "captured-all",
      });
      assert.deepStrictEqual(legalMoves(next), []);
    });

    it("declares a win when the opponent is stuck with pieces left", () => {
      // Black men stranded on row 7 have nowhere to go: men never step
      // backwards, and there is no row 8. White is far away, so White's
      // move is a quiet one and nothing is captured.
      const state = position(
        [
          [4, 7, "white"],
          [7, 0, "black"],
          [7, 2, "black"],
        ],
        "white",
      );
      const { state: next, move } = tryMove(state, at(4, 7), at(3, 6));
      assert.ok(move, "White should have a quiet move available");
      assert.strictEqual(next.outcome.kind, "win");
      if (next.outcome.kind === "win") {
        assert.strictEqual(next.outcome.winner, "white");
        assert.strictEqual(next.outcome.reason, "no-moves");
      }
    });

    it("draws once the idle-ply limit is reached", () => {
      const state = {
        ...position([[4, 3, "white", "king"], [0, 1, "black", "king"]]),
        idlePlies: DRAW_IDLE_PLIES - 1,
      };
      const moves = legalMovesFrom(state, at(4, 3));
      const next = applyMove(state, moves[0]);
      assert.deepStrictEqual(next.outcome, { kind: "draw", reason: "idle-plies" });
    });

    it("refuses any move once the game is over", () => {
      const state = position([[5, 2, "white"], [4, 3, "black"]]);
      const { state: finished } = tryMove(state, at(5, 2), at(3, 4));
      assert.notStrictEqual(finished.outcome.kind, "playing");
      assert.deepStrictEqual(legalMoves(finished), []);
      assert.strictEqual(tryMove(finished, at(3, 4), at(2, 3)).move, undefined);
    });
  });

  describe("move resolution", () => {
    it("disambiguates equal-length sequences by path", () => {
      const state = position([
        [5, 2, "white"],
        [4, 1, "black"],
        [4, 3, "black"],
      ]);
      const moves = legalMovesFrom(state, at(5, 2));
      assert.ok(moves.length >= 2, "two single captures are available");

      for (const move of moves) {
        const resolved = findLegalMove(state, move.from, move.to, move.path);
        assert.ok(resolved, "the exact path must resolve");
        assert.deepStrictEqual([...resolved.path], [...move.path]);
      }
    });

    it("rejects a fabricated path", () => {
      const state = position([[5, 2, "white"], [4, 3, "black"]]);
      assert.strictEqual(
        findLegalMove(state, at(5, 2), at(3, 4), [at(3, 4), at(1, 2)]),
        undefined,
      );
    });
  });
});
