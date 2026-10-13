import { schema, t, type SchemaType } from "@colyseus/schema";

import {
  JoinRequestResultSchema,
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
 *   -1                  → in base
 *   0 .. homeColumnStart-1   → index along the player's own ring path
 *   homeColumnStart .. finishedPosition-1 → private home column (6 cells)
 *   finishedPosition    → finished (center)
 *
 * TWO BOARDS, CHOSEN ONCE PER TABLE FROM `targetPlayers`:
 *
 *   classic (2-4 players): a four-armed cross, the board a player expects.
 *     One shared ring of 52 cells, home column at 51-56, finish at 57.
 *     THE BOARD IS FIXED: four start corners (0/13/26/39), four home columns
 *     and four pairs of safe cells, whatever the player count. A two-player
 *     table is the same cross with two arms left empty, not a re-spaced ring.
 *     A four-player table keeps start offsets 0/13/26/39 and safe cells
 *     0/7/13/20/26/33/39/46, so its rules are unchanged.
 *
 *   hex (5-6 players): a six-armed star. Each arm is 3 cells wide and 6
 *     deep, which gives 13 ring cells per arm and 78 on the whole ring.
 *     A piece walks 77 ring cells (0-76), then the 6-cell home column
 *     (77-82), then the finish at 83. Seat k enters the ring at cell
 *     k * 13, so the six starts are exactly equidistant; a five-player
 *     table uses the same board with the sixth arm left empty (its cells
 *     stay walkable, and its start and star stay safe).
 *
 * The values are NOT module constants for the rules: they live on the
 * LudoTrack of the table, because two rooms of different sizes run at the
 * same time. The classic constants below are kept as exports because the
 * classic board and existing callers still use them.
 *
 * WHY 78 AND NOT A RE-SPACED 52: six regular arms need a ring that is a
 * multiple of six. 52 is not, and fitting it anyway gives arms of unequal
 * length (9/9/9/9/8/8 cells), which cannot look like a regular board.
 */

export const PIECES_PER_PLAYER = 4;
/** Classic board (2-4 players). */
export const RING_LENGTH = 52;
/** Path indexes 0-50 are on the shared ring; 51-56 are the home column. */
export const HOME_COLUMN_START = 51;
export const FINISHED_POSITION = 57;

/** Hexagonal board (5-6 players). */
export const HEX_ARM_COUNT = 6;
export const HEX_ARM_LENGTH = 13;
export const HEX_RING_LENGTH = HEX_ARM_COUNT * HEX_ARM_LENGTH; // 78
/** A piece walks HEX_RING_LENGTH - 1 ring cells, like the classic board. */
export const HEX_HOME_COLUMN_START = HEX_RING_LENGTH - 1; // 77
export const HEX_FINISHED_POSITION = HEX_HOME_COLUMN_START + 6; // 83
/** The star sits this many cells after a start cell. */
export const HEX_STAR_OFFSET = 8;
/** First table size that plays on the hexagonal board. */
export const HEX_MIN_PLAYER_COUNT = 5;
/**
 * Per-turn budgets the host may pick (ms). 0 = no time limit. Mirror on
 * the platform client (`LUDO_TURN_DURATION_OPTIONS`).
 */
export const TURN_DURATION_OPTIONS = [0, 30_000, 60_000, 90_000] as const;
/** The default when a room is created or a duration is never chosen. */
export const TURN_DURATION_DEFAULT = 30_000;

/**
 * The six seats, in turn order. A table of N players uses the FIRST N
 * of these, so a four-player table keeps yellow/red/blue/green exactly
 * as it was — a two-player table is yellow vs red, never a random pair.
 */
export const LUDO_PALETTE = [
  "yellow",
  "red",
  "blue",
  "green",
  "orange",
  "purple",
] as const;
export type LudoColor = (typeof LUDO_PALETTE)[number];

/**
 * The four fixed start corners of the classic board, in arm order (left, top,
 * right, bottom). These belong to the BOARD and never depend on the player
 * count: the four-player table must keep 0/13/26/39 exactly, and a smaller
 * table simply leaves one or two arms empty.
 */
export const CLASSIC_ARM_OFFSETS = [0, 13, 26, 39] as const;
/**
 * The star sits this many cells after each fixed start corner. Eight —
 * matches the delivered four-player board (stars 8, 21, 34, 47).
 */
export const CLASSIC_STAR_OFFSET = 8;
/**
 * Which fixed arms are occupied, per table size. Corners 0 and 26 are
 * opposite (left and right), so a two-player table is the duel those two
 * colors are printed for; a three-player table leaves the bottom arm empty.
 */
export const CLASSIC_OCCUPIED_ARMS: Readonly<Record<number, readonly number[]>> = {
  2: [0, 26],
  3: [0, 13, 26],
  4: [0, 13, 26, 39],
};

export const MIN_PLAYER_COUNT = 2;
export const MAX_PLAYER_COUNT = LUDO_PALETTE.length;

/**
 * The geometry of ONE table: which colors play, where each one enters
 * the ring, and which cells are safe.
 *
 * This is deliberately an object and not a set of module constants. The
 * table size is chosen by the room creator, so two rooms running at the
 * same moment can have different geometries — module-level state would
 * make them overwrite each other. The room builds its track once, from
 * `targetPlayers`, and threads it through the rules; the client mirrors
 * the same pure function from the same `targetPlayers` it already
 * receives in the lobby snapshot.
 */
export interface LudoTrack {
  readonly playerCount: number;
  /** Which board this table plays on. */
  readonly shape: "classic" | "hex";
  /** Number of shared ring cells: 52 (classic) or 78 (hex). */
  readonly ringLength: number;
  /** First home-column position: 51 (classic) or 77 (hex). */
  readonly homeColumnStart: number;
  /** Position of the center: 57 (classic) or 83 (hex). */
  readonly finishedPosition: number;
  readonly colors: readonly LudoColor[];
  /** Start offset on the shared ring, per color. */
  readonly offsets: ReadonlyMap<LudoColor, number>;
  /**
   * Every start and star cell of the BOARD, occupied arms or not. On a
   * two-player classic table this is still the eight classic cells: the four
   * arms are printed on the board whatever the roster.
   */
  readonly safeCells: ReadonlySet<number>;
  /** Ring cell a color's piece sits on for a given path index. */
  ringIndexOf(color: LudoColor, pathIndex: number): number;
  isSafeCell(ringIndex: number): boolean;
  /** The color a seat plays, wrapping if the roster ever overflows. */
  colorAt(seat: number): LudoColor;
}

/**
 * Build the track for a table of `playerCount` players.
 *
 * Throws on an unsupported count rather than clamping: a caller that
 * passes 7 or 0 has a bug, and silently giving it a 6-player board would
 * hide that bug behind a table that looks almost right.
 */
export function createTrack(playerCount: number): LudoTrack {
  if (
    !Number.isInteger(playerCount) ||
    playerCount < MIN_PLAYER_COUNT ||
    playerCount > MAX_PLAYER_COUNT
  ) {
    throw new Error(
      `Unsupported Ludo table size ${playerCount} (expected ${MIN_PLAYER_COUNT}-${MAX_PLAYER_COUNT})`,
    );
  }

  const colors = LUDO_PALETTE.slice(0, playerCount) as LudoColor[];
  const hex = playerCount >= HEX_MIN_PLAYER_COUNT;
  const ringLength = hex ? HEX_RING_LENGTH : RING_LENGTH;

  const offsets = new Map<LudoColor, number>();
  const safeCells = new Set<number>();

  if (hex) {
    // One arm per seat: the starts are exactly 13 cells apart.
    for (let seat = 0; seat < playerCount; seat += 1) {
      offsets.set(colors[seat], seat * HEX_ARM_LENGTH);
    }
    // The safe cells belong to the BOARD, not to who sits at it: the empty
    // arm of a five-player table keeps its start and its star, so the two
    // hexagonal tables are the same drawing.
    for (let arm = 0; arm < HEX_ARM_COUNT; arm += 1) {
      safeCells.add(arm * HEX_ARM_LENGTH);
      safeCells.add(arm * HEX_ARM_LENGTH + HEX_STAR_OFFSET);
    }
  } else {
    // The classic board has FOUR FIXED arms: four start corners, four home
    // columns, four safe-cell pairs. `playerCount` only decides which arms are
    // occupied — a two-player table is not a shorter board, it is the same
    // board with two empty arms, exactly like a printed board with two
    // colours in use. Re-spacing the ring by the player count (the previous
    // behaviour) moved starts into the middle of an arm and made the rules
    // differ per table size for no gameplay reason.
    const occupied = CLASSIC_OCCUPIED_ARMS[playerCount];
    if (!occupied) {
      throw new Error(`Unsupported classic Ludo table size ${playerCount}`);
    }
    occupied.forEach((armOffset, seat) => {
      offsets.set(colors[seat], armOffset);
    });
    // Every arm keeps its start and its star, occupied or not.
    for (const armOffset of CLASSIC_ARM_OFFSETS) {
      safeCells.add(armOffset);
      safeCells.add((armOffset + CLASSIC_STAR_OFFSET) % RING_LENGTH);
    }
  }

  return {
    playerCount,
    shape: hex ? "hex" : "classic",
    ringLength,
    homeColumnStart: hex ? HEX_HOME_COLUMN_START : HOME_COLUMN_START,
    finishedPosition: hex ? HEX_FINISHED_POSITION : FINISHED_POSITION,
    colors,
    offsets,
    safeCells,
    ringIndexOf(color: LudoColor, pathIndex: number): number {
      const offset = offsets.get(color);
      if (offset === undefined) {
        throw new Error(`Color ${color} is not seated on this table`);
      }
      return (offset + pathIndex) % ringLength;
    },
    isSafeCell(ringIndex: number): boolean {
      return safeCells.has(ringIndex);
    },
    colorAt(seat: number): LudoColor {
      return colors[seat % colors.length];
    },
  };
}

/** One piece of one player. Exported so the room can instantiate it. */
export const LudoPieceSchema = schema({
  /** Index of the piece within its player's set (0-3). */
  index: t.uint8().default(0),
  /** -1 = base, then the path index; the last value (57 classic, 83 hex) = finished. */
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
  /** Avatar URL from the gamer profile ("" = initials fallback). */
  avatarUrl: t.string().default(""),
  /** Logical mic state for the voice roster (see base room `voice:mute`). */
  voiceMuted: t.boolean().default(true),
  /** Admin-imposed mute (base room `voice:admin-mute`): the target
   * cannot lift it themselves while set. */
  adminMuted: t.boolean().default(false),
  /** Seated from the platform bot pool (no transport, never host). */
  isBot: t.boolean().default(false),
  /** Bot difficulty label ("" for humans). */
  botDifficulty: t.string().default(""),
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
  /** Epoch ms (server clock) at match start; 0 while waiting. */
  startedAt: t.number().default(0),
  hostUserId: t.string().default(""),
  players: t.map(LudoPlayerSchema),
  pendingPlayerRequests: t.map(PendingRequestSchema),
  joinRequestResults: t.map(JoinRequestResultSchema),
  spectators: t.map(SpectatorSchema),

  // --- ludo-specific fields ---
  /** userId of whoever may roll/move right now; empty between matches. */
  currentTurn: t.string().default(""),
  /** Room-clock time (ms) the current turn expires — clients render the countdown. */
  turnDeadline: t.number().default(0),
  /** Per-turn budget (ms) chosen by the host; 0 = no time limit. */
  turnDurationMs: t.uint32().default(TURN_DURATION_DEFAULT),
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
