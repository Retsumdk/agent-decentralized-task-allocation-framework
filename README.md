# agent-decentralized-task-allocation-framework

Distributed task allocation for agent fleets — capability matching, three load-balancing strategies (including deficit round robin for weight-proportional fairness), heartbeat-based lease recovery, retry with dead-lettering, an optional durable state file, a zero-dependency HTTP API, and a CLI.

MIT licensed. Zero runtime dependencies. Node >= 20.

## Why this exists

When a fleet of autonomous agents pulls work from a shared queue, the naive answer — "everyone grabs what they can" — fails in three predictable ways:

1. **Capability mismatches.** A GPU render lands on an agent that can't run it, fails, and wastes a retry cycle. Nobody tracks what each agent can actually do.
2. **Unfair and unbalanced loads.** Fast or greedy agents hoard work while idle agents starve — or the opposite: one oversized agent gets everything while several small ones sit at zero utilization.
3. **Silent agent death.** An agent crashes or netsplits with claimed tasks. Without lease tracking, those tasks are lost or double-run. Without retry accounting, a poison task loops forever.

Existing schedulers (Kubernetes, Celery, message queues) solve this for containers and workers, but they assume you control the workers' code and runtime. Multi-agent systems rarely have that luxury: agents are independent processes, often on different machines, that can only heartbeat and ack. This framework is the scheduling layer for exactly that setting — agents register capabilities, tasks declare requirements, and the framework assigns fairly, rebalances from dead agents, and dead-letters poison work.

## How it works

```
                 ┌────────────────────────────────────────────┐
                 │                 Allocator                  │
                 │                                            │
  register ────► │  AgentRegistry          TaskStore          │
  heartbeat ───► │  (caps, capacity,      (requires, cost,    │
  task ────────► │   weight, status)       priority, attempts)│
                 │        │                     │             │
                 │        ▼                     ▼             │
                 │   ┌─────────── allocation ────────────┐    │
                 │   │ least-loaded | round-robin | pack │    │
                 │   └───────────────┬───────────────────┘    │
                 │                   │                        │
                 │   complete / fail ───► tick (lease recovery)│
                 │                   │                        │
                 │              stats (Jain fairness)          │
                 └───────────────────┬────────────────────────┘
                                     │
                    persistence (atomic tmp+rename JSON)
                                     │
                          HTTP API (node:http) / CLI
```

### Concepts

- **Agent** — a worker with `capabilities` (e.g. `web`, `gpu`, `email`), a `capacity` (max concurrently running tasks), a `weight` (its fair share of work under round-robin), and a heartbeat clock. Drained agents finish what they hold but take nothing new.
- **Task** — a unit of work with `requires` (capabilities the assigned agent must have), a `cost` (how much DRR credit it consumes), a `priority` (higher allocates first), and `maxAttempts`.
- **Allocation round** — one call to `allocate()`. Queued tasks are considered highest-priority-first; each goes to the best eligible agent under the chosen strategy or stays queued.
- **Tick (lease recovery)** — `tick()` requeues every running task held by an agent whose heartbeat lapsed past `heartbeatTimeoutMs`. A requeued task's attempt count increments, so a flapping agent cannot retry forever.

### Task lifecycle

```
            allocate            complete
  queued ──────────► running ───────────► completed
     ▲                  │ │
     │  fail (retries   │ │  fail (attempts exhausted)
     │  remain)         │ ▼
     └──────────────────┘ └──────────────► dead
                          tick (agent's
                          lease expired,
                          attempts remain)
```

Dead tasks are never deleted — they stay in the store with their failure reason and full history for inspection.

### The three strategies

| Strategy | Placement rule | Use when |
|---|---|---|
| `least-loaded` | Lowest current utilization (`running / capacity`), ties broken by agent id | You want every agent kept equally busy |
| `round-robin` | Deficit round robin: agents accrue `weight × deficitQuantum` credits per round, must cover a task's `cost` to take it | You want long-run work share proportional to `weight` |
| `pack` | Highest utilization first (best-fit) | You want to concentrate load and leave whole agents free for bursts |

