import assert from "assert";
import { JWT } from "@colyseus/auth";

import { getTestServer, type TestServer } from "./test-server.js";
import type { RallyRoom } from "../src/games/rally/rally-room.js";

process.env.REALTIME_TOKEN_SECRET =
  "test-secret-for-the-realtime-suite-0123456789";

const SECRET = process.env.REALTIME_TOKEN_SECRET;
const ISSUER = "game-platform";

async function mintToken(userId: string, name: string): Promise<string> {
  JWT.settings.secret = SECRET;
  return JWT.sign({ sub: userId, name, iss: ISSUER }, { expiresIn: "1h" });
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const tick = () => wait(60);

describe("RallyRoom", () => {
  let colyseus: TestServer;

  before(async () => (colyseus = await getTestServer()));
  beforeEach(async () => {
    await colyseus.cleanup();
  });

  async function seatTwo() {
    const room = (await colyseus.createRoom("rally", {
      targetPlayers: 2,
    })) as RallyRoom;
    const alice = await colyseus.connectTo(room, {
      token: await mintToken("user-a", "Alice"),
    });
    const bob = await colyseus.connectTo(room, {
      token: await mintToken("user-b", "Bob"),
    });
    return { room, alice, bob };
  }

  it("rejects unauthenticated joins", async () => {
    const room = await colyseus.createRoom("rally", { targetPlayers: 2 });
    await assert.rejects(
      () => colyseus.connectTo(room, {} as { token?: string }),
      (error: { name?: string }) => error?.name === "MatchMakeError",
    );
  });

  it("assigns one side per seat and opens on the near side's serve", async () => {
    const { room, alice } = await seatTwo();
    alice.send("startGame", {});
    await tick();

    assert.strictEqual(room.state.phase, "playing");
    assert.strictEqual(room.state.players.get("user-a")?.side, 0);
    assert.strictEqual(room.state.players.get("user-b")?.side, 1);
    assert.strictEqual(room.state.matchState, "ready");
    assert.strictEqual(room.state.server, 0);
  });

  it("moves only the paddle of the sender's own side", async () => {
    const { room, alice, bob } = await seatTwo();
    alice.send("startGame", {});
    await tick();

    alice.send("input", { target: 2, power: false });
    bob.send("input", { target: -2, power: false });
    await wait(250);

    assert.ok(room.state.nearX > 0.3, `near paddle moved right, got ${room.state.nearX}`);
    assert.ok(room.state.farX < -0.3, `far paddle moved left, got ${room.state.farX}`);
  });

  it("clamps an absurd target instead of trusting it", async () => {
    const { room, alice } = await seatTwo();
    alice.send("startGame", {});
    await tick();

    alice.send("input", { target: 99999 });
    await wait(400);
    assert.ok(
      room.state.nearX <= 2.76,
      `paddle must stay on the table, got ${room.state.nearX}`,
    );
  });

  it("ignores junk input without disturbing the match", async () => {
    const { room, alice } = await seatTwo();
    alice.send("startGame", {});
    await tick();
    const before = room.state.matchState;

    alice.send("input", {});
    alice.send("input", { target: "left" } as never);
    alice.send("input", { target: Number.NaN });
    alice.send("input", { power: "yes" } as never);
    await tick();

    assert.strictEqual(room.state.matchState, before);
    assert.ok(Number.isFinite(room.state.nearX));
  });

  it("runs the simulation and rallies the ball", async () => {
    const { room, alice, bob } = await seatTwo();
    alice.send("startGame", {});
    await tick();

    // The far side must not be able to serve when it is not their turn.
    bob.send("serve", {});
    await tick();
    assert.strictEqual(room.state.matchState, "ready", "far side cannot serve");

    alice.send("serve", {});
    await wait(300);
    assert.strictEqual(room.state.matchState, "playing");

    const z = room.state.ballZ;
    await wait(250);
    assert.notStrictEqual(room.state.ballZ, z, "the ball must be moving");
  });

  it("keeps two rooms independent", async () => {
    const a = (await colyseus.createRoom("rally", { targetPlayers: 2 })) as RallyRoom;
    const b = (await colyseus.createRoom("rally", { targetPlayers: 2 })) as RallyRoom;

    const alice = await colyseus.connectTo(a, { token: await mintToken("user-a", "Alice") });
    await colyseus.connectTo(a, { token: await mintToken("user-b", "Bob") });
    await colyseus.connectTo(b, { token: await mintToken("user-c", "Carol") });
    await colyseus.connectTo(b, { token: await mintToken("user-d", "Dan") });

    alice.send("startGame", {});
    await tick();
    alice.send("input", { target: 2.5 });
    await wait(250);

    assert.ok(a.state.nearX > 0.3);
    assert.strictEqual(b.state.nearX, 0, "the other room is untouched");
    assert.strictEqual(b.state.phase, "ready");
  });

  it("stops the simulation when the room is disposed", async () => {
    const { room, alice } = await seatTwo();
    alice.send("startGame", {});
    await tick();
    alice.send("serve", {});
    await wait(200);

    await room.disconnect();
    await tick();
    const frozen = room.state.ballZ;
    await wait(200);
    assert.strictEqual(room.state.ballZ, frozen, "no stepping after disposal");
  });

  it("carries the room chat like every other game", async () => {
    const { alice, bob } = await seatTwo();
    const received: { content: string }[] = [];
    bob.onMessage("chatMessage", (m: { content: string }) => received.push(m));

    alice.send("chatMessage", { content: "bonne partie" });
    await tick();

    assert.strictEqual(received.length, 1);
    assert.strictEqual(received[0].content, "bonne partie");
  });
});
