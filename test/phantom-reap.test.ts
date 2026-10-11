import assert from "assert";
import { JWT } from "@colyseus/auth";
import { roomSnapshotStore } from "../src/rooms/room-snapshot-store.js";

import { getTestServer, type TestServer } from "./test-server.js";
import type { LudoRoom } from "../src/games/ludo/ludo-room.js";

process.env.REALTIME_TOKEN_SECRET =
  "test-secret-for-the-realtime-suite-0123456789";

const SECRET = process.env.REALTIME_TOKEN_SECRET;
const ISSUER = "game-platform";

async function mintToken(userId: string, name: string): Promise<string> {
  JWT.settings.secret = SECRET;
  return JWT.sign({ sub: userId, name, iss: ISSUER }, { expiresIn: "1h" });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 60));
/** Slightly longer than the 2s test grace (+ reap margin). */
const pastGrace = () => new Promise((resolve) => setTimeout(resolve, 2_800));

function collect<T>(
  client: { onMessage: (type: string, handler: (payload: T) => void) => void },
  type: string,
): T[] {
  const received: T[] = [];
  client.onMessage(type, (payload) => received.push(payload));
  return received;
}

/**
 * Ghost sessions: a browser that dies mid-lobby must free its seat (or
 * spectator slot) once the reconnection grace passes — the room must
 * never stay stuck with an offline player. A LIVE match keeps the
 * seat on purpose (the outcome depends on it).
 *
 * The rooms are created with `reconnectionGrace: 2` so these cases run
 * in seconds, not minutes; production keeps the 30 s default.
 */
