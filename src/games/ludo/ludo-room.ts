import { Client, type Delayed } from "colyseus";

import { BaseGameRoom } from "../../rooms/base-game-room.js";
import { getGameDefinition } from "../registry.js";
import {
  COLORS,
  FINISHED_POSITION,
  HOME_COLUMN_START,
  LudoPieceSchema,
  LudoPlayerSchema,
  LudoStateSchema,
  PIECES_PER_PLAYER,
  ringIndexOf,
  type LudoColor,
  type LudoPlayer,
  type LudoState,
} from "./ludo-state.js";
import type { LobbyPlayerLike } from "../../rooms/schema/lobby-state.js";
import {
  destinationOf,
  grantsExtraTurn,
  hasWon,
  legalMoves,
  resolveCaptures,
  type RulePiece,
} from "./ludo-rules.js";

/** How long a player has to act before their turn is skipped. */
const TURN_DURATION_MS = 30_000;
/** Pause before a forced move plays itself, so the dice can land first. */
const AUTO_MOVE_DELAY_MS = 900;
/** Rolls allowed within one extended turn before it is force-passed. */
const MAX_EXTRA_ROLLS = 12;

const LUDO_DEFINITION = getGameDefinition("ludo");

if (!LUDO_DEFINITION) {
  throw new Error("Ludo definition missing from the games registry");
}

/**
 * Server-authoritative Ludo room.
 *
 * Clients only ever send intents (`rollDice`, `movePiece`, `startGame`).
 * The room validates them against the rules module, mutates the shared
 * state, and every client receives the resulting delta. The dice are
 * rolled on the server — the client never decides game outcomes.
 */
export class LudoRoom extends BaseGameRoom<LudoState> {
  readonly game = LUDO_DEFINITION;

  state = new LudoStateSchema();

  private turnTimeout?: Delayed;
  private extraRolls = 0;

  constructor() {
    super();
    // Register lifecycle + game messages. (Instance field initializers
    // cannot reference `super`, so this happens in the constructor.)
    // registerMessages merges in the generic room handlers — chat included.
    this.registerMessages({
      startGame: (client: Client) => this.handleStartGame(client),
      leave: (client: Client) => this.handleLeaveMessage(client),
      rollDice: (client: Client) => this.handleRollDice(client),
      movePiece: (client: Client, message: { pieceIndex?: number }) =>
        this.handleMovePiece(client, message),
    });
  }

  /** Lobby player record factory — the Ludo player carries color + pieces. */
  protected createPlayerInstance(): LobbyPlayerLike {
    return new LudoPlayerSchema();
  }

  protected override onBeforeStart() {
    // Assign deterministic colors and seats from lobby join order.
    const players = [...this.state.players.values()].sort(
      (a, b) => a.seat - b.seat,
    );

    players.forEach((lobbyPlayer, seatIndex) => {
      const ludoPlayer = new LudoPlayerSchema();
      ludoPlayer.userId = lobbyPlayer.userId;
      ludoPlayer.name = lobbyPlayer.name;
      ludoPlayer.sessionId = lobbyPlayer.sessionId;
      ludoPlayer.seat = lobbyPlayer.seat;
      ludoPlayer.connected = lobbyPlayer.connected;
      ludoPlayer.color = COLORS[seatIndex % COLORS.length];
      for (let pieceIndex = 0; pieceIndex < PIECES_PER_PLAYER; pieceIndex++) {
        const piece = new LudoPieceSchema();
        piece.index = pieceIndex;
        piece.position = -1;
        ludoPlayer.pieces.push(piece);
      }
      this.state.players.set(lobbyPlayer.userId, ludoPlayer);
    });

    // First player in seat order starts.
    this.state.currentTurn = players[0]?.userId ?? "";
    this.state.turnDeadline = this.clock.currentTime + TURN_DURATION_MS;
    this.state.diceValue = 0;
    this.state.winnerUserId = "";
    this.extraRolls = 0;

    this.turnTimeout?.clear();
    this.turnTimeout = this.clock.setTimeout(
      () => this.forceSkipTurn(),
      TURN_DURATION_MS,
    );
  }

  /** Player asks to roll the dice — the server decides the value. */
  private handleRollDice(client: Client) {
    const player = this.currentPlayerBySession(client.sessionId);
    if (!player) return;
    if (this.state.diceValue !== 0) return; // dice already rolled

    const value = 1 + Math.floor(Math.random() * 6);
    this.state.diceValue = value;
    this.refreshDeadline();

    const moves = legalMoves(
      player.color as LudoColor,
      snapshotPieces(player),
      value,
    );

    /*
     * Announce the roll as an EVENT, not only as a state field.
     *
     * State is delivered as periodic patches, so successive writes in
     * one tick collapse into the last one. A roll that leads nowhere
     * sets diceValue and clears it again before any patch goes out, so
     * no client ever saw the number — which is why the dice sat frozen
     * for everyone but the roller, whose animation was local.
     */
    this.broadcast("diceRolled", {
      userId: player.userId,
      name: player.name,
      value,
      playable: moves.length,
    });

    if (moves.length === 0) {
      if (value === 6) {
        // Nothing can move, but a 6 still grants another roll.
        this.state.diceValue = 0;
        this.refreshDeadline();
        return;
      }
      this.endTurn(player);
      return;
    }

    /*
     * A single forced move is not a decision, so play it for them. Not
     * on a 6 though: a 6 also grants another roll, and the player may
     * prefer to bring a piece out, so that stays their call.
     *
     * Delayed so the dice animation has time to land before the piece
     * sets off — instant would look like the board moved on its own.
     */
    if (moves.length === 1 && value !== 6) {
      const forced = moves[0].pieceIndex;
      this.delay(AUTO_MOVE_DELAY_MS, () => {
        // Skip if anything moved on in the meantime (the player got
        // there first, the turn timed out, the match ended).
        if (this.state.diceValue !== value) return;
        if (this.state.currentTurn !== player.userId) return;
        this.broadcast("autoMoved", { userId: player.userId });
        this.applyMove(player, forced);
      });
      return;
    }

    // Several options — wait for the player's choice.
  }

