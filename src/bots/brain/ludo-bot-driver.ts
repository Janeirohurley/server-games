/**
 * Ludo bot driver — drives a seated bot through real turns.
 *
 * The brain (ludo-brain.ts) only chooses among legal moves. The driver
 * does the rest: it waits for a bot's turn, rolls on its behalf, waits for
 * the die, picks one legal move and applies it — one action at a time,
 * never during an animation.
 *
 * It is deliberately generic over its host (see `LudoBotHost`): the room
 * supplies the turn state and the two actions, the driver owns only the
 * pacing and the decision. That keeps the driver unit-testable without a
 * Colyseus server.
 *
 * Anti-double-action: each "decision point" (roll, or move) has a key
 * derived from the state (`userId`, die value). A key already scheduled is
 * not scheduled again, and every state change the room reports cancels the
 * pending timer and re-evaluates. Because the room always resets
 * `diceValue` to 0 for an extra turn, that extra roll goes through a fresh
 * "roll" decision point.
 */

import type { LudoColor, LudoTrack } from "../../games/ludo/ludo-state.js";
import type { ResolvedMove, RulePiece } from "../../games/ludo/ludo-rules.js";
import { chooseMove } from "./ludo-brain.js";
import {
  isBotDifficulty,
  normalizeBrainConfig,
  type BotContext,
  type BotDifficulty,
  type BrainConfig,
} from "./types.js";

/** Presentation-only delays: the time a human needs to see the action. */
export const BOT_ROLL_DELAY_MS = 700;
export const BOT_MOVE_DELAY_MS = 600;

/** Minimal seat shape the driver needs (a LudoPlayer satisfies it). */
export interface BotSeat {
  userId: string;
  /**
   * Whether a brain drives this seat. Independent of ACCOUNT identity:
   * the seat may belong to a bot account or to any ordinary account a
   * brain was attached to. The driver only cares that a brain is in
   * control — never who the account is.
   */
  brainControlled: boolean;
  botDifficulty: string;
  /** Strategy knobs for this seat; balanced when absent. */
  brainConfig?: BrainConfig;
  color: string;
  pieces: ReadonlyArray<{ index: number; position: number }>;
}

/** Anything with `clear()` (Colyseus `Delayed` fits). */
export interface BotTimer {
  clear(): void;
}

/** What the driver needs from the room. */
export interface LudoBotHost {
  /** Board geometry of this table. */
  track(): LudoTrack;
  /** True only while the match is actually being played. */
  isPlaying(): boolean;
  /** The player whose turn it is, or undefined. */
  currentPlayer(): BotSeat | undefined;
  /** Every seated player (used to build opponents). */
  seatedPlayers(): readonly BotSeat[];
  /** Current die value (0 = none pending). */
  diceValue(): number;
  /** Legal moves for `player` with the current die. */
  legalMovesFor(player: BotSeat): ResolvedMove[];
  /** Roll on behalf of `player` (the server owns the value). */
  roll(player: BotSeat): void;
  /** Apply a chosen move for `player`. */
  move(player: BotSeat, pieceIndex: number): void;
  /** Schedule `fn` after `delayMs`; the handle lets it be cancelled. */
  schedule(delayMs: number, fn: () => void): BotTimer;
}

function toRulePieces(
  pieces: ReadonlyArray<{ index: number; position: number }>,
): RulePiece[] {
  return pieces.map((piece) => ({ index: piece.index, position: piece.position }));
}

function difficultyOf(player: BotSeat): BotDifficulty {
  return isBotDifficulty(player.botDifficulty) ? player.botDifficulty : "normal";
}

function buildContext(host: LudoBotHost, player: BotSeat): BotContext {
  return {
    track: host.track(),
    color: player.color as LudoColor,
    dice: host.diceValue(),
    pieces: toRulePieces(player.pieces),
    opponents: host
      .seatedPlayers()
      .filter((seat) => seat.userId !== player.userId)
      .map((seat) => ({
        color: seat.color as LudoColor,
        pieces: toRulePieces(seat.pieces),
      })),
    config: normalizeBrainConfig(player.brainConfig),
  };
}

export class LudoBotDriver {
  private timer?: BotTimer;
  private scheduledKey = "";

  constructor(private readonly host: LudoBotHost) {}

  /**
   * Re-evaluate the table after any change that may give or alter a bot's
   * turn (match start, a roll, a move, a passed turn). Safe to call
   * liberally: an unchanged decision point is a no-op.
   */
  onTurnChanged(): void {
    if (!this.host.isPlaying()) {
      this.cancel();
      return;
    }
    const player = this.host.currentPlayer();
    if (!player || !player.brainControlled) {
      this.cancel();
      return;
    }

    const dice = this.host.diceValue();
    const key = `${player.userId}:${dice}`;
    if (this.scheduledKey === key) return;

    this.cancel();
    this.scheduledKey = key;
    this.timer = this.host.schedule(
      dice === 0 ? BOT_ROLL_DELAY_MS : BOT_MOVE_DELAY_MS,
      () => {
        this.timer = undefined;
        this.act();
      },
    );
  }

  /** Stop any pending bot action (room closing, match over, dispose). */
  dispose(): void {
    this.cancel();
  }

  private act(): void {
    if (!this.host.isPlaying()) return;
    const player = this.host.currentPlayer();
    if (!player || !player.brainControlled) return;

    if (this.host.diceValue() === 0) {
      this.host.roll(player);
      return;
    }

    const legal = this.host.legalMovesFor(player);
    const choice = chooseMove(difficultyOf(player), legal, buildContext(this.host, player));
    if (choice) this.host.move(player, choice.move.pieceIndex);
  }

  private cancel(): void {
    this.timer?.clear();
    this.timer = undefined;
    this.scheduledKey = "";
  }
}
