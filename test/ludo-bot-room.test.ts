import assert from "assert";
import { JWT } from "@colyseus/auth";

import { getTestServer, type TestServer } from "./test-server.js";
import type { LudoRoom } from "../src/games/ludo/ludo-room.js";

/*
 * End-to-end proof that a bot seated from the (stubbed) platform pool
 * actually plays: it rolls, then moves, through the very same room paths
 * a human uses. The platform endpoint is faked in-process so the room's
 * claim succeeds without a Next.js server; the game server itself is the
 * real one booted by test-server.ts.
 */

process.env.REALTIME_TOKEN_SECRET =
  "test-secret-for-the-realtime-suite-0123456789";
const SECRET = process.env.REALTIME_TOKEN_SECRET;
const ISSUER = "game-platform";

async function mintToken(userId: string, name: string): Promise<string> {
  JWT.settings.secret = SECRET;
  return JWT.sign({ sub: userId, name, iss: ISSUER }, { expiresIn: "1h" });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 50));

const BOT_USER_ID = "bot-user-1";
const BOT_PAYLOAD = {
  botId: "bot-1",
  userId: BOT_USER_ID,
  gameId: "ludo",
  displayName: "Brave Fox",
  gamerTag: "BraveFox",
  difficulty: "normal",
  status: "in_match",
};

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

interface StubOptions {
  /** Bots the pool hands back for a claim (default: one normal bot). */
  bots?: unknown[];
  /** Captures every match-result report the room sends. */
  reports?: Array<{ participants: Array<{ userId: string }> }>;
  /** When set, `resolve` returns an attached brain for exactly this id. */
  attachedBrainFor?: string;
  /** Captures every `resolve` request's user id, in order. */
  resolveCalls?: string[];
}

/** Serve the signed internal bot endpoint without a real platform. */
function installPlatformStub(options: StubOptions = {}): () => void {
  const { bots = [BOT_PAYLOAD], reports, attachedBrainFor, resolveCalls } = options;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;

    if (url.includes("/api/internal/bots")) {
      const body = JSON.parse(
        typeof init?.body === "string" ? init.body : "{}",
      ) as { action?: string; userId?: string };
      if (body.action === "claim") return jsonResponse({ bots });
      if (body.action === "release") {
        return jsonResponse({ released: bots.length });
      }
      if (body.action === "resolve") {
        resolveCalls?.push(body.userId ?? "");
        if (attachedBrainFor && body.userId === attachedBrainFor) {
          return jsonResponse({
            brain: {
              difficulty: "normal",
              config: { aggression: 0.5, caution: 0.5 },
            },
          });
        }
        return jsonResponse({ brain: null });
      }
      return jsonResponse({});
    }

    if (url.includes("/api/profile/match-results")) {
      reports?.push(JSON.parse(String(init?.body ?? "{}")));
      return jsonResponse({ ingested: 0 });
    }

    return original(input, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function collect<T>(
  client: { onMessage: (type: string, handler: (payload: T) => void) => void },
  type: string,
): T[] {
  const received: T[] = [];
  client.onMessage(type, (payload) => received.push(payload));
  return received;
}

async function waitFor(
  predicate: () => boolean,
  tries = 120,
): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return true;
    await tick();
  }
  return predicate();
}

