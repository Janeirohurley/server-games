import postgres, { type Sql } from "postgres";

import { matchMaker } from "colyseus";
import { isDevMode, setDevMode } from "@colyseus/core";

const TABLE = "game_room_snapshots";
const CLOSED_ROOM_SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1_000;

export interface PersistedRoomSnapshot {
  roomId: string;
  roomName: string;
  options: {
    targetPlayers?: number;
    creatorUserId?: string;
    reconnectionGrace?: number;
  };
  state: Record<string, unknown>;
  savedAt: number;
}

/**
 * Durable lobby snapshots are enabled automatically in production when a
 * DATABASE_URL exists. Tests/development can opt in with
 * REALTIME_ROOM_PERSISTENCE=1. Live matches are never snapshotted here:
 * restoring a lobby is safe, restoring an in-progress game without its
 * simulation timers would be misleading.
 */
class RoomSnapshotStore {
  private sql: Sql | undefined;
  private initialized: Promise<boolean> | undefined;
  private disabled = false;

  private get enabled() {
    return (
      process.env.REALTIME_ROOM_PERSISTENCE === "1" ||
      (process.env.NODE_ENV === "production" && Boolean(process.env.DATABASE_URL))
    );
  }

  private async init() {
    if (!this.enabled || this.disabled) return false;
    if (!this.initialized) {
      this.initialized = this.connect();
    }
    return this.initialized;
  }

  private async connect() {
    try {
      this.sql = postgres(process.env.DATABASE_URL as string, {
        max: 1,
        connect_timeout: 5,
        idle_timeout: 30,
        prepare: false,
      });
      await this.sql.unsafe(`
        CREATE TABLE IF NOT EXISTS ${TABLE} (
          room_id TEXT PRIMARY KEY,
          room_name TEXT NOT NULL,
          options JSONB NOT NULL,
          state JSONB NOT NULL,
          saved_at BIGINT NOT NULL
        )
      `);
      return true;
    } catch (error) {
      this.disabled = true;
      console.warn("[realtime] room snapshot persistence disabled:", error);
      return false;
    }
  }

  async save(snapshot: PersistedRoomSnapshot): Promise<boolean> {
    // Memory-only mode is intentional during development. Production must
    // never acknowledge a write that cannot survive a process restart.
    if (!this.enabled) {
      if (process.env.NODE_ENV === "production") {
        console.error(
          "[realtime] refusing durable lobby acknowledgement: DATABASE_URL is not configured",
        );
        return false;
      }
      return true;
    }
    if (!(await this.init()) || !this.sql) return false;
    try {
      await this.sql`
        INSERT INTO ${this.sql(TABLE)} (room_id, room_name, options, state, saved_at)
        VALUES (
          ${snapshot.roomId},
          ${snapshot.roomName},
          ${this.sql.json(snapshot.options as never)},
          ${this.sql.json(snapshot.state as never)},
          ${snapshot.savedAt}
        )
        ON CONFLICT (room_id) DO UPDATE SET
          room_name = EXCLUDED.room_name,
          options = EXCLUDED.options,
          state = EXCLUDED.state,
          saved_at = EXCLUDED.saved_at
      `;
      return true;
    } catch (error) {
      console.warn("[realtime] room snapshot save failed:", error);
      return false;
    }
  }

  async remove(roomId: string) {
    if (!(await this.init()) || !this.sql) return;
    try {
      await this.sql`DELETE FROM ${this.sql(TABLE)} WHERE room_id = ${roomId}`;
    } catch (error) {
      console.warn("[realtime] room snapshot delete failed:", error);
    }
  }

  async loadAll(): Promise<PersistedRoomSnapshot[]> {
    if (!(await this.init()) || !this.sql) return [];
    try {
      await this.sql`
        DELETE FROM ${this.sql(TABLE)}
        WHERE state->>'phase' = 'closed'
          AND saved_at < ${Date.now() - CLOSED_ROOM_SNAPSHOT_TTL_MS}
      `;
      const rows = await this.sql<{
        room_id: string;
        room_name: string;
        options: PersistedRoomSnapshot["options"];
        state: PersistedRoomSnapshot["state"];
        saved_at: string;
      }[]>`SELECT room_id, room_name, options, state, saved_at FROM ${this.sql(TABLE)}`;
      return rows.map((row) => ({
        roomId: row.room_id,
        roomName: row.room_name,
        options: row.options,
        state: row.state,
        savedAt: Number(row.saved_at),
      }));
    } catch (error) {
      console.warn("[realtime] room snapshot load failed:", error);
      return [];
    }
  }

  async restoreSnapshot(snapshot: PersistedRoomSnapshot) {
    // Colyseus' public createRoom() always generates a new id in production
    // and silently ignores restoreRoomId. The internal restoration path is
    // the only supported way to preserve the invite URL. Startup runs before
    // listen() accepts clients, so temporarily enabling its restore branch is
    // race-free and is reverted immediately.
    const previousDevMode = isDevMode;
    setDevMode(true);
    try {
      return await matchMaker.handleCreateRoom(
        snapshot.roomName,
        {
          ...snapshot.options,
          restoreState: snapshot.state,
        },
        snapshot.roomId,
      );
    } finally {
      setDevMode(previousDevMode);
    }
  }

  async restoreRooms() {
    const snapshots = await this.loadAll();
    for (const snapshot of snapshots) {
      try {
        await this.restoreSnapshot(snapshot);
      } catch (error) {
        console.warn(
          `[realtime] could not restore room ${snapshot.roomId}:`,
          error,
        );
      }
    }
    if (snapshots.length > 0) {
      console.info(`[realtime] restored ${snapshots.length} lobby room(s)`);
    }
  }
}

export const roomSnapshotStore = new RoomSnapshotStore();
