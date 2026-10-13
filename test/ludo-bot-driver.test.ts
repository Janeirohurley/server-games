import assert from "assert";

import {
  LudoBotDriver,
  type BotSeat,
  type BotTimer,
  type LudoBotHost,
} from "../src/bots/brain/ludo-bot-driver.js";
import { createTrack } from "../src/games/ludo/ludo-state.js";
import type { ResolvedMove } from "../src/games/ludo/ludo-rules.js";

/*
 * The driver owns pacing and the decision; the room supplies state and
 * the two actions. This suite drives it with a fake host and a manual
 * clock, so it pins the anti-double-action behaviour and the roll → move →
 * extra-roll progression without booting Colyseus.
 */

function move(overrides: Partial<ResolvedMove> = {}): ResolvedMove {
  return {
    pieceIndex: 0,
    fromPosition: 0,
    toPosition: 1,
    destinationRing: 1,
    captures: [],
    finishes: false,
    releaseFromBase: false,
    safe: false,
    entersHome: false,
    ...overrides,
  };
}

function seat(overrides: Partial<BotSeat> = {}): BotSeat {
  return {
    userId: "bot",
    brainControlled: true,
    botDifficulty: "normal",
    color: "yellow",
    pieces: [
      { index: 0, position: 0 },
      { index: 1, position: 5 },
    ],
    ...overrides,
  };
}

class FakeHost implements LudoBotHost {
  phase: "playing" | "waiting" = "playing";
  turn = "bot";
  dice = 0;
  seats = new Map<string, BotSeat>([
    ["bot", seat()],
    ["human", seat({ userId: "human", brainControlled: false, botDifficulty: "", color: "red" })],
  ]);
  availableMoves: ResolvedMove[] = [move({ pieceIndex: 0 }), move({ pieceIndex: 1, toPosition: 9 })];

  rollCalls: string[] = [];
  moveCalls: Array<[string, number]> = [];
  private pending: Array<{ fn: () => void; cleared: boolean }> = [];

  track() {
    return createTrack(2);
  }
  isPlaying() {
    return this.phase === "playing";
  }
  currentPlayer() {
    return this.seats.get(this.turn);
  }
  seatedPlayers() {
    return [...this.seats.values()];
  }
  diceValue() {
    return this.dice;
  }
  legalMovesFor() {
    return this.availableMoves;
  }
  roll(s: BotSeat) {
    this.rollCalls.push(s.userId);
    this.dice = 5; // the room would roll and set the die
  }
  move(s: BotSeat, pieceIndex: number) {
    this.moveCalls.push([s.userId, pieceIndex]);
  }
  schedule(_delay: number, fn: () => void): BotTimer {
    const entry = { fn, cleared: false };
    this.pending.push(entry);
    return { clear: () => { entry.cleared = true; } };
  }

  scheduledCount(): number {
    return this.pending.filter((p) => !p.cleared).length;
  }
  /** Run the oldest still-armed timer (the driver's next action). */
  tick(): void {
    const entry = this.pending.find((p) => !p.cleared);
    if (!entry) throw new Error("no pending timer to tick");
    entry.cleared = true;
    entry.fn();
  }
}

describe("LudoBotDriver", () => {
  it("does nothing while it is a human's turn", () => {
    const host = new FakeHost();
    host.turn = "human";
    new LudoBotDriver(host).onTurnChanged();
    assert.strictEqual(host.scheduledCount(), 0);
  });

  it("does nothing outside a live match", () => {
    const host = new FakeHost();
    host.phase = "waiting";
    new LudoBotDriver(host).onTurnChanged();
    assert.strictEqual(host.scheduledCount(), 0);
  });

  it("rolls for the bot when it is its turn with no die", () => {
    const host = new FakeHost();
    const driver = new LudoBotDriver(host);
    driver.onTurnChanged();
    assert.strictEqual(host.scheduledCount(), 1);
    host.tick();
    assert.deepStrictEqual(host.rollCalls, ["bot"]);
  });

  it("moves for the bot once a die is present", () => {
    const host = new FakeHost();
    host.dice = 5;
    const driver = new LudoBotDriver(host);
    driver.onTurnChanged();
    host.tick();
    assert.strictEqual(host.moveCalls.length, 1);
    assert.strictEqual(host.moveCalls[0][0], "bot");
    assert.ok([0, 1].includes(host.moveCalls[0][1]));
  });

  it("does not schedule the same decision point twice", () => {
    const host = new FakeHost();
    const driver = new LudoBotDriver(host);
    driver.onTurnChanged();
    driver.onTurnChanged();
    driver.onTurnChanged();
    assert.strictEqual(host.scheduledCount(), 1);
  });

  it("re-rolls for an extra turn (die reset to 0)", () => {
    const host = new FakeHost();
    host.dice = 5;
    const driver = new LudoBotDriver(host);
    driver.onTurnChanged();
    host.tick();
    // The room resolves an extra turn by clearing the die…
    host.dice = 0;
    driver.onTurnChanged();
    host.tick();
    assert.deepStrictEqual(host.rollCalls, ["bot"]);
  });

  it("cancels a pending action on dispose", () => {
    const host = new FakeHost();
    const driver = new LudoBotDriver(host);
    driver.onTurnChanged();
    assert.strictEqual(host.scheduledCount(), 1);
    driver.dispose();
    assert.strictEqual(host.scheduledCount(), 0);
  });
});
