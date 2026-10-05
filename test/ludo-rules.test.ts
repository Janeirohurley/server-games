import assert from "assert";

import {
  destinationOf,
  legalMoves,
} from "../src/games/ludo/ludo-rules.js";
import {
  createTrack,
  FINISHED_POSITION,
  HOME_COLUMN_START,
} from "../src/games/ludo/ludo-state.js";

/*
 * Regression pin for the central finish: the center (FINISHED_POSITION
 * = 57) must be reachable by EXACT count from the home column, or it
 * is unreachable and pieces strand on the last column cell (the client
 * once mirrored a stale `<= 56` bound and could never click a
 * finishing move).
 *
 * These cases are table-size independent, so they run on a four-player
 * track — the size the rules shipped with. The per-size geometry is
 * pinned separately in `ludo-geometry.test.ts`.
 */

const pieceAt = (position: number, index = 0) => ({ index, position });
const track = createTrack(4);

describe("Ludo finish — the center is reachable by exact count", () => {
  it("exposes the authoritative constants the client must mirror", () => {
    assert.strictEqual(FINISHED_POSITION, 57);
    assert.strictEqual(HOME_COLUMN_START, 51);
  });

  it("steps along the home column one cell at a time", () => {
    assert.strictEqual(destinationOf(pieceAt(51), 1), 52);
    assert.strictEqual(destinationOf(pieceAt(54), 1), 55);
    assert.strictEqual(destinationOf(pieceAt(55), 1), 56);
  });

  it("reaches the center from the last column cell with an exact roll", () => {
    assert.strictEqual(destinationOf(pieceAt(56), 1), FINISHED_POSITION);
  });

  it("reaches the center with an exact count from further back", () => {
    assert.strictEqual(destinationOf(pieceAt(55), 2), FINISHED_POSITION);
    assert.strictEqual(destinationOf(pieceAt(51), 6), FINISHED_POSITION);
  });

  it("refuses to overshoot the center", () => {
    assert.strictEqual(destinationOf(pieceAt(56), 2), null);
    assert.strictEqual(destinationOf(pieceAt(55), 3), null);
    assert.strictEqual(destinationOf(pieceAt(51), 7), null); // not a die
  });

  it("offers the finishing move among the legal moves", () => {
    const moves = legalMoves(track, "yellow", [pieceAt(56, 2)], 1);
    assert.strictEqual(moves.length, 1);
    assert.strictEqual(moves[0].toPosition, FINISHED_POSITION);
    assert.strictEqual(moves[0].finishes, true);
  });

  it("never moves a piece that already finished", () => {
    assert.strictEqual(
      destinationOf(pieceAt(FINISHED_POSITION), 1),
      null,
    );
    assert.deepStrictEqual(
      legalMoves(track, "yellow", [pieceAt(FINISHED_POSITION)], 6),
      [],
    );
  });
});
