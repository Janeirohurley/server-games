# Changelog

All notable changes to the Game Arena server are documented here.

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
