# Reliable join requests

## Current guarantee

Join requests are authoritative room state, not one-shot WebSocket notifications.
Each request has a stable `requestId`. The server stores one pending request per
`userId`, acknowledges registration with `joinRequestRegistered`, and records
terminal outcomes in `joinRequestResults`.

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

Colyseus room state is process-memory state. It survives socket loss and reconnect
while the room instance exists, but not a server restart, process crash, or room
destruction. The current database integration is for the admin plugin, not a
durable room/game state store.

The implementation therefore guarantees recovery across temporary disconnections,
not after server loss. Stronger recovery requires a persistent room registry,
durable request records, and room rehydration; a request table alone is
insufficient because room, player, and capacity state would also need restoring.
