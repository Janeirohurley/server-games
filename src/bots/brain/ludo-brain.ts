/**
 * Ludo AI brain: a pure decision, no rendering and no network.
 *
 * PRINCIPLE: the brain only makes a choice AMONG LEGAL MOVES. Legality
 * comes from `ludo-rules.ts` (the room re-checks anyway before applying).
 * The brain knows neither Colyseus nor a board: it is given positions and
 * returns a piece index.
 *
 * THE THREE LEVELS DIFFER IN THE DECISION, not merely by a delay:
 *   - Easy  : random, with an occasional preference for a "can't be bad"
 *             move (finish, capture, release, land on a safe cell).
 *   - Normal: a sum of transparent criteria (finish, capture, release,
 *             safe cell, advance) minus an exposure penalty.
 *   - Hard  : Normal + risk evaluation (chance of being captured next
 *             turn, value of the piece lost), rescue (leaving a dangerous
 *             cell), chase (being able to capture next turn) and the
 *             RACE: a trailing player dares more, a leading player plays
 *             safe (see `raceRiskFactor`).
 *
 * Server port of game-platform `games/ludo/bot/bot.ts`. The logic is
 * intentionally identical; only the source of the table geometry differs
 * (the client derives it from the player count, here it arrives on the
 * context — see brain/types.ts).
 */

import type { LudoColor, LudoTrack } from "../../games/ludo/ludo-state.js";
import type {
  ResolvedMove,
  RulePiece,
  SeatedPlayer,
} from "../../games/ludo/ludo-rules.js";
import {
  DEFAULT_BRAIN_CONFIG,
  type BotContext,
  type BotDifficulty,
  type BrainConfig,
  type ScoredMove,
  type RandomFn,
} from "./types.js";

/** Weights of the criteria. Grouped here so they can be tuned at once. */
const WEIGHTS = {
  finish: 1000,
  captureBase: 550,
  capturePerStep: 6,
  release: 260,
  safe: 90,
  enterHome: 70,
  advancePerStep: 12,
  /** Normal: penalty per opponent piece threatening the destination. */
  threaten: 55,
  /** Hard: coefficient of the expected loss (probability × value). */
  expectedLoss: 8,
  /** Hard: bonus for leaving a threatened cell. */
  rescue: 45,
  /** Hard: bonus per opponent that can be captured next turn. */
  chase: 30,
} as const;

/**
 * The two knobs resolved into MULTIPLIERS around 1.0, so the neutral
 * config (0.5 / 0.5) leaves every weight exactly as tuned above. An
 * operator can thus bend a brain without changing its level.
 */
interface Strategy {
  /** Scales offensive weights (capture, release, advance, chase). */
  aggression: number;
  /** Scales defensive weights (safe cell, threat, expected loss, rescue). */
  caution: number;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}

function resolveStrategy(config?: BrainConfig): Strategy {
  const knobs = config ?? DEFAULT_BRAIN_CONFIG;
  return {
    aggression: 0.5 + clamp01(knobs.aggression),
    caution: 0.5 + clamp01(knobs.caution),
  };
}

interface CapturedPiece {
  color: LudoColor;
  index: number;
  position: number;
}

function isOnRing(track: LudoTrack, position: number): boolean {
  return position >= 0 && position < track.homeColumnStart;
}

/** Approximate progress of a piece (0 in base, +1 per step). */
function pieceSteps(position: number): number {
  return position < 0 ? 0 : position + 1;
}

/**
 * Opponent pieces this move captures, with their origin position — so
 * capturing an advanced piece weighs more than one still near its start.
 */
function capturesAt(
  track: LudoTrack,
  color: LudoColor,
  destination: number,
  opponents: readonly SeatedPlayer[],
): CapturedPiece[] {
  if (!isOnRing(track, destination)) return [];

  const ringIndex = track.ringIndexOf(color, destination);
  if (track.isSafeCell(ringIndex)) return [];

  const captured: CapturedPiece[] = [];
  for (const opponent of opponents) {
    if (opponent.color === color) continue;
    for (const piece of opponent.pieces) {
      if (!isOnRing(track, piece.position)) continue;
      if (track.ringIndexOf(opponent.color, piece.position) === ringIndex) {
        captured.push({
          color: opponent.color,
          index: piece.index,
          position: piece.position,
        });
      }
    }
  }
  return captured;
}

