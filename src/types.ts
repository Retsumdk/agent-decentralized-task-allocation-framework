export type AgentStatus = "active" | "drained";

export type TaskStatus = "queued" | "running" | "completed" | "dead";

export type AllocationStrategy = "least-loaded" | "round-robin" | "pack";

export interface Agent {
  id: string;
  capabilities: string[];
  capacity: number;
  weight: number;
  status: AgentStatus;
  runningTasks: string[];
  completedCount: number;
  failedCount: number;
  reassignments: number;
  lastHeartbeat: number;
  registeredAt: number;
  /** DRR credit balance (round-robin strategy only) */
  deficit: number;
}

export interface AgentInput {
  id?: string;
  capabilities?: string[];
  capacity?: number;
  weight?: number;
  status?: AgentStatus;
}

export interface AgentPatch {
  capabilities?: string[];
  capacity?: number;
  weight?: number;
  status?: AgentStatus;
}

export interface Task {
  id: string;
  requires: string[];
  cost: number;
  priority: number;
  maxAttempts: number;
  attempts: number;
  status: TaskStatus;
  assignedTo: string | null;
  assignedAt: number | null;
  createdAt: number;
  settledAt: number | null;
  note: string | null;
  history: TaskEvent[];
}

export interface TaskInput {
  id?: string;
  requires?: string[];
  cost?: number;
  priority?: number;
  maxAttempts?: number;
}

export interface TaskEvent {
  at: number;
  event: string;
  detail?: string;
}

export interface Assignment {
  taskId: string;
  agentId: string;
  strategy: AllocationStrategy;
  at: number;
}

export interface StrategyBreakdown {
  strategy: AllocationStrategy;
  /** agents considered this round (active + fresh heartbeat) */
  candidates: number;
  /** tasks assigned this round */
  eligible: number;
  /** tasks with no capable agent at all */
  skippedNoCapability: number;
  /** tasks with capable agents but all at capacity */
  skippedNoCapacity: number;
  /** round-robin only: no candidate's deficit could pay the cost yet */
  deferredInsufficientDeficit: number;
}

export interface AllocateResult {
  at: number;
  strategy: AllocationStrategy;
  assignments: Assignment[];
  /** queued tasks left unassigned this round */
  deferred: number;
  breakdown: StrategyBreakdown;
}

export interface TickResult {
  at: number;
  staleAgents: string[];
  reassigned: number;
  deadLettered: number;
}

export interface AllocatorConfig {
  /** an agent silent longer than this is treated as gone */
  heartbeatTimeoutMs: number;
  /** default maxAttempts for tasks that do not specify one */
  defaultMaxAttempts: number;
  /** DRR credits added to each agent per allocation round, scaled by weight */
  deficitQuantum: number;
  /** upper bound on a single agent's accumulated deficit */
  maxDeficit: number;
}

export const DEFAULT_CONFIG: AllocatorConfig = {
  heartbeatTimeoutMs: 30_000,
  defaultMaxAttempts: 3,
  deficitQuantum: 10,
  maxDeficit: 100,
};

export const MAX_TASK_COST = 100;
export const MAX_PRIORITY = 1000;

export interface Stats {
  agents: number;
  activeAgents: number;
  drainedAgents: number;
  staleAgents: number;
  tasks: { queued: number; running: number; completed: number; dead: number };
  allocations: number;
  assignmentsPerAgent: Record<string, number>;
  utilizationPerAgent: Record<string, number>;
  /** Jain fairness index over capacity-weighted assignment shares, [0, 1] */
  jainFairnessIndex: number;
}
