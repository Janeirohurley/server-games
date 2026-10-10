import {
  Room,
  Client,
  CloseCode,
  ServerError,
  type Delayed,
  type Messages,
} from "colyseus";
import { randomUUID } from "node:crypto";

import {
  LIFECYCLE,
  JoinRequestResultSchema,
  PendingRequestSchema,
  SpectatorSchema,
  type LobbyStateLike,
  type LobbyPlayerLike,
  type LobbyPendingRequestLike,
  type LobbyJoinRequestResultLike,
  type LobbySpectatorLike,
} from "./schema/lobby-state.js";
import type { RealtimeIdentity } from "../auth/verify-token.js";
import type { GameDefinition } from "../games/registry.js";
import { RoomChat, type RoomChatRequest } from "./room-chat.js";
import { reportMatchFinished, type ParticipantReport } from "../profile/profile-reporting.js";

/**
 * How long a dropped player's seat is held before it is released.
 * The Colyseus SDK retries automatically in that window, so a network
 * blip does not eject someone from the match.
 */
const RECONNECTION_GRACE_SECONDS = 30;

/**
 * A dropped (browser gone, network cut) participant's record is kept
 * through the reconnection grace, then REAPED: without this, a seat
 * abandoned in the lobby stayed occupied forever — a ghost player the
 * room could never start with, and a ghost spectator that inflated the
 * counter. During a LIVE match the seat is deliberately kept: the
 * match outcome depends on it (forfeit rules), not on lobby readiness.
 */

/** How many onlookers a room accepts on top of its players. */
const MAX_SPECTATORS = 20;

/**
 * What a client asks to be when it joins.
 *   - "play":  request a seat — takes effect only once an admin approves
 *   - "watch": become a spectator immediately, no approval needed
 */
export type JoinMode = "play" | "watch";

/** How a connection ends — decides what happens to the seat. */
export type DepartureKind =
  | "consented"   // deliberate leave (UI action, double-confirmed)
  | "dropped"     // unexpected: seat held for RECONNECTION_GRACE_SECONDS
  | "evicted";    // server-side removal (kick/room close)

/**
 * Host-editable lobby settings. The room applies whatever it knows
 * (`targetPlayers` here); games plug their own knobs (Ludo's turn
 * budget) through `onLobbySettingsApplied`. Fields are optional so a
 * client can tweak a single value in one round-trip.
 */
export interface LobbySettingsInput {
  targetPlayers?: number;
  turnDurationMs?: number;
}

