import assert from "assert";
import { getTestServer, type TestServer } from "./test-server.js";
import { JWT } from "@colyseus/auth";

import type { CheckersRoom } from "../src/games/checkers/checkers-room.js";
import { decodeBoard } from "../src/games/checkers/checkers-state.js";
import {
  countPieces,
  legalMoves,
  squareIndex,
} from "../src/games/checkers/engine/index.js";
import type { Color, GameState } from "../src/games/checkers/engine/index.js";

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

/** The engine view of whatever the room currently holds. */
function engineState(room: CheckersRoom): GameState {
  return {
    board: decodeBoard(room.state.board),
    turn: room.state.turnColor as Color,
    idlePlies: room.state.idlePlies,
    outcome: { kind: "playing" },
  };
}

describe("CheckersRoom", () => {
  let colyseus: TestServer;

  before(async () => (colyseus = await getTestServer()));
  beforeEach(async () => {
    await colyseus.cleanup();
  });

  async function seatTwo() {
    const room = (await colyseus.createRoom("checkers", {
      targetPlayers: 2,
    })) as CheckersRoom;
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

  it("rejects unauthenticated joins", async () => {
    const room = await colyseus.createRoom("checkers", { targetPlayers: 2 });
    await assert.rejects(
      () => colyseus.connectTo(room, {} as { token?: string }),
      (error: { name?: string }) => error?.name === "MatchMakeError",
    );
  });

  it("runs waiting → ready → playing and lets only the host start", async () => {
    const { room, clientA, clientB } = await seatTwo();

    assert.strictEqual(room.state.phase, "ready");
    assert.strictEqual(room.state.hostUserId, "user-a");

    // Non-host start is ignored.
    clientB.send("startGame", {});
    await tick();
    assert.strictEqual(room.state.phase, "ready");

    clientA.send("startGame", {});
    await tick();
    assert.strictEqual(room.state.phase, "playing");
  });

  it("assigns colors by seat and deals the opening position", async () => {
    const { room, clientA } = await seatTwo();
    clientA.send("startGame", {});
    await tick();

    assert.strictEqual(room.state.players.get("user-a")?.color, "white");
    assert.strictEqual(room.state.players.get("user-b")?.color, "black");

    const board = decodeBoard(room.state.board);
    assert.strictEqual(countPieces(board, "white"), 12);
    assert.strictEqual(countPieces(board, "black"), 12);

    // White opens.
    assert.strictEqual(room.state.turnColor, "white");
    assert.strictEqual(room.state.currentTurn, "user-a");
  });

  it("applies a legal move and passes the turn", async () => {
    const { room, clientA } = await seatTwo();
    clientA.send("startGame", {});
    await tick();

    const before = room.state.board;
    const [move] = legalMoves(engineState(room));

    clientA.send("move", { from: move.from, to: move.to, path: [...move.path] });
    await tick();

    assert.notStrictEqual(room.state.board, before, "the board must change");
    assert.strictEqual(room.state.turnColor, "black");
    assert.strictEqual(room.state.currentTurn, "user-b");

    const board = decodeBoard(room.state.board);
    assert.strictEqual(board[move.from], null);
    assert.strictEqual(board[move.to]?.color, "white");
  });

  it("ignores a move sent during the opponent's turn", async () => {
    const { room, clientA, clientB } = await seatTwo();
    clientA.send("startGame", {});
    await tick();

    const before = room.state.board;
    const [whiteMove] = legalMoves(engineState(room));

    // It is White's turn; Black tries to play anyway.
    clientB.send("move", {
      from: whiteMove.from,
      to: whiteMove.to,
      path: [...whiteMove.path],
    });
    await tick();

    assert.strictEqual(room.state.board, before, "the board must be untouched");
    assert.strictEqual(room.state.currentTurn, "user-a");
  });

  it("ignores an illegal move", async () => {
    const { room, clientA } = await seatTwo();
    clientA.send("startGame", {});
    await tick();

    const before = room.state.board;

    // A white man sitting on row 5 cannot reach row 2 in one step.
    clientA.send("move", {
      from: squareIndex(5, 0),
      to: squareIndex(2, 3),
      path: [squareIndex(2, 3)],
    });
    await tick();
    assert.strictEqual(room.state.board, before);

    // Moving an empty square is a no-op too.
    clientA.send("move", { from: squareIndex(4, 1), to: squareIndex(3, 2) });
    await tick();
    assert.strictEqual(room.state.board, before);
    assert.strictEqual(room.state.currentTurn, "user-a");
  });

  it("ignores junk payloads without corrupting the state", async () => {
    const { room, clientA } = await seatTwo();
    clientA.send("startGame", {});
    await tick();

    const before = room.state.board;
    const turnBefore = room.state.currentTurn;

    clientA.send("move", {});
    clientA.send("move", { from: "nope", to: {} } as never);
    clientA.send("move", { from: -5, to: 9999 });
    clientA.send("move", { from: 0, to: 1, path: ["x"] } as never);
    await tick();

    assert.strictEqual(room.state.board, before);
    assert.strictEqual(room.state.currentTurn, turnBefore);
    assert.strictEqual(room.state.outcome, "playing");
  });

  it("never lets a client write the board directly", async () => {
    const { room, clientA } = await seatTwo();
    clientA.send("startGame", {});
    await tick();

    const before = room.state.board;

    // A forged board in the payload must be ignored entirely.
    clientA.send("move", {
      from: squareIndex(5, 0),
      to: squareIndex(4, 1),
      board: ".".repeat(64),
      outcome: "win",
      winnerUserId: "user-a",
    } as never);
    await tick();

    assert.notStrictEqual(room.state.board, ".".repeat(64));
    assert.strictEqual(room.state.outcome, "playing");
    assert.strictEqual(room.state.winnerUserId, "");
    // The legal part of the payload was still applied.
    assert.notStrictEqual(room.state.board, before);
  });

  it("plays a full alternating sequence", async () => {
    const { room, clientA, clientB } = await seatTwo();
    clientA.send("startGame", {});
    await tick();

    for (let ply = 0; ply < 6; ply++) {
      const mover = room.state.turnColor === "white" ? clientA : clientB;
      const expected = room.state.turnColor === "white" ? "user-a" : "user-b";
      assert.strictEqual(room.state.currentTurn, expected);

      const moves = legalMoves(engineState(room));
      assert.ok(moves.length > 0, `no legal move at ply ${ply}`);

      const move = moves[0];
      mover.send("move", {
        from: move.from,
        to: move.to,
        path: [...move.path],
      });
      await tick();
    }

    assert.strictEqual(room.state.outcome, "playing");
    assert.strictEqual(room.state.phase, "playing");
  });

  it("awards the match to the opponent when a player leaves mid-game", async () => {
    const { room, clientA, clientB } = await seatTwo();
    clientA.send("startGame", {});
    await tick();

    clientB.send("leave", {});
    await tick();

    assert.strictEqual(room.state.outcome, "win");
    assert.strictEqual(room.state.outcomeReason, "forfeit");
    assert.strictEqual(room.state.winnerUserId, "user-a");
    assert.strictEqual(room.state.phase, "finished");
  });

  it("refuses further moves once the match is over", async () => {
    const { room, clientA, clientB } = await seatTwo();
    clientA.send("startGame", {});
    await tick();

    clientB.send("leave", {});
    await tick();
    const finalBoard = room.state.board;

    const moves = legalMoves(engineState(room));
    if (moves.length > 0) {
      clientA.send("move", {
        from: moves[0].from,
        to: moves[0].to,
        path: [...moves[0].path],
      });
      await tick();
    }

    assert.strictEqual(room.state.board, finalBoard);
  });
});
