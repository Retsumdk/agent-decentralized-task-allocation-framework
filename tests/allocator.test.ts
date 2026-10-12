import { describe, expect, test } from "bun:test";
import { AllocationError } from "../src/errors.js";
import { Allocator, parseStrategy } from "../src/allocator.js";
import { DEFAULT_CONFIG, type AllocateResult, type Task } from "../src/types.js";

const BASE = 1_700_000_000_000;

function freshAllocator(): Allocator {
  return new Allocator({
    config: { heartbeatTimeoutMs: 30_000, defaultMaxAttempts: 2 },
  });
}

function fleet(allocator: Allocator, now: number): void {
  allocator.agents.register({ id: "alpha", capabilities: ["web", "email"], capacity: 4, weight: 1 }, now);
  allocator.agents.register({ id: "beta", capabilities: ["web"], capacity: 4, weight: 1 }, now);
  allocator.agents.register({ id: "gpu-1", capabilities: ["web", "gpu"], capacity: 2, weight: 3 }, now);
}

describe("agent registry", () => {
  test("registers with defaults and validates inputs", () => {
    const allocator = freshAllocator();
    const agent = allocator.agents.register({ capabilities: ["web"] }, BASE);
    expect(agent.id).toBe("agent-1");
    expect(agent.capacity).toBe(4);
    expect(agent.weight).toBe(1);
    expect(agent.status).toBe("active");

    expect(() => allocator.agents.register({ capabilities: [] }, BASE)).toThrow(AllocationError);
    expect(() => allocator.agents.register({ capabilities: ["web"], capacity: 0 }, BASE)).toThrow(AllocationError);
    expect(() => allocator.agents.register({ capabilities: ["web"], weight: -1 }, BASE)).toThrow(AllocationError);
    allocator.agents.register({ id: "alpha", capabilities: ["web"] }, BASE);
    expect(() => allocator.agents.register({ id: "alpha", capabilities: ["web"] }, BASE)).toThrow(AllocationError);
  });

  test("patch refuses capacity below current load and validates status", () => {
    const allocator = freshAllocator();
    allocator.agents.register({ id: "a", capabilities: ["web"], capacity: 2 }, BASE);
    allocator.tasks.add({ id: "t1", requires: ["web"] }, BASE, DEFAULT_CONFIG.defaultMaxAttempts);
    allocator.tasks.add({ id: "t2", requires: ["web"] }, BASE, DEFAULT_CONFIG.defaultMaxAttempts);
    allocator.allocate(BASE, {});
    expect(allocator.agents.get("a").runningTasks).toHaveLength(2);
    expect(() => allocator.agents.patch("a", { capacity: 1 })).toThrow(AllocationError);
    expect(() => allocator.agents.patch("a", { status: "paused" as never })).toThrow(AllocationError);
    const patched = allocator.agents.patch("a", { capacity: 3, status: "drained" });
    expect(patched.capacity).toBe(3);
    expect(patched.status).toBe("drained");
  });

  test("remove refuses agents with running tasks", () => {
    const allocator = freshAllocator();
    allocator.agents.register({ id: "a", capabilities: ["web"] }, BASE);
    allocator.tasks.add({ id: "t1", requires: ["web"] }, BASE, DEFAULT_CONFIG.defaultMaxAttempts);
    allocator.allocate(BASE, { max: 1 });
    expect(() => allocator.agents.remove("a")).toThrow(AllocationError);
    allocator.complete("t1", BASE + 1);
    expect(allocator.agents.remove("a").id).toBe("a");
  });
});

