# Reliable join requests

## Current guarantee

Join requests are authoritative room state, not one-shot WebSocket notifications.
Each request has a stable `requestId`. The server stores one pending request per
`userId`, acknowledges registration with `joinRequestRegistered`, and records
terminal outcomes in `joinRequestResults`.

When lobby persistence is enabled, `joinRequestRegistered` is sent only after
the current lobby snapshot has been written successfully. A persistence error
produces `joinRequestRegistrationFailed` so the client can retry without
claiming that the request was accepted.

Host decisions, requester cancellation, and server expiration are likewise
written before the terminal state is published. A failed write preserves the
pending request and emits `joinRequestDecisionFailed` to the actor. Decision
and expiration mutations are serialized within a room to keep capacity checks
and terminal outcomes consistent.

The lifecycle is `pending → accepted | rejected | cancelled | expired`.
Retries reuse the same identifier and return the existing registration instead of
creating duplicates. Only the authenticated host can approve or reject a request,
and an accepted request reserves a seat until its requester reconnects or the
ten-minute approval window expires.
Closed rooms are retained as read-only rooms for 24 hours. Pending requests are
stored as `expired` with reason `room-closed`, then the tombstone is removed.

Request and terminal timestamps use epoch milliseconds (`number`), so their
ten-minute expiration remains correct across process restarts and cannot overflow
the 32-bit schema range. A recent terminal result is restored on reconnect rather
than being silently converted into a fresh request.

## Reconnection behavior

- A dropped pending requester remains recoverable in the room queue.
- A host approval is retained while the requester is offline; the next join seats
  that user and emits the authoritative approval.
- Pending requests expire server-side after ten minutes and emit
  `joinRequestExpired`.
- Optional structured diagnostics use `REALTIME_JOIN_REQUEST_LOGS=1` and contain
  room, request, user and event identifiers only.

## Persistence boundary

Lobby rooms in `WAITING` or `READY`, and closed-room tombstones, are snapshotted
to PostgreSQL in production when `DATABASE_URL` is configured. The snapshot
contains the room identity, creation options, host identity, capacity, and
authoritative join-request state. At process startup, the server awaits snapshot
restoration in Colyseus' `beforeListen` hook; the transport does not accept
connections until rooms are recovered. Pending requests therefore remain
recoverable after a process crash or Render restart, with the original room ID
preserved for existing invitation links.

This persistence is deliberately limited to lobbies. An in-progress match is
removed from the snapshot store and is not rehydrated, because restoring it
without its simulation timers and transient player connections would create a
false state. A server restart during an active match therefore still requires a
separate game-session recovery design.

Development without persistence is memory-only and does not provide restart
recovery. Production requires `DATABASE_URL` and fails before opening its
transport if it is absent, cannot be reached, or an existing snapshot cannot be
restored. A database outage after startup leaves the process up, but affected
request writes receive a retryable persistence error and are not acknowledged
as registered.

The opt-in PostgreSQL integration test requires a dedicated disposable database:

```sh
DATABASE_URL="$REALTIME_ROOM_TEST_DATABASE_URL" \
REALTIME_ROOM_PERSISTENCE=1 \
bunx mocha -r tsx -r test/test-server.ts \
  test/room-snapshot-store.integration.test.ts --timeout 15000 --exit
```

Set `REALTIME_ROOM_TEST_DATABASE_URL` to the same connection string before
running the command. The test writes a pending request, destroys the room, calls
the startup restoration path, and verifies that the requester recovers the
request. The current deployment assumes one authoritative game process (the
normal Render service configuration); multi-process shared matchmaker/locking
would need an additional deployment design.
