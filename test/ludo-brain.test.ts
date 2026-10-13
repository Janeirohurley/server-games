import assert from "assert";

import { chooseMove, raceRiskFactor } from "../src/bots/brain/ludo-brain.js";
import type { BotContext, BrainConfig } from "../src/bots/brain/types.js";
import { createTrack, type LudoColor } from "../src/games/ludo/ludo-state.js";
import { legalMoves, type RulePiece } from "../src/games/ludo/ludo-rules.js";

/*
 * Port of game-platform `games/ludo/bot/bot.test.ts`. The brain logic is
 * shared verbatim; only the way the table geometry is supplied differs
 * (a `LudoTrack` from `createTrack` here, `getTrack(playerCount)` there).
 */

const track = createTrack(4);

/** An opponent piece `behind` ring cells BEHIND `dest`. */
function opponentBehind(dest: number, behind: number, color: LudoColor = "red") {
  const destRing = track.ringIndexOf("yellow", dest);
  const ring = (destRing - behind + track.ringLength) % track.ringLength;
  return { position: pathIndexOfRingOrThrow(color, ring), ring };
}

function pathIndexOfRingOrThrow(color: LudoColor, ring: number): number {
  for (let p = 0; p < track.homeColumnStart; p++) {
    if (track.ringIndexOf(color, p) === ring) return p;
  }
  throw new Error(`no path index for ${color} ring ${ring}`);
}

function rulePieces(positions: readonly number[]): RulePiece[] {
  return positions.map((position, index) => ({ index, position }));
}

function context(
  pieces: readonly number[],
  dice: number,
  opponents: readonly { color: LudoColor; pieces: number[] }[] = [],
  config?: BrainConfig,
): BotContext {
  return {
    track,
    color: "yellow",
    dice,
    pieces: rulePieces(pieces),
    opponents: opponents.map((opponent) => ({
      color: opponent.color,
      pieces: rulePieces(opponent.pieces),
    })),
    config,
  };
}

describe("ludo-brain — guards", () => {
  it("returns nothing with no legal move", () => {
    for (const difficulty of ["easy", "normal", "hard"] as const) {
      assert.strictEqual(chooseMove(difficulty, [], context([-1, -1, -1, -1], 3)), null);
    }
  });

  it("always returns a legal move, whatever the level", () => {
    const pieces = [20, 30, -1, 40];
    for (const difficulty of ["easy", "normal", "hard"] as const) {
      const legal = legalMoves(track, "yellow", rulePieces(pieces), 3);
      const choice = chooseMove(difficulty, legal, context(pieces, 3), () => 0.42);
      assert.ok(choice, "a choice is always made");
      assert.ok(legal.some((m) => m.pieceIndex === choice.move.pieceIndex));
    }
  });
});

describe("ludo-brain — Easy", () => {
  it("is deterministic for an injected RNG and stays legal", () => {
    const pieces = [-1, -1];
    const legal = legalMoves(track, "yellow", rulePieces(pieces), 6);
    const first = chooseMove("easy", legal, context(pieces, 6), () => 0.42);
    const second = chooseMove("easy", legal, context(pieces, 6), () => 0.42);
    assert.deepStrictEqual(first, second);
    assert.ok(legal.some((m) => m.pieceIndex === first!.move.pieceIndex));
  });
});

describe("ludo-brain — Normal", () => {
  it("prefers releasing a piece from base on a 6", () => {
    const pieces = [20, -1];
    const legal = legalMoves(track, "yellow", rulePieces(pieces), 6);
    const choice = chooseMove("normal", legal, context(pieces, 6));
    assert.strictEqual(choice!.move.releaseFromBase, true);
  });

  it("takes a capture when one is available", () => {
    // A red piece sits exactly on yellow's destination.
    const capture = opponentBehind(10, 0);
    const legal = legalMoves(track, "yellow", rulePieces([8]), 2);
    const ctx = context([8], 2, [{ color: "red", pieces: [capture.position] }]);
    const choice = chooseMove("normal", legal, ctx);
    assert.strictEqual(choice!.move.pieceIndex, 0);
  });
});

describe("ludo-brain — Hard", () => {
  it("rescues a threatened piece rather than advancing another as far", () => {
    // A at 30 is threatened by a red piece three cells behind; a 6 pushes
    // A to 36 (out of reach); B can also advance by 6.
    const threat = opponentBehind(30, 3);
    const legal = legalMoves(track, "yellow", rulePieces([30, 40]), 6);
    const ctx = context([30, 40], 6, [{ color: "red", pieces: [threat.position] }]);

    const normal = chooseMove("normal", legal, ctx);
    const hard = chooseMove("hard", legal, ctx);

    // Normal, with no notion of rescue, takes the farthest advance.
    assert.strictEqual(normal!.move.pieceIndex, 1);
    // Hard saves the threatened piece.
    assert.strictEqual(hard!.move.pieceIndex, 0);
    assert.strictEqual(hard!.move.toPosition, 36);
  });

  it("avoids exposing a piece when a safe equal move exists", () => {
    // Two moves of equal gain; one lands at 32 (threatened), the other at
    // 22 (safe).
    const threat = opponentBehind(32, 4);
    const legal = legalMoves(track, "yellow", rulePieces([30, 20]), 2);
    const ctx = context([30, 20], 2, [{ color: "red", pieces: [threat.position] }]);
    const hard = chooseMove("hard", legal, ctx);
    assert.strictEqual(hard!.move.pieceIndex, 1);
    assert.strictEqual(hard!.move.toPosition, 22);
  });
});

describe("ludo-brain — strategy knobs", () => {
  // One red piece sits on yellow's destination (capturable); six more sit
  // 1..6 rings behind it, so the capturing move lands in real danger.
  const capture = opponentBehind(10, 0);
  const reds = [
    capture.position,
    ...[1, 2, 3, 4, 5, 6].map((k) => opponentBehind(10, k).position),
  ];

  it("neutral knobs keep the capture — unchanged from the untuned brain", () => {
    const legal = legalMoves(track, "yellow", rulePieces([8, 30]), 2);
    const choice = chooseMove(
      "normal",
      legal,
      context([8, 30], 2, [{ color: "red", pieces: reds }]),
    );
    assert.strictEqual(choice!.move.pieceIndex, 0);
  });

  it("aggression leans into the capture, caution lets it go", () => {
    const legal = legalMoves(track, "yellow", rulePieces([8, 30]), 2);
    const bold = chooseMove(
      "normal",
      legal,
      context([8, 30], 2, [{ color: "red", pieces: reds }], {
        aggression: 1,
        caution: 0,
      }),
    );
    const timid = chooseMove(
      "normal",
      legal,
      context([8, 30], 2, [{ color: "red", pieces: reds }], {
        aggression: 0,
        caution: 1,
      }),
    );

    assert.strictEqual(bold!.move.pieceIndex, 0, "aggressive seizes the capture");
    assert.strictEqual(timid!.move.pieceIndex, 1, "cautious avoids the exposure");
  });
});

describe("raceRiskFactor — risk tolerance by race position", () => {
  it("is daring when trailing", () => {
    const factor = raceRiskFactor(
      context([3], 1, [{ color: "red", pieces: [40] }]),
    );
    assert.ok(factor < 1);
  });

  it("is cautious when leading", () => {
    const factor = raceRiskFactor(
      context([40], 1, [{ color: "red", pieces: [3] }]),
    );
    assert.ok(factor > 1);
  });

  it("is neutral when level", () => {
    const factor = raceRiskFactor(
      context([20], 1, [{ color: "red", pieces: [20] }]),
    );
    assert.strictEqual(factor, 1);
  });
});
