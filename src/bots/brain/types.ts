/**
 * Types for the Ludo AI brain.
 *
 * No Colyseus imports, no React, no clocks: the brain is a pure
 * computation (positions → chosen move) so it stays testable and
 * deterministic with an injected random generator. The driver (Phase 4)
 * supplies the situation; the brain never touches the room.
 *
 * Server port of game-platform `games/ludo/bot/types.ts`; the two are
 * kept deliberately parallel. The only divergence is the track: the
 * client derives it from the player count, while here it is threaded in
 * explicitly, because two rooms of different sizes can run at once.
 */

import type { LudoColor, LudoTrack } from "../../games/ludo/ludo-state.js";
import type { ResolvedMove, RulePiece, SeatedPlayer } from "../../games/ludo/ludo-rules.js";

/** The three levels. */
export type BotDifficulty = "easy" | "normal" | "hard";

/** French labels, aligned with the levels. */
export const BOT_DIFFICULTY_LABELS: Record<BotDifficulty, string> = {
  easy: "Facile",
  normal: "Normal",
  hard: "Difficile",
};

/** Display order (weakest to strongest). */
export const BOT_DIFFICULTIES: readonly BotDifficulty[] = [
  "easy",
  "normal",
  "hard",
];

/** Narrowing guard for untrusted labels (pool payloads, state strings). */
export function isBotDifficulty(value: unknown): value is BotDifficulty {
  return value === "easy" || value === "normal" || value === "hard";
}

/**
 * Strategy knobs an operator tunes from the console. Each is 0..1 with
 * 0.5 neutral: `aggression` leans toward capturing and pushing forward,
 * `caution` toward avoiding exposure. They only NUDGE the criteria — a
 * level still decides whether those criteria are read at all.
 */
export interface BrainConfig {
  aggression: number;
  caution: number;
}

/** Balanced, level-neutral knobs: the behaviour before any tuning. */
export const DEFAULT_BRAIN_CONFIG: BrainConfig = { aggression: 0.5, caution: 0.5 };

/** Clamp any incoming value into the 0..1 band, defaulting on nonsense. */
export function normalizeBrainConfig(value: unknown): BrainConfig {
  const source = (value ?? {}) as Partial<BrainConfig>;
  const clamp = (n: unknown, fallback: number): number => {
    const parsed = typeof n === "number" ? n : Number(n);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(1, Math.max(0, parsed));
  };
  return {
    aggression: clamp(source.aggression, DEFAULT_BRAIN_CONFIG.aggression),
    caution: clamp(source.caution, DEFAULT_BRAIN_CONFIG.caution),
  };
}

/** What the AI sees of its own situation. */
export interface BotContext {
  /** Geometry of THIS table (never module state — see ludo-state.ts). */
  track: LudoTrack;
  /** Colour of the seat the AI drives. */
  color: LudoColor;
  /** Value of the already-rolled die. */
  dice: number;
  /** The AI's own pieces. */
  pieces: readonly RulePiece[];
  /** The other seated players (opponents), with their pieces. */
  opponents: readonly SeatedPlayer[];
  /** Strategy knobs for THIS seat; defaults to balanced when absent. */
  config?: BrainConfig;
}

/**
 * An evaluated move. `score` and `reasons` are for transparency and
 * tests: this is NOT machine learning, just a sum of criteria.
 */
export interface ScoredMove {
  move: ResolvedMove;
  score: number;
  /** Human-readable reasons, most decisive first. */
  reasons: string[];
}

/** Random generator signature, injectable for tests. */
export type RandomFn = () => number;
