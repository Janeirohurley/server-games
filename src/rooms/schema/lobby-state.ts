import { schema, t, type SchemaType } from "@colyseus/schema";
import type { GameDefinition } from "../../games/registry.js";

/**
 * Generic lobby state — shared by every game.
 *
 * It knows about players, spectators, join requests and the room
 * lifecycle. It knows nothing about Ludo rules; game-specific state
 * lives in each game's own schema (see games/ludo/ludo-state.ts).
 *
 * Roles are server-side concepts expressed by three disjoint maps:
 *   - `players`               accepted, seated participants
 *   - `pendingPlayerRequests` asked to play, awaiting admin approval
 *   - `spectators`            read-only onlookers, never count against capacity
 */

export const LIFECYCLE = {
  WAITING: "waiting",
  READY: "ready",
  PLAYING: "playing",
  FINISHED: "finished",
  /** Explicitly shut down by an admin — terminal, never startable again. */
  CLOSED: "closed",
} as const;

export type LifecyclePhase = (typeof LIFECYCLE)[keyof typeof LIFECYCLE];

export const LobbyPlayerSchema = schema({
  /** Platform user id — the stable, persistent identity. */
  userId: t.string(),
  /** Display name (gamerTag) shown in rosters and boards. */
  name: t.string(),
  /** Avatar URL from the gamer profile (null = initials fallback). */
  avatarUrl: t.string().default(""),
  /** Colyseus session id of the current connection (empty when dropped). */
  sessionId: t.string().default(""),
  /** Seat index assigned in join order; used for turn order. */
  seat: t.uint8().default(0),
  /** Whether this player is currently connected (false while reconnecting). */
  connected: t.boolean().default(true),
  /**
   * Logical microphone state, set through the server-validated
   * `voice:mute` message. Voice activity itself is peer-to-peer and is
   * NOT server state — clients detect it locally from the audio levels.
   */
  voiceMuted: t.boolean().default(true),
  /** Admin-imposed mute (see base room `voice:admin-mute`). While set,
   * the player's own unmute requests are refused server-side. */
  adminMuted: t.boolean().default(false),
});

export type LobbyPlayer = SchemaType<typeof LobbyPlayerSchema>;

export const SpectatorSchema = schema({
  /** Platform user id — the stable, persistent identity. */
  userId: t.string(),
  /** Display name. */
  name: t.string(),
  /** Colyseus session id of the current connection (empty when dropped). */
  sessionId: t.string().default(""),
});

export type Spectator = SchemaType<typeof SpectatorSchema>;

export const PendingRequestSchema = schema({
  /** Platform user id of the requester. */
  userId: t.string(),
  /** Display name. */
  name: t.string(),
  /** Server clock timestamp (ms) of the request — display order. */
  requestedAt: t.uint32(),
});

export type PendingRequest = SchemaType<typeof PendingRequestSchema>;

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
  /** userId of the room admin (starts as the creator, may transfer). */
  hostUserId: t.string().default(""),
  players: t.map(LobbyPlayerSchema),
  /** Users waiting for admin approval to become players. */
  pendingPlayerRequests: t.map(PendingRequestSchema),
  /** Read-only onlookers — disjoint from players, outside capacity. */
  spectators: t.map(SpectatorSchema),
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
  /** Avatar URL from the gamer profile ("" = fallback initials). */
  avatarUrl: string;
  sessionId: string;
  seat: number;
  connected: boolean;
  voiceMuted: boolean;
  adminMuted: boolean;
}

export interface LobbySpectatorLike {
  userId: string;
  name: string;
  sessionId: string;
}

export interface LobbyPendingRequestLike {
  userId: string;
  name: string;
  requestedAt: number;
}

export interface LobbyPlayersMapLike {
  get(userId: string): LobbyPlayerLike | undefined;
  set(userId: string, player: LobbyPlayerLike): unknown;
  delete(userId: string): unknown;
  readonly size: number;
  values(): Iterable<LobbyPlayerLike>;
}

export interface LobbySpectatorsMapLike {
  get(userId: string): LobbySpectatorLike | undefined;
  set(userId: string, spectator: LobbySpectatorLike): unknown;
  delete(userId: string): unknown;
  readonly size: number;
  values(): Iterable<LobbySpectatorLike>;
}

export interface LobbyPendingRequestsMapLike {
  get(userId: string): LobbyPendingRequestLike | undefined;
  set(userId: string, request: LobbyPendingRequestLike): unknown;
  delete(userId: string): unknown;
  readonly size: number;
  values(): Iterable<LobbyPendingRequestLike>;
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
  /**
   * userId of the match winner, set by each game when the match ends.
   * Empty string while playing or on a draw — the base room reads it
   * at finishMatch() to derive per-player outcomes for the platform.
   */
  winnerUserId: string;
  players: LobbyPlayersMapLike;
  pendingPlayerRequests: LobbyPendingRequestsMapLike;
  spectators: LobbySpectatorsMapLike;
}

/** Helper: build the per-room metadata shown in room listings. */
export function lobbyMetadata(game: GameDefinition) {
  return { gameId: game.id, gameName: game.name };
}
