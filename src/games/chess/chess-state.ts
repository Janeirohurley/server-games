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

/**
 * Chess state synchronized to both clients.
 *
 * The position travels as a FEN string and the move list as a space-separated
 * SAN string. Both are the engine's own formats (`chess.js`), so the wire and
 * the rules cannot drift apart. The board itself is never sent by a client;
 * the room owns the only `Chess` instance and rebroadcasts the result.
 */

/** Seat order decides colours: seat 0 plays White and moves first. */
export const SEAT_COLORS = ["w", "b"] as const;

export type ChessSeatColor = (typeof SEAT_COLORS)[number];

/**
 * Why a match ended. The first five mirror `chess.js` outcomes; `timeout`
 * and `forfeit` are room-level concerns the engine knows nothing about.
 */
export type ChessEndReason =
  | "checkmate"
  | "stalemate"
  | "threefold"
  | "fifty-move"
  | "insufficient-material"
  | "draw"
  | "timeout"
  | "forfeit";

export const ChessPlayerSchema = schema({
  userId: t.string(),
  name: t.string(),
  sessionId: t.string().default(""),
  seat: t.uint8().default(0),
  connected: t.boolean().default(true),
  /** Avatar URL from the gamer profile ("" = initials fallback). */
  avatarUrl: t.string().default(""),
  /** Logical mic state for the voice roster (see base room `voice:mute`). */
  voiceMuted: t.boolean().default(true),
  /** Admin-imposed mute (base room `voice:admin-mute`). */
  adminMuted: t.boolean().default(false),
  /** Bot seat (no transport, never host, unranked). */
  isBot: t.boolean().default(false),
  /** Bot difficulty ("" for humans). */
  botDifficulty: t.string().default(""),
  /** "w" or "b" — assigned from the seat when the match starts. */
  color: t.string().default(""),
});

export type ChessPlayer = SchemaType<typeof ChessPlayerSchema>;

export const ChessStateSchema = schema({
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
  players: t.map(ChessPlayerSchema),
  pendingPlayerRequests: t.map(PendingRequestSchema),
  joinRequestResults: t.map(JoinRequestResultSchema),
  spectators: t.map(SpectatorSchema),

  // --- chess-specific fields ---
  /** FEN of the authoritative position; empty until the match starts. */
  fen: t.string().default(""),
  /** Colour to move: "w", "b", or empty between matches. */
  turnColor: t.string().default(""),
  /** userId of whoever may move right now — the client's own turn check. */
  currentTurn: t.string().default(""),
  /** Room-clock time (ms) the current turn expires. */
  turnDeadline: t.number().default(0),
  turnSecondsLeft: t.uint8().default(0),
  /** Space-separated SAN history, in order. */
  history: t.string().default(""),
  /** Last move coordinates, for the client's highlight. */
  lastFrom: t.string().default(""),
  lastTo: t.string().default(""),
  /** "playing" | "win" | "draw". */
  outcome: t.string().default("playing"),
  /** See ChessEndReason; empty while playing. */
  outcomeReason: t.string().default(""),
  /** Winner's userId; empty on a draw or while playing. */
  winnerUserId: t.string().default(""),
});

export type ChessState = SchemaType<typeof ChessStateSchema>;

export function colorForSeat(seat: number): ChessSeatColor {
  return SEAT_COLORS[seat % SEAT_COLORS.length];
}

// Structural conformance: the Chess player map satisfies the lobby
// contract, and the whole state satisfies the base room's contract.
const _lobbyPlayersCheck: LobbyPlayersMapLike =
  null as unknown as ChessState["players"];
const _lobbyPlayerCheck: LobbyPlayerLike = null as unknown as ChessPlayer;
const _lobbyStateCheck: LobbyStateLike = null as unknown as ChessState;
void _lobbyPlayersCheck;
void _lobbyPlayerCheck;
void _lobbyStateCheck;
