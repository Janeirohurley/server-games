import {
  Room,
  Client,
  CloseCode,
  ServerError,
  type Delayed,
} from "colyseus";

import {
  LIFECYCLE,
  type LobbyStateLike,
  type LobbyPlayerLike,
} from "./schema/lobby-state.js";
import type { RealtimeIdentity } from "../auth/verify-token.js";
import type { GameDefinition } from "../games/registry.js";

/**
 * How long a dropped player's seat is held before it is released.
 * The Colyseus SDK retries automatically in that window, so a network
 * blip does not eject someone from the match.
 */
const RECONNECTION_GRACE_SECONDS = 30;

/**
 * Generic base room for every game on the platform.
 *
 * Owns the parts that have nothing to do with any specific game:
 *   - authenticated joins (JWT issued by the Next.js platform)
 *   - seat management and the players map
 *   - the WAITING → READY → PLAYING → FINISHED lifecycle
 *   - targetPlayers vs maxPlayers (creator picks a table size)
 *   - host transfer and reconnection handling (onDrop/onReconnect)
 *
 * Game rules are intentionally absent here. Subclasses (see
 * games/ludo/ludo-room.ts) add their own state and messages and call
 * `startMatch()` when the platform lifecycle allows it.
 */
export abstract class BaseGameRoom<
  TState extends LobbyStateLike = LobbyStateLike,