describe("task store", () => {
  test("validates cost, priority, and attempts ranges", () => {
    const allocator = freshAllocator();
    expect(() => allocator.tasks.add({ id: "t", cost: 0 }, BASE, 3)).toThrow(AllocationError);
    expect(() => allocator.tasks.add({ id: "t", cost: 101 }, BASE, 3)).toThrow(AllocationError);
    expect(() => allocator.tasks.add({ id: "t", priority: 1001 }, BASE, 3)).toThrow(AllocationError);
    expect(() => allocator.tasks.add({ id: "t", maxAttempts: 11 }, BASE, 3)).toThrow(AllocationError);
    expect(() => allocator.tasks.add({ id: "t", requires: [""] }, BASE, 3)).toThrow(AllocationError);
  });

  test("dedupes and sorts required capabilities; orders queue by priority then age", () => {
    const allocator = freshAllocator();
    const task = allocator.tasks.add({ id: "t", requires: ["web", "gpu", "web"] }, BASE, 3);
    expect(task.requires).toEqual(["gpu", "web"]);

    allocator.tasks.add({ id: "low", priority: -5 }, BASE, 3);
    allocator.tasks.add({ id: "high", priority: 5 }, BASE, 3);
    allocator.tasks.add({ id: "old-high", priority: 5 }, BASE - 1, 3);
    expect(allocator.tasks.queued().map((t) => t.id)).toEqual(["old-high", "high", "t", "low"]);
  });
});

describe("allocation strategies", () => {
  test("least-loaded picks the agent with the lowest utilization", () => {
    const allocator = freshAllocator();
    fleet(allocator, BASE);
    allocator.tasks.add({ id: "t1", requires: ["web"] }, BASE, 3);
    const result = allocator.allocate(BASE, { strategy: "least-loaded" });
    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0]?.agentId).toBe("alpha");
    // tie: alpha and beta both at 0/4 -> stable id order after the first pick
    allocator.tasks.add({ id: "t2", requires: ["web"] }, BASE, 3);
    const second = allocator.allocate(BASE, { strategy: "least-loaded" });
    expect(second.assignments[0]?.agentId).toBe("beta");
  });

  test("pack fills the busiest capable agent first", () => {
    const allocator = freshAllocator();
    fleet(allocator, BASE);
    allocator.tasks.add({ id: "t1", requires: ["web"] }, BASE, 3);
    allocator.allocate(BASE, { strategy: "least-loaded" }); // alpha 1/4, beta 0/4
    allocator.tasks.add({ id: "t2", requires: ["web"] }, BASE, 3);
    const packed = allocator.allocate(BASE + 1, { strategy: "pack" });
    expect(packed.assignments[0]?.agentId).toBe("alpha");
  });

  test("tasks are never assigned to agents lacking a required capability", () => {
    const allocator = freshAllocator();
    fleet(allocator, BASE);
    allocator.tasks.add({ id: "render", requires: ["gpu"] }, BASE, 3);
    allocator.tasks.add({ id: "both", requires: ["gpu", "email"] }, BASE, 3);
    const result = allocator.allocate(BASE, {});
    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0]?.agentId).toBe("gpu-1");
    expect(result.breakdown.skippedNoCapability).toBe(1);
    expect(allocator.tasks.get("both").status).toBe("queued");
    expect(allocator.tasks.get("both").assignedTo).toBeNull();
  });

  test("drained and stale agents are excluded from candidates", () => {
    const allocator = freshAllocator();
    fleet(allocator, BASE);
    allocator.agents.patch("alpha", { status: "drained" });
    allocator.tasks.add({ id: "t1", requires: ["web"] }, BASE, 3);
    let result = allocator.allocate(BASE, {});
    expect(result.assignments[0]?.agentId).not.toBe("alpha");

    // make every fresh agent stale -> nothing can be allocated
    const later = BASE + 31_000;
    result = allocator.allocate(later, {});
    expect(result.assignments).toHaveLength(0);
    expect(result.breakdown.candidates).toBe(0);
  });

  test("max caps the number of assignments per round", () => {
    const allocator = freshAllocator();
    fleet(allocator, BASE);
    for (let i = 1; i <= 5; i += 1) {
      allocator.tasks.add({ id: `t${i}`, requires: ["web"] }, BASE, 3);
    }
    const result = allocator.allocate(BASE, { max: 2 });
    expect(result.assignments).toHaveLength(2);
    expect(result.deferred).toBe(3);
  });

  test("invalid strategy and max are rejected", () => {
    const allocator = freshAllocator();
    expect(() => parseStrategy("fastest")).toThrow(AllocationError);
    expect(() => allocator.allocate(BASE, { max: 0 })).toThrow(AllocationError);
    expect(() => allocator.allocate(BASE, { max: 1.5 })).toThrow(AllocationError);
  });
});

