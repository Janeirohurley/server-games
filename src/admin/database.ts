import { GameDatabase } from "@colyseus/database";

/**
 * PostgreSQL connection for the `@colyseus/admin` panel.
 *
 * Deliberately optional. The admin panel is operator tooling; the rooms,
 * the matchmaker and the WebSocket transport are the product. So a missing
 * or unreachable database downgrades `/admin` to "not mounted" and leaves
 * everything else serving — the alternative (booting the panel against a
 * database we cannot reach) would take live matches down over an admin
 * dependency.
 *
 * `migrations: "auto"` is the package default and is the reason this needs
 * no drizzle-kit setup: on every boot it issues CREATE TABLE IF NOT EXISTS,
 * ALTER TABLE ADD COLUMN for new columns and CREATE INDEX IF NOT EXISTS.
 * It is idempotent and never drops or retypes, so booting two instances
 * against the same database is safe. Switch to `{ files: "./drizzle" }` only
 * when the schema starts being changed by hand.
 *
 * Every table it owns is prefixed `colyseus_` (`colyseus_users`,
 * `colyseus_roles`, `colyseus_admin_audit`, …), so pointing this at the
 * platform's existing PostgreSQL adds no collision risk to those tables.
 */

/** A hung connection must not hold the whole server hostage. */
const BOOT_TIMEOUT_MS = 10_000;

export async function createAdminDatabase(): Promise<GameDatabase | undefined> {
  const connectionString = process.env.DATABASE_URL?.trim();

  if (!connectionString) {
    console.warn(
      "[admin] DATABASE_URL is not set — /admin is disabled. Rooms, matchmaking and WebSockets are unaffected.",
    );
    return undefined;
  }

  try {
    const database = new GameDatabase({
      dialect: "pg",
      connectionString,
      migrations: "auto",
    });

    await withTimeout(
      database.boot(),
      BOOT_TIMEOUT_MS,
      `DATABASE_URL did not answer within ${BOOT_TIMEOUT_MS}ms`,
    );

    return database;
  } catch (error) {
    // Logged, not thrown: the game server must survive a dead admin database.
    console.error(
      "[admin] database boot failed — /admin is disabled; the game server keeps running.",
      error,
    );
    return undefined;
  }
}

/** Reject with `message` if `work` has not settled in `ms`. */
function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(message)), ms).unref?.(),
    ),
  ]);
}
