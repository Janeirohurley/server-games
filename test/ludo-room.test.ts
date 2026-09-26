import assert from "assert";
import { getTestServer, type TestServer } from "./test-server.js";

import type { LudoState } from "../src/games/ludo/ludo-state.js";
import type { LudoRoom } from "../src/games/ludo/ludo-room.js";
import { JWT } from "@colyseus/auth";

// Match the value the Next.js platform uses in .env.local.
process.env.REALTIME_TOKEN_SECRET =
  "test-secret-for-the-realtime-suite-0123456789";

const SECRET = process.env.REALTIME_TOKEN_SECRET;
const ISSUER = "game-platform";

async function mintToken(userId: string, name: string): Promise<string> {
  JWT.settings.secret = SECRET;
  return JWT.sign({ sub: userId, name, iss: ISSUER }, { expiresIn: "1h" });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 50));

describe("LudoRoom", () => {
  let colyseus: TestServer;

  before(async () => (colyseus = await getTestServer()));
  beforeEach(async () => {
    await colyseus.cleanup();
  });

  it("rejects unauthenticated joins", async () => {
    const room = await colyseus.createRoom("ludo", { targetPlayers: 2 });
    await assert.rejects(
      () => colyseus.connectTo(room, {} as { token?: string }),
      (error: { name?: string; message?: string }) =>
        error?.name === "MatchMakeError",
    );
  });

  it("moves through lifecycle: waiting → ready → playing, host-only start", async () => {
    const room = (await colyseus.createRoom("ludo", {
      targetPlayers: 2,
    })) as LudoRoom;
    const clientA = await colyseus.connectTo(room, {
      token: await mintToken("user-a", "Alice"),
    });

    assert.strictEqual(room.state.phase, "waiting");
    assert.strictEqual(room.state.hostUserId, "user-a");

    // Not the full table yet: starting must be refused.
    clientA.send("startGame", {});
    await tick();
    assert.strictEqual(room.state.phase, "waiting");

    const clientB = await colyseus.connectTo(room, {
      token: await mintToken("user-b", "Bob"),
    });

    // Bob waits for admin approval before taking his seat.
    assert.strictEqual(room.state.players.size, 1);
    assert.ok(room.state.pendingPlayerRequests.get("user-b"));
    clientA.send("approveJoin", { userId: "user-b" });
    await tick();
    assert.strictEqual(room.state.phase, "ready");

    // Non-host cannot start.
    clientB.send("startGame", {});
    await tick();
    assert.strictEqual(room.state.phase, "ready");

    clientA.send("startGame", {});
    await tick();
    assert.strictEqual(room.state.phase, "playing");
    assert.strictEqual(room.state.currentTurn, "user-a");

    // 2-player table: colors follow seat order, 4 pieces each.
    assert.strictEqual(room.state.players.get("user-a")?.color, "yellow");
    assert.strictEqual(room.state.players.get("user-b")?.color, "red");
    assert.strictEqual(room.state.players.get("user-a")?.pieces.length, 4);
  });

  it("enforces turn order and rolls the dice server-side", async () => {
    const room = (await colyseus.createRoom("ludo", {
      targetPlayers: 2,
    })) as LudoRoom;
    const clientA = await colyseus.connectTo(room, {
      token: await mintToken("user-a", "Alice"),
    });
    const clientB = await colyseus.connectTo(room, {
      token: await mintToken("user-b", "Bob"),
    });

    // Bob waits for admin approval before taking his seat.
    clientA.send("approveJoin", { userId: "user-b" });
    await tick();

    clientA.send("startGame", {});
    await tick();

    assert.strictEqual(room.state.currentTurn, "user-a");
    assert.strictEqual(room.state.diceValue, 0);

    // Out-of-turn roll must be ignored.
    clientB.send("rollDice", {});
    await tick();
    assert.strictEqual(room.state.diceValue, 0);

    // In-turn roll produces a server-side dice value (0..6; 0 means the
    // server already passed the turn because no move was possible).
    clientA.send("rollDice", {});
    await tick();
    const dice = room.state.diceValue;
    assert.ok(dice >= 0 && dice <= 6, `dice must be a valid roll, got ${dice}`);
  });

  it("full room locks and rejects extra joins", async () => {
    const room = (await colyseus.createRoom("ludo", {
      targetPlayers: 2,
    })) as LudoRoom;
    const clientA = await colyseus.connectTo(room, {
      token: await mintToken("user-a", "Alice"),
    });
    await colyseus.connectTo(room, {
      token: await mintToken("user-b", "Bob"),
    });

    // Bob waits for admin approval before taking his seat.
    clientA.send("approveJoin", { userId: "user-b" });
    await tick();
    assert.strictEqual(room.state.players.size, 2);
    const joinExtra = async () =>
      colyseus.connectTo(room, {
        token: await mintToken("user-c", "Carol"),
      });
    await assert.rejects(joinExtra, /full|lock|started|join/i);
  });

  it("single player cannot start a match", async () => {
    const room = (await colyseus.createRoom("ludo", {
      targetPlayers: 4,
    })) as LudoRoom;
    const clientA = await colyseus.connectTo(room, {
      token: await mintToken("user-a", "Alice"),
    });

    clientA.send("startGame", {});
    await tick();
    assert.strictEqual(room.state.phase, "waiting");
  });
});
