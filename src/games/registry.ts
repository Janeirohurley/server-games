/**
 * Registry of games available on the realtime server.
 *
 * This is the ONLY place a game's identity is declared. The room system
 * (lobby lifecycle, join/leave, invitations) reads from here and never
 * hardcodes game-specific rules or player counts.
 *
 * To add a new game later (chess, dominoes, ...):
 *   1. add its definition here,
 *   2. create its Room class extending BaseGameRoom,
 *   3. register it in `app.config.ts`.
 */

export interface GameDefinition {
  /** Stable identifier, also used as the Colyseus room name. */
  id: string;
  /** Display name. */
  name: string;
  /** Fewest players required for the match to be startable. */
  minPlayers: number;
  /** Capacity of the room. */
  maxPlayers: number;
  /**
   * Table sizes the creator may pick from. When omitted every size in
   * [minPlayers, maxPlayers] is allowed. Spectators never count against
   * these numbers.
   */
  allowedPlayerCounts?: readonly number[];
}

export const GAMES: readonly GameDefinition[] = [
  {
    id: "ludo",
    name: "Ludo",
    minPlayers: 2,
    // Six seats is the size of the colour palette in `ludo-state.ts`
    // (LUDO_PALETTE). Raising it past six would hand two players the
    // same colour, which would make their paths identical and captures
    // between them undecidable.
    maxPlayers: 6,
    allowedPlayerCounts: [2, 3, 4, 5, 6],
  },
  {
    id: "checkers",
    name: "Checkers",
    minPlayers: 2,
    maxPlayers: 2,
  },
  {
    id: "rally",
    name: "Rally",
    minPlayers: 2,
    maxPlayers: 2,
  },
  {
    id: "tetris",
    name: "Tetris",
    minPlayers: 2,
    maxPlayers: 10,
    allowedPlayerCounts: [2, 3, 4, 5, 6, 7, 8, 9, 10],
  },
] as const;

export function getGameDefinition(gameId: string): GameDefinition | undefined {
  return GAMES.find((game) => game.id === gameId);
}
