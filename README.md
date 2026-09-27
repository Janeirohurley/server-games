# Welcome to Colyseus!

This project was created with [⚔️ `create-colyseus-app`](https://github.com/colyseus/create-colyseus-app/).

[Documentation](https://docs.colyseus.io/)

## :crossed_swords: Usage

```
npm start
```

Then open http://localhost:2567 for the playground, or /monitor for the monitor.

## Deployment (Render)

The repository ships a `render.yaml` Blueprint: one persistent **Web
Service** (`runtime: docker`) built from the existing Dockerfile
(bun 1.4.2, `bun install --frozen-lockfile`, `tsc` → `build/index.js`,
started with `bun build/index.js`).

1. Push this repository to GitHub/GitLab.
2. In Render: **New → Blueprint**, select the repo — Render detects
   `render.yaml` and creates the `server-games` web service.
3. Set the secret when prompted: `REALTIME_TOKEN_SECRET` (same
   byte-for-byte value as the Next.js platform's `REALTIME_TOKEN_SECRET`.
   Never commit it).
4. Wait for the image build, then check `https://<your-service>.onrender.com/health`
   → `{"status":"ok"}`.
5. Point the game platform's realtime URL at the service
   (`wss://<your-service>.onrender.com`); Render terminates TLS and
   forwards WebSocket traffic — Colyseus matchmaking works unchanged.

Useful checks: the service log shows `⚔️ Listening on …` with the bound
port; `/health` is the readiness probe; a full matchmaking round-trip
(create → join → leave) is the real validation, `/health` alone is not.

## Production commands (local)

```
bun install --frozen-lockfile
npm run build        # tsc → build/index.js
npm run start:prod   # bun run build/index.js
```

`NODE_ENV=production` hides the playground/monitor routes; `PORT`
selects the listen port (default 2567).

## Structure

- `src/index.ts`: entry point — leave it alone if you plan to deploy to Colyseus Cloud
- `src/app.config.ts`: server configuration — rooms, HTTP routes, express middleware
- `src/rooms/MyRoom.ts`: your room handler
- `src/rooms/schema/MyRoomState.ts`: the state synchronized to every client in the room
- `test/MyRoom.test.ts`: boots the real server and connects a real client
- `loadtest/example.ts`: scriptable client for `npm run loadtest`
- `ecosystem.config.cjs`: pm2 configuration, used when deploying to Colyseus Cloud

## Scripts

- `npm start`: run the server in watch mode (`tsx watch src/index.ts`)
- `npm test`: run the mocha test suite
- `npm run build`: compile to `build/`
- `npm run loadtest`: connect N simulated clients with [`@colyseus/loadtest`](https://github.com/colyseus/colyseus-loadtest/)

## What's included

### Turn-based

`MyRoom` owns the turn order: `state.currentTurn` names whose turn it is, and a
`play` message from anyone else is ignored. The room locks once it is full, and
each turn carries a deadline — a `clock.setTimeout` skips a player who runs out
the clock, so one idle client cannot stall the match.

`state.turnDeadline` is stamped from `this.clock.currentTime`, the room's own
clock, so a reconnecting client can render the remaining time without the server
sending a countdown.

- https://docs.colyseus.io/room/timing-events

### Reconnection

`MyRoom.onDrop()` holds a dropped client's seat for 30 seconds via
`allowReconnection()`. The SDK retries automatically with exponential backoff;
`onReconnect()` fires if it gets back in time, `onLeave()` if it does not.

- https://docs.colyseus.io/room/reconnection