/**
 * Number of opponent pieces that could land on the cell occupied by a
 * `color` piece at `pathPosition` on the next roll. 0 if the cell is safe
 * or off the ring. This is the "threat" the Hard level reads.
 */
function ringThreatCount(
  track: LudoTrack,
  color: LudoColor,
  opponents: readonly SeatedPlayer[],
  pathPosition: number,
): number {
  if (!isOnRing(track, pathPosition)) return 0;
  const ring = track.ringIndexOf(color, pathPosition);
  if (track.isSafeCell(ring)) return 0;

  let count = 0;
  for (const opponent of opponents) {
    if (opponent.color === color) continue;
    for (const piece of opponent.pieces) {
      if (!isOnRing(track, piece.position)) continue;
      const theirRing = track.ringIndexOf(opponent.color, piece.position);
      const distance = (ring - theirRing + track.ringLength) % track.ringLength;
      if (distance >= 1 && distance <= 6) count++;
    }
  }
  return count;
}

/**
 * Number of opponent pieces `color` will be able to capture next roll
 * from `pathPosition` (pressure). Safe cells do not count.
 */
function chaseTargets(
  track: LudoTrack,
  color: LudoColor,
  opponents: readonly SeatedPlayer[],
  pathPosition: number,
): number {
  if (!isOnRing(track, pathPosition)) return 0;
  const ring = track.ringIndexOf(color, pathPosition);

  let count = 0;
  for (const opponent of opponents) {
    if (opponent.color === color) continue;
    for (const piece of opponent.pieces) {
      if (!isOnRing(track, piece.position)) continue;
      const theirRing = track.ringIndexOf(opponent.color, piece.position);
      if (track.isSafeCell(theirRing)) continue;
      const distance = (theirRing - ring + track.ringLength) % track.ringLength;
      if (distance >= 1 && distance <= 6) count++;
    }
  }
  return count;
}

/** Criteria shared by Normal and Hard, heaviest first. */
function baseScore(
  move: ResolvedMove,
  context: BotContext,
  strategy: Strategy,
): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;

  if (move.finishes) {
    score += WEIGHTS.finish;
    reasons.push("arrive au centre");
  }

  const captured = capturesAt(
    context.track,
    context.color,
    move.toPosition,
    context.opponents,
  );
  for (const piece of captured) {
    score +=
      (WEIGHTS.captureBase + pieceSteps(piece.position) * WEIGHTS.capturePerStep) *
      strategy.aggression;
  }
  if (captured.length > 0) {
    reasons.push(`capture ${captured.length} pion(s)`);
  }

  if (move.releaseFromBase) {
    score += WEIGHTS.release * strategy.aggression;
    reasons.push("sort de la base");
  }
  if (move.safe && !move.releaseFromBase) {
    score += WEIGHTS.safe * strategy.caution;
    reasons.push("arrive sur une case sûre");
  }
  if (move.entersHome) {
    score += WEIGHTS.enterHome;
    reasons.push("entre dans la colonne maison");
  }

  const advance = move.releaseFromBase ? 1 : move.toPosition - move.fromPosition;
  score += Math.max(advance, 0) * WEIGHTS.advancePerStep * strategy.aggression;

  return { score, reasons };
}

/** Total progress (in steps) of a set of pieces. */
function totalSteps(pieces: readonly RulePiece[]): number {
  return pieces.reduce((sum, piece) => sum + pieceSteps(piece.position), 0);
}

/**
 * Risk tolerance according to the RACE. A trailing player must dare to
 * come back; a leading player plays it safe. This is the only
 * computation that looks at the GLOBAL table state and not just the moved
 * piece — hence the Hard level only.
 *
 *   - trailing → 0.7 (accept more exposure rather than fall behind)
 *   - leading  → 1.3 (overestimate the danger, protect the lead)
 *   - level    → 1
 */
