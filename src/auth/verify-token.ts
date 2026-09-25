/**
 * Realtime auth: verify the short-lived JWT minted by the Next.js platform.
 *
 * The Next.js app signs the token with a shared secret (HS256). We only
 * verify the signature and expiry here — we do NOT own the user accounts,
 * that stays the platform's job. No second user system.
 */

import type { JwtPayload } from "@colyseus/auth";
import { JWT } from "@colyseus/auth";

export interface RealtimeIdentity {
  /** Platform user id (better-auth `user.id`). */
  userId: string;
  /** Display name for the lobby and the board. */
  name: string;
}

/** Shared env var names, agreed with the Next.js app. */
export const REALTIME_TOKEN_SECRET_ENV = "REALTIME_TOKEN_SECRET";
export const REALTIME_TOKEN_ISSUER = "game-platform";

export function getRealtimeTokenSecret(): string {
  const secret = process.env[REALTIME_TOKEN_SECRET_ENV];
  if (!secret || secret.length < 16) {
    throw new Error(
      `${REALTIME_TOKEN_SECRET_ENV} is missing or too short. ` +
        `It must match the value configured in the Next.js app.`,
    );
  }
  return secret;
}

/**
 * Verify a platform JWT and return the caller's identity.
 * Throws when the token is missing, forged or expired.
 */
export async function verifyRealtimeToken(
  token: string,
): Promise<RealtimeIdentity> {
  if (!token || typeof token !== "string") {
    throw new Error("Missing realtime token");
  }

  // The shared secret is configured once on the JWT helper's settings;
  // per-call options only carry the issuer constraint.
  JWT.settings.secret = getRealtimeTokenSecret();

  const payload = (await JWT.verify(token, {
    issuer: REALTIME_TOKEN_ISSUER,
    algorithms: ["HS256"],
  })) as JwtPayload;

  const userId = typeof payload.sub === "string" ? payload.sub : undefined;
  const name = typeof payload.name === "string" ? payload.name : undefined;

  if (!userId || !name) {
    throw new Error("Realtime token payload is missing required claims");
  }

  return { userId, name };
}
