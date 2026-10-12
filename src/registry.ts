import { AllocationError } from "./errors.js";
import type { Agent, AgentInput, AgentPatch, AgentStatus } from "./types.js";

export interface RegistryState {
  agents: Agent[];
  agentSeq: number;
}

const MAX_CAPACITY = 1024;

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AllocationError("VALIDATION", `${field} must be a non-empty string`);
  }
  return value;
}

function requireInt(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new AllocationError("VALIDATION", `${field} must be an integer in [${min}, ${max}]`);
  }
  return value;
}

export function normalizeCapabilities(raw: readonly string[], field: string): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new AllocationError("VALIDATION", `${field} must be a non-empty array of strings`);
  }
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new AllocationError("VALIDATION", `${field} entries must be non-empty strings`);
    }
    seen.add(entry.trim());
  }
  return [...seen].sort();
}

/** Does `agent` satisfy every capability in `requires`? */
export function satisfiesCapabilities(
  agentCaps: readonly string[],
  requires: readonly string[],
): boolean {
  const owned = new Set(agentCaps);
  return requires.every((capability) => owned.has(capability));
}

export class AgentRegistry {
  private readonly agents = new Map<string, Agent>();
  private agentSeq = 0;

  register(input: AgentInput, now: number): Agent {
    const capabilities = normalizeCapabilities(input.capabilities ?? [], "capabilities");
    const capacity = input.capacity === undefined ? 4 : requireInt(input.capacity, "capacity", 1, MAX_CAPACITY);
    const weight = input.weight === undefined ? 1 : requireWeight(input.weight);
    const status: AgentStatus = input.status ?? "active";

    let id: string;
    if (input.id === undefined) {
      this.agentSeq += 1;
      id = `agent-${this.agentSeq}`;
    } else {
      id = requireNonEmptyString(input.id, "id").trim();
      if (this.agents.has(id)) {
        throw new AllocationError("CONFLICT", `agent '${id}' is already registered`);
      }
    }

    const agent: Agent = {
      id,
      capabilities,
      capacity,
      weight,
      status,
      runningTasks: [],
      completedCount: 0,
      failedCount: 0,
      reassignments: 0,
      lastHeartbeat: now,
      registeredAt: now,
      deficit: 0,
    };
    this.agents.set(id, agent);
    return agent;
  }

  get(id: string): Agent {
    const agent = this.agents.get(id);
    if (agent === undefined) {
      throw new AllocationError("NOT_FOUND", `agent '${id}' is not registered`);
    }
    return agent;
  }

  has(id: string): boolean {
    return this.agents.has(id);
  }

  requireAgent(id: string | null, field: string): Agent {
    if (id === null) {
      throw new AllocationError("VALIDATION", `${field} must reference a registered agent`);
    }
    return this.get(id);
  }

  patch(id: string, patch: AgentPatch): Agent {
    const agent = this.get(id);
    if (patch.capabilities !== undefined) {
      agent.capabilities = normalizeCapabilities(patch.capabilities, "capabilities");
    }
    if (patch.capacity !== undefined) {
      const capacity = requireInt(patch.capacity, "capacity", 1, MAX_CAPACITY);
      if (capacity < agent.runningTasks.length) {
        throw new AllocationError(
          "CONFLICT",
          `capacity ${capacity} is below the agent's ${agent.runningTasks.length} running tasks`,
        );
      }
      agent.capacity = capacity;
    }
    if (patch.weight !== undefined) {
      agent.weight = requireWeight(patch.weight);
    }
    if (patch.status !== undefined) {
      if (patch.status !== "active" && patch.status !== "drained") {
        throw new AllocationError("VALIDATION", `status must be 'active' or 'drained'`);
      }
      agent.status = patch.status;
    }
    return agent;
  }

  heartbeat(id: string, now: number): Agent {
    const agent = this.get(id);
    agent.lastHeartbeat = now;
    return agent;
  }

  /**
   * Deregister an agent. Refuses while the agent still has running
   * tasks; drain first (or reassign via tick) and retry.
   */
  remove(id: string): Agent {
    const agent = this.get(id);
    if (agent.runningTasks.length > 0) {
      throw new AllocationError(
        "CONFLICT",
        `agent '${id}' still holds ${agent.runningTasks.length} running task(s); drain first`,
      );
    }
    this.agents.delete(id);
    return agent;
  }

  list(): Agent[] {
    return [...this.agents.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  activeAgents(): Agent[] {
    return this.list().filter((agent) => agent.status === "active");
  }

  loadOf(agent: Agent): number {
    return agent.runningTasks.length;
  }

  utilizationOf(agent: Agent): number {
    return agent.runningTasks.length / agent.capacity;
  }

  toState(): RegistryState {
    return { agents: this.list(), agentSeq: this.agentSeq };
  }

  static fromState(state: unknown): AgentRegistry {
    if (typeof state !== "object" || state === null) {
      throw new AllocationError("CORRUPTION", "agent registry state must be an object");
    }
    const record = state as Record<string, unknown>;
    const rawAgents = record.agents;
    if (!Array.isArray(rawAgents)) {
      throw new AllocationError("CORRUPTION", "agent registry state.agents must be an array");
    }
    const registry = new AgentRegistry();
    const seq = record.agentSeq;
    if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0) {
      throw new AllocationError("CORRUPTION", "agent registry state.agentSeq must be a non-negative integer");
    }
    registry.agentSeq = seq;
    for (const raw of rawAgents) {
      const agent = reviveAgent(raw);
      if (registry.agents.has(agent.id)) {
        throw new AllocationError("CORRUPTION", `duplicate agent id '${agent.id}' in state`);
      }
      registry.agents.set(agent.id, agent);
    }
    return registry;
  }
}

function requireWeight(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new AllocationError("VALIDATION", "weight must be a finite number in [0, 100]");
  }
  return value;
}

function reviveAgent(raw: unknown): Agent {
  if (typeof raw !== "object" || raw === null) {
    throw new AllocationError("CORRUPTION", "agent entry must be an object");
  }
  const record = raw as Record<string, unknown>;
  const id = requireNonEmptyString(record.id, "agent.id");
  const status = record.status;
  if (status !== "active" && status !== "drained") {
    throw new AllocationError("CORRUPTION", `agent '${id}' has invalid status`);
  }
  const runningTasks = record.runningTasks;
  if (!Array.isArray(runningTasks) || runningTasks.some((t) => typeof t !== "string")) {
    throw new AllocationError("CORRUPTION", `agent '${id}' has invalid runningTasks`);
  }
  return {
    id,
    capabilities: normalizeCapabilities(record.capabilities as string[], "agent.capabilities"),
    capacity: requireInt(record.capacity, "agent.capacity", 1, MAX_CAPACITY),
    weight: requireWeight(record.weight),
    status,
    runningTasks: [...(runningTasks as string[])],
    completedCount: requireInt(record.completedCount, "agent.completedCount", 0, Number.MAX_SAFE_INTEGER),
    failedCount: requireInt(record.failedCount, "agent.failedCount", 0, Number.MAX_SAFE_INTEGER),
    reassignments: requireInt(record.reassignments, "agent.reassignments", 0, Number.MAX_SAFE_INTEGER),
    lastHeartbeat: requireNumber(record.lastHeartbeat, "agent.lastHeartbeat"),
    registeredAt: requireNumber(record.registeredAt, "agent.registeredAt"),
    deficit: requireNumber(record.deficit, "agent.deficit"),
  };
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AllocationError("CORRUPTION", `${field} must be a finite number`);
  }
  return value;
}
