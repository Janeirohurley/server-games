/**
 * Realtime auth: verify the short-lived JWT minted by the Next.js platform.
 *
 * The Next.js app signs the token with a shared secret (HS256). We only
 * verify the signature and expiry here — we do NOT own the user accounts,
 * that stays the platform's job. No second user system.
 *
 * Two token kinds share the same secret:
 *   - user tokens (issuer "game-platform"): full identity, can play;
 *   - guest tokens (issuer "game-platform-guest"): anonymous SPECTATORS
 *     only. They must never seat, never run a room — the platform keeps
 *     accounts, watching is open.
 */

import type { JwtPayload } from "@colyseus/auth";
import { JWT } from "@colyseus/auth";

export interface RealtimeIdentity {
  /** Platform user id (better-auth `user.id`), or the guest id. */
  userId: string;
  /** Display name for the lobby and the board. */
  name: string;
  /**
   * Public gamer tag from the platform's gamer profile (falls back to
   * the display name when the profile lookup failed on the platform).
   */
  gamerTag?: string;
  /** Avatar URL from the gamer profile, when the player set one. */
  avatarUrl?: string | null;
  /** True for anonymous spectators — cannot hold a seat or run the room. */
  guest?: boolean;
}

/** Shared env var names, agreed with the Next.js app. */
export const REALTIME_TOKEN_SECRET_ENV = "REALTIME_TOKEN_SECRET";
export const REALTIME_TOKEN_ISSUER = "game-platform";
/** Distinct issuer so a guest token can never pass as a user token. */
export const REALTIME_GUEST_TOKEN_ISSUER = "game-platform-guest";

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

/** Verify and shape a payload into an identity. */
async function verifyWithIssuer(
  token: string,
  issuer: string,
): Promise<{
  userId: string;
  name: string;
  gamerTag?: string;
  avatarUrl?: string | null;
  guest?: true;
}> {
  if (!token || typeof token !== "string") {
    throw new Error("Missing realtime token");
  }

  // The shared secret is configured once on the JWT helper's settings;
  // per-call options only carry the issuer constraint.
  JWT.settings.secret = getRealtimeTokenSecret();

  const payload = (await JWT.verify(token, {
    issuer,
    algorithms: ["HS256"],
  })) as JwtPayload;

  const userId = typeof payload.sub === "string" ? payload.sub : undefined;
  const name = typeof payload.name === "string" ? payload.name : undefined;

  if (!userId || !name) {
    throw new Error("Realtime token payload is missing required claims");
  }

  const gamerTag = typeof payload.gamerTag === "string" ? payload.gamerTag : undefined;
  const avatarUrl =
    typeof payload.avatarUrl === "string" ? payload.avatarUrl : null;

  return {
    userId,
    name,
    gamerTag,
    avatarUrl,
    guest: payload.guest === true ? true : undefined,
  };
}

/**
 * Verify a platform USER token. Throws when the token is missing,
 * forged or expired.
 */
export async function verifyRealtimeToken(
  token: string,
): Promise<RealtimeIdentity> {
  const identity = await verifyWithIssuer(token, REALTIME_TOKEN_ISSUER);
  if (identity.guest) {
    throw new Error("Guest token used as user token");
  }
  return {
    userId: identity.userId,
    name: identity.name,
    gamerTag: identity.gamerTag,
    avatarUrl: identity.avatarUrl,
  };
}

/**
 * Verify an anonymous SPECTATOR token. Guests watch only: the flag on
 * the returned identity is what rooms use to deny seats.
 */
export async function verifyGuestRealtimeToken(
  token: string,
): Promise<RealtimeIdentity> {
  const identity = await verifyWithIssuer(
    token,
    REALTIME_GUEST_TOKEN_ISSUER,
  );
  if (!identity.guest || !identity.userId.startsWith("guest-")) {
    throw new Error("Invalid guest token");
  }
  return { userId: identity.userId, name: identity.name, guest: true };
}

/**
 * Verify whichever kind of token arrived. User tokens win: a forged
 * "guest" claim inside a user token is ignored, and a guest token can
 * never satisfy the user issuer.
 */
export async function verifyAnyRealtimeToken(
  token: string,
): Promise<RealtimeIdentity> {
  try {
    return await verifyRealtimeToken(token);
  } catch (userError) {
    try {
      return await verifyGuestRealtimeToken(token);
    } catch {
      throw userError; // surface the user-token error, the usual case
    }
  }
}
