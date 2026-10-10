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

The lifecycle is `pending → accepted | rejected | cancelled | expired`.
Retries reuse the same identifier and return the existing registration instead of
creating duplicates. Only the authenticated host can approve or reject a request,
and an accepted request reserves a seat until its requester reconnects or the
ten-minute approval window expires.

## Reconnection behavior

- A dropped pending requester remains recoverable in the room queue.
- A host approval is retained while the requester is offline; the next join seats
  that user and emits the authoritative approval.
- Pending requests expire server-side after ten minutes and emit
  `joinRequestExpired`.
- Optional structured diagnostics use `REALTIME_JOIN_REQUEST_LOGS=1` and contain
  room, request, user and event identifiers only.

## Persistence boundary

Lobby rooms in `WAITING` or `READY` are snapshotted to PostgreSQL when
`NODE_ENV=production` and `DATABASE_URL` are configured. The snapshot contains
the room identity, creation options, host identity, capacity, and authoritative
join-request state. It is restored at server startup before normal room use, so
pending requests remain recoverable after a process crash or Render restart,
with the original room ID preserved for existing invitation links.

This persistence is deliberately limited to lobbies. An in-progress match is
removed from the snapshot store and is not rehydrated, because restoring it
without its simulation timers and transient player connections would create a
false state. A server restart during an active match therefore still requires a
separate game-session recovery design.

Development/tests can opt in with `REALTIME_ROOM_PERSISTENCE=1`. If the database
is unavailable, the server continues in memory-only mode and logs the degraded
guarantee. The current deployment assumes one authoritative game process (the
normal Render service configuration); multi-process shared matchmaker/locking
would need an additional deployment design.
