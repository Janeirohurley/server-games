/**
 * Checkers engine — the rules, with no UI and no transport.
 *
 * Mirrored from `game-platform/src/games/checkers/engine` so the realtime
 * server validates online moves with the exact same logic. Keep the two
 * copies in step; they are duplicated rather than imported because the
 * platform and the game server are separate codebases (same reasoning as
 * `src/lib/realtime/types.ts`).
 */

export * from "./types.js";
export * from "./board.js";
export * from "./rules.js";