describe("LudoRoom — bot play", () => {
  let colyseus: TestServer;

  before(async () => (colyseus = await getTestServer()));
  beforeEach(async () => {
    await colyseus.cleanup();
  });

  it("seats a pooled bot and lets it roll then move on its own turn", async () => {
    const restore = installPlatformStub();
    try {
      const room = (await colyseus.createRoom("ludo", {
        targetPlayers: 2,
        bots: 1,
      })) as LudoRoom;

      // The seat is claimed asynchronously; wait for the bot to appear.
      await waitFor(() => room.state.players.size === 1);
      const bot = room.state.players.get(BOT_USER_ID);
      assert.ok(bot, "the bot was seated");
      assert.strictEqual(bot.isBot, true);
      assert.strictEqual(bot.botDifficulty, "normal");
      assert.strictEqual(room.state.hostUserId, "", "a bot never becomes host");

      // The human creator joins; bots must not have blocked that.
      const alice = await colyseus.connectTo(room, {
        token: await mintToken("user-a", "Alice"),
      });
      assert.strictEqual(room.state.hostUserId, "user-a");
      assert.strictEqual(room.state.players.size, 2);

      const rolls = collect<{ userId: string }>(alice, "diceRolled");
      const moves = collect<{ userId: string }>(alice, "pieceMoved");

      // The two seats fill the table, so the host can start.
      alice.send("startGame", {});
      assert.ok(await waitFor(() => room.state.phase === "playing"));

      // Give the bot a piece on the board so any roll is playable (a piece
      // in base is stuck without a 6, and the idle human never hands the
      // turn back). onBeforeStart rebuilds player instances, so re-read the
      // seat from the live state.
      const activeBot = room.state.players.get(BOT_USER_ID);
      assert.ok(activeBot, "the bot is still seated after the start");
      activeBot.pieces[0].position = 20;

      assert.ok(
        await waitFor(() => rolls.some((r) => r.userId === BOT_USER_ID)),
        "the bot rolled the dice",
      );
      assert.ok(
        await waitFor(() => moves.some((m) => m.userId === BOT_USER_ID)),
        "the bot moved a piece",
      );
    } finally {
      restore();
    }
  });

  it("shrinks the target when the pool cannot supply the requested bots", async () => {
    // The host asks for a 4-seat table with 3 bots, but the pool only
    // grants one. The room must not strand: the target drops so the two
    // humans already present can still start.
    const restore = installPlatformStub({ bots: [BOT_PAYLOAD] });
    try {
      const room = (await colyseus.createRoom("ludo", {
        targetPlayers: 4,
        bots: 3,
      })) as LudoRoom;

      await waitFor(() => room.state.players.size === 1);
      assert.ok(
        await waitFor(() => room.state.targetPlayers === 2),
        `target should drop to the floor, was ${room.state.targetPlayers}`,
      );

      const alice = await colyseus.connectTo(room, {
        token: await mintToken("user-a", "Alice"),
      });
      assert.strictEqual(room.state.players.size, 2);

      alice.send("startGame", {});
      assert.ok(await waitFor(() => room.state.phase === "playing"));
    } finally {
      restore();
    }
  });

  it("reports bots like any account (ranked, real XP)", async () => {
    const reports: Array<{ participants: Array<{ userId: string }> }> = [];
    const restore = installPlatformStub({ reports });
    try {
      const room = (await colyseus.createRoom("ludo", {
        targetPlayers: 2,
        bots: 1,
      })) as LudoRoom;

      await waitFor(() => room.state.players.size === 1);
      await colyseus.connectTo(room, {
        token: await mintToken("user-a", "Alice"),
      });
      await waitFor(() => room.state.players.size === 2);

      // Reach the one reporting funnel directly (no need to play to a win).
      (room as unknown as { finishMatch: () => void }).finishMatch();

      assert.ok(await waitFor(() => reports.length === 1), "a report was sent");
      const ids = reports[0].participants.map((p) => p.userId).sort();
      assert.deepStrictEqual(
        ids,
        ["user-a", BOT_USER_ID].sort(),
        "the bot is reported as a participant",
      );
    } finally {
      restore();
    }
  });

  it("drives an ordinary account when a brain is attached to it", async () => {
    // A brain is a controller, not an identity. Here no bot is claimed from
    // the pool at all: the seat belongs to Alice, an ordinary account, and a
    // brain drives it. There is no `isBot` account anywhere in this match.
    const restore = installPlatformStub();
    try {
      const room = (await colyseus.createRoom("ludo", {
        targetPlayers: 2,
      })) as LudoRoom;

      const alice = await colyseus.connectTo(room, {
        token: await mintToken("user-a", "Alice"),
      });
      const bob = await colyseus.connectTo(room, {
        token: await mintToken("user-b", "Bob"),
      });

      // A second human must be approved into a seat by the host.
      bob.send("requestJoinAsPlayer", {});
      await waitFor(
        () => room.state.pendingPlayerRequests.size === 1,
      );
      alice.send("approveJoin", { userId: "user-b" });
      assert.ok(
        await waitFor(() => room.state.players.size === 2),
        "Bob was seated",
      );

      assert.strictEqual(
        room.state.players.get("user-a")?.isBot,
        false,
        "the brain-controlled seat is an ordinary account",
      );

      // Attach the brain to Alice's seat (host hands her account to it).
      (room as unknown as { attachBrain: (id: string) => void }).attachBrain(
        "user-a",
      );

      const rolls = collect<{ userId: string }>(bob, "diceRolled");
      const moves = collect<{ userId: string }>(bob, "pieceMoved");

      alice.send("startGame", {});
      assert.ok(await waitFor(() => room.state.phase === "playing"));

      const active = room.state.players.get("user-a");
      assert.ok(active, "Alice is still seated after the start");
      assert.strictEqual(active.isBot, false, "still not a bot account");
      active.pieces[0].position = 20;

      assert.ok(
        await waitFor(() => rolls.some((r) => r.userId === "user-a")),
        "the brain rolled for Alice's account",
      );
      assert.ok(
        await waitFor(() => moves.some((m) => m.userId === "user-a")),
        "the brain moved for Alice's account",
      );
    } finally {
      restore();
    }
  });

  it("auto-attaches a brain the platform resolves for an account on join", async () => {
    // The operator bound a brain to Alice's account on the platform. She
    // joins like anyone else; the room asks the platform, learns a brain
    // drives her, and starts playing her seat — no manual attach.
    const resolveCalls: string[] = [];
    const restore = installPlatformStub({
      attachedBrainFor: "user-a",
      resolveCalls,
    });
    try {
      const room = (await colyseus.createRoom("ludo", {
        targetPlayers: 2,
      })) as LudoRoom;

      const alice = await colyseus.connectTo(room, {
        token: await mintToken("user-a", "Alice"),
      });
      assert.ok(
        await waitFor(() => resolveCalls.includes("user-a")),
        "the room asked the platform about Alice's brain on join",
      );

      const bob = await colyseus.connectTo(room, {
        token: await mintToken("user-b", "Bob"),
      });
      bob.send("requestJoinAsPlayer", {});
      await waitFor(() => room.state.pendingPlayerRequests.size === 1);
      alice.send("approveJoin", { userId: "user-b" });
      await waitFor(() => room.state.players.size === 2);

      const rolls = collect<{ userId: string }>(bob, "diceRolled");
      const moves = collect<{ userId: string }>(bob, "pieceMoved");

      alice.send("startGame", {});
      assert.ok(await waitFor(() => room.state.phase === "playing"));

      const seat = room.state.players.get("user-a");
      assert.ok(seat, "Alice is still seated after the start");
      assert.strictEqual(seat.isBot, false, "still not a bot account");
      seat.pieces[0].position = 20;

      assert.ok(
        await waitFor(() => rolls.some((r) => r.userId === "user-a")),
        "the auto-resolved brain rolled for Alice's account",
      );
      assert.ok(
        await waitFor(() => moves.some((m) => m.userId === "user-a")),
        "the auto-resolved brain moved for Alice's account",
      );
    } finally {
      restore();
    }
  });
});
