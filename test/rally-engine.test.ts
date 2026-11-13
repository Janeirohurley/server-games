import assert from "node:assert/strict";

import { RallyMatch } from "../src/games/rally/engine/index.js";
import type { RallySave } from "../src/games/rally/engine/index.js";

/**
 * `serialize()` / `RallyMatch.restore()` back the "resume after reload" feature:
 * a saved match must rebuild into the exact same state, or a refresh would
 * silently move the ball and the score.
 */
describe("RallyMatch serialize/restore", () => {
  function playAFewPoints(): RallyMatch {
    let seed = 42;
    const match = new RallyMatch({
      level: "pro",
      // Deterministic RNG so the two matches see the same serves.
      random: () => {
        seed = (seed * 1103515245 + 12345) % 0x80000000;
        return seed / 0x80000000;
      },
    });

    match.start("pro");

    // Step for a while so the ball is mid-flight, a point is scored and the
    // counters (rally, bounces, aiTarget…) all drift away from their defaults.
    for (let i = 0; i < 1200; i++) match.step(1 / 120);

    return match;
  }

  it("rebuilds an identical match", () => {
    const original = playAFewPoints();
    const saved = original.serialize();

    const rebuilt = RallyMatch.restore(saved);

    assert.deepEqual(rebuilt.serialize(), saved);
    assert.deepEqual(rebuilt.snapshot(), original.snapshot());
  });

  it("keeps stepping the same way after a restore", () => {
    const saved: RallySave = playAFewPoints().serialize();

    const before = RallyMatch.restore(saved);
    const after = RallyMatch.restore(saved);

    for (let i = 0; i < 240; i++) {
      before.step(1 / 120);
      after.step(1 / 120);
    }

    assert.deepEqual(after.snapshot(), before.snapshot());
  });
});
