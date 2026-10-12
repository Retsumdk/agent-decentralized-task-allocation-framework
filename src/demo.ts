import { Allocator } from "./allocator.js";
import type { AllocateResult, Stats, TickResult } from "./types.js";

/**
 * Deterministic walkthrough of the allocation framework. Every clock
 * value is fixed, so running `demo` twice prints byte-identical output.
 *
 * Scenario: two generalist agents and two GPU specialists. Tasks are
 * allocated under the three strategies, one task fails and is retried,
 * an offline agent's lease is recovered by tick, and the fairness index
 * is reported at the end.
 */
export function demo(): void {
  const allocator = new Allocator({
    config: { heartbeatTimeoutMs: 30_000, defaultMaxAttempts: 3, deficitQuantum: 10, maxDeficit: 100 },
  });
  let clock = 1_700_000_000_000;

  console.log("== agent-decentralized-task-allocation-framework demo ==");
  console.log("");

  const beat = (id: string): void => allocator.heartbeat(id, clock);
  for (const id of ["general-a", "general-b", "gpu-lab", "gpu-backup"]) {
    allocator.agents.register({ id, capabilities: id.startsWith("gpu") ? ["gpu"] : ["web", "email"], capacity: id.startsWith("gpu") ? 2 : 4, weight: id === "gpu-lab" ? 3 : 1 }, clock);
  }
  console.log("registered 4 agents: general-a (web,email cap=4 w=1), general-b (web,email cap=4 w=1),");
  console.log("                     gpu-lab (gpu cap=2 w=3), gpu-backup (gpu cap=2 w=1)");
  console.log("");

  clock += 1_000;
  const taskSpecs: Array<{ id: string; requires: string[]; cost: number; priority: number }> = [
    { id: "render-1", requires: ["gpu"], cost: 8, priority: 10 },
    { id: "render-2", requires: ["gpu"], cost: 6, priority: 5 },
    { id: "crawl-1", requires: ["web"], cost: 4, priority: 5 },
    { id: "crawl-2", requires: ["web"], cost: 4, priority: 0 },
    { id: "digest-1", requires: ["email"], cost: 2, priority: 0 },
  ];
  for (const spec of taskSpecs) {
    allocator.tasks.add(spec, clock, allocator.config.defaultMaxAttempts);
  }
  console.log("queued 5 tasks: render-1 (gpu, cost 8, prio 10), render-2 (gpu, cost 6, prio 5),");
  console.log("                crawl-1 (web, cost 4, prio 5), crawl-2 (web, cost 4), digest-1 (email, cost 2)");
  console.log("");

  clock += 1_000;
  for (const id of ["general-a", "general-b", "gpu-lab", "gpu-backup"]) beat(id);
  const least = allocator.allocate(clock, { strategy: "least-loaded" });
  printRound("round 1 - least-loaded (work goes to the emptiest capable agent)", least);
  printAssignments(least);
  console.log("");

  clock += 1_000;
  for (const id of ["general-a", "general-b", "gpu-lab", "gpu-backup"]) beat(id);
  allocator.complete("crawl-1", clock, "200 OK");
  const failure = allocator.fail("crawl-2", clock, "upstream 503");
  console.log("crawl-1 completed by general-a (note: 200 OK)");
  console.log(`crawl-2 failed once: ${failure.retried ? "requeued" : "dead-lettered"} (attempt 1/3)`);
  console.log("");

  clock += 1_000;
  for (const id of ["general-a", "general-b", "gpu-lab", "gpu-backup"]) beat(id);
  const retried = allocator.allocate(clock, { strategy: "round-robin" });
  printRound("round 2 - round-robin (deficit credits; crawl-2 re-allocated after its retry)", retried);
  printAssignments(retried);
  console.log("");

  clock += 60_000;
  // gpu-lab stops heartbeating while holding render-2; the others stay live.
  beat("general-a");
  beat("general-b");
  beat("gpu-backup");
  const tick = allocator.tick(clock);
  printTick(tick);
  console.log("");

  clock += 1_000;
  beat("general-a");
  beat("general-b");
  beat("gpu-backup");
  const recovered = allocator.allocate(clock, { strategy: "round-robin" });
  printRound("round 3 - round-robin (render-2 recovered from the offline gpu-lab)", recovered);
  printAssignments(recovered);
  console.log("");

  clock += 1_000;
  for (const [taskId, note] of [
    ["render-1", "mp4 rendered"],
    ["render-2", "mp4 rendered"],
    ["crawl-2", "succeeded on retry"],
    ["digest-1", "sent"],
  ] as const) {
    const task = allocator.tasks.get(taskId);
    if (task.status === "running" && task.assignedTo !== null) {
      allocator.complete(taskId, clock, note);
    }
  }
  console.log("all running tasks completed");
  console.log("");

  printStats(allocator.stats(clock));
}

function printRound(label: string, result: AllocateResult): void {
  console.log(label);
  console.log(
    `  candidates=${result.breakdown.candidates} assigned=${result.assignments.length}` +
      ` deferred=${result.deferred} (no-capability=${result.breakdown.skippedNoCapability},` +
      ` no-capacity=${result.breakdown.skippedNoCapacity}, awaiting-deficit=${result.breakdown.deferredInsufficientDeficit})`,
  );
}

function printAssignments(result: AllocateResult): void {
  for (const assignment of result.assignments) {
    console.log(`  ${assignment.taskId} -> ${assignment.agentId}`);
  }
}

function printTick(tick: TickResult): void {
  console.log(`tick: stale agents=[${tick.staleAgents.join(", ")}] tasks requeued=${tick.reassigned} dead-lettered=${tick.deadLettered}`);
}

function printStats(stats: Stats): void {
  console.log("final stats:");
  console.log(`  tasks: queued=${stats.tasks.queued} running=${stats.tasks.running} completed=${stats.tasks.completed} dead=${stats.tasks.dead}`);
  for (const id of Object.keys(stats.assignmentsPerAgent).sort()) {
    const utilization = stats.utilizationPerAgent[id] ?? 0;
    console.log(`  ${id}: assignments=${stats.assignmentsPerAgent[id]} utilization=${utilization}`);
  }
  console.log(`  jain fairness index (capacity-weighted): ${stats.jainFairnessIndex}`);
  console.log("  1.0 = every agent's work share is exactly proportional to its weight;");
  console.log("  gpu-lab's idle share (offline mid-run) is what pulls the index below 1.0");
}
