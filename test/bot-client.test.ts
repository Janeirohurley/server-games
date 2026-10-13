import assert from "assert";
import { createHmac } from "node:crypto";

import {
  claimBots,
  releaseBots,
  releaseStaleBotLeases,
  type ClaimedBot,
} from "../src/bots/bot-client.js";

/*
 * The bot pool client is the game server's only link to the platform's
 * bot pool, and it must never throw into a room. These tests pin the two
 * halves of that contract:
 *   1. a well-formed signed request, with a correct HMAC over the raw
 *      body (the platform rejects anything else), and
 *   2. graceful degradation — a down or rejecting platform yields an
 *      empty result, not an exception.
 */

const SECRET = "test-secret-for-the-realtime-suite-0123456789";
const BASE = "http://platform.test";

// Same secret every suite in this directory sets at load; assigning it
// here too keeps the shared process env stable (no per-test mutation,
// which would corrupt the JWT secret the room suites rely on).
process.env.REALTIME_TOKEN_SECRET = SECRET;
process.env.PLATFORM_URL = BASE;

type FetchCall = { url: string; body: string; signature: string | null };

function installFetch(
  handler: (call: FetchCall) => { status: number; json?: unknown },
): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = typeof init?.body === "string" ? init.body : "";
    const headers = new Headers(init?.headers);
    const call: FetchCall = {
      url,
      body,
      signature: headers.get("x-realtime-signature"),
    };
    calls.push(call);
    const result = handler(call);
    return new Response(
      result.json === undefined ? "" : JSON.stringify(result.json),
      { status: result.status, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const bot = (overrides: Partial<ClaimedBot> = {}): ClaimedBot => ({
  botId: "bot-1",
  userId: "user-1",
  gameId: "ludo",
  displayName: "Brave Fox",
  gamerTag: "BraveFox",
  difficulty: "normal",
  config: { aggression: 0.5, caution: 0.5 },
  status: "in_match",
  ...overrides,
});

describe("bot-client", () => {
  it("signs the raw body and returns claimed bots", async () => {
    const expected = bot();
    const { calls, restore } = installFetch(() => ({
      status: 200,
      json: { bots: [expected] },
    }));
    try {
      const bots = await claimBots({ gameId: "ludo", count: 2, roomId: "r1" });

      assert.deepStrictEqual(bots, [expected]);
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0].url, `${BASE}/api/internal/bots`);

      const digest = createHmac("sha256", SECRET)
        .update(calls[0].body, "utf8")
        .digest("hex");
      assert.strictEqual(calls[0].signature, `sha256=${digest}`);

      const payload = JSON.parse(calls[0].body) as Record<string, unknown>;
      assert.deepStrictEqual(payload, {
        action: "claim",
        gameId: "ludo",
        count: 2,
        roomId: "r1",
      });
    } finally {
      restore();
    }
  });

  it("drops malformed entries from a claim result", async () => {
    const { restore } = installFetch(() => ({
      status: 200,
      json: {
        bots: [
          bot({ userId: "good" }),
          { userId: "missing-fields" },
          bot({ userId: "bad-difficulty", difficulty: "impossible" as never }),
        ],
      },
    }));
    try {
      const bots = await claimBots({ gameId: "ludo", count: 3, roomId: "r1" });
      assert.deepStrictEqual(
        bots.map((b) => b.userId),
        ["good"],
      );
    } finally {
      restore();
    }
  });

  it("carries strategy knobs, defaulting a missing config", async () => {
    const { restore } = installFetch(() => ({
      status: 200,
      json: {
        bots: [
          bot({ userId: "tuned", config: { aggression: 0.9, caution: 0.1 } }),
          bot({ userId: "silent", config: undefined as never }),
        ],
      },
    }));
    try {
      const bots = await claimBots({ gameId: "ludo", count: 2, roomId: "r1" });
      const byUser = new Map(bots.map((b) => [b.userId, b.config]));
      assert.deepStrictEqual(byUser.get("tuned"), {
        aggression: 0.9,
        caution: 0.1,
      });
      assert.deepStrictEqual(byUser.get("silent"), {
        aggression: 0.5,
        caution: 0.5,
      });
    } finally {
      restore();
    }
  });

  it("returns [] when the platform responds 5xx (never throws)", async () => {
    const { calls, restore } = installFetch(() => ({ status: 503 }));
    try {
      const bots = await claimBots({ gameId: "ludo", count: 2, roomId: "r1" });
      assert.deepStrictEqual(bots, []);
      assert.ok(calls.length >= 2, "should retry a retryable failure");
    } finally {
      restore();
    }
  });

  it("does not retry a hard 4xx rejection", async () => {
    const { calls, restore } = installFetch(() => ({ status: 403 }));
    try {
      const bots = await claimBots({ gameId: "ludo", count: 2, roomId: "r1" });
      assert.deepStrictEqual(bots, []);
      assert.strictEqual(calls.length, 1);
    } finally {
      restore();
    }
  });

  it("returns [] when the secret is missing, without hitting the network", async () => {
    delete process.env.REALTIME_TOKEN_SECRET;
    const { calls, restore } = installFetch(() => ({ status: 200, json: {} }));
    try {
      const bots = await claimBots({ gameId: "ludo", count: 1, roomId: "r1" });
      assert.deepStrictEqual(bots, []);
      assert.strictEqual(calls.length, 0);
    } finally {
      process.env.REALTIME_TOKEN_SECRET = SECRET;
      restore();
    }
  });

  it("reads the released count from a release response", async () => {
    const { restore } = installFetch(() => ({
      status: 200,
      json: { released: 3 },
    }));
    try {
      assert.strictEqual(await releaseBots({ roomId: "r1" }), 3);
    } finally {
      restore();
    }
  });

  it("falls back to 0 when release fails", async () => {
    const { restore } = installFetch(() => ({ status: 500 }));
    try {
      assert.strictEqual(await releaseBots({ roomId: "r1" }), 0);
    } finally {
      restore();
    }
  });

  it("sweeps stale leases and reports the count", async () => {
    const { calls, restore } = installFetch(() => ({
      status: 200,
      json: { released: 7 },
    }));
    try {
      assert.strictEqual(await releaseStaleBotLeases({ maxAgeMs: 1000 }), 7);
      const payload = JSON.parse(calls[0].body) as Record<string, unknown>;
      assert.deepStrictEqual(payload, { action: "release-stale", maxAgeMs: 1000 });
    } finally {
      restore();
    }
  });
});
