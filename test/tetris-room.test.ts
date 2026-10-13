import assert from "assert";
import { JWT } from "@colyseus/auth";

import { getTestServer, type TestServer } from "./test-server.js";
import type { TetrisRoom } from "../src/games/tetris/tetris-room.js";

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

describe("TetrisRoom", () => {
  let colyseus: TestServer;

  before(async () => (colyseus = await getTestServer()));
  beforeEach(async () => {
    await colyseus.cleanup();
  });

  /** Table de `seats` places, alice (créatrice) et bob assis. */
  async function seatTwo(seats = 3) {
    const room = (await colyseus.createRoom("tetris", {
      targetPlayers: seats,
    })) as TetrisRoom;
    // Le test n'a pas à attendre le vrai compte à rebours de 3 secondes.
    room.startCountdownMs = 50;

    const alice = await colyseus.connectTo(room, {
      token: await mintToken("user-a", "Alice"),
    });
    const bob = await colyseus.connectTo(room, {
      token: await mintToken("user-b", "Bob"),
    });

    // Tout siège au-delà du créateur demande l'approbation de l'admin.
    alice.send("approveJoin", { userId: "user-b" });
    await tick();

    return { room, alice, bob };
  }

  async function startMatch(
    room: TetrisRoom,
    alice: { send: (type: string, message?: unknown) => void },
  ) {
    alice.send("startGame", {});
    await wait(room.startCountdownMs + 150);
  }

  it("rejects unauthenticated joins", async () => {
    const room = await colyseus.createRoom("tetris", { targetPlayers: 2 });
    await assert.rejects(
      () => colyseus.connectTo(room, {} as { token?: string }),
      (error: { name?: string }) => error?.name === "MatchMakeError",
    );
  });

  it("refuses to start alone", async () => {
    const room = (await colyseus.createRoom("tetris", {
      targetPlayers: 4,
    })) as TetrisRoom;
    room.startCountdownMs = 50;
    const alice = await colyseus.connectTo(room, {
      token: await mintToken("user-a", "Alice"),
    });

    await startMatch(room, alice);

    assert.notStrictEqual(room.state.phase, "playing");
  });

  it("starts part-full: the admin decides, no need to fill every seat", async () => {
    // 3 places ouvertes, 2 joueurs assis : le départ reste possible.
    const { room, alice } = await seatTwo(3);

    await startMatch(room, alice);

    assert.strictEqual(room.state.phase, "playing");
    assert.strictEqual(room.state.playersAlive, 2);
    assert.strictEqual(room.state.players.get("user-a")?.status, "playing");
    assert.strictEqual(room.state.players.get("user-b")?.status, "playing");
  });

  it("gives every player the same pieces on their own empty board", async () => {
    const { room, alice } = await seatTwo();
    await startMatch(room, alice);

    const a = room.state.players.get("user-a");
    const b = room.state.players.get("user-b");
    assert.ok(a && b);
    assert.strictEqual(a.board, "0".repeat(200));
    assert.strictEqual(a.pieceType, b.pieceType);
    assert.strictEqual(a.next, b.next);
    assert.notStrictEqual(a.pieceType, "");
  });

  it("applies an input to the sender's piece only", async () => {
    const { room, alice } = await seatTwo();
    await startMatch(room, alice);
    const bobX = room.state.players.get("user-b")!.pieceX;
    const aliceX = room.state.players.get("user-a")!.pieceX;

    alice.send("input", { input: "left" });
    await tick();

    assert.strictEqual(room.state.players.get("user-a")!.pieceX, aliceX - 1);
    assert.strictEqual(room.state.players.get("user-b")!.pieceX, bobX);
  });

  it("never lets a client force gravity or send junk", async () => {
    const { room, alice } = await seatTwo();
    await startMatch(room, alice);
    const y = room.state.players.get("user-a")!.pieceY;

    alice.send("input", { input: "tick" });
    alice.send("input", { input: 42 } as never);
    alice.send("input", {} as never);
    await tick();

    assert.strictEqual(room.state.players.get("user-a")!.pieceY, y);
    assert.strictEqual(room.state.phase, "playing");
  });

  it("drops the pieces by itself, at the speed of the level", async () => {
    const { room, alice } = await seatTwo();
    await startMatch(room, alice);
    const y = room.state.players.get("user-a")!.pieceY;

    // Niveau 1 : une case toutes les 800 ms.
    await wait(1_000);

    assert.ok(
      room.state.players.get("user-a")!.pieceY > y,
      "la gravité du serveur doit avoir fait tomber la pièce",
    );
  });

  it("makes the last player standing the winner", async () => {
    const { room, alice, bob } = await seatTwo();
    await startMatch(room, alice);

    // Bob largue sans arrêt : sa pile finit par atteindre le haut.
    for (let i = 0; i < 30 && room.state.phase === "playing"; i++) {
      bob.send("input", { input: "hardDrop" });
      await wait(40);
    }
    await tick();

    assert.strictEqual(room.state.phase, "finished");
    assert.strictEqual(room.state.winnerUserId, "user-a");
    assert.strictEqual(room.state.players.get("user-b")?.status, "over");
    assert.strictEqual(room.state.players.get("user-b")?.place, 2);
    assert.strictEqual(room.state.players.get("user-a")?.place, 1);
  });

  it("gives the win to the other player when someone leaves mid-match", async () => {
    const { room, alice, bob } = await seatTwo();
    await startMatch(room, alice);

    await bob.leave();
    await wait(200);

    assert.strictEqual(room.state.phase, "finished");
    assert.strictEqual(room.state.winnerUserId, "user-a");
  });

  it("stops the gravity when the room is disposed", async () => {
    const { room, alice } = await seatTwo();
    await startMatch(room, alice);

    await room.disconnect();
    await tick();
    const frozen = room.state.players.get("user-a")?.pieceY;
    await wait(900);

    assert.strictEqual(
      room.state.players.get("user-a")?.pieceY,
      frozen,
      "plus aucune chute après la fermeture de la room",
    );
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