  /** Player commits a move; the server validates and applies it. */
  private handleMovePiece(client: Client, message: { pieceIndex?: number }) {
    const player = this.currentPlayerBySession(client.sessionId);
    if (!player) return;

    const dice = this.state.diceValue;
    if (dice < 1 || dice > 6) return; // no roll pending

    const pieceIndex = Math.trunc(Number(message?.pieceIndex));
    if (
      !Number.isInteger(pieceIndex) ||
      pieceIndex < 0 ||
      pieceIndex >= PIECES_PER_PLAYER
    ) {
      return;
    }

    this.applyMove(player, pieceIndex);
  }

  /**
   * Move one of `player`'s pieces by the pending dice value.
   *
   * Shared by the player's own choice and by the auto-play that spares
   * them a forced move, so both paths go through exactly the same
   * validation, captures and turn handling.
   */
  private applyMove(player: LudoPlayer, pieceIndex: number) {
    const dice = this.state.diceValue;
    if (dice < 1 || dice > 6) return; // no roll pending

    const color = player.color as LudoColor;
    const piece = player.pieces[pieceIndex];
    if (!piece) return;

    const fromPosition = piece.position;
    const destination = destinationOf(
      { index: piece.index, position: piece.position },
      dice,
    );
    if (destination === null) return; // illegal — ignored

    const allPieces = this.snapshotAllPieces();
    const captures = resolveCaptures(color, destination, allPieces);

    // Move the piece.
    piece.position = destination;
    if (destination === FINISHED_POSITION) {
      player.finished = player.finished + 1;
    }

    // Send captured opponents back to base (never from safe cells).
    if (captures.length > 0) {
      const destinationRing = ringIndexOf(color, destination);
      for (const other of this.state.players.values()) {
        if (other.userId === player.userId) continue;
        const otherColor = other.color as LudoColor;
        for (const opponentPiece of other.pieces) {
          if (
            opponentPiece.position >= 0 &&
            opponentPiece.position < HOME_COLUMN_START &&
            ringIndexOf(otherColor, opponentPiece.position) === destinationRing
          ) {
            opponentPiece.position = -1;
            this.broadcast("pieceCaptured", {
              userId: other.userId,
              pieceIndex: opponentPiece.index,
              byUserId: player.userId,
            });
          }
        }
      }
    }

    this.broadcast("pieceMoved", {
      userId: player.userId,
      pieceIndex,
      from: fromPosition,
      to: destination,
    });

    // Victory check.
    if (hasWon(snapshotPieces(player))) {
      this.state.winnerUserId = player.userId;
      this.finishMatch();
      this.turnTimeout?.clear();
      this.broadcast("gameFinished", { winnerUserId: player.userId });
      return;
    }

    // Extra turn (6, capture, finish) or pass.
    const move = { captures, finishes: destination === FINISHED_POSITION };
    if (grantsExtraTurn(dice, move)) {
      this.extraRolls += 1;
      if (this.extraRolls >= MAX_EXTRA_ROLLS) {
        this.endTurn(player); // safety valve against endless 6-streaks
        return;
      }
      this.state.diceValue = 0; // same player rolls again
      this.refreshDeadline();
      return;
    }

    this.endTurn(player);
  }

  public override onDispose() {
    this.turnTimeout?.clear();
    super.onDispose();
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  private currentPlayerBySession(sessionId: string): LudoPlayer | undefined {
    for (const player of this.state.players.values()) {
      if (
        player.sessionId === sessionId &&
        this.state.currentTurn === player.userId
      ) {
        return player;
      }
    }
    return undefined;
  }

  private endTurn(player: LudoPlayer) {
    const roster = [...this.state.players.values()].sort(
      (a, b) => a.seat - b.seat,
    );
    const currentIndex = roster.findIndex((p) => p.userId === player.userId);
    let next = roster[(currentIndex + 1) % roster.length];
    for (let step = 0; step < roster.length; step++) {
      next = roster[(currentIndex + 1 + step) % roster.length];
      if (next && next.finished < PIECES_PER_PLAYER) break;
    }

    this.extraRolls = 0;
    this.state.diceValue = 0;
    this.state.currentTurn = next?.userId ?? "";
    this.refreshDeadline();

    this.turnTimeout?.clear();
    this.turnTimeout = this.clock.setTimeout(
      () => this.forceSkipTurn(),
      TURN_DURATION_MS,
    );
  }

  private forceSkipTurn() {
    const current = this.state.players.get(this.state.currentTurn);
    if (current) {
      this.state.diceValue = 0;
      this.endTurn(current);
    }
  }

  private refreshDeadline() {
    this.state.turnDeadline = this.clock.currentTime + TURN_DURATION_MS;
  }

  private snapshotAllPieces(): Record<LudoColor, RulePiece[]> {
    const snapshot = {} as Record<LudoColor, RulePiece[]>;
    for (const color of COLORS) snapshot[color] = [];
    for (const player of this.state.players.values()) {
      const color = player.color as LudoColor;
      if (!snapshot[color]) continue;
      snapshot[color].push(
        ...player.pieces.map((piece) => ({
          index: piece.index,
          position: piece.position,
        })),
      );
    }
    return snapshot;
  }
}

function snapshotPieces(player: LudoPlayer): RulePiece[] {
  return player.pieces.map((piece) => ({
    index: piece.index,
    position: piece.position,
  }));
}