describe("phantom reaping after the reconnection grace", () => {
  let colyseus: TestServer;

  before(async () => (colyseus = await getTestServer()));
  beforeEach(async () => {
    await colyseus.cleanup();
  });

  /** A Ludo room with a short grace + seated alice and bob. */
  async function seatedRoom() {
    const room = (await colyseus.createRoom("ludo", {
      targetPlayers: 2,
      reconnectionGrace: 2,
    })) as LudoRoom;
    const alice = await colyseus.connectTo(room, {
      token: await mintToken("user-a", "Alice"),
    });
    const bob = await colyseus.connectTo(room, {
      token: await mintToken("user-b", "Bob"),
    });
    alice.send("approveJoin", { userId: "user-b" });
    await tick();
    return { room, alice, bob };
  }

  /** Brutal browser death: close the socket WITHOUT a consented leave. */
  function kill(client: { connection: { close(): void } }): void {
    client.connection.close();
  }

  it("frees a dropped player's seat once the grace passes — no ghost", async () => {
    const { room, alice, bob } = await seatedRoom();
    const playerLeft = collect<{ userId: string }>(alice, "playerLeft");

    kill(bob);
    await tick();

    // Held during the grace: the SDK may still reconnect them.
    assert.ok(room.state.players.get("user-b"), "held during grace");
    assert.strictEqual(
      room.state.players.get("user-b")?.connected,
      false,
      "marked offline while held",
    );

    await pastGrace();

    // The ghost is gone — the seat is reusable.
    assert.ok(
      !room.state.players.has("user-b"),
      "a dropped lobby player must be reaped after the grace",
    );
    // Everyone was told, so no client shows a ghost row.
    assert.ok(
      playerLeft.some((m) => m.userId === "user-b"),
      "playerLeft broadcast on reap",
    );
  });

  it("keeps the seat when the player makes it back within the grace", async () => {
    const { room, bob } = await seatedRoom();

    kill(bob);
    await tick();

    // A brand-new connection (fresh page load) with the same identity:
    // the returning player reclaims the seat without approval.
    const bobAgain = await colyseus.connectTo(room, {
      token: await mintToken("user-b", "Bob"),
    });
    await tick();

    await pastGrace();

    const record = room.state.players.get("user-b");
    assert.ok(record, "reconnected player keeps the seat");
    assert.strictEqual(record.connected, true);
    assert.strictEqual(record.sessionId, bobAgain.sessionId);
  });

  it("keeps a dropped join request recoverable after the grace window", async () => {
    const room = (await colyseus.createRoom("ludo", {
      targetPlayers: 2,
      reconnectionGrace: 2,
    })) as LudoRoom;
    const alice = await colyseus.connectTo(room, {
      token: await mintToken("user-a", "Alice"),
    });
    const bob = await colyseus.connectTo(room, {
      token: await mintToken("user-b", "Bob"),
    });
    await tick();
    assert.ok(
      room.state.pendingPlayerRequests.has("user-b"),
      "bob queued as a join request",
    );
    const cancelled = collect<{ userId: string }>(alice, "joinRequestCancelled");

    kill(bob);
    await tick();

    // A dropped requester is not a deliberate cancellation. The request
    // remains authoritative even after the transport grace expires.
    const requestId = room.state.pendingPlayerRequests.get("user-b")?.requestId;
    assert.ok(
      room.state.pendingPlayerRequests.has("user-b"),
      "a dropped request must remain recoverable",
    );
    assert.ok(
      !cancelled.some((m) => m.userId === "user-b"),
      "a transport loss must not broadcast cancellation",
    );

    await pastGrace();
    assert.strictEqual(
      room.state.pendingPlayerRequests.get("user-b")?.requestId,
      requestId,
      "the request id survives the reconnection grace",
    );

    // Coming back restores the same request instead of creating a duplicate.
    const bobAgain = await colyseus.connectTo(room, {
      token: await mintToken("user-b", "Bob"),
    });
    await tick();
    const request = room.state.pendingPlayerRequests.get("user-b");
    assert.strictEqual(request?.requestId, requestId);
    void bobAgain;
  });

  it("acknowledges the same request id without duplicating the queue entry", async () => {
    const room = (await colyseus.createRoom("ludo", {
      targetPlayers: 2,
    })) as LudoRoom;
    const alice = await colyseus.connectTo(room, {
      token: await mintToken("user-a", "Alice"),
    });
    const bob = await colyseus.connectTo(room, {
      token: await mintToken("user-b", "Bob"),
    });
    await tick();

    const registered = collect<{ requestId: string; status: string }>(
      bob,
      "joinRequestRegistered",
    );
    const requested = collect<{ requestId: string }>(alice, "joinRequested");
    const requestId = "retryable-request-001";

    bob.send("cancelJoinRequest", {});
    await tick();
    registered.length = 0;
    requested.length = 0;

    bob.send("requestJoinAsPlayer", { requestId });
    bob.send("requestJoinAsPlayer", { requestId });
    await tick();

    assert.strictEqual(
      room.state.pendingPlayerRequests.get("user-b")?.requestId,
      requestId,
    );
    assert.ok(
      room.state.pendingPlayerRequests.get("user-b")!.requestedAt > 4_294_967_295,
      "request timestamps retain the full epoch-millisecond value",
    );
    assert.strictEqual(
      requested.filter((item) => item.requestId === requestId).length,
      1,
      "a retry must not create a second notification",
    );
    assert.ok(
      registered.some((item) => item.requestId === requestId && item.status === "pending"),
      "the requester receives a server registration acknowledgement",
    );
  });

  it("waits for durable storage before acknowledging request registration", async () => {
    const room = (await colyseus.createRoom("ludo", {
      targetPlayers: 2,
    })) as LudoRoom;
    const alice = await colyseus.connectTo(room, {
      token: await mintToken("user-a", "Alice"),
    });
    const bob = await colyseus.connectTo(room, {
      token: await mintToken("user-b", "Bob"),
      mode: "watch",
    });
    await tick();

    const acknowledgements = collect<{ requestId: string }>(
      bob,
      "joinRequestRegistered",
    );
    const deliveries = collect<{ requestId: string }>(alice, "joinRequested");
    let writes = 0;
    let finishWrite!: (saved: boolean) => void;
    const writeFinished = new Promise<boolean>((resolve) => {
      finishWrite = resolve;
    });
    const originalSave = roomSnapshotStore.save;
    roomSnapshotStore.save = async (snapshot) => {
      writes += 1;
      assert.ok(
        (snapshot.state.pendingPlayerRequests as Record<string, unknown>)["user-b"],
        "the durable candidate includes the pending request",
      );
      return writeFinished;
    };

    try {
      bob.send("requestJoinAsPlayer", { requestId: "durable-request-001" });
      bob.send("requestJoinAsPlayer", { requestId: "durable-request-001" });
      await tick();
      assert.strictEqual(writes, 1, "concurrent retries share one durable write");
      assert.strictEqual(
        acknowledgements.length,
        0,
        "registration is not acknowledged while persistence is pending",
      );
      assert.strictEqual(
        room.state.pendingPlayerRequests.has("user-b"),
        false,
        "unconfirmed requests are not exposed in shared room state",
      );
      finishWrite(true);
      await tick();
      assert.ok(
        acknowledgements.some((item) => item.requestId === "durable-request-001"),
        "registration is acknowledged after durable storage succeeds",
      );
      assert.ok(
        room.state.pendingPlayerRequests.has("user-b"),
        "the server remains authoritative for the registered request",
      );
      assert.strictEqual(
        deliveries.filter((item) => item.requestId === "durable-request-001").length,
        1,
        "concurrent retries produce one notification for the host",
      );
    } finally {
      roomSnapshotStore.save = originalSave;
    }
  });

  it("reports registration failure when durable storage rejects the write", async () => {
    const room = (await colyseus.createRoom("ludo", {
      targetPlayers: 2,
    })) as LudoRoom;
    await colyseus.connectTo(room, {
      token: await mintToken("user-a", "Alice"),
    });
    const bob = await colyseus.connectTo(room, {
      token: await mintToken("user-b", "Bob"),
      mode: "watch",
    });
    await tick();

    const failures = collect<{ reason: string }>(
      bob,
      "joinRequestRegistrationFailed",
    );
    const acknowledgements = collect<{ requestId: string }>(
      bob,
      "joinRequestRegistered",
    );
    const originalSave = roomSnapshotStore.save;
    roomSnapshotStore.save = async () => false;

    try {
      bob.send("requestJoinAsPlayer", { requestId: "failed-durable-request-001" });
      await tick();
      assert.strictEqual(failures[0]?.reason, "persistence-unavailable");
      assert.strictEqual(acknowledgements.length, 0);
      assert.strictEqual(
        room.state.pendingPlayerRequests.has("user-b"),
        false,
        "failed requests are not left pending in volatile room state",
      );
    } finally {
      roomSnapshotStore.save = originalSave;
    }
  });

  it("does not confirm a host decision until the terminal state is durable", async () => {
    const room = (await colyseus.createRoom("ludo", {
      targetPlayers: 2,
    })) as LudoRoom;
    const alice = await colyseus.connectTo(room, {
      token: await mintToken("user-a", "Alice"),
    });
    const bob = await colyseus.connectTo(room, {
      token: await mintToken("user-b", "Bob"),
      mode: "watch",
    });
    await tick();
    const requestId = "durable-decision-request-001";
    bob.send("requestJoinAsPlayer", { requestId });
    await tick();

    const failures = collect<{ reason: string }>(alice, "joinRequestDecisionFailed");
    const rejected = collect<{ requestId: string }>(alice, "joinRequestRejected");
    const originalSave = roomSnapshotStore.save;
    roomSnapshotStore.save = async () => false;
    try {
      alice.send("rejectJoin", { userId: "user-b", requestId });
      await tick();
      assert.strictEqual(
        room.state.pendingPlayerRequests.get("user-b")?.requestId,
        requestId,
        "a failed durable decision leaves the request pending",
      );
      assert.strictEqual(room.state.joinRequestResults.has(requestId), false);
      assert.strictEqual(rejected.length, 0, "the requester is not told it was rejected");
      assert.strictEqual(failures[0]?.reason, "persistence-unavailable");
    } finally {
      roomSnapshotStore.save = originalSave;
    }
  });

  it("persists an approval before seating and notifying the requester", async () => {
    const room = (await colyseus.createRoom("ludo", {
      targetPlayers: 2,
    })) as LudoRoom;
    const alice = await colyseus.connectTo(room, {
      token: await mintToken("user-a", "Alice"),
    });
    const bob = await colyseus.connectTo(room, {
      token: await mintToken("user-b", "Bob"),
      mode: "watch",
    });
    await tick();
    const requestId = "durable-approval-request-001";
    bob.send("requestJoinAsPlayer", { requestId });
    await tick();

    const approvals = collect<{ requestId: string }>(bob, "joinRequestApproved");
    let finishWrite!: (saved: boolean) => void;
    const writeFinished = new Promise<boolean>((resolve) => {
      finishWrite = resolve;
    });
    const originalSave = roomSnapshotStore.save;
    roomSnapshotStore.save = async (snapshot) => {
      const result = (snapshot.state.joinRequestResults as Record<string, { status?: string }>)[requestId];
      assert.strictEqual(result?.status, "accepted");
      return writeFinished;
    };
    try {
      alice.send("approveJoin", { userId: "user-b", requestId });
      await tick();
      assert.strictEqual(room.state.pendingPlayerRequests.has("user-b"), true);
      assert.strictEqual(room.state.joinRequestResults.has(requestId), false);
      assert.strictEqual(room.state.players.has("user-b"), false);
      assert.strictEqual(approvals.length, 0);
      finishWrite(true);
      await tick();
      assert.strictEqual(room.state.pendingPlayerRequests.has("user-b"), false);
      assert.strictEqual(room.state.joinRequestResults.get(requestId)?.status, "accepted");
      assert.strictEqual(room.state.players.has("user-b"), true);
      assert.strictEqual(approvals.length, 1);
    } finally {
      roomSnapshotStore.save = originalSave;
    }
  });

  it("expires requests by wall-clock age and keeps them pending if persistence fails", async () => {
    const room = (await colyseus.createRoom("ludo", {
      targetPlayers: 2,
    })) as LudoRoom;
    await colyseus.connectTo(room, {
      token: await mintToken("user-a", "Alice"),
    });
    const bob = await colyseus.connectTo(room, {
      token: await mintToken("user-b", "Bob"),
      mode: "watch",
    });
    await tick();
    const requestId = "wall-clock-expiration-001";
    bob.send("requestJoinAsPlayer", { requestId });
    await tick();
    const request = room.state.pendingPlayerRequests.get("user-b")!;
    request.requestedAt = Date.now() - 11 * 60 * 1_000;

    const originalSave = roomSnapshotStore.save;
    const expire = room as unknown as {
      expirePendingJoinRequests: () => Promise<void>;
    };
    roomSnapshotStore.save = async () => false;
    try {
      await expire.expirePendingJoinRequests();
      assert.strictEqual(
        room.state.pendingPlayerRequests.has("user-b"),
        true,
        "a failed expiration write does not remove the pending request",
      );

      roomSnapshotStore.save = async () => true;
      await expire.expirePendingJoinRequests();
      assert.strictEqual(room.state.pendingPlayerRequests.has("user-b"), false);
      assert.strictEqual(room.state.joinRequestResults.get(requestId)?.status, "expired");
      assert.ok(Date.now() - room.state.joinRequestResults.get(requestId)!.updatedAt < 5_000);
    } finally {
      roomSnapshotStore.save = originalSave;
    }
  });

  it("restores a recent rejection instead of silently filing a new request", async () => {
    const room = (await colyseus.createRoom("ludo", {
      targetPlayers: 2,
    })) as LudoRoom;
    const alice = await colyseus.connectTo(room, {
      token: await mintToken("user-a", "Alice"),
    });
    const bob = await colyseus.connectTo(room, {
      token: await mintToken("user-b", "Bob"),
      mode: "watch",
    });
    await tick();
    const requestId = "rejection-reconnect-001";
    bob.send("requestJoinAsPlayer", { requestId });
    await tick();
    alice.send("rejectJoin", { userId: "user-b", requestId });
    await tick();
    assert.strictEqual(room.state.joinRequestResults.get(requestId)?.status, "rejected");

    await bob.leave();
    await tick();
    const bobAgain = await colyseus.connectTo(room, {
      token: await mintToken("user-b", "Bob"),
    });
    await tick();
    assert.strictEqual(room.state.pendingPlayerRequests.has("user-b"), false);
    assert.strictEqual(room.state.joinRequestResults.get(requestId)?.status, "rejected");
    void bobAgain;
  });

  it("keeps an approval authoritative while the requester is offline", async () => {
    const room = (await colyseus.createRoom("ludo", {
      targetPlayers: 2,
      reconnectionGrace: 2,
    })) as LudoRoom;
    const alice = await colyseus.connectTo(room, {
      token: await mintToken("user-a", "Alice"),
    });
    const bob = await colyseus.connectTo(room, {
      token: await mintToken("user-b", "Bob"),
    });
    await tick();
    const requestId = room.state.pendingPlayerRequests.get("user-b")?.requestId;
    assert.ok(requestId);

    kill(bob);
    await tick();
    alice.send("approveJoin", { userId: "user-b", requestId });
    await tick();

    assert.strictEqual(room.state.pendingPlayerRequests.has("user-b"), false);
    assert.strictEqual(
      room.state.joinRequestResults.get(requestId)?.status,
      "accepted",
    );

    const bobAgain = await colyseus.connectTo(room, {
      token: await mintToken("user-b", "Bob"),
    });
    await tick();
    assert.ok(room.state.players.has("user-b"));
    void bobAgain;
  });

  it("ignores a host decision for an obsolete request id", async () => {
    const room = (await colyseus.createRoom("ludo", {
      targetPlayers: 2,
    })) as LudoRoom;
    const alice = await colyseus.connectTo(room, {
      token: await mintToken("user-a", "Alice"),
    });
    const bob = await colyseus.connectTo(room, {
      token: await mintToken("user-b", "Bob"),
    });
    await tick();

    const oldRequestId = room.state.pendingPlayerRequests.get("user-b")?.requestId;
    assert.ok(oldRequestId);
    bob.send("cancelJoinRequest", {});
    await tick();
    bob.send("requestJoinAsPlayer", { requestId: "fresh-request-002" });
    await tick();

    alice.send("approveJoin", { userId: "user-b", requestId: oldRequestId });
    await tick();

    assert.strictEqual(room.state.players.has("user-b"), false);
    assert.strictEqual(
      room.state.pendingPlayerRequests.get("user-b")?.requestId,
      "fresh-request-002",
    );
  });

  it("rehydrates lobby players and join-request state from a restart snapshot", async () => {
    const room = (await colyseus.createRoom("ludo", {
      targetPlayers: 2,
      restoreState: {
        targetPlayers: 2,
        phase: "waiting",
        startedAt: 0,
        hostUserId: "user-a",
        turnDurationMs: 60_000,
        players: {
          "user-a": {
            userId: "user-a",
            name: "Alice",
            seat: 0,
            voiceMuted: true,
            adminMuted: false,
          },
        },
        pendingPlayerRequests: {
          "user-b": {
            requestId: "restored-request-001",
            userId: "user-b",
            name: "Bob",
            requestedAt: 123,
          },
        },
        joinRequestResults: {
          "old-request-001": {
            requestId: "old-request-001",
            userId: "user-c",
            status: "rejected",
            updatedAt: 456,
            reason: "host-rejected",
          },
        },
        spectators: {
          "user-spectator": {
            userId: "user-spectator",
            name: "Spectator",
            sessionId: "old-session",
          },
        },
      },
    })) as LudoRoom;

    assert.strictEqual(room.state.hostUserId, "user-a");
    assert.strictEqual(room.state.players.get("user-a")?.connected, false);
    assert.strictEqual(room.state.players.get("user-a")?.sessionId, "");
    assert.strictEqual(
      room.state.pendingPlayerRequests.get("user-b")?.requestId,
      "restored-request-001",
    );
    assert.strictEqual(
      room.state.joinRequestResults.get("old-request-001")?.status,
      "rejected",
    );
    assert.strictEqual(
      room.state.spectators.size,
      0,
      "old spectator transports are not restored",
    );
    assert.strictEqual(room.state.turnDurationMs, 60_000);
  });

  it("restores a lobby with the historical room id used by invite links", async () => {
    const listing = await roomSnapshotStore.restoreSnapshot({
      roomId: "restored-lobby-id-001",
      roomName: "ludo",
      options: { targetPlayers: 2 },
      state: {
        targetPlayers: 2,
        phase: "waiting",
        hostUserId: "user-a",
        players: {},
        pendingPlayerRequests: {},
        joinRequestResults: {},
        spectators: {},
      },
      savedAt: Date.now(),
    });

    assert.strictEqual(listing.roomId, "restored-lobby-id-001");
  });

  it("frees a dropped spectator slot too", async () => {
    const { room, alice } = await seatedRoom();
    const spectatorLeft = collect<{ userId: string }>(
      alice,
      "spectatorLeft",
    );

    const cara = await colyseus.connectTo(room, {
      token: await mintToken("user-c", "Cara"),
      mode: "watch",
    });
    await tick();
    assert.strictEqual(room.state.spectators.size, 1);

    kill(cara);
    await pastGrace();

    assert.strictEqual(
      room.state.spectators.size,
      0,
      "a dropped spectator must not haunt the counter",
    );
    assert.ok(
      spectatorLeft.some((m) => m.userId === "user-c"),
      "spectatorLeft broadcast on reap",
    );
  });

  it("keeps a LIVE match's seat — the outcome depends on it", async () => {
    const { room, alice, bob } = await seatedRoom();

    // Ludo waits through its 3 s countdown before the match is live; poll
    // until it really flips (beat the SDK's over-optimistic tick()).
    alice.send("startGame", {});
    for (let i = 0; i < 60 && room.state.phase !== "playing"; i++) {
      await tick();
    }
    assert.strictEqual(room.state.phase, "playing");

    kill(bob);
    await pastGrace();

    assert.ok(
      room.state.players.has("user-b"),
      "a live match holds the seat (forfeit/resume is the match's business)",
    );
    assert.strictEqual(room.state.players.get("user-b")?.connected, false);
    void alice;
  });
});
