import { Client, type Delayed } from "colyseus";
import { Chess, type Move } from "chess.js";

import { BaseGameRoom } from "../../rooms/base-game-room.js";
import type { LobbyPlayerLike } from "../../rooms/schema/lobby-state.js";
import { getGameDefinition } from "../registry.js";
import {
  ChessPlayerSchema,
  ChessStateSchema,
  colorForSeat,
  type ChessEndReason,
  type ChessPlayer,
  type ChessSeatColor,
  type ChessState,
} from "./chess-state.js";

/** How long a player has to move before losing on time. */
const TURN_DURATION_MS = 60_000;

const SQUARE_PATTERN = /^[a-h][1-8]$/;
const PROMOTIONS = new Set(["q", "r", "b", "n"]);

const CHESS_DEFINITION = getGameDefinition("chess");

if (!CHESS_DEFINITION) {
  throw new Error("Chess definition missing from the games registry");
}

interface MoveMessage {
  from?: unknown;
  to?: unknown;
  promotion?: unknown;
}

/**
 * Server-authoritative Chess room.
 *
 * The client never sends a board or a FEN — only the intent "move this piece
 * there, promote to this". The room owns the only `Chess` instance, applies
 * the move itself, and ignores anything illegal. A client cannot write the
 * position, the history or the result under any circumstance.
 *
 * `chess.js` is also the platform's local engine, so local and online games
 * are refereed by identical rules.
 */
export class ChessRoom extends BaseGameRoom<ChessState> {
  readonly game = CHESS_DEFINITION;

  state = new ChessStateSchema();

