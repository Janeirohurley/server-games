import { schema, t, type SchemaType } from "@colyseus/schema";

import type {
  LobbyPlayerLike,
  LobbyPlayersMapLike,
  LobbyStateLike,
} from "../../rooms/schema/lobby-state.js";
import { PendingRequestSchema, SpectatorSchema } from "../../rooms/schema/lobby-state.js";

/**
 * Rally state synchronized to both clients.
 *
 * Unlike a turn-based game, this is continuous physics: the ball and
 * both paddles are published as plain numbers and patched at the room's
 * rate, and the clients smooth between patches. Nothing here is a
 * command — it is the server's picture of the world.
 */

/** Seat order decides sides: seat 0 is the near side and serves first. */
export const SEAT_SIDES = [0, 1] as const;

export const RallyPlayerSchema = schema({
  userId: t.string(),
  name: t.string(),
  sessionId: t.string().default(""),
  seat: t.uint8().default(0),
  connected: t.boolean().default(true),
  /** Logical mic state for the voice roster (see base room `voice:mute`). */
  voiceMuted: t.boolean().default(true),
  /** Admin-imposed mute (base room `voice:admin-mute`): the target
   * cannot lift it themselves while set. */
  adminMuted: t.boolean().default(false),
  /** 0 = near side, 1 = far side. Assigned when the match starts. */
  side: t.uint8().default(0),
});

export type RallyPlayer = SchemaType<typeof RallyPlayerSchema>;

export const RallyStateSchema = schema({
  // --- generic lobby fields (kept in sync with the base room contract) ---
  gameId: t.string(),
  gameName: t.string(),
  maxPlayers: t.uint8(),
  minPlayers: t.uint8(),
  targetPlayers: t.uint8(),
  phase: t.string().default("waiting"),
  hostUserId: t.string().default(""),
  players: t.map(RallyPlayerSchema),
  pendingPlayerRequests: t.map(PendingRequestSchema),
  spectators: t.map(SpectatorSchema),

  // --- match state ---
  /** "intro" | "ready" | "playing" | "point" | "paused" | "over". */
  matchState: t.string().default("intro"),
  ballX: t.number().default(0),
  ballY: t.number().default(0),
  ballZ: t.number().default(0),
  nearX: t.number().default(0),
  nearY: t.number().default(0),
  farX: t.number().default(0),
  farY: t.number().default(0),
  scoreNear: t.uint8().default(0),
  scoreFar: t.uint8().default(0),
  rally: t.uint16().default(0),
  best: t.uint16().default(0),
  /** Which side serves the next point. */
  server: t.uint8().default(0),
  /** userId of the winner, empty until the match is decided. */
  winnerUserId: t.string().default(""),
});

export type RallyState = SchemaType<typeof RallyStateSchema>;

// Structural conformance: the Rally player map satisfies the lobby
// contract, and the whole state satisfies the base room's contract.
const _lobbyPlayersCheck: LobbyPlayersMapLike =
  null as unknown as RallyState["players"];
const _lobbyPlayerCheck: LobbyPlayerLike = null as unknown as RallyPlayer;
const _lobbyStateCheck: LobbyStateLike = null as unknown as RallyState;
void _lobbyPlayersCheck;
void _lobbyPlayerCheck;
void _lobbyStateCheck;
