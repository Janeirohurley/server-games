import { schema, t, type SchemaType } from "@colyseus/schema";

import {
  PendingRequestSchema,
  SpectatorSchema,
  type LobbyPlayerLike,
  type LobbyPlayersMapLike,
  type LobbyStateLike,
} from "../../rooms/schema/lobby-state.js";

/**
 * Ludo state synchronized to every client.
 *
 * The root schema composes the generic lobby fields (required by the
 * base room) with Ludo's own fields.
 *
 * Piece position convention (mirrors the client's existing GameState):
 *   -1  → in base
 *   0-56 → index along the player's own path
 *   57 → finished (center)
 *
 * Track model: one shared ring of 52 cells + a 6-cell home column per
 * color. A piece's path index 0-50 maps onto the shared ring via the
 * color's start offset; indexes 51-56 are the private home column.
 */

export const PIECES_PER_PLAYER = 4;
export const RING_LENGTH = 52;
/** Path indexes 0-50 are on the shared ring; 51-56 are the home column. */
export const HOME_COLUMN_START = 51;
export const FINISHED_POSITION = 57;

/** Color order matches seat order (seat % 4). */
export const COLORS = ["yellow", "red", "blue", "green"] as const;
export type LudoColor = (typeof COLORS)[number];

/** Where each color's path index 0 sits on the shared ring. */
export const RING_OFFSETS: Record<LudoColor, number> = {
  yellow: 0,
  red: 13,
  blue: 26,
  green: 39,
};

/**
 * Safe cells on the shared ring: the 4 start cells plus the 4 star cells.
 */
const RING_STAR_CELLS = [8, 21, 34, 47];
export const SAFE_RING_CELLS: ReadonlySet<number> = new Set([
  ...Object.values(RING_OFFSETS),
  ...RING_STAR_CELLS,
]);

export function isSafeRingCell(ringIndex: number): boolean {
  return SAFE_RING_CELLS.has(ringIndex);
}

/** Map a color's path index (0-50) onto the shared ring. */
export function ringIndexOf(color: LudoColor, pathIndex: number): number {
  return (RING_OFFSETS[color] + pathIndex) % RING_LENGTH;
}

/** One piece of one player. Exported so the room can instantiate it. */
export const LudoPieceSchema = schema({
  /** Index of the piece within its player's set (0-3). */
  index: t.uint8().default(0),
  /** -1 = base, 0-56 = path index, 57 = finished. */
  position: t.int8().default(-1),
});
export type LudoPiece = SchemaType<typeof LudoPieceSchema>;

const LudoPlayerSchemaFields = {
  userId: t.string(),
  name: t.string(),
  color: t.string(),
  /** Colyseus session id (empty while disconnected). */
  sessionId: t.string().default(""),
  /** Turn order position (mirrors the lobby seat). */
  seat: t.uint8().default(0),
  connected: t.boolean().default(true),
  /** Finished piece count, maintained by the room for cheap victory checks. */
  finished: t.uint8().default(0),
  pieces: t.array(LudoPieceSchema),
};

export const LudoPlayerSchema = schema(LudoPlayerSchemaFields);
export type LudoPlayer = SchemaType<typeof LudoPlayerSchema>;

export const LudoStateSchema = schema({
  // --- generic lobby fields (kept in sync with the base room contract) ---
  gameId: t.string(),
  gameName: t.string(),
  maxPlayers: t.uint8(),
  minPlayers: t.uint8(),
  targetPlayers: t.uint8(),
  phase: t.string().default("waiting"),
  hostUserId: t.string().default(""),
  players: t.map(LudoPlayerSchema),
  pendingPlayerRequests: t.map(PendingRequestSchema),
  spectators: t.map(SpectatorSchema),

  // --- ludo-specific fields ---
  /** userId of whoever may roll/move right now; empty between matches. */
  currentTurn: t.string().default(""),
  /** Room-clock time (ms) the current turn expires — clients render the countdown. */
  turnDeadline: t.number().default(0),
  /** Last dice value rolled; 0 when no roll is pending. */
  diceValue: t.uint8().default(0),
  /** Set once a player has all four pieces home. */
  winnerUserId: t.string().default(""),
});

export type LudoState = SchemaType<typeof LudoStateSchema>;

// Structural conformance: the Ludo player map satisfies the lobby
// contract, and the whole state satisfies the base room's contract.
const _lobbyPlayersCheck: LobbyPlayersMapLike = null as unknown as LudoState["players"];
const _lobbyPlayerCheck: LobbyPlayerLike = null as unknown as LudoPlayer;
const _lobbyStateCheck: LobbyStateLike = null as unknown as LudoState;
void _lobbyPlayersCheck;
void _lobbyPlayerCheck;
void _lobbyStateCheck;
