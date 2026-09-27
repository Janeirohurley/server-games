import {
  defineServer,
  defineRoom,
  monitor,
  playground,
  createRouter,
  createEndpoint,
  matchMaker,
  WebSocketTransport,
} from "colyseus";

/**
 * Import your Room files
 */
import { MyRoom } from "./rooms/MyRoom.js";
import { LudoRoom } from "./games/ludo/ludo-room.js";
import { CheckersRoom } from "./games/checkers/checkers-room.js";
import { RallyRoom } from "./games/rally/rally-room.js";
import { LIFECYCLE } from "./rooms/schema/lobby-state.js";

const server = defineServer({

  /*
   * Explicit WebSocket transport with a raised maxPayload: WebRTC
   * signaling (SDP offers/answers) routinely exceeds the 4 KB default.
   * Everything else about the transport stays Colyseus' defaults.
   */
  transport: new WebSocketTransport({ maxPayload: 16 * 1024 }),

  /**
   * Define your room handlers:
   */
  rooms: {
    my_room: defineRoom(MyRoom),
    ludo: defineRoom(LudoRoom),
    checkers: defineRoom(CheckersRoom),
    rally: defineRoom(RallyRoom),
  },

  /**
   * Experimental: Define API routes. Built-in integration with the "playground" and SDK.
   *
   * Usage from SDK:
   *   client.http.get("/api/hello").then((response) => {})
   *
   */
  routes: createRouter({
    api_hello: createEndpoint("/api/hello", { method: "GET" }, async (ctx) => {
      return { message: "Hello World" };
    }),

    /*
     * The public match list of one game (spec section 4).
     *
     * Data comes straight from the matchmaker — rooms publish their
     * players / spectators / phase into metadata as they live — so a
     * closed room vanishes here the moment it is shut down. No room is
     * hidden by capacity: a full table still shows up, watchable.
     */
    api_rooms: createEndpoint(
      "/api/rooms/:gameId",
      { method: "GET" },
      async (ctx) => {
        const gameId = ctx.params.gameId;
        const rooms = await matchMaker.query({ name: gameId });
        return {
          rooms: rooms
            .filter(
              (room) =>
                room.metadata?.phase !== LIFECYCLE.CLOSED &&
                room.metadata?.gameId !== undefined,
            )
            .map((room) => ({
              roomId: room.roomId,
              metadata: {
                gameId: String(room.metadata?.gameId ?? gameId),
                gameName: String(room.metadata?.gameName ?? gameId),
                targetPlayers: Number(room.metadata?.targetPlayers ?? 0),
                players: Number(room.metadata?.players ?? 0),
                maxPlayers: Number(room.metadata?.maxPlayers ?? 0),
                spectators: Number(room.metadata?.spectators ?? 0),
                phase: String(room.metadata?.phase ?? LIFECYCLE.WAITING),
              },
            })),
        };
      },
    ),

    /*
     * Presence lookup for the platform's gamer profiles. Given user
     * ids (comma-separated, capped), returns only what a profile needs:
     * the strongest live state per user — playing beats spectating —
     * plus the game they are in. No names, no room ids beyond that.
     * Data comes from room metadata, which every room refreshes on
     * each role change, so a departure is visible immediately.
     */
    api_presence: createEndpoint(
      "/api/presence",
      { method: "GET" },
      async (ctx) => {
        const idsParam =
          typeof ctx.params?.ids === "string" ? ctx.params.ids : "";
        const userIds = idsParam
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean)
          .slice(0, 50);

        if (userIds.length === 0) {
          return { users: {} };
        }

        const rooms = await matchMaker.query({});
        const presence: Record<
          string,
          { state: "in-match" | "spectating"; gameId: string }
        > = {};

        for (const room of rooms) {
          if (room.metadata?.phase === LIFECYCLE.CLOSED) continue;
          const gameId = String(room.metadata?.gameId ?? "");
          if (!gameId) continue;

          const playerIds = Array.isArray(room.metadata?.playerIds)
            ? (room.metadata.playerIds as unknown[]).map(String)
            : [];
          for (const userId of playerIds) {
            if (!userIds.includes(userId)) continue;
            presence[userId] = { state: "in-match", gameId };
          }

          const spectatorIds = Array.isArray(room.metadata?.spectatorIds)
            ? (room.metadata.spectatorIds as unknown[]).map(String)
            : [];
          for (const userId of spectatorIds) {
            if (!userIds.includes(userId) || presence[userId]) continue;
            presence[userId] = { state: "spectating", gameId };
          }
        }

        return { users: presence };
      },
    ),
  }),

  /**
   * Bind your custom express routes here:
   * Read more: https://expressjs.com/en/starter/basic-routing.html
   */
  express: (app) => {

    /**
     * Readiness probe for the container orchestrator. Kept above the
     * playground so it answers in every environment.
     */
    app.get("/health", (req, res) => {
      res.json({ status: "ok" });
    });

    app.get("/hi", (req, res) => {
      res.send("It's time to kick ass and chew bubblegum!");
    });

    /**
     * Use @colyseus/monitor
     * If you expose it in production, make sure to protect it with a password:
     * https://docs.colyseus.io/tools/monitoring#password-protection
     */
    if (process.env.NODE_ENV !== "production") {
      app.use("/monitor", monitor());
    }

    /**
     * Use @colyseus/playground
     * (It is not recommended to expose this route in a production environment)
     */
    if (process.env.NODE_ENV !== "production") {
      app.use("/", playground());
    }
  }
});

export default server;