describe("round-robin fairness (deficit round robin)", () => {
  test("equal weights receive an equal share over many rounds", () => {
    const allocator = freshAllocator();
    allocator.agents.register({ id: "a", capabilities: ["web"], capacity: 10, weight: 1 }, BASE);
    allocator.agents.register({ id: "b", capabilities: ["web"], capacity: 10, weight: 1 }, BASE);
    for (let i = 1; i <= 8; i += 1) allocator.tasks.add({ id: `t${i}`, requires: ["web"], cost: 4 }, BASE, 3);

    const counts: Record<string, number> = { a: 0, b: 0 };
    for (let round = 0; round < 8; round += 1) {
      const result = allocator.allocate(BASE + round, { strategy: "round-robin" });
      for (const assignment of result.assignments) {
        counts[assignment.agentId] = (counts[assignment.agentId] ?? 0) + 1;
      }
      // settle each round so capacity is not the binding constraint
      for (const id of ["a", "b"]) {
        const agent = allocator.agents.get(id);
        for (const taskId of [...agent.runningTasks]) {
          allocator.complete(taskId, BASE + round + 0.5);
        }
      }
    }
    expect(counts.a).toBe(4);
    expect(counts.b).toBe(4);
  });

  test("a weight-3 agent receives three times the work of a weight-1 agent", () => {
    const allocator = freshAllocator();
    allocator.agents.register({ id: "light", capabilities: ["web"], capacity: 20, weight: 1 }, BASE);
    allocator.agents.register({ id: "heavy", capabilities: ["web"], capacity: 20, weight: 3 }, BASE);
    for (let i = 1; i <= 8; i += 1) allocator.tasks.add({ id: `t${i}`, requires: ["web"], cost: 10 }, BASE, 3);

    const counts: Record<string, number> = { light: 0, heavy: 0 };
    for (let round = 0; round < 8; round += 1) {
      const result = allocator.allocate(BASE + round, { strategy: "round-robin" });
      for (const assignment of result.assignments) {
        counts[assignment.agentId] = (counts[assignment.agentId] ?? 0) + 1;
      }
      for (const id of ["light", "heavy"]) {
        const agent = allocator.agents.get(id);
        for (const taskId of [...agent.runningTasks]) {
          allocator.complete(taskId, BASE + round + 0.5);
        }
      }
    }
    expect((counts.heavy ?? 0) / (counts.light ?? 1)).toBe(3);
  });

  test("tasks costing more than a round's quantum wait for accumulated deficit", () => {
    const allocator = freshAllocator();
    allocator.agents.register({ id: "a", capabilities: ["web"], capacity: 5, weight: 1 }, BASE);
    allocator.tasks.add({ id: "big", requires: ["web"], cost: 25 }, BASE, 3);

    const first = allocator.allocate(BASE, { strategy: "round-robin" });
    expect(first.assignments).toHaveLength(0);
    expect(first.breakdown.deferredInsufficientDeficit).toBe(1);

    // quantum 10 per round: affordable during the third round (10, 20, 30)
    allocator.allocate(BASE + 1, { strategy: "round-robin" });
    const third = allocator.allocate(BASE + 2, { strategy: "round-robin" });
    expect(third.assignments).toHaveLength(1);
    expect(third.assignments[0]?.taskId).toBe("big");
  });

  test("a zero-weight agent is never chosen by round-robin", () => {
    const allocator = freshAllocator();
    allocator.agents.register({ id: "zero", capabilities: ["web"], capacity: 5, weight: 0 }, BASE);
    allocator.agents.register({ id: "one", capabilities: ["web"], capacity: 5, weight: 1 }, BASE);
    allocator.tasks.add({ id: "t1", requires: ["web"], cost: 1 }, BASE, 3);
    const result = allocator.allocate(BASE, { strategy: "round-robin" });
    expect(result.assignments[0]?.agentId).toBe("one");
  });
});

