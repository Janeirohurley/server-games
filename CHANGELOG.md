# Changelog

All notable changes to the Game Arena server are documented here.

## [0.4.7] - 2026-10-11

### Fixed

* Persist closed-room outcomes and retain a read-only room for 24 hours so
  disconnected requesters can recover the closure result after reconnect or
  process restart.

## [0.4.6] - 2026-10-11

### Fixed

* Store request and outcome timestamps as epoch-millisecond numbers instead of
  clamping them to `uint32` or relying on a process-relative room clock.
* Restore recent rejected/cancelled/expired outcomes after reconnect rather
  than silently creating another request.

## [0.4.5] - 2026-10-11

### Fixed

* Persist host approval/rejection, requester cancellation and expiration before
  publishing terminal outcomes; failed writes leave requests recoverable.
* Serialize decisions and expirations so simultaneous host actions cannot
  exceed room capacity or contradict one another.

## [0.4.4] - 2026-10-10

### Fixed

* Serialized concurrent retries for the same user while durable registration
  is in flight, preventing duplicate writes and host notifications.

## [0.4.3] - 2026-10-10

### Fixed

* Restored lobby snapshots through Colyseus' historical room-id path so
  existing invitation links remain valid after a process restart.

## [0.4.2] - 2026-10-10

### Fixed

* Persisted new and changed join-request state before acknowledging a durable
  registration, with an explicit failure event when persistence is unavailable.

## [0.4.1] - 2026-10-10

### Fixed

* Rehydrated persisted lobby players, pending requests and terminal outcomes
  into typed Colyseus schemas after a process restart.
* Added regression coverage for restart snapshot recovery.

## [0.4.0] - 2026-10-10

### Added

* Added durable PostgreSQL snapshots for WAITING/READY lobbies so pending join
  requests can be recovered after a process crash or server restart.
* Added startup rehydration of lobby identity, capacity, host and request state.

### Reliability

* Documented the explicit boundary that in-progress matches are not restored
  without a separate game-session recovery design.

## [0.3.0] - 2026-10-10

### Added

* Added stable, idempotent join-request registration and terminal outcomes.
* Added recovery of pending requests after temporary disconnections.
* Added server-side expiration after ten minutes and opt-in request diagnostics.
* Reserved approved seats while the requester is offline.

### Fixed

* Prevented duplicate notifications and approvals after retries.
