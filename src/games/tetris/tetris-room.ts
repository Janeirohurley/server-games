import { Client, CloseCode, type Delayed } from "colyseus";

import { BaseGameRoom } from "../../rooms/base-game-room.js";
import type { LobbyPlayerLike } from "../../rooms/schema/lobby-state.js";
import { LIFECYCLE } from "../../rooms/schema/lobby-state.js";
import { getGameDefinition } from "../registry.js";
import {
  TetrisPlayerSchema,
  TetrisStateSchema,
  type TetrisPlayer,
  type TetrisState,
} from "./tetris-state.js";
import { TetrisMatch } from "./tetris-match.js";

/** Pause plein écran avant le départ, comme au Ludo : personne ne joue à froid. */
const START_COUNTDOWN_SECONDS = 3;
/**
 * Cadence de la boucle de gravité. Le délai de chute le plus court est de
 * 160 ms (niveau 6) : un pas de 40 ms garde la gravité précise à ~25 %.
 */
const GRAVITY_STEP_MS = 40;

const TETRIS_DEFINITION = getGameDefinition("tetris");

if (!TETRIS_DEFINITION) {
  throw new Error("Tetris definition missing from the games registry");
}

interface InputMessage {
  input?: unknown;
}

/**
 * Tetris à plusieurs, autoritaire côté serveur.
 *
 * Chaque joueur a son plateau ; tous partent de la même graine, donc de la
 * même suite de pièces. Les clients n'envoient que des intentions
 * (`input`: gauche, droite, rotation, bas, largage) : le serveur applique
 * les règles du moteur, fait tomber les pièces et publie les plateaux.
 * Le dernier joueur en vie gagne.
 *
 * Toute la logique de match vit dans `tetris-match.ts` (module pur, testé
 * sans Colyseus) ; cette classe n'est que la colle réseau.
 */
export class TetrisRoom extends BaseGameRoom<TetrisState> {
  readonly game = TETRIS_DEFINITION;

  state = new TetrisStateSchema();

  /**
   * Durée du compte à rebours avant le départ. Publique et modifiable
   * uniquement pour les tests, qui n'ont pas à attendre trois secondes.
   */
  public startCountdownMs = START_COUNTDOWN_SECONDS * 1_000;

  private match?: TetrisMatch;
  private loop?: Delayed;
  private countdownTimer?: Delayed;
  private countdownActive = false;

  constructor() {
    super();
    // Dans le constructeur : un initialiseur de champ ne peut pas référencer
    // `super`. `registerMessages` y fusionne chat, demandes, admin, voix.
    this.registerMessages({
      startGame: (client: Client) => this.handleStartGame(client),
      leave: (client: Client) => this.handleLeaveMessage(client),
      input: (client: Client, message: InputMessage) =>
        this.handleInput(client, message),
    });
  }

  protected createPlayerInstance(): LobbyPlayerLike {
    return new TetrisPlayerSchema();
  }

  /**
   * La table peut démarrer partiellement remplie : l'admin décide du moment
   * dès qu'il y a le minimum de joueurs. `targetPlayers` reste le nombre de
   * places ouvertes, pas un seuil de départ.
   */
  protected override requiredPlayersToStart(): number {
    return this.state.minPlayers;
  }

  /**
   * L'admin lance la partie : compte à rebours diffusé à tous, puis départ.
   * Même schéma que le Ludo — le départ réel n'a lieu qu'à la fin du compte
   * à rebours, et seulement si la table est toujours démarrable à cet instant
   * (un joueur peut être parti entre-temps).
   */
  protected override handleStartGame(client: Client) {
    if (!this.isAdmin(client.sessionId)) return;
    if (!this.canStart()) return;
    if (this.countdownActive) return;

    this.broadcast("countdown", { seconds: this.startCountdownMs / 1_000 });
    this.countdownActive = true;
    this.countdownTimer = this.clock.setTimeout(() => {
      this.countdownActive = false;
      if (
        this.state.phase !== LIFECYCLE.WAITING &&
        this.state.phase !== LIFECYCLE.READY
      ) {
        return;
      }
      if (!this.startMatch()) return;
      this.beginMatch();
      this.broadcast("gameStarted", {});
    }, this.startCountdownMs);
  }

