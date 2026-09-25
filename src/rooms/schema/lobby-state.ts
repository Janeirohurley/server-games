import { schema, t, type SchemaType } from "@colyseus/schema";
import type { GameDefinition } from "../../games/registry.js";

/**
 * Generic lobby state — shared by every game.
 *
 * It knows about players, seats and the room lifecycle. It knows nothing
 * about Ludo rules; game-specific state lives in each game's own schema
 * (see games/ludo/ludo-state.ts).
 */

export const LIFECYCLE = {
  WAITING: "waiting",
  READY: "ready",
  PLAYING: "playing",
  FINISHED: "finished",
} as const;

export type LifecyclePhase = (typeof LIFECYCLE)[keyof typeof LIFECYCLE];

export const LobbyPlayerSchema = schema({
  /** Platform user id — the stable, persistent identity. */
  userId: t.string(),
  /** Display name. */
  name: t.string(),
  /** Colyseus session id of the current connection (empty when dropped). */
  sessionId: t.string().default(""),
  /** Seat index assigned in join order; used for turn order. */
  seat: t.uint8().default(0),
  /** Whether this player is currently connected (false while reconnecting). */
  connected: t.boolean().default(true),
});

export type LobbyPlayer = SchemaType<typeof LobbyPlayerSchema>;

export const LobbyStateSchema = schema({
  /** Which game this room runs (mirrors GameDefinition.id). */
  gameId: t.string(),
  /** Human-readable game name. */
  gameName: t.string(),
  /** Room capacity from the game definition. */
  maxPlayers: t.uint8(),
  /** Fewest players required to start. */
  minPlayers: t.uint8(),
  /** How many players the creator asked for (targetPlayers ≤ maxPlayers). */
  targetPlayers: t.uint8(),
  /** Lifecycle phase — a plain small string, see LIFECYCLE. */
  phase: t.string().default(LIFECYCLE.WAITING),
  /** userId of the room creator (host). */
  hostUserId: t.string().default(""),
  players: t.map(LobbyPlayerSchema),
});

export type LobbyState = SchemaType<typeof LobbyStateSchema>;

// ---------------------------------------------------------------------------
// Structural views
//
// Colyseus rooms have a single root state. Game rooms compose the lobby
// fields with their own schema, so the base room works against these
// structural interfaces rather than the concrete LobbyStateSchema — any
// game state carrying the same fields fits.
// ---------------------------------------------------------------------------

export interface LobbyPlayerLike {
  userId: string;
  name: string;
  sessionId: string;
  seat: number;
  connected: boolean;
}

export interface LobbyPlayersMapLike {
  get(userId: string): LobbyPlayerLike | undefined;
  set(userId: string, player: LobbyPlayerLike): unknown;
  delete(userId: string): unknown;
  readonly size: number;
  values(): Iterable<LobbyPlayerLike>;
}

/** The lobby-related fields every game room state must expose. */
export interface LobbyStateLike {
  gameId: string;
  gameName: string;
  maxPlayers: number;
  minPlayers: number;
  targetPlayers: number;
  phase: string;
  hostUserId: string;
  players: LobbyPlayersMapLike;
}

/** Helper: build the per-room metadata shown in room listings. */
export function lobbyMetadata(game: GameDefinition) {
  return { gameId: game.id, gameName: game.name };
}