describe("task lifecycle", () => {
  test("complete frees capacity and records the outcome", () => {
    const allocator = freshAllocator();
    fleet(allocator, BASE);
    allocator.tasks.add({ id: "t1", requires: ["web"] }, BASE, 3);
    allocator.allocate(BASE, { max: 1 });
    allocator.complete("t1", BASE + 5, "done");
    const task = allocator.tasks.get("t1");
    expect(task.status).toBe("completed");
    expect(task.settledAt).toBe(BASE + 5);
    expect(task.note).toBe("done");
    expect(allocator.agents.get("alpha").runningTasks).toHaveLength(0);
    expect(() => allocator.complete("t1", BASE + 6)).toThrow(AllocationError);
  });

  test("fail requeues while attempts remain, then dead-letters", () => {
    const allocator = freshAllocator();
    fleet(allocator, BASE);
    allocator.tasks.add({ id: "t1", requires: ["web"], maxAttempts: 2 }, BASE, 3);
    allocator.allocate(BASE, { max: 1 });
    const first = allocator.fail("t1", BASE + 1, "boom");
    expect(first).toEqual({ retried: true, deadLettered: false });
    expect(allocator.tasks.get("t1").status).toBe("queued");
    expect(allocator.tasks.get("t1").attempts).toBe(1);

    allocator.allocate(BASE + 2, { max: 1 });
    const second = allocator.fail("t1", BASE + 3, "boom again");
    expect(second).toEqual({ retried: false, deadLettered: true });
    expect(allocator.tasks.get("t1").status).toBe("dead");
    expect(allocator.stats(BASE).tasks.dead).toBe(1);
  });

  test("fail on a non-running task is a conflict", () => {
    const allocator = freshAllocator();
    allocator.tasks.add({ id: "t1" }, BASE, 3);
    expect(() => allocator.fail("t1", BASE)).toThrow(AllocationError);
  });
});

describe("tick: lease recovery for stale agents", () => {
  test("reassigns a silent agent's tasks and dead-letters at exhaustion", () => {
    const allocator = freshAllocator();
    fleet(allocator, BASE);
    allocator.tasks.add({ id: "t1", requires: ["web"], maxAttempts: 2 }, BASE, 2);
    allocator.allocate(BASE, { max: 1 }); // alpha takes t1
    expect(allocator.tasks.get("t1").assignedTo).toBe("alpha");

    // alpha goes silent; others heartbeat
    allocator.heartbeat("beta", BASE + 31_000);
    allocator.heartbeat("gpu-1", BASE + 31_000);
    const tick = allocator.tick(BASE + 31_000);
    expect(tick.staleAgents).toEqual(["alpha"]);
    expect(tick.reassigned).toBe(1);
    expect(allocator.tasks.get("t1").status).toBe("queued");
    expect(allocator.tasks.get("t1").attempts).toBe(1);

    // reallocate, then alpha-style silence again exhausts the attempts
    allocator.allocate(BASE + 32_000, { max: 1 });
    const assignee = allocator.tasks.get("t1").assignedTo;
    expect(assignee).not.toBeNull();
    allocator.tick(BASE + 62_000);
    expect(allocator.tasks.get("t1").status).toBe("dead");
    expect(allocator.agents.get(assignee as string).reassignments).toBe(1);
  });

  test("healthy agents are untouched by tick", () => {
    const allocator = freshAllocator();
    fleet(allocator, BASE);
    allocator.tasks.add({ id: "t1", requires: ["web"] }, BASE, 3);
    allocator.allocate(BASE, { max: 1 });
    allocator.heartbeat("alpha", BASE + 10_000);
    const tick = allocator.tick(BASE + 11_000);
    expect(tick.staleAgents).toHaveLength(0);
    expect(allocator.tasks.get("t1").status).toBe("running");
  });
});

