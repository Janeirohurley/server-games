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
});
