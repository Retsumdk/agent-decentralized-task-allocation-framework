import { AllocationError } from "./errors.js";
import { canPay, jainFairnessIndex, payDeficit, replenishDeficit, weightedShares } from "./fairness.js";
import { AgentRegistry, satisfiesCapabilities } from "./registry.js";
import { TaskStore } from "./tasks.js";
import {
  DEFAULT_CONFIG,
  type Agent,
  type AllocateResult,
  type AllocatorConfig,
  type AllocationStrategy,
  type Assignment,
  type Stats,
  type StrategyBreakdown,
  type Task,
  type TickResult,
} from "./types.js";

const STRATEGIES: readonly AllocationStrategy[] = ["least-loaded", "round-robin", "pack"];

export function parseStrategy(value: unknown): AllocationStrategy {
  if (typeof value === "string" && (STRATEGIES as readonly string[]).includes(value)) {
    return value as AllocationStrategy;
  }
  throw new AllocationError("VALIDATION", `strategy must be one of: ${STRATEGIES.join(", ")}`);
}

export interface AllocatorOptions {
  config?: Partial<AllocatorConfig>;
}

/**
 * The allocation engine. Owns the agent registry and task store, runs
 * the three placement strategies, and drives the task lifecycle
 * (complete / fail / tick-based lease recovery).
 */
export class Allocator {
  agents: AgentRegistry;
  tasks: TaskStore;
  config: AllocatorConfig;
  allocationCount = 0;

  constructor(options: AllocatorOptions = {}) {
    this.agents = new AgentRegistry();
    this.tasks = new TaskStore();
    this.config = { ...DEFAULT_CONFIG, ...options.config };
    if (!Number.isFinite(this.config.heartbeatTimeoutMs) || this.config.heartbeatTimeoutMs <= 0) {
      throw new AllocationError("CONFIG", "heartbeatTimeoutMs must be a positive finite number");
    }
    if (!Number.isInteger(this.config.defaultMaxAttempts) || this.config.defaultMaxAttempts < 1 || this.config.defaultMaxAttempts > 10) {
      throw new AllocationError("CONFIG", "defaultMaxAttempts must be an integer in [1, 10]");
    }
    if (!Number.isInteger(this.config.deficitQuantum) || this.config.deficitQuantum < 1) {
      throw new AllocationError("CONFIG", "deficitQuantum must be a positive integer");
    }
    if (!Number.isInteger(this.config.maxDeficit) || this.config.maxDeficit < this.config.deficitQuantum) {
      throw new AllocationError("CONFIG", "maxDeficit must be an integer >= deficitQuantum");
    }
  }

  /**
   * Assign queued tasks to agents, highest priority first.
   *
   * A task is eligible when at least one active, non-stale agent has
   * every required capability and spare capacity. Tasks with no
   * eligible agent stay queued; they are picked up by a later round.
   */
  allocate(now: number, options: { strategy?: AllocationStrategy; max?: number } = {}): AllocateResult {
    const strategy = options.strategy ?? "least-loaded";
    if (options.max !== undefined && (!Number.isInteger(options.max) || options.max < 1 || options.max > 1000)) {
      throw new AllocationError("VALIDATION", "max must be an integer in [1, 1000]");
    }
    const max = options.max ?? 1000;

    const breakdown: StrategyBreakdown = {
      strategy,
      candidates: 0,
      eligible: 0,
      skippedNoCapacity: 0,
      skippedNoCapability: 0,
      deferredInsufficientDeficit: 0,
    };

    const candidates = this.candidateAgents(now);
    breakdown.candidates = candidates.length;

    if (strategy === "round-robin") {
      // Replenish every active agent's deficit at the start of the
      // round — this is the DRR "quantum" step.
      for (const agent of candidates) {
        agent.deficit = replenishDeficit(agent.deficit, agent.weight, this.config.deficitQuantum, this.config.maxDeficit);
      }
    }

    const assignments: Assignment[] = [];
    let deferred = 0;

    for (const task of this.tasks.queued()) {
      if (assignments.length >= max) {
        // Once the cap is hit the remaining queue is simply left for
        // the next round; it counts as deferred work.
        deferred += 1;
        continue;
      }

      const capable = candidates.filter((agent) => satisfiesCapabilities(agent.capabilities, task.requires));
      const withRoom = capable.filter((agent) => agent.runningTasks.length < agent.capacity);
      breakdown.skippedNoCapability += capable.length === 0 ? 1 : 0;
      breakdown.skippedNoCapacity += capable.length > 0 && withRoom.length === 0 ? 1 : 0;
      if (withRoom.length === 0) {
        deferred += 1;
        continue;
      }

      const chosen = this.pick(strategy, withRoom, task.cost);
      if (chosen === null) {
        deferred += 1;
        breakdown.deferredInsufficientDeficit += 1;
        continue;
      }

      chosen.deficit = payDeficit(chosen.deficit, task.cost);
      this.attach(task, chosen, now, strategy);
      breakdown.eligible += 1;
      assignments.push({ taskId: task.id, agentId: chosen.id, strategy, at: now });
    }

    this.allocationCount += 1;
    return { at: now, strategy, assignments, deferred, breakdown };
  }