/**
 * Generic base room for every game on the platform.
 *
 * Owns the parts that have nothing to do with any specific game:
 *   - authenticated joins (JWT issued by the Next.js platform)
 *   - roles: players / pending join requests / spectators, kept disjoint
 *   - admin approval for every player seat
 *   - the WAITING → READY → PLAYING → FINISHED → CLOSED lifecycle
 *   - capacity from the game definition; spectators stay outside it
 *   - reconnection handling (onDrop/onReconnect) keyed by stable userId
 *   - voluntary leave vs unexpected drop, with distinct consequences
 *   - admin transfer to the most senior remaining player
 *   - the room's ephemeral chat (see room-chat.ts)
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

  /**
   * Voice/video rides on LiveKit (media transport, server `livekit`),
   * NOT on Colyseus: this room carries only the LOGICAL voice state
   * (`voiceMuted` / `adminMuted` through `voice:mute` and
   * `voice:admin-mute`) that rosters display, and it authorizes media
   * joins via `/api/room-membership/:roomId`. No SDP/ICE ever crosses
   * this room — there is deliberately no WebRTC signaling plugin here.
   */

  /** Identity attached per session by onAuth. */
  private identities = new Map<string, RealtimeIdentity>();
  /**
   * Sessions with a live transport. A session absent from here is stale
   * (dropped socket, grace pending or already finalised) — a fresh join
   * by the same user may replace it instead of being refused.
   */
  private liveSessions = new Set<string>();
  /** Per-room grace (constructor default; onCreate may narrow it). */
  protected reconnectionGraceSeconds = RECONNECTION_GRACE_SECONDS;
  private started = false;
  private closed = false;

  /**
   * This room's chat. Every game inherits it — nothing below is
   * game-specific, and no game implements its own.
   */
  protected readonly chat = new RoomChat();

  public onCreate(
    options: {
      targetPlayers?: number;
      creatorUserId?: string;
      reconnectionGrace?: number;
    } = {},
  ) {
    const def = this.game;

    /*
     * Validate the requested table size against the game's own list of
     * allowed player counts — a client cannot smuggle in a size the
     * game does not support. Default: the game's largest table.
     */
    const requested = Math.trunc(Number(options.targetPlayers) || 0);
    const allowed = def.allowedPlayerCounts;
    const fallback =
      allowed && allowed.length > 0
        ? allowed[allowed.length - 1]
        : def.maxPlayers;
    const valid =
      requested > 0 &&
      requested <= def.maxPlayers &&
      (!allowed || allowed.includes(requested));
    this.state.targetPlayers = valid ? requested : fallback;
    this.state.gameId = def.id;
    this.state.gameName = def.name;
    this.state.maxPlayers = def.maxPlayers;
    this.state.minPlayers = def.minPlayers;
    this.state.phase = LIFECYCLE.WAITING;

    this.refreshMetadata();

    /*
     * Room capacity = players + spectators. Spectators never occupy a
     * player seat; player seats are enforced by approval, not by the
     * client budget. The board stays joinable for onlookers even once
     * every seat is taken.
     */
    this.maxClients = def.maxPlayers + MAX_SPECTATORS;

    // The creator is registered as admin up-front; their seat is seated
    // when their connection arrives (creator joins with mode "play" and
    // is auto-approved as the first player).
    if (options.creatorUserId) {
      this.state.hostUserId = options.creatorUserId;
    }

    /*
     * Reconnection grace, overridable per room (2–120 s). Legitimate
     * uses: integration tests (a real 30 s wait per case is not one),
     * kiosk setups. A client-suggested value only ever applies to a
     * room its creator asked for — and the SDK's own auto-retry still
     * governs how fast a real reconnection happens.
     */
    const grace = Math.trunc(Number(options.reconnectionGrace) || 0);
    if (grace >= 2 && grace <= 120) {
      this.reconnectionGraceSeconds = grace;
    }
  }

  /** Verify the platform JWT and remember the caller's identity. */
  public async onAuth(client: Client, options: JoinOptions = {}) {
    const identity = await this.verifyIdentity(options.token);

    // One simultaneous connection per user, whatever the role: a second
    // tab would fight over the same seat/spectator record. A session
    // whose transport is gone (drop mid-grace) does not count — the
    // user may rejoin right away through a new page load.
    const existingSession = this.sessionIdOfUser(identity.userId);
    if (existingSession) {
      if (this.liveSessions.has(existingSession)) {
        throw new ServerError(4_009, "Already connected to this room");
      }
      this.identities.delete(existingSession);
    }

    this.identities.set(client.sessionId, identity);
    return identity;
  }

  /**
   * Overridable hook so tests (or a future integration) can substitute a
   * different identity source. Default: verify the platform JWT — user
   * tokens and guest tokens both accepted; guests may only ever watch.
   */
  protected async verifyIdentity(token?: string): Promise<RealtimeIdentity> {
    const { verifyAnyRealtimeToken } = await import("../auth/verify-token.js");
    return verifyAnyRealtimeToken(token ?? "");
  }

  /**
   * Route every fresh connection by role.
   *
   * A returning player (seat held through the reconnection grace or a
   * still-registered player record) reclaims their seat without any
   * approval — reconnection must never go through the request queue
   * again. Everything else lands as spectator or pending request.
   */
  public async onJoin(client: Client, options: JoinOptions = {}) {
    const identity = this.identities.get(client.sessionId);
    if (!identity) {
      throw new ServerError(4_003, "Not authenticated");
    }
    if (this.closed) {
      throw new ServerError(4_012, "Room is closed");
    }
    this.liveSessions.add(client.sessionId);

    const mode: JoinMode = options.mode === "watch" ? "watch" : "play";

    // 1) Returning accepted player: seat reclaim, no approval.
    const returning = this.state.players.get(identity.userId);
    if (returning) {
      this.reclaimPlayerSeat(returning, client.sessionId);
      this.sendChatSnapshot(client);
      this.broadcast("playerReconnected", { userId: identity.userId });
      return;
    }

    // 2) Spectator mode: immediate, never capacity-bound.
    if (mode === "watch") {
      this.addSpectator(identity, client.sessionId);
      this.sendChatSnapshot(client);
      this.broadcast("spectatorJoined", {
        userId: identity.userId,
        spectators: this.state.spectators.size,
      });
      return;
    }

    // 3) Play mode. Guests NEVER seat — watching is the only thing an
    //    anonymous viewer can do. Redirect them to spectatorship.
    if (identity.guest) {
      this.addSpectator(identity, client.sessionId);
      this.sendChatSnapshot(client);
      this.broadcast("spectatorJoined", {
        userId: identity.userId,
        spectators: this.state.spectators.size,
      });
      return;
    }

    // 4) Play mode: the creator's own first join is auto-approved —
    //    onCreate already registered them as admin, so their arrival is
    //    recognised by userId, not by connection order. Every other seat
    //    needs admin approval (section 5 of the spec).
    const isCreatorArrival =
      this.state.players.size === 0 &&
      (!this.state.hostUserId || identity.userId === this.state.hostUserId);
    if (isCreatorArrival) {
      this.seatPlayer(identity, client.sessionId);
      this.sendChatSnapshot(client);
      return;
    }

    const acceptedRequest = this.latestJoinRequestResult(identity.userId, "accepted");
    if (acceptedRequest) {
      this.seatPlayer(identity, client.sessionId);
      client.send("joinRequestApproved", acceptedRequest);
      this.sendChatSnapshot(client);
      return;
    }

    // A request is room state, not a socket event. Rejoining a room with an
    // existing pending entry must restore it instead of creating a new one.
    const pendingRequest = this.state.pendingPlayerRequests.get(identity.userId);
    if (pendingRequest) {
      client.send("joinRequestRegistered", {
        requestId: pendingRequest.requestId,
        status: "pending",
        requestedAt: pendingRequest.requestedAt,
      });
      this.sendChatSnapshot(client);
      return;
    }

    if (this.started) {
      // Matches in progress do not accept new players at all; watching
      // remains available (section 13).
      throw new ServerError(4_010, "Match already started — join as spectator");
    }
    if (this.state.players.size >= this.state.targetPlayers) {
      throw new ServerError(4_011, "Room is full — join as spectator");
    }

    this.enqueueJoinRequest(identity);
    this.sendChatSnapshot(client);
    // The requester keeps their connection open and watches read-only
    // until an admin approves or rejects (client renders the pending
    // banner over the read-only board).
  }

  /** Unexpected disconnection: hold roles open for a reconnection window. */
  public onDrop(client: Client) {
    const identity = this.identities.get(client.sessionId);
    if (!identity) return;
    this.markSessionDown(client.sessionId, identity.userId, "dropped");
    this.allowReconnection(client, this.reconnectionGraceSeconds);
  }

  /** A dropped player made it back inside the grace window. */
  public onReconnect(client: Client) {
    const identity = this.identities.get(client.sessionId);
    if (!identity) return;

    const player = this.state.players.get(identity.userId);
    if (player) {
      this.reclaimPlayerSeat(player, client.sessionId);
      this.sendChatSnapshot(client);
      this.broadcast("playerReconnected", { userId: identity.userId });
      return;
    }

    const spectator = this.state.spectators.get(identity.userId);
    if (spectator) {
      spectator.sessionId = client.sessionId;
      this.sendChatSnapshot(client);
    }
  }

  /**
   * Final leave. Fired directly for a deliberate close (consented), or
   * after the reconnection window expired following onDrop. The two
   * outcomes differ: a drop already went through its grace period, a
   * consented leave is an explicit, confirmed departure.
   */
  public onLeave(client: Client, code?: number) {
    const identity = this.identities.get(client.sessionId);
    if (!identity) return;

    const kind: DepartureKind =
      code === CloseCode.CONSENTED ? "consented" : "dropped";
    this.handleDeparture(identity.userId, client.sessionId, kind);

    // No ghost "…" in the indicator: the session is over for good.
    this.broadcast("chatTyping", {
      users: this.chat.stopTyping(identity.userId),
    });
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

  /**
   * Register a game's message handlers.
   *
   * Games call this instead of assigning `this.messages` directly, so
   * the generic handlers every room needs — chat, join requests, room
   * administration — are merged in and cannot be forgotten.
   */
  protected registerMessages(handlers: Messages<this>) {
    // MERGE, never replace: `this.messages` may already carry handlers
    // registered at construction time (framework behaviour), and a
    // plain replacement would silently drop them. Games only add their
    // own handlers; the room's generic ones (chat, join requests,
    // admin actions) are merged in below.
    this.messages = { ...this.messages, ...this.roomMessages(), ...handlers };
  }

  /** Handlers every room gets, whatever game it runs. */
  private roomMessages(): Messages<this> {
    return {
      chatMessage: (client: Client, message: RoomChatRequest) =>
        this.handleChatMessage(client, message),
      chatSync: (client: Client) => this.sendChatSnapshot(client),
      chatTyping: (client: Client, message: { isTyping?: boolean }) =>
        this.handleChatTyping(client, message),

      // Join requests (section 5).
      requestJoinAsPlayer: (
        client: Client,
        message: { requestId?: string },
      ) => this.handleJoinRequest(client, message),
      cancelJoinRequest: (client: Client) => this.handleCancelRequest(client),

      // Admin actions (sections 5, 6, 12) — host-only, validated here.
      approveJoin: (client: Client, message: { userId?: string; requestId?: string }) =>
        this.handleApproveJoin(client, message),
      rejectJoin: (client: Client, message: { userId?: string; requestId?: string }) =>
        this.handleRejectJoin(client, message),
      closeRoom: (client: Client) => this.handleCloseRoom(client),
      updateLobbySettings: (client: Client, message: unknown) =>
        this.handleLobbySettings(client, message),

      // Deliberate leave via UI (section 10) — after double confirmation
      // client-side, so the server treats it as final.
      leaveRoom: (client: Client) => this.handleLeaveMessage(client),

      // Voice: the LOGICAL mute state, for the roster UI. Only seated
      // players may ever set it; the server is the source of truth.
      "voice:mute": (client: Client, message: { muted?: boolean }) =>
        this.handleVoiceMute(client, message),

      // Admin power over the call (user request): the room creator may
      // remotely mute ANOTHER seated player. The target cannot unmute
      // themselves until the admin lifts it — the server enforces both.
      "voice:admin-mute": (
        client: Client,
        message: { userId?: string; muted?: boolean },
      ) => this.handleAdminMute(client, message),
    };
  }

  /** A seated player toggles their logical microphone state. */
  private handleVoiceMute(client: Client, message: { muted?: boolean }) {
    const player = this.playerBySession(client.sessionId);
    if (!player) return; // spectators and guests have no mic on the roster

    // An admin-imposed mute can only be lifted by the admin.
    if (player.adminMuted && message?.muted === false) return;

    player.voiceMuted = message?.muted !== false;
  }

  /**
   * Admin remotely mutes/unmutes another seated player (user request).
   * While `adminMuted` is set, the target's own unmute calls are
   * refused — only the admin (or the target leaving) lifts it.
   */
  private handleAdminMute(
    client: Client,
    message: { userId?: string; muted?: boolean },
  ) {
    if (!this.isAdmin(client.sessionId)) return; // admin-only, period
    const target = this.playerByUserId(String(message?.userId ?? ""));
    if (!target) return; // unknown / not a seated player
    if (target.userId === this.state.hostUserId) return; // admin never mutes self

    target.adminMuted = message?.muted !== false;
    target.voiceMuted = target.adminMuted;
    // Tell everyone: the target's client disables their mic button and
    // flips the local track; other rosters refresh the dot.
    this.broadcast("voice:adminMuted", {
      userId: target.userId,
      muted: target.adminMuted,
    });
  }

  /**
   * A participant sends a chat message.
   *
   * The sender's identity comes from this room's own records, so a
   * client cannot claim another user's name or id; anything it puts in
   * the payload beyond `content` is ignored. Rejections go back to that
   * one client, never to the room. Spectators may chat; pending
   * requesters may not.
   */
  private handleChatMessage(client: Client, message: RoomChatRequest) {
    const sender = this.participantBySession(client.sessionId);
    if (!sender) {
      client.send("chatRejected", { reason: "not-in-room" });
      return;
    }

    const result = this.chat.submit(
      { userId: sender.userId, username: sender.name },
      message,
    );

    if (result.status === "rejected") {
      client.send("chatRejected", { reason: result.reason });
      return;
    }

    // Broadcast reaches only the clients of THIS room, sender included,
    // so everyone renders the same authoritative message.
    this.broadcast("chatMessage", result.message);
  }

  /**
   * A participant signals (or clears) its typing state. The room
   * relays the whole set rather than per-user deltas — at most a
   * handful of seats, so simplicity wins. Pruning happens on every
   * touch, so an abrupt disconnect cannot leave a ghost "…" behind.
   */
  private handleChatTyping(client: Client, message: { isTyping?: boolean }) {
    const sender = this.participantBySession(client.sessionId);
    if (!sender) return;

    const users = this.chat.setTyping(
      { userId: sender.userId, username: sender.name },
      message?.isTyping !== false,
    );
    this.broadcast("chatTyping", { users });
  }

  /**
   * How many messages this room currently holds. Read-only, for
   * diagnostics and tests — the buffer itself stays private.
   */
  public get chatSize(): number {
    return this.chat.size;
  }

  /**
   * Hand a client the room's bounded buffer.
   *
   * Pushed on join so a client whose handlers are already registered
   * gets it with no round trip. That push can lose the race against a
   * client that registers `onMessage` after the join resolves, so the
   * `chatSync` message lets it ask again once it is ready. The snapshot
   * is the whole buffer, so receiving it twice is harmless.
   */
  private sendChatSnapshot(client: Client) {
    client.send("chatSnapshot", {
      messages: this.chat.snapshot(),
      // Pruned on the way out, so a rejoining client never sees a
      // stale indicator.
      typing: this.chat.pruneTyping(),
    });
  }

  /**
   * Release the room's chat. Games that override onDispose must call
   * `super.onDispose()` so the buffer is dropped with the room.
   */
  public onDispose() {
    this.chat.dispose();
  }

  /** Delegated lifecycle message: admin asks to start. */
  protected handleStartGame(client: Client) {
    if (!this.isAdmin(client.sessionId)) return;
    if (!this.canStart()) return;

    this.onBeforeStart();
    if (!this.startMatch()) return;
    this.broadcast("gameStarted", {});
  }

  /** Deliberate leave via UI. The client has double-confirmed already. */
  protected handleLeaveMessage(client: Client) {
    client.leave(CloseCode.CONSENTED);
  }

  /**
   * Host-only lobby settings (table size + game knobs through the hook).
   * Only applies while the lobby waits: once the match runs the settings
   * are frozen — gameplay must never shift under the players' feet.
   */
  protected handleLobbySettings(
    client: Client,
    message: LobbySettingsInput | undefined,
  ) {
    if (!this.isAdmin(client.sessionId)) return;
    if (this.started || this.closed) return;
    if (
      this.state.phase !== LIFECYCLE.WAITING &&
      this.state.phase !== LIFECYCLE.READY
    ) {
      return;
    }

    if (message?.targetPlayers !== undefined) {
      const requested = Math.trunc(Number(message.targetPlayers));
      const allowed = this.game.allowedPlayerCounts;
      const valid =
        requested > 0 &&
        requested <= this.state.maxPlayers &&
        requested >= this.state.players.size && // never shrink below seated
        (!allowed || allowed.includes(requested));
      if (valid) this.state.targetPlayers = requested;
    }

    // Game-specific knobs (Ludo's turn budget, future rule toggles).
    this.onLobbySettingsApplied(message);

    // Enlarging/shrinking the table may flip WAITING ⇄ READY.
    this.refreshReadiness();
  }

  /**
   * Hook for game subclasses to apply their own host-editable settings.
   * Receives the raw message (undefined-safe), defaults to a no-op.
   */
  protected onLobbySettingsApplied(_message: LobbySettingsInput | undefined) {}

  /** A user asks for a player seat — lands in the approval queue. */
  private handleJoinRequest(client: Client, message: { requestId?: string } = {}) {
    const identity = this.identities.get(client.sessionId);
    if (!identity) return;
    // Guests are spectators by nature — the seat queue is not for them.
    if (identity.guest) {
      client.send("joinRequestRejected", { reason: "guests-watch-only" });
      return;
    }

    if (this.state.players.get(identity.userId)) return; // already seated
    // No pending-swallow here: asking again REFRESHES the request
    // (fresh timestamp + joinRequested) instead of recycling a stale
    // notification — that is exactly what "il refait la demande" must
    // produce. Duplicate requests are harmless: one map entry keyed by
    // userId, always pointing at the newest ask.
    if (this.closed || this.started) {
      client.send("joinRequestRejected", { reason: "room-unavailable" });
      return;
    }
    if (this.state.players.size >= this.state.targetPlayers) {
      client.send("joinRequestRejected", { reason: "room-full" });
      return;
    }

    this.enqueueJoinRequest(identity, message.requestId);
  }

  /** A requester withdraws their own pending request. */
  private handleCancelRequest(client: Client) {
    const identity = this.identities.get(client.sessionId);
    if (!identity) return;
    const request = this.state.pendingPlayerRequests.get(identity.userId);
    if (!request) return;

    this.state.pendingPlayerRequests.delete(identity.userId);
    this.recordJoinRequestResult(request, "cancelled", "requester-cancelled");
    this.broadcast("joinRequestCancelled", {
      userId: identity.userId,
      requestId: request.requestId,
    });
  }

  /** Admin accepts a pending requester — all four checks of section 6. */
  private handleApproveJoin(
    client: Client,
    message: { userId?: string; requestId?: string },
  ) {
    const admin = this.adminBySession(client.sessionId);
    if (!admin) return; // permission: admin only
    // A guest token must never be able to run the room, belt and braces.
    if (admin.guest) return;

    const userId = String(message?.userId ?? "");
    const request = this.state.pendingPlayerRequests.get(userId);
    if (!request) return; // unknown or already handled
    if (message?.requestId && message.requestId !== request.requestId) return;

    // Section 6 — validate before seating.
    if (this.closed || this.started) {
      client.send("joinRequestRejected", { reason: "room-unavailable" });
      return;
    }
    if (this.state.players.get(userId)) return; // already present
    if (this.state.players.size >= this.state.targetPlayers) {
      client.send("joinRequestRejected", { reason: "room-full" });
      return;
    }

    const identity: RealtimeIdentity = {
      userId: request.userId,
      name: request.name,
    };
    const requesterSession = this.sessionIdOfUser(userId);
    this.state.pendingPlayerRequests.delete(userId);
    this.recordJoinRequestResult(request, "accepted", "approved");

    if (requesterSession) {
      // Still connected: promote in place, keep their session.
      this.seatPlayer(identity, requesterSession);
    } else {
      // The requester's connection dropped while queued. Keep the
      // authoritative approval in room state; a later reconnect will
      // reclaim the reserved request and receive the seat.
      this.broadcast("joinRequestApproved", {
        userId,
        requestId: request.requestId,
        name: request.name,
        players: this.state.players.size,
      });
      return;
    }

    this.broadcast("joinRequestApproved", {
      userId,
      requestId: request.requestId,
      name: request.name,
      players: this.state.players.size,
    });
    this.refreshReadiness();
  }

  /** Admin declines a pending requester. */
  private handleRejectJoin(
    client: Client,
    message: { userId?: string; requestId?: string },
  ) {
    if (!this.isAdmin(client.sessionId)) return;

    const userId = String(message?.userId ?? "");
    const request = this.state.pendingPlayerRequests.get(userId);
    if (!request) return;
    if (message?.requestId && message.requestId !== request.requestId) return;

    this.state.pendingPlayerRequests.delete(userId);
    this.recordJoinRequestResult(request, "rejected", "declined");
    this.broadcast("joinRequestRejected", {
      userId,
      requestId: request.requestId,
      name: request.name,
      reason: "declined",
    });
  }

  /** Admin closes the room — terminal, section 12. */
  private handleCloseRoom(client: Client) {
    if (!this.isAdmin(client.sessionId)) return;
    if (this.closed) return;

    this.closed = true;
    this.state.phase = LIFECYCLE.CLOSED;
    for (const request of this.state.pendingPlayerRequests.values()) {
      this.recordJoinRequestResult(request, "expired", "room-closed");
    }
    for (const request of [...this.state.pendingPlayerRequests.values()]) {
      this.state.pendingPlayerRequests.delete(request.userId);
    }
    this.lock();
    this.refreshMetadata();
    this.broadcast("roomClosed", {});

    // Everyone is told; give clients a moment to render the notice
    // before their transport is torn down with the room.
    this.delay(1_500, () => this.disconnect());
  }

  /** Participant record by session id (players or spectators). */
  private participantBySession(
    sessionId: string,
  ): { userId: string; name: string } | undefined {
    const player = this.playerBySession(sessionId);
    if (player) return { userId: player.userId, name: player.name };
    const spectator = this.spectatorBySession(sessionId);
    if (spectator) return { userId: spectator.userId, name: spectator.name };
    return undefined;
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

  /** Spectator record by session id. */
  private spectatorBySession(
    sessionId: string,
  ): LobbySpectatorLike | undefined {
    for (const spectator of this.state.spectators.values()) {
      if (spectator.sessionId === sessionId) return spectator;
    }
    return undefined;
  }

  /** Is this session the room admin (or the admin's live session)? */
  protected isAdmin(sessionId: string): boolean {
    const identity = this.identities.get(sessionId);
    if (!identity) return false;
    // The admin acts through any of their live sessions; approval state
    // is keyed by stable userId, not by the transport.
    return this.state.hostUserId === identity.userId;
  }

  /** Admin record, if that session belongs to the current admin. */
  private adminBySession(
    sessionId: string,
  ): (RealtimeIdentity & { guest?: boolean }) | undefined {
    if (!this.isAdmin(sessionId)) return undefined;
    return this.identities.get(sessionId);
  }

  /** Session id currently attached to a user id, if any. */
  private sessionIdOfUser(userId: string): string | undefined {
    for (const [sessionId, identity] of this.identities) {
      if (identity.userId === userId) return sessionId;
    }
    return undefined;
  }

  /**
   * The lifecycle allows a start when the table has at least the game's
   * minimum AND everyone the creator asked for has arrived. Starting is
   * always an explicit admin action — never automatic on capacity.
   */
  protected canStart(): boolean {
    if (this.started || this.closed) return false;
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
    if (this.started || this.closed) return;
    this.state.phase = this.canStart() ? LIFECYCLE.READY : LIFECYCLE.WAITING;
    this.refreshMetadata();
  }

  /**
   * Transition READY → PLAYING. Subclasses call this from their own
   * start message once they have initialised their game state.
   * Returns false when the start conditions are not met.
   *
   * The room is NOT locked: seats are guarded by approval and the
   * player checks, so a running match stays watchable (spec sections
   * 7 and 13) — spectators must be able to join mid-game.
   */
  protected startMatch(): boolean {
    if (!this.canStart()) return false;
    this.started = true;
    this.state.phase = LIFECYCLE.PLAYING;
    this.matchStartedAt = Date.now();
    // Expose to clients: their elapsed-time dial stays exact even for
    // spectators who join mid-match (server clock, not receiver clock).
    this.state.startedAt = Date.now();
    this.refreshMetadata();
    return true;
  }

  /**
   * Timestamp (ms) captured when the match flips to PLAYING — the
   * server-side measure of how long the match actually ran.
   */
  private matchStartedAt = 0;

  /**
   * Transition to FINISHED once a game subclass completed its match.
   *
   * This is also where the platform's gamer profile gets fed: every
   * seated player's outcome is derived from `state.winnerUserId` (empty
   * = draw) — the one funnel every game room goes through — and
   * reported once to the platform, signed, fire-and-forget. Games never
   * report anything themselves; profile code never touches game rules.
   */
  protected finishMatch() {
    this.state.phase = LIFECYCLE.FINISHED;
    this.refreshMetadata();
    this.reportMatchOutcome();
  }

  /**
   * Derive win/loss/draw for every seated player and hand the result
   * to the platform. Guests (no account) are skipped: they have no
   * profile. Reporting failures never propagate to the room.
   */
  private reportMatchOutcome(): void {
    const winnerUserId = this.state.winnerUserId;
    const participants: ParticipantReport[] = [];

    for (const player of this.state.players.values()) {
      // Guests can never hold a seat, but a defensive skip keeps a
      // future schema change from creating ghost profiles.
      if (player.userId.startsWith("guest-")) continue;

      const outcome =
        !winnerUserId
          ? "draw"
          : player.userId === winnerUserId
            ? "win"
            : "loss";

      const durationSeconds = this.matchStartedAt
        ? Math.max(0, Math.round((Date.now() - this.matchStartedAt) / 1_000))
        : 0;

      participants.push({
        userId: player.userId,
        outcome,
        seat: player.seat,
        durationSeconds,
      });
    }

    if (participants.length === 0) return;

    void reportMatchFinished({
      gameId: this.game.id,
      roomId: this.roomId,
      participants,
    }).catch((error) => {
      // reportMatchFinished already swallows errors; belt and braces —
      // a reporting bug must never take the room down.
      console.error("[profile] match report crashed:", error);
    });
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

  /** Queue a user as a pending player request and tell the room. */
  private enqueueJoinRequest(identity: RealtimeIdentity, requestedId?: string) {
    const existing = this.state.pendingPlayerRequests.get(identity.userId);
    if (existing) {
      this.sendJoinRequestAck(identity.userId, existing);
      return;
    }

    const requestId =
      typeof requestedId === "string" && /^[a-zA-Z0-9._:-]{8,128}$/.test(requestedId)
        ? requestedId
        : randomUUID();
    const request: LobbyPendingRequestLike = PendingRequestFactory(
      requestId,
      identity.userId,
      identity.name,
      Math.min(this.clock.currentTime, 4_294_967_295),
    );
    this.state.pendingPlayerRequests.set(identity.userId, request);
    this.sendJoinRequestAck(identity.userId, request);
    this.broadcast("joinRequested", {
      requestId: request.requestId,
      userId: identity.userId,
      name: identity.name,
      requestedAt: request.requestedAt,
    });
  }

  private sendJoinRequestAck(userId: string, request: LobbyPendingRequestLike) {
    const sessionId = this.sessionIdOfUser(userId);
    const client = sessionId ? this.clients.find((item) => item.sessionId === sessionId) : undefined;
    client?.send("joinRequestRegistered", {
      requestId: request.requestId,
      status: "pending",
      requestedAt: request.requestedAt,
    });
  }

  private recordJoinRequestResult(
    request: LobbyPendingRequestLike,
    status: "accepted" | "rejected" | "cancelled" | "expired",
    reason: string,
  ) {
    const result = new JoinRequestResultSchema();
    result.requestId = request.requestId;
    result.userId = request.userId;
    result.status = status;
    result.updatedAt = Math.min(this.clock.currentTime, 4_294_967_295);
    result.reason = reason;
    this.state.joinRequestResults.set(request.requestId, result);
    return result;
  }

  private latestJoinRequestResult(
    userId: string,
    status?: "accepted" | "rejected" | "cancelled" | "expired",
  ): LobbyJoinRequestResultLike | undefined {
    return [...this.state.joinRequestResults.values()]
      .filter((result) => result.userId === userId && (!status || result.status === status))
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  }

  private clearJoinRequestResults(
    userId: string,
    status?: "accepted" | "rejected" | "cancelled" | "expired",
  ) {
    for (const result of [...this.state.joinRequestResults.values()]) {
      if (result.userId === userId && (!status || result.status === status)) {
        this.state.joinRequestResults.delete(result.requestId);
      }
    }
  }

  /** Seat an approved user: build their player record and register it. */
  private seatPlayer(identity: RealtimeIdentity, sessionId: string) {
    // A seated player is no longer an onlooker — a requester may have
    // been watching while waiting for approval.
    if (this.state.spectators.get(identity.userId)) {
      this.state.spectators.delete(identity.userId);
      this.broadcast("spectatorLeft", {
        userId: identity.userId,
        spectators: this.state.spectators.size,
      });
    }

    const seat = this.nextFreeSeat();
    const player = this.createPlayerInstance();
    player.userId = identity.userId;
    // Gaming identity: the roster shows the gamerTag (with a graceful
    // fallback to the platform name) — but the KEY stays the stable
    // userId. The profile is never stored in the room state.
    player.name = identity.gamerTag ?? identity.name;
    player.avatarUrl = identity.avatarUrl ?? null;
    player.sessionId = sessionId;
    player.seat = seat;
    player.connected = true;
    this.state.players.set(identity.userId, player);

    // The admin keeps admin rights regardless of seat order; hostUserId
    // is only defaulted here for the very first seat (creator).
    if (!this.state.hostUserId) {
      this.state.hostUserId = identity.userId;
    }
    this.refreshReadiness();
  }

  /** Reattach a live session to a held player record (reconnection). */
  private reclaimPlayerSeat(player: LobbyPlayerLike, sessionId: string) {
    player.sessionId = sessionId;
    player.connected = true;
  }

  /** Register a spectator. */
  private addSpectator(identity: RealtimeIdentity, sessionId: string) {
    const spectator: LobbySpectatorLike = SpectatorFactory(
      identity.userId,
      identity.name,
      sessionId,
    );
    this.state.spectators.set(identity.userId, spectator);
    this.refreshMetadata();
  }

  /**
   * Shared departure handling.
   *
   * Players keep their seat through a drop (reconnection grace, then the
   * record stays for a later reclaim) — an accepted player is never
   * demoted by network trouble. A consented leave is final: seat freed,
   * room notified. Spectators simply leave.
   */
  private handleDeparture(
    userId: string,
    sessionId: string,
    kind: DepartureKind,
  ) {
    this.identities.delete(sessionId);
    this.liveSessions.delete(sessionId);

    const player = this.state.players.get(userId);
    if (player && player.sessionId === sessionId) {
      if (kind === "consented" || kind === "evicted") {
        const name = player.name;
        this.state.players.delete(userId);
        this.clearJoinRequestResults(userId, "accepted");
        this.broadcast("playerLeft", { userId, name });

        // Admin left without closing: transfer to the most senior
        // remaining player so approval/keep-alive keeps working.
        if (this.state.hostUserId === userId) {
          const nextAdmin = [...this.state.players.values()].sort(
            (a, b) => a.seat - b.seat,
          )[0];
          this.state.hostUserId = nextAdmin?.userId ?? "";
          if (nextAdmin) {
            this.broadcast("hostTransferred", { userId: nextAdmin.userId });
          }
        }

        this.refreshReadiness();
        return;
      }

      // Dropped: keep the seat, mark offline, notify.
      player.connected = false;
      player.sessionId = "";
      if (this.state.phase === LIFECYCLE.PLAYING) {
        this.broadcast("playerDisconnected", { userId, name: player.name });
      }
      return;
    }

    const spectator = this.state.spectators.get(userId);
    if (spectator && spectator.sessionId === sessionId) {
      this.state.spectators.delete(userId);
      this.broadcast("spectatorLeft", {
        userId,
        spectators: this.state.spectators.size,
      });
      this.refreshMetadata();
      return;
    }

    // A deliberate leave is an explicit cancellation. An unexpected
    // disconnect keeps the request in authoritative room state so a
    // reconnecting requester or host can recover it.
    if (kind === "consented") {
      const request = this.state.pendingPlayerRequests.get(userId);
      if (!request) return;
      this.state.pendingPlayerRequests.delete(userId);
      this.recordJoinRequestResult(request, "cancelled", "requester-left");
      this.broadcast("joinRequestCancelled", {
        userId,
        requestId: request.requestId,
      });
    }
  }

  /**
   * One path for every connection loss, so drop, consented leave and
   * eviction all stay consistent with handleDeparture().
   */
  private markSessionDown(
    sessionId: string,
    userId: string,
    kind: DepartureKind,
  ) {
    // The transport is gone: a fresh join by this user must be allowed
    // through onAuth from this instant, even mid-grace.
    this.liveSessions.delete(sessionId);

    if (kind === "dropped") {
      const player = this.state.players.get(userId);
      if (player && player.sessionId === sessionId) {
        player.connected = false;
        player.sessionId = "";
        if (this.state.phase === LIFECYCLE.PLAYING) {
          // A live match keeps the seat: the outcome (forfeit, resume)
          // depends on it. Only the match's own rules may end it.
          this.broadcast("playerDisconnected", { userId, name: player.name });
        } else {
          // Lobby: release the seat when the grace expires — unless the
          // player made it back in the meantime (reaped record check).
          this.schedulePhantomReap(userId);
        }
        return;
      }
      const spectator = this.state.spectators.get(userId);
      if (spectator && spectator.sessionId === sessionId) {
        spectator.sessionId = "";
        // Held for the same grace, then reaped (see schedulePhantomReap).
        this.schedulePhantomReap(userId);
      }

      // Pending requests are deliberately retained. Room state is the
      // delivery queue; the requester can reconnect and the host can
      // still approve or reject without relying on a transient message.
    }
  }

  /**
   * Remove a dropped participant's record once the reconnection grace
   * has passed — the fix for ghost sessions. Every check re-reads the
   * CURRENT record: anyone who reclaimed their seat (SDK reconnect or
   * a fresh join) now has a live sessionId and is left untouched; a
   * consented leave already deleted the record, making this a no-op.
   */
  private schedulePhantomReap(userId: string): void {
    this.delay(this.reconnectionGraceSeconds * 1000 + 500, () => {
      const player = this.state.players.get(userId);
      if (player && !player.connected && player.sessionId === "") {
        const name = player.name;
        this.state.players.delete(userId);
        this.broadcast("playerLeft", { userId, name });

        // Mirror the consented-leave path: a departed admin hands the
        // room to the most senior remaining player.
        if (this.state.hostUserId === userId) {
          const nextAdmin = [...this.state.players.values()].sort(
            (a, b) => a.seat - b.seat,
          )[0];
          this.state.hostUserId = nextAdmin?.userId ?? "";
          if (nextAdmin) {
            this.broadcast("hostTransferred", { userId: nextAdmin.userId });
          }
        }
        this.refreshReadiness();
        return;
      }

      const spectator = this.state.spectators.get(userId);
      if (spectator && spectator.sessionId === "") {
        this.state.spectators.delete(userId);
        this.broadcast("spectatorLeft", {
          userId,
          spectators: this.state.spectators.size,
        });
        this.refreshMetadata();
      }
    });
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

  /**
   * Push the numbers the match list shows into room metadata — plus
   * the participant ids, which the platform resolves into presence
   * ("● En ligne", "🎮 En train de jouer"). Ids only: no names, no
   * profile data — the profile stays the platform's business.
   */
  private refreshMetadata() {
    this.setMetadata({
      gameId: this.state.gameId,
      gameName: this.state.gameName,
      targetPlayers: this.state.targetPlayers,
      players: this.state.players.size,
      maxPlayers: this.state.maxPlayers,
      spectators: this.state.spectators.size,
      phase: this.state.phase,
      playerIds: [...this.state.players.values()].map((p) => p.userId),
      spectatorIds: [...this.state.spectators.values()].map((s) => s.userId),
    });
  }

  /** Exposed for tests. */
  public get isStarted(): boolean {
    return this.started;
  }

  /** Exposed for tests. */
  public get isClosed(): boolean {
    return this.closed;
  }
}

/** Join payload accepted by onAuth/onJoin. */
export interface JoinOptions {
  token?: string;
  mode?: JoinMode;
  creatorUserId?: string;
}

// ---------------------------------------------------------------------------
// Schema record factories
// ---------------------------------------------------------------------------

function PendingRequestFactory(
  requestId: string,
  userId: string,
  name: string,
  requestedAt: number,
): LobbyPendingRequestLike {
  const record = new PendingRequestSchema();
  record.requestId = requestId;
  record.userId = userId;
  record.name = name;
  record.requestedAt = requestedAt;
  return record;
}

function SpectatorFactory(
  userId: string,
  name: string,
  sessionId: string,
): LobbySpectatorLike {
  const record = new SpectatorSchema();
  record.userId = userId;
  record.name = name;
  record.sessionId = sessionId;
  return record;
}