**Deficit round robin in one paragraph.** Each allocation round, every candidate agent's deficit grows by `weight × deficitQuantum` (capped at `maxDeficit`). A task of cost `c` is only placed on an agent whose deficit is at least `c`; placement subtracts `c`. A weight-3 agent therefore gains credits three times as fast and wins roughly three times the work. A task costing more than a round's quantum simply waits a few rounds for credits to accumulate — the queue reports this as `deferredInsufficientDeficit`. Zero-weight agents are never chosen by round-robin (they remain eligible under the other two strategies).

### Fairness metric

`stats()` reports the **Jain fairness index** over *capacity-weighted shares*: each agent's assignment count divided by its weight. Shares equal ⇒ index `1.0`; concentration ⇒ index near `0`. Because it normalizes by weight, a fleet where every agent does exactly its proportional share scores a perfect 1.0.

## Getting started

**Run from a clone:**

```bash
git clone https://github.com/Retsumdk/agent-decentralized-task-allocation-framework.git
cd agent-decentralized-task-allocation-framework
bun install
bun test
bun src/cli.ts demo
```

**Install as a library from GitHub** (the package is not on the npm registry; git installs run the `prepare` script, which compiles `dist/`):

```bash
npm install github:Retsumdk/agent-decentralized-task-allocation-framework
```

With Bun, lifecycle scripts of git dependencies are blocked by default — trust the package once after installing, or the import will fail:

```bash
bun add github:Retsumdk/agent-decentralized-task-allocation-framework
bun pm trust agent-decentralized-task-allocation-framework
```

### Library example

```typescript
import { Allocator } from "agent-decentralized-task-allocation-framework";

const allocator = new Allocator();

allocator.agents.register({ id: "node-1", capabilities: ["web"], capacity: 2 }, Date.now());
allocator.agents.register({ id: "node-2", capabilities: ["web"], capacity: 2 }, Date.now());

allocator.tasks.add({ id: "job-a", requires: ["web"] }, Date.now(), 3);
allocator.tasks.add({ id: "job-b", requires: ["web"] }, Date.now(), 3);

const result = allocator.allocate(Date.now(), { strategy: "least-loaded" });
// assignments: job-a -> node-1, job-b -> node-2 (each idle agent takes one job)

for (const assignment of result.assignments) {
  allocator.complete(assignment.taskId, Date.now());
}

console.log(allocator.stats(Date.now()).tasks);   // { queued: 0, running: 0, completed: 2, dead: 0 }
console.log(allocator.stats(Date.now()).jainFairnessIndex);  // 1 — perfectly proportional
```

Note the argument order: `now` (a millisecond timestamp) is always passed explicitly, so the whole engine is deterministic and trivially testable — no hidden wall-clock reads.

## CLI

Every stateful command accepts `--state <file>`. Without it, state is loaded from and saved to `./allocator-state.json`. Exit codes: `0` success, `1` runtime error, `2` usage error.

| Command | Purpose |
|---|---|
| `demo` | Deterministic end-to-end walkthrough (below) |
| `register <agent-id> --caps a,b [--capacity N] [--weight W] [--drained]` | Register an agent |
| `task <task-id> [--requires a,b] [--cost N] [--priority P] [--max-attempts N]` | Queue a task |
| `allocate [--strategy s] [--max N]` | Run one allocation round |
| `complete <task-id> [--note text]` | Record success |
| `fail <task-id> [--note text]` | Record failure (requeues or dead-letters) |
| `heartbeat <agent-id>` | Refresh an agent's lease |
| `patch <agent-id> [--caps …] [--capacity N] [--weight W] [--status active\|drained]` | Update an agent |
| `remove-agent <agent-id>` | Deregister (refuses while tasks are running) |
| `agents` / `tasks [--status s] [--assigned-to id]` | Inspect state |
| `stats` | Counters, utilization, Jain fairness |
| `tick` | Requeue work from agents with expired leases |
| `serve --port N [--token secret]` | Serve the HTTP API |

