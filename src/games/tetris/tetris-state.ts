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
 * État Tetris synchronisé à tous les clients.
 *
 * Chaque joueur porte SON plateau, encodé en une chaîne de 200 caractères
 * (10 colonnes x 20 lignes, « 0 » = vide, « 1 »..« 7 » = type de pièce posée),
 * plus la pièce en cours de chute. Le client n'en déduit rien : il affiche ce
 * que le serveur publie, comme le plateau de 64 caractères des dames.
 */

export const TetrisPlayerSchema = schema({
  // --- champs du lobby (contrat de la room de base) ---
  userId: t.string(),
  name: t.string(),
  sessionId: t.string().default(""),
  seat: t.uint8().default(0),
  connected: t.boolean().default(true),
  /** URL d'avatar du profil ("" = initiales). */
  avatarUrl: t.string().default(""),
  /** État logique du micro (voir `voice:mute` dans la room de base). */
  voiceMuted: t.boolean().default(true),
  /** Mute imposé par l'admin : le joueur ne peut pas le lever lui-même. */
  adminMuted: t.boolean().default(false),
  /** Siège occupé par un bot (sans transport, jamais hôte, non classé). */
  isBot: t.boolean().default(false),
  /** Difficulté du bot ("" pour un humain). */
  botDifficulty: t.string().default(""),

  // --- partie ---
  /** 200 caractères, ligne du haut en premier ; vide avant le départ. */
  board: t.string().default(""),
  /** « I J L O S T Z » ; vide avant le départ. */
  pieceType: t.string().default(""),
  pieceRotation: t.uint8().default(0),
  /** Coin haut-gauche de la pièce ; peut être négatif (hors plateau à l'apparition). */
  pieceX: t.int8().default(0),
  pieceY: t.int8().default(0),
  /** Les prochaines pièces, ex. « TLJ ». */
  next: t.string().default(""),
  score: t.uint32().default(0),
  lines: t.uint16().default(0),
  level: t.uint8().default(1),
  /** « waiting » avant le départ, « playing », puis « over » une fois éliminé. */
  status: t.string().default("waiting"),
  /** 0 tant qu'il joue, puis son classement final (1 = vainqueur). */
  place: t.uint8().default(0),
});

export type TetrisPlayer = SchemaType<typeof TetrisPlayerSchema>;

export const TetrisStateSchema = schema({
  // --- champs du lobby, redéclarés à la main (pas de composition de schéma) ---
  gameId: t.string(),
  gameName: t.string(),
  maxPlayers: t.uint8(),
  minPlayers: t.uint8(),
  targetPlayers: t.uint8(),
  phase: t.string().default("waiting"),
  /** Epoch ms (horloge serveur) au départ du match ; 0 pendant l'attente. */
  startedAt: t.number().default(0),
  hostUserId: t.string().default(""),
  players: t.map(TetrisPlayerSchema),
  pendingPlayerRequests: t.map(PendingRequestSchema),
  joinRequestResults: t.map(JoinRequestResultSchema),
  spectators: t.map(SpectatorSchema),

  // --- partie ---
  /** Nombre de joueurs encore en vie ; 0 avant le départ. */
  playersAlive: t.uint8().default(0),
  /** userId du vainqueur ; vide tant que le match court, ou en cas de nul. */
  winnerUserId: t.string().default(""),
});

export type TetrisState = SchemaType<typeof TetrisStateSchema>;

// Conformité structurelle, vérifiée à la compilation : la map des joueurs et
// tout l'état respectent le contrat de la room de base.
const _lobbyPlayersCheck: LobbyPlayersMapLike =
  null as unknown as TetrisState["players"];
const _lobbyPlayerCheck: LobbyPlayerLike = null as unknown as TetrisPlayer;
const _lobbyStateCheck: LobbyStateLike = null as unknown as TetrisState;
void _lobbyPlayersCheck;
void _lobbyPlayerCheck;
void _lobbyStateCheck;
