/**
 * IMPORTANT:
 * ---------
 * Do not manually edit this file if you'd like to host your server on Colyseus Cloud
 *
 * If you're self-hosting, you can see "Raw usage" from the documentation.
 *
 * See: https://docs.colyseus.io/server
 */
import { listen } from "@colyseus/tools";
import { roomSnapshotStore } from "./rooms/room-snapshot-store.js";

// Import Colyseus config
import app from "./app.config.js";

// Restore persisted rooms before the transport starts accepting clients.
const existingBeforeListen = app.options.beforeListen;
app.options.beforeListen = async () => {
  await existingBeforeListen?.();
  await roomSnapshotStore.restoreRooms();
};

// Create and listen on 2567 (or PORT environment variable.)
await listen(app);
