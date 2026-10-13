/**
 * Bot pool client — the game server's only view of the platform-owned
 * bot pool.
 *
 * Bots are provisioned, leased and released by the Next.js platform (see
 * game-platform `lib/bots/provisioning.ts`); this process never writes
 * the pool tables. It asks the signed internal endpoint
 * (`/api/internal/bots`) and treats the answer as the truth.
 *
 * Trust model mirrors profile reporting (see profile-reporting.ts): a
 * per-request HMAC of the RAW body, keyed by the shared
 * REALTIME_TOKEN_SECRET. Same secret, same discipline, one more
 * server-side use.
 *
 * Failure policy is deliberately asymmetric:
 *   - `claimBots` returns `[]` on any failure — a dead platform must
 *     degrade a room to "no bots", never crash it or delay its start;
 *   - `releaseBots` / `releaseStaleBotLeases` are best-effort too; the
 *     platform's stale-lease sweep is the backstop for a lost release.
 * Nothing here ever throws to a caller.
 */

import type { BotDifficulty, BrainConfig } from "./brain/types.js";
import { normalizeBrainConfig } from "./brain/types.js";

export type { BotDifficulty, BrainConfig } from "./brain/types.js";

/** A bot reservation, shaped for seating. */
export interface ClaimedBot {
  botId: string;
  userId: string;
  gameId: string;
  displayName: string;
  gamerTag: string;
  difficulty: BotDifficulty;
  /** Strategy knobs, already defaulted by the platform. */
  config: BrainConfig;
  status: string;
}

/**
 * An attached brain resolved for a seated account: enough to drive the
 * seat. Unlike a `ClaimedBot` it carries no identity — the seat already
 * belongs to a real account; only the difficulty and strategy matter.
 */
export interface ResolvedBrain {
  difficulty: BotDifficulty;
  config: BrainConfig;
}

const DEFAULT_PLATFORM_URL = "http://localhost:3000";
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_ATTEMPTS = 3;

function platformBaseUrl(): string {
  return (
    process.env.PLATFORM_URL ??
    process.env.GAME_PLATFORM_URL ??
    DEFAULT_PLATFORM_URL
  ).replace(/\/+$/, "");
}

async function sign(body: string): Promise<string> {
  const secret = process.env.REALTIME_TOKEN_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error("REALTIME_TOKEN_SECRET is missing or too short");
  }
  const { createHmac } = await import("node:crypto");
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

const DIFFICULTIES: readonly BotDifficulty[] = ["easy", "normal", "hard"];
function isClaimedBot(value: unknown): value is ClaimedBot {
  if (value === null || typeof value !== "object") return false;
  const bot = value as Record<string, unknown>;
  return (
    typeof bot.botId === "string" &&
    typeof bot.userId === "string" &&
    typeof bot.gameId === "string" &&
    typeof bot.displayName === "string" &&
    typeof bot.gamerTag === "string" &&
    typeof bot.status === "string" &&
    typeof bot.difficulty === "string" &&
    (DIFFICULTIES as readonly string[]).includes(bot.difficulty)
  );
}

function isResolvedBrain(value: unknown): value is ResolvedBrain {
  if (value === null || typeof value !== "object") return false;
  const brain = value as Record<string, unknown>;
  if (
    typeof brain.difficulty !== "string" ||
    !(DIFFICULTIES as readonly string[]).includes(brain.difficulty)
  ) {
    return false;
  }
  const config = brain.config;
  if (config === null || typeof config !== "object") return false;
  const knobs = config as Record<string, unknown>;
  return (
    typeof knobs.aggression === "number" && typeof knobs.caution === "number"
  );
}

/**
 * One signed round trip to the pool endpoint, with bounded retries.
 * Throws only after the last attempt; callers decide whether that is
 * fatal (never, today).
 */
async function callBotPool(payload: Record<string, unknown>): Promise<unknown> {
  const body = JSON.stringify(payload);

  let signature: string;
  try {
    signature = await sign(body);
  } catch (error) {
    console.error("[bots] cannot sign pool request:", error);
    throw error;
  }

  const url = `${platformBaseUrl()}/api/internal/bots`;

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // A 4xx other than 429 will never improve by retrying.
    let retryable = true;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-realtime-signature": `sha256=${signature}`,
        },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (response.ok) return await response.json();

      if (
        response.status >= 400 &&
        response.status < 500 &&
        response.status !== 429
      ) {
        retryable = false;
        lastError = new Error(
          `bot pool request rejected (HTTP ${response.status})`,
        );
      } else {
        lastError = new Error(`bot pool request failed (HTTP ${response.status})`);
      }
      console.warn(
        `[bots] pool request attempt ${attempt} failed (HTTP ${response.status})`,
      );
    } catch (error) {
      console.warn(`[bots] pool request attempt ${attempt} failed:`, error);
      lastError = error;
    }

    if (!retryable) break;
    if (attempt < MAX_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }

  throw lastError ?? new Error("bot pool request failed");
}

/**
 * Reserve `count` bots for a room. Returns the seats the platform could
 * grant — possibly fewer than asked, possibly none (platform down).
 */
export async function claimBots(options: {
  gameId: string;
  count: number;
  roomId: string;
}): Promise<ClaimedBot[]> {
  try {
    const data = (await callBotPool({
      action: "claim",
      gameId: options.gameId,
      count: options.count,
      roomId: options.roomId,
    })) as { bots?: unknown };

    if (!Array.isArray(data.bots)) return [];
    return data.bots
      .filter(isClaimedBot)
      .map((bot) => ({ ...bot, config: normalizeBrainConfig(bot.config) }));
  } catch (error) {
    console.error("[bots] claim failed:", error);
    return [];
  }
}

/**
 * Ask the platform whether an attached brain drives `userId` for `gameId`.
 * Returns null when there is none, the brain is disabled, or the platform
 * is unreachable — a missing answer simply means "let the human play".
 */
export async function resolveBrain(options: {
  gameId: string;
  userId: string;
}): Promise<ResolvedBrain | null> {
  try {
    const data = (await callBotPool({
      action: "resolve",
      gameId: options.gameId,
      userId: options.userId,
    })) as { brain?: unknown };
    return isResolvedBrain(data?.brain) ? data.brain : null;
  } catch (error) {
    console.error("[bots] brain resolve failed:", error);
    return null;
  }
}

/** Return every bot this room leased to the idle pool. Best-effort. */
export async function releaseBots(options: { roomId: string }): Promise<number> {
  try {
    const data = (await callBotPool({
      action: "release",
      roomId: options.roomId,
    })) as { released?: unknown };
    return typeof data.released === "number" ? data.released : 0;
  } catch (error) {
    console.error("[bots] release failed:", error);
    return 0;
  }
}

/**
 * Ask the platform to reclaim leases stranded by a crashed server.
 * Belt-and-braces: the platform also runs this on its own schedule, but
 * a fresh game server can trigger it at boot.
 */
export async function releaseStaleBotLeases(options?: {
  maxAgeMs?: number;
}): Promise<number> {
  try {
    const data = (await callBotPool({
      action: "release-stale",
      ...(options?.maxAgeMs !== undefined ? { maxAgeMs: options.maxAgeMs } : {}),
    })) as { released?: unknown };
    return typeof data.released === "number" ? data.released : 0;
  } catch (error) {
    console.error("[bots] stale-lease sweep failed:", error);
    return 0;
  }
}