describe("stats", () => {
  test("reports counts, utilization, and Jain fairness with an idle weighted agent", () => {
    const allocator = freshAllocator();
    fleet(allocator, BASE);
    allocator.tasks.add({ id: "t1", requires: ["web"] }, BASE, 3);
    allocator.tasks.add({ id: "t2", requires: ["web"] }, BASE, 3);
    allocator.allocate(BASE, { max: 2 });
    const stats = allocator.stats(BASE);
    expect(stats.agents).toBe(3);
    expect(stats.activeAgents).toBe(3);
    expect(stats.tasks.running).toBe(2);
    expect(stats.allocations).toBe(1);
    expect(stats.assignmentsPerAgent).toEqual({ alpha: 1, beta: 1, "gpu-1": 0 });
    expect(stats.utilizationPerAgent).toEqual({ alpha: 0.25, beta: 0.25, "gpu-1": 0 });
    expect(stats.jainFairnessIndex).toBeCloseTo(2 / 3, 5);
  });

  test("stale agents are counted in stats", () => {
    const allocator = freshAllocator();
    fleet(allocator, BASE);
    expect(allocator.stats(BASE + 31_000).staleAgents).toBe(3);
  });
});

describe("allocator config", () => {
  test("rejects nonsensical config", () => {
    expect(() => new Allocator({ config: { heartbeatTimeoutMs: 0 } })).toThrow(AllocationError);
    expect(() => new Allocator({ config: { defaultMaxAttempts: 11 } })).toThrow(AllocationError);
    expect(() => new Allocator({ config: { deficitQuantum: 0 } })).toThrow(AllocationError);
    expect(() => new Allocator({ config: { maxDeficit: 5, deficitQuantum: 10 } })).toThrow(AllocationError);
  });
});

describe("state round-trip", () => {
  test("toState/fromState preserves agents, tasks, deficits, and counters", () => {
    const allocator = freshAllocator();
    fleet(allocator, BASE);
    allocator.tasks.add({ id: "t1", requires: ["web"], cost: 4 }, BASE, 3);
    allocator.allocate(BASE, { strategy: "round-robin", max: 1 });
    const snapshot = allocator.toState();

    const revived = Allocator.fromState(JSON.parse(JSON.stringify(snapshot)));
    expect(revived.agents.get("alpha")).toEqual(allocator.agents.get("alpha"));
    expect(revived.tasks.get("t1")).toEqual(allocator.tasks.get("t1"));
    expect(revived.stats(BASE).allocations).toBe(1);

    // continue operating on the revived instance
    revived.complete("t1", BASE + 1);
    expect(revived.tasks.get("t1").status).toBe("completed");
  });

  test("fromState rejects malformed payloads", () => {
    expect(() => Allocator.fromState(null)).toThrow(AllocationError);
    expect(() => Allocator.fromState({ version: 99 })).toThrow(AllocationError);
    expect(() => Allocator.fromState({ version: 1, registry: { agents: [] }, taskStore: { tasks: [] }, allocationCount: 0, config: {} })).toThrow(AllocationError);
  });
});

describe("parseStrategy", () => {
  test("accepts every supported strategy", () => {
    expect(parseStrategy("least-loaded")).toBe("least-loaded");
    expect(parseStrategy("round-robin")).toBe("round-robin");
    expect(parseStrategy("pack")).toBe("pack");
  });
});

describe("library end-to-end (README example parity)", () => {
  test("enqueue, allocate, complete, and observe fairness", () => {
    const allocator = new Allocator();
    allocator.agents.register({ id: "node-1", capabilities: ["web"], capacity: 2 }, BASE);
    allocator.agents.register({ id: "node-2", capabilities: ["web"], capacity: 2 }, BASE);
    allocator.tasks.add({ id: "job-a", requires: ["web"] }, BASE, 3);
    allocator.tasks.add({ id: "job-b", requires: ["web"] }, BASE, 3);
    const result: AllocateResult = allocator.allocate(BASE, {});
    expect(result.assignments).toHaveLength(2);
    const completed: Task[] = [];
    for (const assignment of result.assignments) {
      allocator.complete(assignment.taskId, BASE + 1);
      completed.push(allocator.tasks.get(assignment.taskId));
    }
    expect(completed.every((task) => task.status === "completed")).toBe(true);
    expect(allocator.stats(BASE + 1).tasks.completed).toBe(2);
  });
});
