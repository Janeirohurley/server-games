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
import { TetrisRoom } from "./games/tetris/tetris-room.js";
import { LIFECYCLE } from "./rooms/schema/lobby-state.js";
import { getRealtimeTokenSecret } from "./auth/verify-token.js";
import { admin } from "@colyseus/admin";
import { createAdminDatabase } from "./admin/database.js";

/**
 * Operator panel, served at `/admin` with its REST API at `/admin-api`.
 *
 * Booted before `defineServer` on purpose: `admin()` reads the database's
 * table registry at construction time, so it has to run after
 * `GameDatabase.boot()` rather than during `listen()`. Top-level await is
 * what makes that ordering expressible — `index.ts` cannot observe this
 * module until the boot settles.
 *
 * `createAdminDatabase` returns undefined without a database, in which case
 * the panel is simply not mounted: a missing DATABASE_URL must degrade
 * operator tooling, never the rooms, the matchmaker or the transport.
 *
 * Mounted on the express app rather than spread into `createRouter` — see
 * the note at the mount site below for why that detail is load-bearing.
 */
const adminDatabase = await createAdminDatabase();
const adminPanel = adminDatabase ? admin({ database: adminDatabase }) : undefined;

const server = defineServer({

  /*
   * Explicit WebSocket transport with a raised maxPayload: headroom for
   * large game-state messages. (Historically it covered WebRTC SDP
   * relay; audio/video signaling now lives on the LiveKit server.)
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
    tetris: defineRoom(TetrisRoom),
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
     * ADMIN: full active-room roster for the platform console. Same
     * matchmaker metadata the public per-game list publishes, but ALL
     * rooms (every game), plus createdAt for an operational "age"
     * column. Server-to-server only: the shared REALTIME_TOKEN_SECRET
     * header authorizes the call (same discipline as
     * api_room_membership) — the public can never enumerate every room.
     */
    api_admin_rooms: createEndpoint(
      "/api/admin/rooms",
      { method: "GET" },
      async (ctx) => {
        const presented = ctx.getHeader("x-realtime-token-secret");
        let expected: string;
        try {
          expected = getRealtimeTokenSecret();
        } catch {
          return new Response(JSON.stringify({ error: "Realtime secret not configured" }), {
            status: 503,
            headers: { "content-type": "application/json" },
          });
        }
        if (!presented || presented !== expected) {
          return new Response(JSON.stringify({ error: "Forbidden" }), {
            status: 403,
            headers: { "content-type": "application/json" },
          });
        }

        const rooms = await matchMaker.query({});
        return {
          rooms: rooms
            .filter(
              (room) =>
                room.metadata?.phase !== LIFECYCLE.CLOSED &&
                room.metadata?.gameId !== undefined,
            )
            .map((room) => ({
              roomId: room.roomId,
              createdAt: room.createdAt ?? null,
              metadata: {
                gameId: String(room.metadata?.gameId ?? ""),
                gameName: String(room.metadata?.gameName ?? ""),
                targetPlayers: Number(room.metadata?.targetPlayers ?? 0),
                players: Number(room.metadata?.players ?? 0),
                maxPlayers: Number(room.metadata?.maxPlayers ?? 0),
                spectators: Number(room.metadata?.spectators ?? 0),
                playerIds: Array.isArray(room.metadata?.playerIds)
                  ? (room.metadata.playerIds as unknown[]).map(String)
                  : [],
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

    /*
     * Room membership lookup for the platform's LiveKit token route.
     *
     * The platform must prove that an authenticated user actually belongs
     * to a game room before it issues that user a media token for the
     * room's media channel. Room membership lives HERE — in the live room
     * state, not in the platform database — so this is the authoritative
     * answer, read from the same metadata `refreshMetadata` already
     * publishes on every role change.
     *
     * It is deliberately server-to-server only:
     *
     *   - it requires the shared REALTIME_TOKEN_SECRET in a header, so
     *     the public cannot use it to enumerate who is in which room;
     *   - it answers for exactly ONE (room, user) pair and returns
     *     nothing else — no names, no other members, no roster.
     *
     * An unknown room and a user who is simply not in it both answer
     * `{ member: false }`: the caller must not be able to tell the two
     * apart and probe for private rooms.
     */
    api_room_membership: createEndpoint(
      "/api/room-membership/:roomId",
      { method: "GET" },
      async (ctx) => {
        const presented = ctx.getHeader("x-realtime-token-secret");
        let expected: string;
        try {
          expected = getRealtimeTokenSecret();
        } catch {
          return new Response(
            JSON.stringify({ member: false, role: null }),
            { status: 503, headers: { "content-type": "application/json" } },
          );
        }
        if (!presented || presented !== expected) {
          return new Response(
            JSON.stringify({ error: "Forbidden" }),
            { status: 403, headers: { "content-type": "application/json" } },
          );
        }

        const roomId =
          typeof ctx.params?.roomId === "string" ? ctx.params.roomId : "";
        const userId =
          typeof ctx.query?.userId === "string" ? ctx.query.userId : "";
        if (!roomId || !userId) {
          return new Response(
            JSON.stringify({ error: "roomId and userId are required" }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }

        // Colyseus 0.18 has no `matchMaker.findOne`: query by name-less
        // room list and pick the id, exactly like `/api/rooms` does.
        const found = await matchMaker.query({});
        const room = found.find((entry) => entry.roomId === roomId) ?? null;
        const denied = new Response(
          JSON.stringify({ member: false, role: null }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
        if (!room) return denied;

        // A closed room admits nobody: its voice channel must not outlive
        // the match.
        if (room.metadata?.phase === LIFECYCLE.CLOSED) return denied;

        const asIds = (value: unknown): string[] =>
          Array.isArray(value) ? value.map((id) => String(id)) : [];

        const isPlayer = asIds(room.metadata?.playerIds).includes(userId);
        const isSpectator = asIds(room.metadata?.spectatorIds).includes(userId);

        return new Response(
          JSON.stringify({
            member: isPlayer || isSpectator,
            role: isPlayer ? "player" : isSpectator ? "spectator" : null,
            gameId: String(room.metadata?.gameId ?? ""),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
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
     * @colyseus/admin, mounted ahead of the dev-only middleware below.
     *
     * Order matters: the playground is mounted on "/" further down and, being
     * a catch-all, would swallow "/admin/*" if it were registered first.
     *
     * Express rather than `createRouter` because the router only registers
     * "/admin/" plus an "/admin/**" catch-all, while the express build
     * additionally 302s the bare "/admin" onto the canonical "/admin/".
     * Registering it here is what makes the documented entry point resolve.
     */
    if (adminPanel) {
      app.use(adminPanel);
    }

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

