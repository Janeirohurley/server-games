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
    maxPlayers: 4,
    allowedPlayerCounts: [2, 3, 4],
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
] as const;

export function getGameDefinition(gameId: string): GameDefinition | undefined {
  return GAMES.find((game) => game.id === gameId);
}
