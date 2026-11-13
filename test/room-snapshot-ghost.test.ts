import assert from "assert";
import { JWT } from "@colyseus/auth";

import {
  roomSnapshotStore,
  type PersistedRoomSnapshot,
} from "../src/rooms/room-snapshot-store.js";
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

const tick = () => new Promise((resolve) => setTimeout(resolve, 80));

/**
 * Ghost lobbies: a snapshot with no seated player can never be approved
 * or started. Older builds persisted them anyway, then restored them at
 * boot; the room never gets a live client, so it never auto-disposes and
 * it haunts the room list forever. Persisting must delete instead.
 */
describe("lobby snapshot ghosts", () => {
  let colyseus: TestServer;
  let originalSave: typeof roomSnapshotStore.save;
  let originalRemove: typeof roomSnapshotStore.remove;

  before(async () => (colyseus = await getTestServer()));
  beforeEach(async () => {
    await colyseus.cleanup();
    originalSave = roomSnapshotStore.save;
    originalRemove = roomSnapshotStore.remove;
  });
  afterEach(() => {
    roomSnapshotStore.save = originalSave;
    roomSnapshotStore.remove = originalRemove;
  });

  function spyStore() {
    const saves: PersistedRoomSnapshot[] = [];
    const removals: string[] = [];
    roomSnapshotStore.save = async (snapshot) => {
      saves.push(snapshot);
      return true;
    };
    roomSnapshotStore.remove = async (roomId) => {
      removals.push(roomId);
    };
    return { saves, removals };
  }

  it("deletes instead of persisting a room with no seated human", async () => {
    const { saves, removals } = spyStore();

    const room = (await colyseus.createRoom("ludo", {
      targetPlayers: 2,
    })) as LudoRoom;
    await tick();

    assert.strictEqual(
      saves.length,
      0,
      "an empty lobby must never reach durable storage",
    );
    assert.ok(
      removals.includes(room.roomId),
      "the stale snapshot of the empty lobby is dropped",
    );
  });

  it("persists the lobby as soon as a human is seated", async () => {
    const { saves } = spyStore();

    const room = (await colyseus.createRoom("ludo", {
      targetPlayers: 2,
    })) as LudoRoom;
    const alice = await colyseus.connectTo(room, {
      token: await mintToken("ghost-test-host", "Alice"),
    });
    await tick();

    assert.ok(
      saves.some((snapshot) => {
        const players = snapshot.state.players as Record<string, unknown>;
        return Boolean(players?.["ghost-test-host"]);
      }),
      "a lobby with a seated host is worth restoring after a restart",
    );
    void alice;
  });
});
