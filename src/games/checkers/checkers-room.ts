import { Client, type Delayed } from "colyseus";

import { BaseGameRoom } from "../../rooms/base-game-room.js";
import type { LobbyPlayerLike } from "../../rooms/schema/lobby-state.js";
import { getGameDefinition } from "../registry.js";
import {
  CheckersPlayerSchema,
  CheckersStateSchema,
  colorForSeat,
  decodeBoard,
  encodeBoard,
  type CheckersEndReason,
  type CheckersPlayer,
  type CheckersState,
} from "./checkers-state.js";
import {
  applyMove,
  createInitialState,
  findLegalMove,
  opponentOf,
  type Color,
  type GameState,
} from "./engine/index.js";

/** How long a player has to move before losing on time. */
const TURN_DURATION_MS = 60_000;

const CHECKERS_DEFINITION = getGameDefinition("checkers");

if (!CHECKERS_DEFINITION) {
  throw new Error("Checkers definition missing from the games registry");
}

interface MoveMessage {
  from?: number;
  to?: number;
  path?: number[];
}

/**
 * Server-authoritative Checkers room.
 *
 * The client never sends a board — only the intent "move from A to B
 * along this path". The room rebuilds the engine state from its own
 * synchronized board, asks the engine whether that move is legal, and
 * ignores it when it is not. A client cannot write the authoritative
 * state under any circumstance.
 *
 * The engine here is a mirror of the platform's
 * (`game-platform/src/games/checkers/engine`), so local and online games
 * are refereed by identical rules.
 */
export class CheckersRoom extends BaseGameRoom<CheckersState> {
  readonly game = CHECKERS_DEFINITION;

  state = new CheckersStateSchema();

  private turnTimeout?: Delayed;

  constructor() {
    super();
    // registerMessages merges in the generic room handlers — chat included.
    this.registerMessages({
      startGame: (client: Client) => this.handleStartGame(client),
      leave: (client: Client) => this.handleLeaveMessage(client),
      move: (client: Client, message: MoveMessage) =>
        this.handleMove(client, message),
    });
  }

  protected createPlayerInstance(): LobbyPlayerLike {
    return new CheckersPlayerSchema();
  }

  protected override onBeforeStart() {
    const players = [...this.state.players.values()].sort(
      (a, b) => a.seat - b.seat,
    );

    players.forEach((lobbyPlayer, index) => {
      const player = new CheckersPlayerSchema();
      player.userId = lobbyPlayer.userId;
      player.name = lobbyPlayer.name;
      player.sessionId = lobbyPlayer.sessionId;
      player.seat = lobbyPlayer.seat;
      player.connected = lobbyPlayer.connected;
      player.avatarUrl = lobbyPlayer.avatarUrl;
      player.color = colorForSeat(index);
      this.state.players.set(lobbyPlayer.userId, player);
    });

    const initial = createInitialState("white");
    this.writeGameState(initial);
    this.state.outcomeReason = "";
    this.state.winnerUserId = "";
    this.armTurnTimer();
  }

  /**
   * A player commits a move. Everything is re-derived and re-validated
   * server-side; `message` is treated as untrusted input throughout.
   */
  private handleMove(client: Client, message: MoveMessage) {
    if (this.state.outcome !== "playing") return;

    const player = this.playerBySession(client.sessionId) as
      | CheckersPlayer
      | undefined;
    if (!player) return;

    // Not your turn: silently ignored, never applied.
    if (player.userId !== this.state.currentTurn) return;

    const from = Math.trunc(Number(message?.from));
    const to = Math.trunc(Number(message?.to));
    if (!Number.isInteger(from) || !Number.isInteger(to)) return;

    const path = Array.isArray(message?.path)
      ? message.path.map((step) => Math.trunc(Number(step)))
      : undefined;
    if (path?.some((step) => !Number.isInteger(step))) return;

    const current = this.readGameState();
    const move = findLegalMove(current, from, to, path);
    if (!move) return; // illegal — the authoritative state is untouched

    const next = applyMove(current, move);
    this.writeGameState(next);

    this.broadcast("moveApplied", {
      userId: player.userId,
      from: move.from,
      to: move.to,
      path: [...move.path],
      captures: [...move.captures],
      promotes: move.promotes,
    });

    if (next.outcome.kind === "playing") {
      this.armTurnTimer();
      return;
    }

    if (next.outcome.kind === "draw") {
      this.endMatch(null, next.outcome.reason);
    } else {
      this.endMatch(next.outcome.winner, next.outcome.reason);
    }
  }

  public override onLeave(client: Client, code?: number) {
    const leaving = this.playerBySession(client.sessionId) as
      | CheckersPlayer
      | undefined;
    const wasPlaying = this.state.phase === "playing";
    const color = leaving?.color as Color | undefined;

    super.onLeave(client, code);

    // A two-player game cannot continue a player short.
    if (wasPlaying && color && this.state.outcome === "playing") {
      this.endMatch(opponentOf(color), "forfeit");
    }
  }

  public override onDispose() {
    this.turnTimeout?.clear();
    super.onDispose();
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  /** Rebuild an engine state from the synchronized fields. */
  private readGameState(): GameState {
    return {
      board: decodeBoard(this.state.board),
      turn: this.state.turnColor as Color,
      idlePlies: this.state.idlePlies,
      outcome: { kind: "playing" },
    };
  }

  /** Publish an engine state onto the synchronized fields. */
  private writeGameState(next: GameState) {
    this.state.board = encodeBoard(next.board);
    this.state.turnColor = next.turn;
    this.state.idlePlies = Math.min(next.idlePlies, 255);
    this.state.currentTurn = this.userIdForColor(next.turn) ?? "";
  }

  private userIdForColor(color: Color): string | undefined {
    for (const player of this.state.players.values()) {
      if (player.color === color) return player.userId;
    }
    return undefined;
  }

  private armTurnTimer() {
    this.state.turnDeadline = this.clock.currentTime + TURN_DURATION_MS;
    this.turnTimeout?.clear();
    this.turnTimeout = this.clock.setTimeout(
      () => this.handleTimeout(),
      TURN_DURATION_MS,
    );
  }

  /**
   * Running out of time loses the game. Skipping the turn instead would
   * let the opponent move twice, which is not a thing in checkers.
   */
  private handleTimeout() {
    if (this.state.outcome !== "playing") return;
    const toMove = this.state.turnColor as Color;
    if (!toMove) return;
    this.endMatch(opponentOf(toMove), "timeout");
  }

  private endMatch(winner: Color | null, reason: CheckersEndReason) {
    this.turnTimeout?.clear();

    this.state.outcome = winner ? "win" : "draw";
    this.state.outcomeReason = reason;
    this.state.winnerUserId = winner ? (this.userIdForColor(winner) ?? "") : "";
    this.state.currentTurn = "";
    this.state.turnDeadline = 0;

    this.finishMatch();
    this.broadcast("gameFinished", {
      outcome: this.state.outcome,
      reason,
      winnerUserId: this.state.winnerUserId,
    });
  }
}