  /** Crée le match à partir des joueurs assis et lance la gravité. */
  private beginMatch() {
    const seated = [...this.state.players.values()].sort(
      (a, b) => a.seat - b.seat,
    );
    // La graine n'a pas besoin d'être secrète : le but est seulement que tous
    // les joueurs reçoivent la même suite de pièces.
    const seed = Math.floor(Math.random() * 0x1_0000_0000) >>> 0;

    this.match = new TetrisMatch({
      userIds: seated.map((player) => player.userId),
      seed,
      now: this.clock.currentTime,
    });
    this.state.winnerUserId = "";
    this.flush();

    this.loop?.clear();
    this.loop = this.clock.setInterval(() => this.advance(), GRAVITY_STEP_MS);
  }

  private advance() {
    if (!this.match || this.state.phase !== LIFECYCLE.PLAYING) return;
    this.match.advance(this.clock.currentTime);
    this.flush();
  }

  /** Un joueur envoie une intention. Tout ce qui est invalide est ignoré. */
  private handleInput(client: Client, message: InputMessage) {
    if (!this.match || this.state.phase !== LIFECYCLE.PLAYING) return;
    // L'identité vient de l'enregistrement de la room, jamais du message.
    const player = this.playerBySession(client.sessionId);
    if (!player) return;

    this.match.handleInput(
      player.userId,
      message?.input,
      this.clock.currentTime,
    );
    this.flush();
  }

  /**
   * Recopie dans l'état synchronisé tout ce qui a changé, puis diffuse les
   * éliminations et la fin de match. Appelée après chaque intention et chaque
   * pas de gravité.
   */
  private flush() {
    const match = this.match;
    if (!match) return;

    for (const userId of match.takeDirty()) this.syncPlayer(userId);
    if (this.state.playersAlive !== match.aliveCount) {
      this.state.playersAlive = match.aliveCount;
    }

    for (const event of match.takeEvents()) {
      if (event.type === "eliminated") {
        this.broadcast("playerEliminated", {
          userId: event.userId,
          place: event.place,
        });
        continue;
      }
      // Le vainqueur est écrit AVANT `finishMatch` : c'est lui qui en dérive
      // victoire / défaite / nul pour la progression des profils.
      this.state.winnerUserId = event.winnerUserId;
      this.finishMatch();
      this.loop?.clear();
      this.broadcast("gameFinished", { winnerUserId: event.winnerUserId });
    }
  }

  /**
   * N'écrit que les champs qui changent : une écriture identique ne vaut rien
   * à envoyer, et avec dix joueurs à 25 pas de gravité par seconde cela
   * compte.
   */
  private syncPlayer(userId: string) {
    const view = this.match?.view(userId);
    // Absent de la room : il a quitté pour de bon, son enregistrement a été retiré.
    const player = this.state.players.get(userId) as TetrisPlayer | undefined;
    if (!view || !player) return;

    if (player.board !== view.board) player.board = view.board;
    if (player.pieceType !== view.pieceType) player.pieceType = view.pieceType;
    if (player.pieceRotation !== view.pieceRotation) {
      player.pieceRotation = view.pieceRotation;
    }
    if (player.pieceX !== view.pieceX) player.pieceX = view.pieceX;
    if (player.pieceY !== view.pieceY) player.pieceY = view.pieceY;
    if (player.next !== view.next) player.next = view.next;
    if (player.score !== view.score) player.score = view.score;
    if (player.lines !== view.lines) player.lines = view.lines;
    if (player.level !== view.level) player.level = view.level;
    if (player.status !== view.status) player.status = view.status;
    if (player.place !== view.place) player.place = view.place;
  }

  /**
   * Départ volontaire en plein match : le joueur est éliminé AVANT que la
   * room de base retire son siège. Ainsi, quand il ne reste que le
   * vainqueur, `finishMatch` rapporte encore le joueur parti comme perdant
   * au lieu de l'oublier.
   */
  public override onLeave(client: Client, code?: number) {
    if (
      code === CloseCode.CONSENTED &&
      this.match &&
      !this.match.finished &&
      this.state.phase === LIFECYCLE.PLAYING
    ) {
      const leaver = this.playerBySession(client.sessionId);
      if (leaver) {
        this.match.forfeit(leaver.userId);
        this.flush();
      }
    }
    super.onLeave(client, code);
  }

  public override async onDispose() {
    this.loop?.clear();
    this.countdownTimer?.clear();
    this.match = undefined;
    await super.onDispose();
  }
}
