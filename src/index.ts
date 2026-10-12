/**
 * agent-decentralized-task-allocation-framework — public API.
 *
 * Assign queued tasks to registered agents under fairness and
 * load-balancing strategies, with capability matching, heartbeat-based
 * lease recovery, and optional durable state.
 */
export { Allocator, parseStrategy } from "./allocator.js";
export type { AllocatorOptions } from "./allocator.js";
export { AgentRegistry, satisfiesCapabilities } from "./registry.js";
export type { RegistryState } from "./registry.js";
export { TaskStore, sortQueued } from "./tasks.js";
export type { TaskStoreState } from "./tasks.js";
export { AllocationError, isAllocationError } from "./errors.js";
export { jainFairnessIndex, weightedShares, replenishDeficit, canPay, payDeficit } from "./fairness.js";
export { createAllocatorServer, type ServerOptions } from "./server.js";
export { loadState, saveState, toStateEnvelope } from "./persistence.js";
export type {
  Agent,
  AgentInput,
  AgentPatch,
  AgentStatus,
  AllocateResult,
  AllocationStrategy,
  AllocatorConfig,
  Assignment,
  Stats,
  StrategyBreakdown,
  Task,
  TaskEvent,
  TaskInput,
  TaskStatus,
  TickResult,
} from "./types.js";
export { DEFAULT_CONFIG, MAX_TASK_COST, MAX_PRIORITY } from "./types.js";
export { demo } from "./demo.js";
