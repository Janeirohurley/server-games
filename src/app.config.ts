import {
  defineServer,
  defineRoom,
  monitor,
  playground,
  createRouter,
  createEndpoint,
  matchMaker,
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