  private chess = new Chess();
  private turnTimeout?: Delayed;
  private turnCountdown?: Delayed;

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
    return new ChessPlayerSchema();
  }

  protected override onBeforeStart() {
    const players = [...this.state.players.values()].sort(
      (a, b) => a.seat - b.seat,
    );

    players.forEach((lobbyPlayer, index) => {
      const player = new ChessPlayerSchema();
      player.userId = lobbyPlayer.userId;
      player.name = lobbyPlayer.name;
      player.sessionId = lobbyPlayer.sessionId;
      player.seat = lobbyPlayer.seat;
      player.connected = lobbyPlayer.connected;
      player.avatarUrl = lobbyPlayer.avatarUrl;
      player.isBot = lobbyPlayer.isBot;
      player.botDifficulty = lobbyPlayer.botDifficulty;
      player.color = colorForSeat(index);
      this.state.players.set(lobbyPlayer.userId, player);
    });

    this.chess = new Chess();
    this.state.outcome = "playing";
    this.state.outcomeReason = "";
    this.state.winnerUserId = "";
    this.writeGameState();
    this.armTurnTimer();
  }

  /**
   * A player commits a move. Everything is re-derived and re-validated
   * server-side; `message` is treated as untrusted input throughout.
   */
  private handleMove(client: Client, message: MoveMessage) {
    if (this.state.outcome !== "playing") {
      client.send("moveRejected", { reason: "finished" });
      return;
    }

    const player = this.playerBySession(client.sessionId) as
      | ChessPlayer
      | undefined;
    if (!player) {
      client.send("moveRejected", { reason: "not-in-match" });
      return;
    }

    // Not your turn: refused with a reason so the client can unlock, but
    // the position is never touched.
    if (player.userId !== this.state.currentTurn) {
      client.send("moveRejected", { reason: "not-your-turn" });
      return;
    }

    const from = typeof message?.from === "string" ? message.from : "";
    const to = typeof message?.to === "string" ? message.to : "";
    if (!SQUARE_PATTERN.test(from) || !SQUARE_PATTERN.test(to)) {
      client.send("moveRejected", { from, to, reason: "invalid" });
      return;
    }

    const promotion =
      typeof message?.promotion === "string" &&
      PROMOTIONS.has(message.promotion)
        ? message.promotion
        : undefined;

    let move: Move | null = null;
    try {
      move = this.chess.move({ from, to, promotion });
    } catch {
      // Illegal move: the authoritative position is untouched.
      client.send("moveRejected", { from, to, reason: "illegal" });
      return;
    }
    if (!move) {
      client.send("moveRejected", { from, to, reason: "illegal" });
      return;
    }

    this.writeGameState(move.from, move.to);

    this.broadcast("moveApplied", {
      userId: player.userId,
      from: move.from,
      to: move.to,
      san: move.san,
      captured: move.captured ?? "",
      promotion: move.promotion ?? "",
      check: this.chess.isCheck(),
    });

    if (this.chess.isGameOver()) {
      this.endFromBoard();
      return;
    }

    this.armTurnTimer();
  }

  public override onLeave(client: Client, code?: number) {
    const leaving = this.playerBySession(client.sessionId) as
      | ChessPlayer
      | undefined;
    const wasPlaying = this.state.phase === "playing";
    const color = leaving?.color as ChessSeatColor | undefined;

    super.onLeave(client, code);

    // A two-player game cannot continue a player short.
    if (wasPlaying && color && this.state.outcome === "playing") {
      this.endMatch(opponentOf(color), "forfeit");
    }
  }

  public override async onDispose() {
    this.turnTimeout?.clear();
    this.turnCountdown?.clear();
    await super.onDispose();
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  /** Publish the authoritative engine position onto the synchronized fields. */
  private writeGameState(lastFrom = "", lastTo = "") {
    this.state.fen = this.chess.fen();
    this.state.turnColor = this.chess.turn();
    this.state.currentTurn = this.userIdForColor(this.chess.turn()) ?? "";
    this.state.history = this.chess.history().join(" ");
    this.state.lastFrom = lastFrom;
    this.state.lastTo = lastTo;
  }

  private userIdForColor(color: ChessSeatColor): string | undefined {
    for (const player of this.state.players.values()) {
      if (player.color === color) return player.userId;
    }
    return undefined;
  }

  private armTurnTimer() {
    this.state.turnDeadline = this.clock.currentTime + TURN_DURATION_MS;
    this.state.turnSecondsLeft = TURN_DURATION_MS / 1_000;

    this.turnTimeout?.clear();
    this.turnCountdown?.clear();

    this.turnCountdown = this.clock.setInterval(() => {
      const secondsLeft = Math.max(
        0,
        Math.ceil(
          (this.state.turnDeadline - this.clock.currentTime) / 1_000,
        ),
      );

      this.state.turnSecondsLeft = secondsLeft;
    }, 250);

    this.turnTimeout = this.clock.setTimeout(
      () => this.handleTimeout(),
      TURN_DURATION_MS,
    );
  }

  /**
   * Running out of time loses the game. Skipping the turn instead would
   * let the opponent move twice, which is not a thing in chess.
   */
  private handleTimeout() {
    if (this.state.outcome !== "playing") return;
    const toMove = this.state.turnColor as ChessSeatColor;
    if (!toMove) return;
    this.endMatch(opponentOf(toMove), "timeout");
  }

  /** Derive the result from the authoritative board, then end the match. */
  private endFromBoard() {
    let winner: ChessSeatColor | null = null;
    let reason: ChessEndReason;

    if (this.chess.isCheckmate()) {
      winner = opponentOf(this.chess.turn());
      reason = "checkmate";
    } else if (this.chess.isStalemate()) {
      reason = "stalemate";
    } else if (this.chess.isInsufficientMaterial()) {
      reason = "insufficient-material";
    } else if (this.chess.isThreefoldRepetition()) {
      reason = "threefold";
    } else if (this.chess.isDrawByFiftyMoves()) {
      reason = "fifty-move";
    } else {
      reason = "draw";
    }

    this.endMatch(winner, reason);
  }

  private endMatch(winner: ChessSeatColor | null, reason: ChessEndReason) {
    this.turnTimeout?.clear();
    this.turnCountdown?.clear();

    this.state.outcome = winner ? "win" : "draw";
    this.state.outcomeReason = reason;
    this.state.winnerUserId = winner ? (this.userIdForColor(winner) ?? "") : "";
    this.state.currentTurn = "";
    this.state.turnDeadline = 0;
    this.state.turnSecondsLeft = 0;

    this.finishMatch();
    this.broadcast("gameFinished", {
      outcome: this.state.outcome,
      reason,
      winnerUserId: this.state.winnerUserId,
    });
  }
}

function opponentOf(color: ChessSeatColor): ChessSeatColor {
  return color === "w" ? "b" : "w";
}
