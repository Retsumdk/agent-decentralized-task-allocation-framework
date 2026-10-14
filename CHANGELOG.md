# Changelog

All notable changes to this project are documented here.
This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-10-14

First stable release. The framework is complete end to end: capability-aware
placement, three load-balancing strategies, lease recovery, retry with
dead-lettering, durable state, a zero-dependency HTTP API, and a CLI.

### Added

- **Agent registry** — agents register `capabilities`, `capacity` (max
  concurrent tasks), `weight` (fair share under round robin) and a heartbeat
  clock. Agents can be patched, drained, and removed; a drained agent finishes
  what it holds but takes nothing new.
- **Task store** — tasks declare `requires` (capabilities the assigned agent
  must have), `cost` (DRR credit consumed), `priority` (higher allocates first)
  and `maxAttempts`. The store keeps the full per-task history; dead tasks are
  never deleted.
- **Three allocation strategies**:
  - `least-loaded` — lowest current utilization (`running / capacity`), ties
    broken by agent id.
  - `round-robin` — deficit round robin: agents accrue `weight × deficitQuantum`
    credits per round (capped at `maxDeficit`) and must cover a task's `cost` to
    take it, so long-run work share is proportional to `weight`. A task costing
    more than a round's quantum waits and is reported as
    `deferredInsufficientDeficit` rather than being placed unfairly.
  - `pack` — highest utilization first (best-fit), concentrating load and
    leaving whole agents free for bursts.
- **Lease recovery via `tick()`** — every running task held by an agent whose
  heartbeat lapsed past `heartbeatTimeoutMs` is requeued, and the attempt count
  increments, so a flapping agent cannot retry forever.
- **Retry with dead-lettering** — failed tasks requeue while attempts remain and
  move to `dead` with their failure reason once `maxAttempts` is exhausted.
- **Fairness metric** — `stats()` reports the Jain fairness index over
  capacity-weighted shares (each agent's assignment count divided by its
  weight), so a fleet doing exactly its proportional share scores 1.0.
- **Durable state** — optional atomic tmp+rename JSON persistence; corrupt or
  missing state files fail loudly rather than silently resetting a fleet.
- **Zero-dependency HTTP API** (`node:http`) — register, list, patch, heartbeat
  and remove agents; add, allocate, complete and fail tasks; `stats`, `tick`
  and a `healthz` probe. Mutations require a bearer token when one is
  configured, compared in constant time; malformed bodies are rejected with 400.
- **Zero-dependency CLI** (`agent-task-allocator`) built on `node:util`
  `parseArgs`, including a deterministic `demo` command whose transcript is
  asserted byte-for-byte by the test suite.
- **Config bounds enforced at construction** — task cost ∈ [1, 100], priority ∈
  [−1000, 1000], maxAttempts ∈ [1, 10], capacity ∈ [1, 1024], weight ∈ [0, 100].

### Notes

- Zero runtime dependencies. Node >= 20.
- The package is not published to the npm registry; install it from GitHub with
  `npm install github:Retsumdk/agent-decentralized-task-allocation-framework`
  (the `prepare` script compiles `dist/`). With Bun, run `bun pm trust
  agent-decentralized-task-allocation-framework` after adding it, since Bun
  blocks a git dependency's lifecycle scripts by default.
- Test suite: 52 tests / 193 assertions across allocator, fairness,
  persistence, HTTP API and CLI.

[1.0.0]: https://github.com/Retsumdk/agent-decentralized-task-allocation-framework/releases/tag/v1.0.0