  private pick(
    strategy: AllocationStrategy,
    candidates: Agent[],
    cost: number,
  ): Agent | null {
    switch (strategy) {
      case "least-loaded": {
        let best: Agent | null = null;
        for (const agent of candidates) {
          if (
            best === null ||
            this.agents.utilizationOf(agent) < this.agents.utilizationOf(best) ||
            (this.agents.utilizationOf(agent) === this.agents.utilizationOf(best) && agent.id < best.id)
          ) {
            best = agent;
          }
        }
        return best;
      }
      case "pack": {
        // Best-fit: fill the agent closest to capacity first, leaving
        // whole agents free for bursty demand.
        let best: Agent | null = null;
        for (const agent of candidates) {
          if (
            best === null ||
            this.agents.utilizationOf(agent) > this.agents.utilizationOf(best) ||
            (this.agents.utilizationOf(agent) === this.agents.utilizationOf(best) && agent.id < best.id)
          ) {
            best = agent;
          }
        }
        return best;
      }
      case "round-robin": {
        // DRR: only agents whose deficit can pay the task's cost are
        // eligible. If nobody can pay yet, defer — deficits grow every
        // round, so the task is served once enough credits accrue.
        let best: Agent | null = null;
        for (const agent of candidates) {
          if (!canPay(agent.deficit, cost)) continue;
          if (best === null || agent.deficit > best.deficit || (agent.deficit === best.deficit && agent.id < best.id)) {
            best = agent;
          }
        }
        return best;
      }
    }
  }

  private attach(task: Task, agent: Agent, now: number, strategy: AllocationStrategy): void {
    task.status = "running";
    task.assignedTo = agent.id;
    task.assignedAt = now;
    agent.runningTasks.push(task.id);
    this.tasks.record(task, now, "assigned", `agent=${agent.id} strategy=${strategy}`);
  }

  complete(taskId: string, now: number, note?: string): void {
    const task = this.tasks.requireRunning(taskId);
    const agent = this.agents.requireAgent(task.assignedTo, "assignedTo");
    task.status = "completed";
    task.settledAt = now;
    task.note = note ?? null;
    detach(agent, task.id);
    agent.completedCount += 1;
    this.tasks.record(task, now, "completed", note === undefined ? undefined : `note=${note}`);
  }

  /**
   * Record a failure. The task is retried (requeued) while attempts
   * remain; once attempts reach maxAttempts it is dead-lettered and
   * stays in the store for inspection — never silently dropped.
   */
  fail(taskId: string, now: number, reason?: string): { retried: boolean; deadLettered: boolean } {
    const task = this.tasks.requireRunning(taskId);
    const agent = this.agents.requireAgent(task.assignedTo, "assignedTo");
    task.attempts += 1;
    detach(agent, task.id);
    agent.failedCount += 1;

    if (task.attempts >= task.maxAttempts) {
      task.status = "dead";
      task.settledAt = now;
      task.note = reason ?? "failed";
      this.tasks.record(task, now, "dead-lettered", `attempts=${task.attempts}/${task.maxAttempts}`);
      return { retried: false, deadLettered: true };
    }

    task.status = "queued";
    task.assignedTo = null;
    task.assignedAt = null;
    this.tasks.record(task, now, "requeued", reason === undefined ? `attempt=${task.attempts}` : `attempt=${task.attempts} reason=${reason}`);
    return { retried: true, deadLettered: false };
  }

  heartbeat(agentId: string, now: number): void {
    this.agents.heartbeat(agentId, now);
  }

