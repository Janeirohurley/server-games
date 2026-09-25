import assert from "assert";
import { getTestServer, type TestServer } from "./test-server.js";

import { MyRoomState } from "../src/rooms/schema/MyRoomState.js";

describe("testing your Colyseus app", () => {
  let colyseus: TestServer;

  before(async () => (colyseus = await getTestServer()));

  beforeEach(async () => {
    await colyseus.cleanup();
  });

  it("only lets the current player act", async () => {
    const room = await colyseus.createRoom<MyRoomState>("my_room", {});
    const client1 = await colyseus.connectTo(room);
    const client2 = await colyseus.connectTo(room);

    assert.strictEqual(room.state.currentTurn, client1.sessionId, "first joiner starts");

    // out of turn: ignored
    client2.send("play", {});
    await room.waitForMessage("play");
    assert.strictEqual(room.state.players.get(client2.sessionId).score, 0);
    assert.strictEqual(room.state.currentTurn, client1.sessionId);

    // in turn: counted, and the turn passes on
    client1.send("play", {});
    await room.waitForMessage("play");
    assert.strictEqual(room.state.players.get(client1.sessionId).score, 1);
    assert.strictEqual(room.state.currentTurn, client2.sessionId);
  });
});
