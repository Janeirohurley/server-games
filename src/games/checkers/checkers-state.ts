import { schema, t, type SchemaType } from "@colyseus/schema";

import type {
  LobbyPlayerLike,
  LobbyPlayersMapLike,
  LobbyStateLike,
} from "../../rooms/schema/lobby-state.js";
import {
  JoinRequestResultSchema,
  PendingRequestSchema,
  SpectatorSchema,
} from "../../rooms/schema/lobby-state.js";
import type { Color } from "./engine/index.js";

// The board encoding is the engine's — the wire format and the rules
// must never drift apart.
export { EMPTY_SQUARE, decodeBoard, encodeBoard } from "./engine/index.js";

/**
 * Checkers state synchronized to both clients.
 *
 * The board travels as a 64-character string rather than a schema array:
 * it is one small field, it diffs cheaply, and it is the engine's own
 * encoding (re-exported below), so the wire format and the rules cannot
 * drift apart.
 */

/** Seat order decides colors: seat 0 plays White and moves first. */
export const SEAT_COLORS = ["white", "black"] as const;

/**
 * Why a match ended. The first three mirror the engine's own outcomes;
 * `timeout` and `forfeit` are room-level concerns the engine knows
 * nothing about.
 */
export type CheckersEndReason =
  | "captured-all"
  | "no-moves"
  | "idle-plies"
  | "timeout"
  | "forfeit";

export const CheckersPlayerSchema = schema({
  userId: t.string(),
  name: t.string(),
  sessionId: t.string().default(""),
  seat: t.uint8().default(0),
  connected: t.boolean().default(true),
  /** Avatar URL from the gamer profile ("" = initials fallback). */
  avatarUrl: t.string().default(""),
  /** Logical mic state for the voice roster (see base room `voice:mute`). */
  voiceMuted: t.boolean().default(true),
  /** Admin-imposed mute (base room `voice:admin-mute`): the target
   * cannot lift it themselves while set. */
  adminMuted: t.boolean().default(false),
  /** "white" or "black" — assigned from the seat when the match starts. */
  color: t.string().default(""),
});

export type CheckersPlayer = SchemaType<typeof CheckersPlayerSchema>;

export const CheckersStateSchema = schema({
  // --- generic lobby fields (kept in sync with the base room contract) ---
  gameId: t.string(),
  gameName: t.string(),
  maxPlayers: t.uint8(),
  minPlayers: t.uint8(),
  targetPlayers: t.uint8(),
  phase: t.string().default("waiting"),
  /** Epoch ms (server clock) at match start; 0 while waiting. */
  startedAt: t.number().default(0),
  hostUserId: t.string().default(""),
  players: t.map(CheckersPlayerSchema),
  pendingPlayerRequests: t.map(PendingRequestSchema),
  joinRequestResults: t.map(JoinRequestResultSchema),
  spectators: t.map(SpectatorSchema),

  // --- checkers-specific fields ---
  /** 64-character board encoding; empty until the match starts. */
  board: t.string().default(""),
  /** Color to move: "white", "black", or empty between matches. */
  turnColor: t.string().default(""),
  /** userId of whoever may move right now — the client's own turn check. */
  currentTurn: t.string().default(""),
  /** Room-clock time (ms) the current turn expires. */
  turnDeadline: t.number().default(0),
  turnSecondsLeft: t.uint8().default(0),
  /** Plies since the last capture or promotion; drives the draw rule. */
  idlePlies: t.uint8().default(0),
  /** "playing" | "win" | "draw". */
  outcome: t.string().default("playing"),
  /** See CheckersEndReason; empty while playing. */
  outcomeReason: t.string().default(""),
  /** Winner's userId; empty on a draw or while playing. */
  winnerUserId: t.string().default(""),
});

export type CheckersState = SchemaType<typeof CheckersStateSchema>;

export function colorForSeat(seat: number): Color {
  return SEAT_COLORS[seat % SEAT_COLORS.length];
}

// Structural conformance: the Checkers player map satisfies the lobby
// contract, and the whole state satisfies the base room's contract.
const _lobbyPlayersCheck: LobbyPlayersMapLike =
  null as unknown as CheckersState["players"];
const _lobbyPlayerCheck: LobbyPlayerLike = null as unknown as CheckersPlayer;
const _lobbyStateCheck: LobbyStateLike = null as unknown as CheckersState;
void _lobbyPlayersCheck;
void _lobbyPlayerCheck;
void _lobbyStateCheck;
