import assert from "assert";
import { JWT } from "@colyseus/auth";

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

  it("a dropped requester's join request dies with the connection — re-requesting starts fresh", async () => {
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

    // The request expires the moment its connection dies. It cannot be
    // left for the late onLeave: a fresh rejoin would have deleted the
    // old identity (onAuth), so that leave bails before the purge.
    assert.ok(
      !room.state.pendingPlayerRequests.has("user-b"),
      "a departed requester's pending entry must expire",
    );
    assert.ok(
      cancelled.some((m) => m.userId === "user-b"),
      "everyone was told the request is gone",
    );

    // Coming back on a fresh connection re-queues a NEW request — a
    // live entry tied to the new session, never the recycled ghost.
    const bobAgain = await colyseus.connectTo(room, {
      token: await mintToken("user-b", "Bob"),
    });
    await tick();
    const request = room.state.pendingPlayerRequests.get("user-b");
    assert.ok(request, "re-request after expiry starts fresh");
    void bobAgain;
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
