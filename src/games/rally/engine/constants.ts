import type { Difficulty } from "./types.js";

/**
 * Table and physics, in metres and seconds. These are the reference
 * build's values — changing one changes how the game feels, so they are
 * kept together and named.
 */
export const TABLE = {
  halfWidth: 2.3,
  halfLength: 4,
  /** Height of the playing surface. */
  top: 0.82,
  ballRadius: 0.095,
  /** Where each paddle sits along z. */
  paddleZ: 4.45,
  paddleRadius: 0.52,
  gravity: 9.8,
  /** Energy kept on a bounce. */
  restitution: 0.84,
  netHeight: 0.46,
} as const;

/** How hard the computer plays. */
export interface LevelProfile {
  /** Paddle travel, metres per second. */
  speed: number;
  /** Aim scatter added to where it thinks the ball lands. */
  error: number;
  /** Reaction delay, seconds. */
  delay: number;
  /** Time of flight it gives its own returns — lower is faster. */
  flight: number;
  /** Chance of reading the shot wrong entirely. */
  misread: number;
}

export const LEVELS: Record<Difficulty, LevelProfile> = {
  chill: { speed: 2.3, error: 0.42, delay: 0.22, flight: 1.02, misread: 0.15 },
  club: { speed: 3.25, error: 0.24, delay: 0.15, flight: 0.94, misread: 0.075 },
  pro: { speed: 4.5, error: 0.1, delay: 0.08, flight: 0.85, misread: 0.025 },
};

/** First to 11, win by two. */
export const TARGET_SCORE = 11;
export const WINNING_MARGIN = 2;

/** How far the player's paddle may travel sideways. */
export const PADDLE_RANGE = 2.75;

/** The engine is stepped at a fixed rate, independent of the display. */
export const FIXED_STEP_SECONDS = 1 / 120;

export const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));