### A real session

```text
$ bun src/cli.ts register gpu-lab --caps gpu --capacity 2 --weight 3
{
  "id": "gpu-lab",
  "capabilities": [
    "gpu"
  ],
  "capacity": 2,
  "weight": 3,
  "status": "active",
  "runningTasks": [],
  "completedCount": 0,
  "failedCount": 0,
  "reassignments": 0,
  "lastHeartbeat": 1791836924347,
  "registeredAt": 1791836924347,
  "deficit": 0
}
$ bun src/cli.ts task crawl-1 --requires web --cost 4   # plus digest-1 (email, cost 2), queued the same way
$ bun src/cli.ts allocate --strategy least-loaded
{
  "assignments": [
    {
      "taskId": "render-1",
      "agentId": "gpu-lab",
      "strategy": "least-loaded"
    },
    {
      "taskId": "crawl-1",
      "agentId": "worker-1",
      "strategy": "least-loaded"
    }
  ],
  "deferred": 0,
  "breakdown": {
    "candidates": 3,
    "eligible": 2,
    "skippedNoCapacity": 0,
    "skippedNoCapability": 0,
    "deferredInsufficientDeficit": 0
  }
}
$ bun src/cli.ts complete crawl-1 --note "200 OK"
$ bun src/cli.ts stats
{
  "tasks": {
    "queued": 0,
    "running": 1,
    "completed": 1,
    "dead": 0
  },
  "jainFairnessIndex": 0.533333
}
```

## Demo

`alloc demo` runs the whole story on a fixed clock — register a mixed fleet, allocate under each strategy, fail and retry a task, let one GPU agent go silent, recover its work via tick, and print fairness stats. Byte-identical on every run:

```
$ bun src/cli.ts demo
== agent-decentralized-task-allocation-framework demo ==

registered 4 agents: general-a (web,email cap=4 w=1), general-b (web,email cap=4 w=1),
                     gpu-lab (gpu cap=2 w=3), gpu-backup (gpu cap=2 w=1)

queued 5 tasks: render-1 (gpu, cost 8, prio 10), render-2 (gpu, cost 6, prio 5),
                crawl-1 (web, cost 4, prio 5), crawl-2 (web, cost 4), digest-1 (email, cost 2)

round 1 - least-loaded (work goes to the emptiest capable agent)
  candidates=4 assigned=5 deferred=0 (no-capability=0, no-capacity=0, awaiting-deficit=0)
  render-1 -> gpu-backup
  crawl-1 -> general-a
  render-2 -> gpu-lab
  crawl-2 -> general-b
  digest-1 -> general-a

crawl-1 completed by general-a (note: 200 OK)
crawl-2 failed once: requeued (attempt 1/3)

round 2 - round-robin (deficit credits; crawl-2 re-allocated after its retry)
  candidates=4 assigned=1 deferred=0 (no-capability=0, no-capacity=0, awaiting-deficit=0)
  crawl-2 -> general-a

tick: stale agents=[gpu-lab] tasks requeued=1 dead-lettered=0

round 3 - round-robin (render-2 recovered from the offline gpu-lab)
  candidates=3 assigned=1 deferred=0 (no-capability=0, no-capacity=0, awaiting-deficit=0)
  render-2 -> gpu-backup

all running tasks completed

final stats:
  tasks: queued=0 running=0 completed=5 dead=0
  general-a: assignments=3 utilization=0
  general-b: assignments=1 utilization=0
  gpu-backup: assignments=2 utilization=0
  gpu-lab: assignments=0 utilization=0
  jain fairness index (capacity-weighted): 0.642857
  1.0 = every agent's work share is exactly proportional to its weight;
  gpu-lab's idle share (offline mid-run) is what pulls the index below 1.0
```