  /**
   * Lease recovery: agents that have not heartbeated within the
   * configured window are treated as gone; their running tasks are
   * requeued for reallocation (attempts count against maxAttempts).
   */
  tick(now: number): TickResult {
    const stale = this.agents
      .list()
      .filter((agent) => agent.runningTasks.length > 0 && now - agent.lastHeartbeat > this.config.heartbeatTimeoutMs);

    const result: TickResult = { at: now, staleAgents: [], reassigned: 0, deadLettered: 0 };
    for (const agent of stale) {
      result.staleAgents.push(agent.id);
      agent.reassignments += 1;
      for (const taskId of [...agent.runningTasks]) {
        const task = this.tasks.get(taskId);
        task.attempts += 1;
        detach(agent, taskId);
        if (task.attempts >= task.maxAttempts) {
          task.status = "dead";
          task.settledAt = now;
          task.note = `agent ${agent.id} stale (lease expired)`;
          this.tasks.record(task, now, "dead-lettered", `stale-agent=${agent.id}`);
          result.deadLettered += 1;
        } else {
          task.status = "queued";
          task.assignedTo = null;
          task.assignedAt = null;
          this.tasks.record(task, now, "requeued", `stale-agent=${agent.id}`);
          result.reassigned += 1;
        }
      }
    }
    return result;
  }

  stats(now: number): Stats {
    const all = this.agents.list();
    const running = this.tasks.running();
    const runningByAgent = new Map<string, number>();
    for (const task of running) {
      if (task.assignedTo !== null) {
        runningByAgent.set(task.assignedTo, (runningByAgent.get(task.assignedTo) ?? 0) + 1);
      }
    }

    const assignmentsPerAgent: Record<string, number> = {};
    const utilizationPerAgent: Record<string, number> = {};
    const weights: Record<string, number> = {};
    let activeAgents = 0;
    let drainedAgents = 0;
    let staleAgents = 0;

    for (const agent of all) {
      const currentLoad = runningByAgent.get(agent.id) ?? 0;
      assignmentsPerAgent[agent.id] = agent.completedCount + agent.failedCount + currentLoad;
      utilizationPerAgent[agent.id] = round3(currentLoad / agent.capacity);
      weights[agent.id] = agent.weight;
      if (agent.status === "active") activeAgents += 1;
      else drainedAgents += 1;
      if (now - agent.lastHeartbeat > this.config.heartbeatTimeoutMs) staleAgents += 1;
    }

    const shares = weightedShares(assignmentsPerAgent, weights);
    return {
      agents: all.length,
      activeAgents,
      drainedAgents,
      staleAgents,
      tasks: {
        queued: this.tasks.list({ status: "queued" }).length,
        running: running.length,
        completed: this.tasks.list({ status: "completed" }).length,
        dead: this.tasks.list({ status: "dead" }).length,
      },
      allocations: this.allocationCount,
      assignmentsPerAgent,
      utilizationPerAgent,
      jainFairnessIndex: round6(jainFairnessIndex(shares)),
    };
  }

  toState(): Record<string, unknown> {
    return {
      version: 1,
      config: { ...this.config },
      allocationCount: this.allocationCount,
      registry: this.agents.toState(),
      taskStore: this.tasks.toState(),
    };
  }
  static fromState(state: unknown): Allocator {
    if (typeof state !== "object" || state === null) {
      throw new AllocationError("CORRUPTION", "allocator state must be an object");
    }
    const record = state as Record<string, unknown>;
    if (record.version !== 1) {
      throw new AllocationError("CORRUPTION", `unsupported state version ${String(record.version)}`);
    }
    const config = record.config;
    if (typeof config !== "object" || config === null) {
      throw new AllocationError("CORRUPTION", "allocator state.config must be an object");
    }
    const allocator = new Allocator({ config: config as Partial<AllocatorConfig> });
    const allocationCount = record.allocationCount;
    if (typeof allocationCount !== "number" || !Number.isInteger(allocationCount) || allocationCount < 0) {
      throw new AllocationError("CORRUPTION", "allocator state.allocationCount must be a non-negative integer");
    }
    allocator.allocationCount = allocationCount;
    allocator.agents = AgentRegistry.fromState(record.registry);
    allocator.tasks = TaskStore.fromState(record.taskStore);
    return allocator;
  }

  private candidateAgents(now: number): Agent[] {
    return this.agents
      .activeAgents()
      .filter((agent) => now - agent.lastHeartbeat <= this.config.heartbeatTimeoutMs);
  }
}

function detach(agent: Agent, taskId: string): void {
  const index = agent.runningTasks.indexOf(taskId);
  if (index !== -1) agent.runningTasks.splice(index, 1);
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