> extends Room<{ state: TState }> {
  /** The game this room runs — provided by each game's room subclass. */
  abstract readonly game: GameDefinition;

  /** Identity attached per session by onAuth. */
  private identities = new Map<string, RealtimeIdentity>();
  private started = false;

  public onCreate(options: { targetPlayers?: number } = {}) {
    const def = this.game;

    // Clamp the requested table size between the game's bounds.
    const requested = Math.trunc(Number(options.targetPlayers) || 0);
    this.state.targetPlayers = Math.min(
      def.maxPlayers,
      Math.max(def.minPlayers, requested || def.maxPlayers),
    );
    this.state.gameId = def.id;
    this.state.gameName = def.name;
    this.state.maxPlayers = def.maxPlayers;
    this.state.minPlayers = def.minPlayers;
    this.state.phase = LIFECYCLE.WAITING;

    this.setMetadata({
      gameId: def.id,
      gameName: def.name,
      targetPlayers: this.state.targetPlayers,
      players: 0,
      maxPlayers: def.maxPlayers,
    });

    // Room capacity is the game's maximum; the *start* condition is
    // targetPlayers, which may be lower.
    this.maxClients = def.maxPlayers;
  }

  /** Verify the platform JWT and remember the caller's identity. */
  public async onAuth(client: Client, options: { token?: string } = {}) {
    const identity = await this.verifyIdentity(options.token);

    // Block a second simultaneous seat for the same user (double tab).
    for (const existing of this.clients) {
      const existingIdentity = this.identities.get(existing.sessionId);
      if (existingIdentity?.userId === identity.userId) {
        throw new ServerError(4_009, "Already connected to this room");
      }
    }

    this.identities.set(client.sessionId, identity);
    return identity;
  }

  /**
   * Overridable hook so tests (or a future integration) can substitute a
   * different identity source. Default: verify the platform JWT.
   */
  protected async verifyIdentity(token?: string): Promise<RealtimeIdentity> {
    const { verifyRealtimeToken } = await import("../auth/verify-token.js");
    return verifyRealtimeToken(token ?? "");
  }

  public async onJoin(client: Client) {
    const identity = this.identities.get(client.sessionId);
    if (!identity) {
      throw new ServerError(4_003, "Not authenticated");
    }

    // Defensive reclaim (reconnections normally route through onReconnect).
    const existing = this.state.players.get(identity.userId);
    if (existing) {
      existing.sessionId = client.sessionId;
      existing.connected = true;
      this.broadcast("playerReconnected", { userId: identity.userId });
      return;
    }

    if (this.started) {
      throw new ServerError(4_010, "Match already started");
    }
    if (this.state.players.size >= this.state.targetPlayers) {
      throw new ServerError(4_011, "Room is full");
    }

    const seat = this.nextFreeSeat();
    const player = this.createPlayerInstance();
    player.userId = identity.userId;
    player.name = identity.name;
    player.sessionId = client.sessionId;
    player.seat = seat;
    player.connected = true;
    this.state.players.set(identity.userId, player);

    if (this.state.players.size === 1) {
      this.state.hostUserId = identity.userId;
    }

    this.refreshReadiness();

    if (this.state.players.size >= this.maxClients) {
      this.lock();
    }
  }

  /**
   * Unexpected disconnection (network blip, suspended tab): hold the seat
   * open for a reconnection window. The framework routes the outcome to
   * onReconnect() when the player makes it back, or onLeave() if not.
   */
  public onDrop(client: Client) {
    const identity = this.identities.get(client.sessionId);
    if (!identity) return;
    this.markDisconnected(identity.userId);
    this.allowReconnection(client, RECONNECTION_GRACE_SECONDS);
  }

  public onReconnect(client: Client) {
    const identity = this.identities.get(client.sessionId);
    if (!identity) return;
    const player = this.state.players.get(identity.userId);
    if (!player) return;
    player.sessionId = client.sessionId;
    player.connected = true;
    this.broadcast("playerReconnected", { userId: identity.userId });
  }

  /**
   * Final leave. Fired directly for a deliberate close (consented), or
   * after the reconnection window expired following onDrop.
   */
  public onLeave(client: Client, code?: number) {
    const identity = this.identities.get(client.sessionId);
    if (!identity) return;
    this.removePlayer(identity.userId);
    void code;
  }

  // ------------------------------------------------------------------
  // Protected API for game subclasses
  // ------------------------------------------------------------------

  /**
   * Concrete player record factory. Game rooms compose their own player
   * schema (lobby fields + game fields) so the base room only relies on
   * the structural LobbyPlayerLike contract.
   */
  protected abstract createPlayerInstance(): LobbyPlayerLike;

  /** Delegated lifecycle message: host asks to start. */
  protected handleStartGame(client: Client) {
    const player = this.playerBySession(client.sessionId);
    if (!player) return;
    if (player.userId !== this.state.hostUserId) return; // only the host starts
    if (!this.canStart()) return;

    this.onBeforeStart();
    if (!this.startMatch()) return;
    this.broadcast("gameStarted", {});
  }

  /** Delegated lifecycle message: deliberate leave via UI. */
  protected handleLeaveMessage(client: Client) {
    client.leave(CloseCode.CONSENTED);
  }

  /** Player record by session id (undefined when the session is unknown). */
  protected playerBySession(sessionId: string): LobbyPlayerLike | undefined {
    for (const player of this.state.players.values()) {
      if (player.sessionId === sessionId) return player;
    }
    return undefined;
  }

  /** Player record by platform user id. */
  protected playerByUserId(userId: string): LobbyPlayerLike | undefined {
    return this.state.players.get(userId);
  }

  /**
   * The lifecycle allows a start when the table has at least the game's
   * minimum AND everyone the creator asked for has arrived.
   */
  protected canStart(): boolean {
    if (this.started) return false;
    if (
      this.state.phase !== LIFECYCLE.WAITING &&
      this.state.phase !== LIFECYCLE.READY
    ) {
      return false;
    }
    return (
      this.state.players.size >= this.state.minPlayers &&
      this.state.players.size >= this.state.targetPlayers
    );
  }

  /** Move WAITING → READY (or back to WAITING when a seat frees up). */
  protected refreshReadiness() {
    if (this.started) return;
    this.state.phase = this.canStart() ? LIFECYCLE.READY : LIFECYCLE.WAITING;
  }

  /**
   * Transition READY → PLAYING. Subclasses call this from their own
   * start message once they have initialised their game state.
   * Returns false when the start conditions are not met.
   */
  protected startMatch(): boolean {
    if (!this.canStart()) return false;
    this.started = true;
    this.state.phase = LIFECYCLE.PLAYING;
    this.lock();
    return true;
  }

  /** Transition to FINISHED once a game subclass completed its match. */
  protected finishMatch() {
    this.state.phase = LIFECYCLE.FINISHED;
  }

  /** Subclass hook called right before the phase flips to PLAYING. */
  protected onBeforeStart() {}

  /** Utility for subclasses that want a delayed callback. */
  protected delay(ms: number, callback: () => void): Delayed {
    return this.clock.setTimeout(callback, ms);
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  private markDisconnected(userId: string) {
    const player = this.state.players.get(userId);
    if (!player) return;
    player.connected = false;
    player.sessionId = "";
    if (this.state.phase === LIFECYCLE.PLAYING) {
      this.broadcast("playerDisconnected", { userId });
    }
  }

  private removePlayer(userId: string) {
    const player = this.state.players.get(userId);
    if (!player) return;
    this.state.players.delete(userId);
    this.identities.delete(player.sessionId);

    // Simple, predictable host policy: the lowest remaining seat takes over.
    if (this.state.hostUserId === userId) {
      const nextHost = [...this.state.players.values()].sort(
        (a, b) => a.seat - b.seat,
      )[0];
      this.state.hostUserId = nextHost?.userId ?? "";
    }

    // Before start the table shrinks; after start the match continues
    // with the remaining players.
    if (this.state.phase === LIFECYCLE.PLAYING) {
      this.broadcast("playerLeft", { userId });
    } else {
      this.refreshReadiness();
    }
  }

  private nextFreeSeat(): number {
    const taken = new Set(
      [...this.state.players.values()].map((player) => player.seat),
    );
    for (let seat = 0; seat < this.state.maxPlayers; seat++) {
      if (!taken.has(seat)) return seat;
    }
    return this.state.players.size;
  }

  /** Exposed for tests. */
  public get isStarted(): boolean {
    return this.started;
  }
}
