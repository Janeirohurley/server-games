import assert from "assert";
import { getTestServer, type TestServer } from "./test-server.js";
import { JWT } from "@colyseus/auth";

import type { ChessRoom } from "../src/games/chess/chess-room.js";

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

describe("ChessRoom", () => {
  let colyseus: TestServer;

  before(async () => (colyseus = await getTestServer()));
  beforeEach(async () => {
    await colyseus.cleanup();
  });

  async function seatTwo() {
    const room = (await colyseus.createRoom("chess", {
      targetPlayers: 2,
    })) as ChessRoom;
    const clientA = await colyseus.connectTo(room, {
      token: await mintToken("user-a", "Alice"),
    });
    const clientB = await colyseus.connectTo(room, {
      token: await mintToken("user-b", "Bob"),
    });

    // Every seat beyond the creator's requires admin approval.
    clientA.send("approveJoin", { userId: "user-b" });
    await tick();

    return { room, clientA, clientB };
  }

  async function started() {
    const seated = await seatTwo();
    seated.clientA.send("startGame", {});
    await tick();
    return seated;
  }

  it("rejects unauthenticated joins", async () => {
    const room = await colyseus.createRoom("chess", { targetPlayers: 2 });
    await assert.rejects(
      () => colyseus.connectTo(room, {} as { token?: string }),
      (error: { name?: string }) => error?.name === "MatchMakeError",
    );
  });

  it("runs waiting → ready → playing and lets only the host start", async () => {
    const { room, clientA, clientB } = await seatTwo();

    assert.strictEqual(room.state.phase, "ready");
    assert.strictEqual(room.state.hostUserId, "user-a");

    clientB.send("startGame", {});
    await tick();
    assert.strictEqual(room.state.phase, "ready");

    clientA.send("startGame", {});
    await tick();
    assert.strictEqual(room.state.phase, "playing");
  });

  it("assigns colours by seat and deals the opening position", async () => {
    const { room } = await started();

    assert.strictEqual(room.state.players.get("user-a")?.color, "w");
    assert.strictEqual(room.state.players.get("user-b")?.color, "b");

    assert.match(room.state.fen, /^rnbqkbnr\/pppppppp\/8\/8\/8\/8\/PPPPPPPP\/RNBQKBNR w/);
    assert.strictEqual(room.state.turnColor, "w");
    assert.strictEqual(room.state.currentTurn, "user-a");
    assert.strictEqual(room.state.history, "");
  });

  it("applies a legal move and passes the turn", async () => {
    const { room, clientA } = await started();

    clientA.send("move", { from: "e2", to: "e4" });
    await tick();

    assert.match(room.state.fen, /^rnbqkbnr\/pppppppp\/8\/8\/4P3\/8\/PPPP1PPP\/RNBQKBNR b/);
    assert.strictEqual(room.state.turnColor, "b");
    assert.strictEqual(room.state.currentTurn, "user-b");
    assert.strictEqual(room.state.lastFrom, "e2");
    assert.strictEqual(room.state.lastTo, "e4");
    assert.strictEqual(room.state.history, "e4");
  });

  it("ignores a move sent during the opponent's turn", async () => {
    const { room, clientB } = await started();
    const before = room.state.fen;

    clientB.send("move", { from: "e7", to: "e5" });
    await tick();

    assert.strictEqual(room.state.fen, before);
    assert.strictEqual(room.state.currentTurn, "user-a");
  });

  it("ignores an illegal move", async () => {
    const { room, clientA } = await started();
    const before = room.state.fen;

    clientA.send("move", { from: "e2", to: "e5" });
    await tick();
    assert.strictEqual(room.state.fen, before);

    // Moving an empty square is a no-op too.
    clientA.send("move", { from: "d4", to: "d5" });
    await tick();
    assert.strictEqual(room.state.fen, before);
    assert.strictEqual(room.state.currentTurn, "user-a");
  });

  it("ignores junk payloads without corrupting the state", async () => {
    const { room, clientA } = await started();
    const before = room.state.fen;

    clientA.send("move", {});
    clientA.send("move", { from: "nope", to: {} } as never);
    clientA.send("move", { from: -5, to: 9999 });
    await tick();

    assert.strictEqual(room.state.fen, before);
    assert.strictEqual(room.state.outcome, "playing");
  });

  it("never lets a client write the position or the result", async () => {
    const { room, clientA } = await started();
    const before = room.state.fen;

    clientA.send("move", {
      from: "e2",
      to: "e4",
      fen: "8/8/8/8/8/8/8/8 w - - 0 1",
      outcome: "win",
      winnerUserId: "user-a",
    } as never);
    await tick();

    assert.notStrictEqual(room.state.fen, "8/8/8/8/8/8/8/8 w - - 0 1");
    assert.strictEqual(room.state.outcome, "playing");
    assert.strictEqual(room.state.winnerUserId, "");
    // The legal part of the payload was still applied.
    assert.notStrictEqual(room.state.fen, before);
  });

  it("detects Fool's mate and ends the match", async () => {
    const { room, clientA, clientB } = await started();

    clientA.send("move", { from: "f2", to: "f3" });
    await tick();
    clientB.send("move", { from: "e7", to: "e5" });
    await tick();
    clientA.send("move", { from: "g2", to: "g4" });
    await tick();
    clientB.send("move", { from: "d8", to: "h4" });
    await tick();

    assert.strictEqual(room.state.outcome, "win");
    assert.strictEqual(room.state.outcomeReason, "checkmate");
    assert.strictEqual(room.state.winnerUserId, "user-b");
    assert.strictEqual(room.state.phase, "finished");
    assert.strictEqual(room.state.currentTurn, "");
    assert.ok(room.state.history.endsWith("Qh4#"));
  });

  it("sanitizes the promotion field", async () => {
    const { room, clientA } = await started();

    // An unknown promotion piece is dropped instead of being forwarded to
    // the engine; the move itself is still validated and applied normally.
    clientA.send("move", { from: "e2", to: "e4", promotion: "z" } as never);
    await tick();

    assert.strictEqual(room.state.turnColor, "b");
    assert.strictEqual(room.state.currentTurn, "user-b");
    assert.strictEqual(room.state.history, "e4");
  });

  it("awards the match to the opponent when a player leaves mid-game", async () => {
    const { room, clientA, clientB } = await started();

    clientB.send("leave", {});
    await tick();

    assert.strictEqual(room.state.outcome, "win");
    assert.strictEqual(room.state.outcomeReason, "forfeit");
    assert.strictEqual(room.state.winnerUserId, "user-a");
    assert.strictEqual(room.state.phase, "finished");
  });

  it("refuses further moves once the match is over", async () => {
    const { room, clientA, clientB } = await started();

    clientB.send("leave", {});
    await tick();
    const finalFen = room.state.fen;

    clientA.send("move", { from: "e2", to: "e4" });
    await tick();

    assert.strictEqual(room.state.fen, finalFen);
  });
});
