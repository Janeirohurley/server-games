import assert from "node:assert/strict";
import { JWT } from "@colyseus/auth";
import { roomSnapshotStore } from "../src/rooms/room-snapshot-store.js";
import { getTestServer, type TestServer } from "./test-server.js";
import type { LudoRoom } from "../src/games/ludo/ludo-room.js";

const testDatabaseUrl = process.env.REALTIME_ROOM_TEST_DATABASE_URL;
const secret = "test-secret-for-the-realtime-suite-0123456789";
process.env.REALTIME_TOKEN_SECRET = secret;
JWT.settings.secret = secret;

async function mintToken(userId: string, name: string) {
  return JWT.sign({ sub: userId, name, iss: "game-platform" }, { expiresIn: "1h" });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 80));

describe("PostgreSQL lobby snapshot recovery", function () {
  if (!testDatabaseUrl) {
    it("requires REALTIME_ROOM_TEST_DATABASE_URL", function () {
      this.skip();
    });
    return;
  }

  let colyseus: TestServer;

  before(async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.REALTIME_ROOM_PERSISTENCE = "1";
    colyseus = await getTestServer();
  });

  after(() => {
    // Persistence is opt-in per process, but this suite turns it on while
    // the shared test server keeps running. Leaving it on would make every
    // later spec (tetris, ludo, …) write snapshots into the dev database.
    delete process.env.REALTIME_ROOM_PERSISTENCE;
    delete process.env.DATABASE_URL;
  });

  it("restores a pending request from PostgreSQL after the room is destroyed", async () => {
    const room = (await colyseus.createRoom("ludo", {
      targetPlayers: 2,
    })) as LudoRoom;
    const host = await colyseus.connectTo(room, {
      token: await mintToken("snapshot-host", "Host"),
    });
    const requester = await colyseus.connectTo(room, {
      token: await mintToken("snapshot-requester", "Requester"),
      mode: "watch",
    });
    const requestId = `snapshot-recovery-${crypto.randomUUID()}`;
    const registration = new Promise<{ requestId: string }>((resolve) => {
      requester.onMessage("joinRequestRegistered", resolve);
    });

    requester.send("requestJoinAsPlayer", { requestId });
    assert.strictEqual((await registration).requestId, requestId);

    const saved = (await roomSnapshotStore.loadAll()).find(
      (snapshot) => snapshot.roomId === room.roomId,
    );
    assert.ok(saved);
    const pending = saved.state.pendingPlayerRequests as
      | Record<string, { requestId?: string }>
      | undefined;
    assert.strictEqual(pending?.["snapshot-requester"]?.requestId, requestId);

    await host.leave();
    await requester.leave();
    await colyseus.cleanup();

    try {
      await roomSnapshotStore.restoreRooms();
      const restoredRoom = colyseus.getRoomById<LudoRoom>(room.roomId);
      const reconnectingRequester = await colyseus.connectTo(restoredRoom, {
        token: await mintToken("snapshot-requester", "Requester"),
      });
      await tick();

      assert.strictEqual(
        restoredRoom.state.pendingPlayerRequests.get("snapshot-requester")?.requestId,
        requestId,
      );
      await reconnectingRequester.leave();
    } finally {
      await colyseus.cleanup();
      await roomSnapshotStore.remove(room.roomId);
    }
  });

  it("purges empty and stale snapshots before restoring rooms", async () => {
    const emptyId = `snapshot-empty-${crypto.randomUUID()}`;
    const staleId = `snapshot-stale-${crypto.randomUUID()}`;
    const liveId = `snapshot-live-${crypto.randomUUID()}`;
    const stalePendingId = `snapshot-stale-pending-${crypto.randomUUID()}`;
    const freshPendingId = `snapshot-fresh-pending-${crypto.randomUUID()}`;
    const base = {
      roomName: "ludo",
      options: { targetPlayers: 2 },
      savedAt: Date.now(),
    };

    try {
      await roomSnapshotStore.save({
        ...base,
        roomId: emptyId,
        state: { phase: "waiting", players: {}, spectators: {} },
      });
      await roomSnapshotStore.save({
        ...base,
        roomId: staleId,
        savedAt: Date.now() - 25 * 60 * 60 * 1_000,
        state: {
          phase: "waiting",
          players: { "stale-user": { userId: "stale-user", seat: 0 } },
          spectators: {},
        },
      });
      await roomSnapshotStore.save({
        ...base,
        roomId: liveId,
        state: {
          phase: "waiting",
          players: { "live-user": { userId: "live-user", seat: 0 } },
          spectators: {},
        },
      });

      // A lobby kept alive only by a pending request older than the join
      // TTL is dead: the requester is gone and restoring it would re-save
      // a ghost forever. A fresh request must survive so its invite link
      // keeps working.
      await roomSnapshotStore.save({
        ...base,
        roomId: stalePendingId,
        state: {
          phase: "waiting",
          players: {},
          spectators: {},
          pendingPlayerRequests: {
            "stale-requester": {
              requestId: "stale-request",
              userId: "stale-requester",
              name: "Stale",
              requestedAt: Date.now() - 11 * 60 * 1_000,
            },
          },
        },
      });
      await roomSnapshotStore.save({
        ...base,
        roomId: freshPendingId,
        state: {
          phase: "waiting",
          players: {},
          spectators: {},
          pendingPlayerRequests: {
            "fresh-requester": {
              requestId: "fresh-request",
              userId: "fresh-requester",
              name: "Fresh",
              requestedAt: Date.now() - 1 * 60 * 1_000,
            },
          },
        },
      });

      const loaded = await roomSnapshotStore.loadAll();
      assert.ok(
        !loaded.some((snapshot) => snapshot.roomId === emptyId),
        "a lobby with no seated player is not restored",
      );
      assert.ok(
        !loaded.some((snapshot) => snapshot.roomId === staleId),
        "a snapshot older than the TTL is not restored",
      );
      assert.ok(
        loaded.some((snapshot) => snapshot.roomId === liveId),
        "a fresh lobby with a seated player is still restored",
      );
      assert.ok(
        !loaded.some((snapshot) => snapshot.roomId === stalePendingId),
        "a lobby kept alive only by an expired join request is not restored",
      );
      assert.ok(
        loaded.some((snapshot) => snapshot.roomId === freshPendingId),
        "a lobby with a fresh join request is still restored",
      );
    } finally {
      await roomSnapshotStore.remove(emptyId);
      await roomSnapshotStore.remove(staleId);
      await roomSnapshotStore.remove(liveId);
      await roomSnapshotStore.remove(stalePendingId);
      await roomSnapshotStore.remove(freshPendingId);
    }
  });
});