## HTTP API

`serve --port N` exposes the engine over zero-dependency `node:http`. GET routes are open; every mutating route requires `Authorization: Bearer <token>` when `--token` is configured (constant-time comparison). When `--state` is passed, every successful mutation persists.

| Method | Path | Purpose |
|---|---|---|
| GET | `/healthz` | Liveness |
| GET | `/stats` | Fairness and utilization snapshot |
| GET | `/config` | Active configuration |
| GET | `/agents` | List agents |
| POST | `/agents` | Register (`{ id?, capabilities, capacity?, weight?, status? }`) |
| GET | `/agents/:id` | Fetch one agent |
| PATCH | `/agents/:id` | Update capabilities/capacity/weight/status |
| DELETE | `/agents/:id` | Deregister (409 while tasks are running) |
| POST | `/agents/:id/heartbeat` | Refresh the lease |
| GET | `/tasks?status=&assignedTo=` | List tasks |
| POST | `/tasks` | Queue (`{ id?, requires?, cost?, priority?, maxAttempts? }`) |
| GET | `/tasks/:id` | Fetch one task (full history) |
| POST | `/allocate` | Run a round (`{ strategy?, max? }`) |
| POST | `/tasks/:id/complete` | Complete (`{ note? }`) |
| POST | `/tasks/:id/fail` | Fail (`{ note? }`) — response says `retried` or `deadLettered` |
| POST | `/tick` | Lease recovery sweep |

Errors are structured: `{ "code": "VALIDATION" | "NOT_FOUND" | "CONFLICT" | "CORRUPTION" | "CONFIG" | "UNAUTHORIZED", "message": … }` with matching HTTP status (400/404/409/500/500/401).

## Configuration

| Knob | Default | Meaning |
|---|---|---|
| `heartbeatTimeoutMs` | `30000` | Agents silent longer than this lose their leases on the next `tick()` |
| `defaultMaxAttempts` | `3` | `maxAttempts` for tasks that do not specify one |
| `deficitQuantum` | `10` | DRR credits added per round, scaled by agent weight |
| `maxDeficit` | `100` | Upper bound on accumulated credit |

Bounds enforced at construction: task cost ∈ [1, 100], priority ∈ [-1000, 1000], maxAttempts ∈ [1, 10], capacity ∈ [1, 1024], weight ∈ [0, 100].

## Project layout

```
src/
  allocator.ts    allocation engine: strategies, lifecycle, tick, stats, state
  registry.ts     agent registry (capabilities, capacity, weight, status)
  tasks.ts        task store (priority queue ordering, validation, history)
  fairness.ts     Jain index + DRR credit math (pure functions)
  persistence.ts  atomic tmp+rename JSON persistence
  server.ts       zero-dep node:http API with bearer auth
  cli.ts          zero-dep parseArgs CLI
  demo.ts         deterministic demo
  types.ts        shared types + config defaults
  errors.ts       AllocationError hierarchy
tests/
  allocator.test.ts   strategies, lifecycle, tick, stats, state round-trip
  fairness.test.ts    DRR + Jain properties
  persistence.test.ts save/load/corruption
  server.test.ts      HTTP API over real loopback sockets
  cli.test.ts         CLI end-to-end incl. byte-for-byte demo transcript
```

## Related repos

Part of a series on agent operations primitives:

- [agent-task-queue](https://github.com/Retsumdk/agent-task-queue) — persistent task queue for a single orchestrator
- [agent-swarm-orchestrator](https://github.com/Retsumdk/agent-swarm-orchestrator) — swarm lifecycle and messaging
- [serverless-retry-queue](https://github.com/Retsumdk/serverless-retry-queue) — retry/backoff scheduling with the same dead-letter discipline
- [gcs-job-scheduler](https://github.com/Retsumdk/gcs-job-scheduler) — cron-style scheduling for maintenance jobs

## License

[MIT](LICENSE) — Copyright (c) 2026 Retsumdk