export function raceRiskFactor(context: BotContext): number {
  const own = totalSteps(context.pieces);
  const bestOpponent = context.opponents.reduce(
    (best, opponent) => Math.max(best, totalSteps(opponent.pieces)),
    0,
  );
  if (own < bestOpponent) return 0.7;
  if (own > bestOpponent) return 1.3;
  return 1;
}

function scoreHard(
  move: ResolvedMove,
  context: BotContext,
  strategy: Strategy,
): ScoredMove {
  const base = baseScore(move, context, strategy);
  const reasons = [...base.reasons];
  const score = base.score;

  const destThreats = ringThreatCount(
    context.track,
    context.color,
    context.opponents,
    move.toPosition,
  );
  // Probability of being captured next turn (at least one opponent reaches
  // the cell): 1 - (5/6)^threats, each opponent having a one-in-six chance
  // to land exactly on it.
  const captureChance = 1 - Math.pow(5 / 6, destThreats);
  const lostValue = pieceSteps(move.toPosition);
  const risk = raceRiskFactor(context);
  const expectedLoss =
    captureChance * lostValue * WEIGHTS.expectedLoss * risk * strategy.caution;
  if (expectedLoss > 0) reasons.push(`risque de perte ${expectedLoss.toFixed(0)}`);

  const originThreats = ringThreatCount(
    context.track,
    context.color,
    context.opponents,
    move.fromPosition,
  );
  const rescue =
    originThreats > destThreats
      ? (originThreats - destThreats) * WEIGHTS.rescue * strategy.caution
      : 0;
  if (rescue > 0) reasons.push("échappe à une menace");

  const chases = chaseTargets(
    context.track,
    context.color,
    context.opponents,
    move.toPosition,
  );
  if (chases > 0) reasons.push(`met la pression sur ${chases} pion(s)`);

  return {
    move,
    score:
      score -
      expectedLoss +
      rescue +
      chases * WEIGHTS.chase * strategy.aggression,
    reasons,
  };
}

function scoreNormal(
  move: ResolvedMove,
  context: BotContext,
  strategy: Strategy,
): ScoredMove {
  const { score, reasons } = baseScore(move, context, strategy);
  const threats = ringThreatCount(
    context.track,
    context.color,
    context.opponents,
    move.toPosition,
  );
  if (threats > 0) reasons.push(`exposé à ${threats} pion(s)`);
  return {
    move,
    score: score - threats * WEIGHTS.threaten * strategy.caution,
    reasons,
  };
}

function chooseEasy(
  legal: readonly ResolvedMove[],
  context: BotContext,
  random: RandomFn,
): ScoredMove {
  const obvious = legal.filter(
    (move) =>
      move.finishes ||
      move.releaseFromBase ||
      move.safe ||
      capturesAt(context.track, context.color, move.toPosition, context.opponents)
        .length > 0,
  );

  // One time out of two, the easy AI takes a "can't be bad" move (release,
  // capture, finish, land on a safe cell) without seeking the optimum.
  // Otherwise it plays fully at random. It is thus always legal, but not
  // reliable — the hallmark of an easy level.
  const pool = random() < 0.5 && obvious.length > 0 ? obvious : legal;
  const choice = pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
  return { move: choice, score: 0, reasons: ["choix facile"] };
}

/**
 * Chooses a move among moves that are ALREADY LEGAL. Returns `null` if
 * there is nothing to play (the turn then goes back to the game, which
 * handles passing).
 */
export function chooseMove(
  difficulty: BotDifficulty,
  legal: readonly ResolvedMove[],
  context: BotContext,
  random: RandomFn = Math.random,
): ScoredMove | null {
  if (legal.length === 0) return null;
  if (difficulty === "easy") return chooseEasy(legal, context, random);

  const strategy = resolveStrategy(context.config);
  const scored = legal.map((move) =>
    difficulty === "hard"
      ? scoreHard(move, context, strategy)
      : scoreNormal(move, context, strategy),
  );
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      b.move.toPosition - a.move.toPosition ||
      a.move.pieceIndex - b.move.pieceIndex,
  );
  return scored[0];
}
