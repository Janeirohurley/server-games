import assert from "node:assert/strict";
import { roomSnapshotStore } from "../src/rooms/room-snapshot-store.js";

type StoreInternals = {
  init: () => Promise<boolean>;
  loadAll: () => Promise<unknown[]>;
  restoreSnapshot: (snapshot: unknown) => Promise<unknown>;
  restoreRooms: () => Promise<void>;
};

const store = roomSnapshotStore as unknown as StoreInternals;

function preserveEnvironment() {
  const previous = {
    NODE_ENV: process.env.NODE_ENV,
    DATABASE_URL: process.env.DATABASE_URL,
    REALTIME_ROOM_PERSISTENCE: process.env.REALTIME_ROOM_PERSISTENCE,
  };
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

describe("durable room restoration startup behavior", () => {
  it("fails production startup when DATABASE_URL is missing", async () => {
    const restoreEnvironment = preserveEnvironment();
    process.env.NODE_ENV = "production";
    delete process.env.DATABASE_URL;
    delete process.env.REALTIME_ROOM_PERSISTENCE;

    try {
      await assert.rejects(
        store.loadAll(),
        /DATABASE_URL is required for durable lobby snapshots in production/,
      );
    } finally {
      restoreEnvironment();
    }
  });

  it("fails production startup when configured persistence cannot initialize", async () => {
    const restoreEnvironment = preserveEnvironment();
    process.env.NODE_ENV = "production";
    process.env.DATABASE_URL = "postgres://configured.example/game";
    process.env.REALTIME_ROOM_PERSISTENCE = "1";
    store.init = async () => false;

    try {
      await assert.rejects(
        store.loadAll(),
        /Unable to initialize durable lobby storage during startup/,
      );
    } finally {
      Reflect.deleteProperty(store, "init");
      restoreEnvironment();
    }
  });

  it("fails production startup rather than serving with an unrestored room", async () => {
    const restoreEnvironment = preserveEnvironment();
    const originalLoadAll = store.loadAll;
    const originalRestoreSnapshot = store.restoreSnapshot;
    process.env.NODE_ENV = "production";
    store.loadAll = async () => [{ roomId: "unrestorable-room" }];
    store.restoreSnapshot = async () => {
      throw new Error("room schema cannot be restored");
    };

    try {
      await assert.rejects(
        store.restoreRooms(),
        (error: unknown) =>
          error instanceof AggregateError &&
          /Unable to restore 1 durable lobby room/.test(error.message),
      );
    } finally {
      store.loadAll = originalLoadAll;
      store.restoreSnapshot = originalRestoreSnapshot;
      restoreEnvironment();
    }
  });
});
