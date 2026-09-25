/**
 * Rally — table tennis. Domain types.
 *
 * Ported from the reference build, keeping its constants and formulas
 * exactly. The engine is free of React, Three.js and the DOM: it steps
 * a world and emits events, and whoever owns it decides how to draw it.
 *
 * Mirrored from `game-platform/src/games/rally/engine` so an online
 * match is refereed by the same rules the browser runs offline. Keep
 * the two copies in step.
 */

/** 0 = the human player's side, 1 = the opponent's. */
export type Side = 0 | 1;

export type Difficulty = "chill" | "club" | "pro";

export type MatchState =
  | "intro"
  | "ready"
  | "playing"
  | "point"
  | "paused"
  | "over";

export interface Paddle {
  x: number;
  y: number;
  z: number;
  /** Horizontal velocity, used to add side spin to a return. */
  vx: number;
}

export interface Ball {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
}

/** Why a point ended — shown to the player verbatim. */
export type PointReason =
  | "Into the net"
  | "Service fault"
  | "Wrong-side bounce"
  | "Double bounce"
  | "Out of play"
  | "Shot went long"
  | "Clean winner";

export type RallyEvent =
  | { type: "start" }
  | { type: "ready"; server: Side }
  | { type: "serve"; side: Side }
  | { type: "hit"; side: Side; powered: boolean; x: number; y: number; z: number }
  | { type: "bounce"; x: number; y: number; z: number }
  | { type: "net" }
  | { type: "point"; side: Side; reason: PointReason; matchOver: boolean }
  | { type: "pause" }
  | { type: "resume" };

export interface RallyOptions {
  /** Injectable so a test can make a match deterministic. */
  random?: () => number;
  onEvent?: (event: RallyEvent) => void;
  level?: Difficulty;
  /**
   * True when side 1 is a second human. The computer is then switched
   * off entirely: that side moves and returns exactly like side 0.
   */
  opponentIsHuman?: boolean;
}

/** What the renderer reads each frame. */
export interface RallySnapshot {
  state: MatchState;
  player: Paddle;
  cpu: Paddle;
  ball: Ball;
  scores: readonly [number, number];
  rally: number;
  best: number;
  server: Side;
  winner: Side | null;
}
