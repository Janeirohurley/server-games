import { Client, type Delayed } from "colyseus";

import { BaseGameRoom } from "../../rooms/base-game-room.js";
import type { LobbyPlayerLike } from "../../rooms/schema/lobby-state.js";
import { getGameDefinition } from "../registry.js";
import {
  RallyPlayerSchema,
  RallyStateSchema,
  type RallyPlayer,
  type RallyState,
} from "./rally-state.js";
import { FIXED_STEP_SECONDS, RallyMatch } from "./engine/index.js";
import type { RallyEvent, Side } from "./engine/index.js";

/** How often the simulation advances, in milliseconds. */
const STEP_MS = 1000 / 120;
/** How often the world is published to the clients. */
const PATCH_MS = 1000 / 30;

const RALLY_DEFINITION = getGameDefinition("rally");

if (!RALLY_DEFINITION) {
  throw new Error("Rally definition missing from the games registry");
}

interface InputMessage {
  /** Where this player wants their paddle, in world units. */
  target?: number;
  /** Whether they are holding the power shot. */
  power?: boolean;
}

/**
 * Server-authoritative Rally.
 *
 * Continuous physics rather than turns, so the contract differs from a
 * board game: clients stream their paddle intent, the server runs the
 * one and only simulation, and both clients render the world it
 * publishes. A client cannot move the ball, score a point, or touch the
 * opponent's paddle — it can only say where it is steering.
 *
 * The engine is a mirror of the platform's, so an online match is
 * refereed exactly like an offline one.
 */
export class RallyRoom extends BaseGameRoom<RallyState> {
  readonly game = RALLY_DEFINITION;

  state = new RallyStateSchema();

  private match?: RallyMatch;
  private loop?: Delayed;
  /** side → userId, resolved once the match starts. */
  private sides = new Map<Side, string>();

  constructor() {
    super();
    this.registerMessages({
      startGame: (client: Client) => this.handleStartGame(client),
      leave: (client: Client) => this.handleLeaveMessage(client),
      input: (client: Client, message: InputMessage) =>
        this.handleInput(client, message),
      serve: (client: Client) => this.handleServe(client),
    });
  }

  protected createPlayerInstance(): LobbyPlayerLike {
    return new RallyPlayerSchema();
  }

  protected override onBeforeStart() {
    const players = [...this.state.players.values()].sort(
      (a, b) => a.seat - b.seat,
    );

    this.sides.clear();
    players.forEach((lobbyPlayer, index) => {
      const player = new RallyPlayerSchema();
      player.userId = lobbyPlayer.userId;
      player.name = lobbyPlayer.name;
      player.sessionId = lobbyPlayer.sessionId;
      player.seat = lobbyPlayer.seat;
      player.connected = lobbyPlayer.connected;
      player.side = index === 0 ? 0 : 1;
      this.state.players.set(lobbyPlayer.userId, player);
      this.sides.set(player.side as Side, player.userId);
    });

    this.match = new RallyMatch({
      opponentIsHuman: true,
      onEvent: (event: RallyEvent) => this.forward(event),
    });
    this.match.start("club");
    this.state.winnerUserId = "";
    this.publish();

    this.loop?.clear();
    this.loop = this.clock.setInterval(() => this.advance(), STEP_MS);

    // Publish a little less often than we simulate; clients smooth the gap.
    this.setPatchRate(PATCH_MS);
  }

  /** Relay engine events that the clients react to (sound, banners). */
  private forward(event: RallyEvent) {
    if (event.type === "point") {
      this.broadcast("rallyPoint", {
        side: event.side,
        reason: event.reason,
        matchOver: event.matchOver,
      });
      if (event.matchOver) {
        this.state.winnerUserId = this.sides.get(event.side) ?? "";
        this.finishMatch();
        this.loop?.clear();
        this.broadcast("gameFinished", {
          winnerUserId: this.state.winnerUserId,
        });
      }
      return;
    }

    if (event.type === "bounce" || event.type === "net") {
      this.broadcast(event.type === "net" ? "rallyNet" : "rallyBounce", event);
      return;
    }

    if (event.type === "hit") {
      this.broadcast("rallyHit", { side: event.side, powered: event.powered });
    }
  }

  private advance() {
    if (!this.match || this.state.phase !== "playing") return;
    this.match.step(FIXED_STEP_SECONDS);
    this.publish();
  }

  /** Copy the engine's world onto the synchronized state. */
  private publish() {
    const match = this.match;
    if (!match) return;

    this.state.matchState = match.state;
    this.state.ballX = match.ball.x;
    this.state.ballY = match.ball.y;
    this.state.ballZ = match.ball.z;
    this.state.nearX = match.player.x;
    this.state.nearY = match.player.y;
    this.state.farX = match.cpu.x;
    this.state.farY = match.cpu.y;
    this.state.scoreNear = match.scores[0];
    this.state.scoreFar = match.scores[1];
    this.state.rally = Math.min(match.rally, 65_535);
    this.state.best = Math.min(match.best, 65_535);
    this.state.server = match.server;
  }

  /**
   * A player streams their paddle intent. Everything is clamped by the
   * engine, and a client can only ever drive its own side.
   */
  private handleInput(client: Client, message: InputMessage) {
    const side = this.sideOf(client);
    if (side === null || !this.match) return;

    const target = Number(message?.target);
    if (Number.isFinite(target)) this.match.setTargetFor(side, target);

    this.match.setPowerFor(side, message?.power === true);
  }

  private handleServe(client: Client) {
    const side = this.sideOf(client);
    if (side === null || !this.match) return;
    // The engine refuses a serve from the side that does not have it.
    this.match.serveFor(side);
  }

  /** Which side this connection owns, or null if it owns none. */
  private sideOf(client: Client): Side | null {
    const player = this.playerBySession(client.sessionId) as
      | RallyPlayer
      | undefined;
    if (!player) return null;
    return player.side === 1 ? 1 : 0;
  }

  public override onDispose() {
    this.loop?.clear();
    this.match = undefined;
    this.sides.clear();
    super.onDispose();
  }
}
