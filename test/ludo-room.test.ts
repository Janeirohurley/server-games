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

/** Collects every broadcast of a message type (no 3s waitForMessage cap). */
function collect<T>(
  client: { onMessage: (type: string, handler: (payload: T) => void) => void },
  type: string,
): T[] {
  const received: T[] = [];
  client.onMessage(type, (payload) => received.push(payload));
  return received;
}

/**
 * Waits until the room really flips to the expected phase. The Ludo start
 * countdown takes 3 s; waiting on the message directly is too borderline
 * for the SDK's message subscription, so poll the room state instead.
 */
async function awaitPhase(
  room: { state: { phase: string } },
  expected: string,
  tries = 90,
): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (room.state.phase === expected) return;
    await tick();
  }
  throw new Error(`room never reached phase "expected": ${expected}`);
}

/** Starts as the admin and waits for the 3 s countdown to actually elapse. */
async function startMatch(
  admin: { send: (type: string, message?: unknown) => unknown },
  room: { state: { phase: string } },
): Promise<void> {
  admin.send("startGame", {});
  await awaitPhase(room, "playing");
}

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

    // Host starts: the 3 s countdown elapses, then the match is live.
    await startMatch(clientA, room);
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

    await startMatch(clientA, room);

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

  it("broadcasts a 3s countdown before the match actually starts", async () => {
    const room = (await colyseus.createRoom("ludo", {
      targetPlayers: 2,
    })) as LudoRoom;
    const clientA = await colyseus.connectTo(room, {
      token: await mintToken("user-a", "Alice"),
    });
    const clientB = await colyseus.connectTo(room, {
      token: await mintToken("user-b", "Bob"),
    });
    clientA.send("approveJoin", { userId: "user-b" });
    await tick();

    const countdowns = collect<{ seconds?: number }>(clientA, "countdown");
    clientA.send("startGame", {});

    // The countdown is broadcast to the whole table while the room is
    // still "ready" — the match has NOT started yet.
    await tick();
    assert.deepStrictEqual(countdowns, [{ seconds: 3 }]);
    assert.strictEqual(room.state.phase, "ready");

    // Only once the 3 s has elapsed does the match actually start.
    await awaitPhase(room, "playing");
    assert.strictEqual(room.state.currentTurn, "user-a");
  });

  it("ignores a second start request while the countdown is running", async () => {
    const room = (await colyseus.createRoom("ludo", {
      targetPlayers: 2,
    })) as LudoRoom;
    const clientA = await colyseus.connectTo(room, {
      token: await mintToken("user-a", "Alice"),
    });
    const clientB = await colyseus.connectTo(room, {
      token: await mintToken("user-b", "Bob"),
    });
    clientA.send("approveJoin", { userId: "user-b" });
    await tick();

    const countdowns = collect<{ seconds?: number }>(clientA, "countdown");
    clientA.send("startGame", {});
    clientA.send("startGame", {});
    await awaitPhase(room, "playing");

    // One countdown, one start — the second request is swallowed.
    assert.deepStrictEqual(countdowns, [{ seconds: 3 }]);
    assert.strictEqual(room.state.phase, "playing");
  });

  it("host-edited lobby settings: table size + turn budget, host-only and pre-start", async () => {
    const room = (await colyseus.createRoom("ludo", {
      targetPlayers: 2,
    })) as LudoRoom;
    const host = await colyseus.connectTo(room, {
      token: await mintToken("user-a", "Alice"),
    });
    const guest = await colyseus.connectTo(room, {
      token: await mintToken("user-b", "Bob"),
    });
    host.send("approveJoin", { userId: "user-b" });
    await tick();
    assert.strictEqual(room.state.phase, "ready");
    assert.strictEqual(room.state.turnDurationMs, 30_000); // default

    // A regular player cannot change any setting.
    guest.send("updateLobbySettings", { targetPlayers: 3 });
    await tick();
    assert.strictEqual(room.state.targetPlayers, 2);

    // Shrinking the table below the seated players is refused.
    host.send("updateLobbySettings", { targetPlayers: 1 });
    await tick();
    assert.strictEqual(room.state.targetPlayers, 2);

    // Enlarging flips READY → WAITING: the table is no longer full.
    host.send("updateLobbySettings", { targetPlayers: 4 });
    await tick();
    assert.strictEqual(room.state.targetPlayers, 4);
    assert.strictEqual(room.state.phase, "waiting");

    // Budget comes from the allowed options only.
    host.send("updateLobbySettings", { turnDurationMs: 60_000 });
    await tick();
    assert.strictEqual(room.state.turnDurationMs, 60_000);
    host.send("updateLobbySettings", { turnDurationMs: 45_000 }); // unknown
    await tick();
    assert.strictEqual(room.state.turnDurationMs, 60_000);

    // Unlimited: budget 0 is a valid option.
    host.send("updateLobbySettings", { turnDurationMs: 0 });
    await tick();
    assert.strictEqual(room.state.turnDurationMs, 0);

    // Back to a full 2-player table.
    host.send("updateLobbySettings", { targetPlayers: 2 });
    await tick();
    assert.strictEqual(room.state.phase, "ready");

    await startMatch(host, room);
    assert.strictEqual(room.state.phase, "playing");
    // An infinite budget arms no deadline from the very first turn.
    assert.strictEqual(room.state.turnDeadline, 0);

    // Settings freeze once the match runs.
    host.send("updateLobbySettings", { turnDurationMs: 90_000 });
    await tick();
    assert.strictEqual(room.state.turnDurationMs, 0);
  });

  it("arms a turn deadline when a finite budget is configured", async () => {
    const room = (await colyseus.createRoom("ludo", {
      targetPlayers: 2,
    })) as LudoRoom;
    const host = await colyseus.connectTo(room, {
      token: await mintToken("user-a", "Alice"),
    });
    await colyseus.connectTo(room, {
      token: await mintToken("user-b", "Bob"),
    });
    host.send("approveJoin", { userId: "user-b" });
    host.send("updateLobbySettings", { turnDurationMs: 60_000 });
    await tick();

    await startMatch(host, room);
    assert.ok(
      room.state.turnDeadline > 0,
      "a finite budget exposes the turn deadline",
    );
    assert.ok(
      room.state.turnDeadline > room.state.startedAt,
      "the deadline lies in the future of the match start",
    );
  });
});
