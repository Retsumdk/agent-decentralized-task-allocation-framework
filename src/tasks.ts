import { AllocationError } from "./errors.js";
import { MAX_PRIORITY, MAX_TASK_COST, type Task, type TaskEvent, type TaskInput, type TaskStatus } from "./types.js";

export interface TaskStoreState {
  tasks: Task[];
  taskSeq: number;
}

const MAX_ATTEMPTS_LIMIT = 10;

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AllocationError("VALIDATION", `${field} must be a non-empty string`);
  }
  return value.trim();
}

export function sortQueued(tasks: readonly Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return a.id.localeCompare(b.id);
  });
}

export class TaskStore {
  private readonly tasks = new Map<string, Task>();
  private taskSeq = 0;

  add(input: TaskInput, now: number, defaultMaxAttempts: number): Task {
    const requires = (input.requires ?? [])
      .map((entry) => requireString(entry, "requires"))
      .filter((entry, index, all) => all.indexOf(entry) === index)
      .sort();

    const cost = input.cost === undefined ? 1 : requireCost(input.cost);
    const priority = input.priority === undefined ? 0 : requirePriority(input.priority);
    const maxAttempts =
      input.maxAttempts === undefined
        ? defaultMaxAttempts
        : requireAttempts(input.maxAttempts);

    let id: string;
    if (input.id === undefined) {
      this.taskSeq += 1;
      id = `task-${this.taskSeq}`;
    } else {
      id = requireString(input.id, "id");
      if (this.tasks.has(id)) {
        throw new AllocationError("CONFLICT", `task '${id}' already exists`);
      }
    }

    const task: Task = {
      id,
      requires,
      cost,
      priority,
      maxAttempts,
      attempts: 0,
      status: "queued",
      assignedTo: null,
      assignedAt: null,
      createdAt: now,
      settledAt: null,
      note: null,
      history: [{ at: now, event: "queued" }],
    };
    this.tasks.set(id, task);
    return task;
  }

  get(id: string): Task {
    const task = this.tasks.get(id);
    if (task === undefined) {
      throw new AllocationError("NOT_FOUND", `task '${id}' does not exist`);
    }
    return task;
  }

  requireRunning(id: string): Task {
    const task = this.get(id);
    if (task.status !== "running") {
      throw new AllocationError("CONFLICT", `task '${id}' is ${task.status}, not running`);
    }
    return task;
  }

  list(filter?: { status?: TaskStatus; assignedTo?: string }): Task[] {
    const all = [...this.tasks.values()];
    const filtered = all.filter((task) => {
      if (filter?.status !== undefined && task.status !== filter.status) return false;
      if (filter?.assignedTo !== undefined && task.assignedTo !== filter.assignedTo) return false;
      return true;
    });
    return sortQueued(filtered);
  }

  queued(): Task[] {
    return sortQueued(this.list({ status: "queued" }));
  }

  running(): Task[] {
    return this.list({ status: "running" });
  }

  record(task: Task, at: number, event: string, detail?: string): void {
    const entry: TaskEvent = { at, event };
    if (detail !== undefined) entry.detail = detail;
    task.history.push(entry);
  }

  toState(): TaskStoreState {
    return { tasks: this.list(), taskSeq: this.taskSeq };
  }

  static fromState(state: unknown): TaskStore {
    if (typeof state !== "object" || state === null) {
      throw new AllocationError("CORRUPTION", "task store state must be an object");
    }
    const record = state as Record<string, unknown>;
    const rawTasks = record.tasks;
    if (!Array.isArray(rawTasks)) {
      throw new AllocationError("CORRUPTION", "task store state.tasks must be an array");
    }
    const seq = record.taskSeq;
    if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0) {
      throw new AllocationError("CORRUPTION", "task store state.taskSeq must be a non-negative integer");
    }
    const store = new TaskStore();
    store.taskSeq = seq;
    for (const raw of rawTasks) {
      const task = reviveTask(raw);
      if (store.tasks.has(task.id)) {
        throw new AllocationError("CORRUPTION", `duplicate task id '${task.id}' in state`);
      }
      store.tasks.set(task.id, task);
    }
    return store;
  }
}

function requireCost(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_TASK_COST) {
    throw new AllocationError("VALIDATION", `cost must be an integer in [1, ${MAX_TASK_COST}]`);
  }
  return value;
}

function requirePriority(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < -MAX_PRIORITY || value > MAX_PRIORITY) {
    throw new AllocationError("VALIDATION", `priority must be an integer in [-${MAX_PRIORITY}, ${MAX_PRIORITY}]`);
  }
  return value;
}

function requireAttempts(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_ATTEMPTS_LIMIT) {
    throw new AllocationError("VALIDATION", `maxAttempts must be an integer in [1, ${MAX_ATTEMPTS_LIMIT}]`);
  }
  return value;
}

function reviveTask(raw: unknown): Task {
  if (typeof raw !== "object" || raw === null) {
    throw new AllocationError("CORRUPTION", "task entry must be an object");
  }
  const record = raw as Record<string, unknown>;
  const id = requireString(record.id, "task.id");
  const status = record.status;
  if (status !== "queued" && status !== "running" && status !== "completed" && status !== "dead") {
    throw new AllocationError("CORRUPTION", `task '${id}' has invalid status '${String(status)}'`);
  }
  const history = record.history;
  if (!Array.isArray(history)) {
    throw new AllocationError("CORRUPTION", `task '${id}' has invalid history`);
  }
  const requires = record.requires;
  if (!Array.isArray(requires) || requires.some((r) => typeof r !== "string")) {
    throw new AllocationError("CORRUPTION", `task '${id}' has invalid requires`);
  }
  const assignedTo = record.assignedTo;
  if (assignedTo !== null && typeof assignedTo !== "string") {
    throw new AllocationError("CORRUPTION", `task '${id}' has invalid assignedTo`);
  }
  const note = record.note;
  if (note !== null && typeof note !== "string") {
    throw new AllocationError("CORRUPTION", `task '${id}' has invalid note`);
  }
  const assignedAt = record.assignedAt;
  const settledAt = record.settledAt;
  return {
    id,
    requires: [...(requires as string[])],
    cost: requireCost(record.cost),
    priority: requirePriority(record.priority),
    maxAttempts: requireAttempts(record.maxAttempts),
    attempts: requireInt(record.attempts, "task.attempts", 0, MAX_ATTEMPTS_LIMIT),
    status,
    assignedTo,
    assignedAt: typeof assignedAt === "number" ? assignedAt : null,
    createdAt: requireNumber(record.createdAt, "task.createdAt"),
    settledAt: typeof settledAt === "number" ? settledAt : null,
    note,
    history: (history as TaskEvent[]).map((event) => {
      if (typeof event !== "object" || event === null) {
        throw new AllocationError("CORRUPTION", `task '${id}' has a malformed history entry`);
      }
      const eventRecord = event as unknown as Record<string, unknown>;
      const revived: TaskEvent = { at: requireNumber(eventRecord.at, "history.at"), event: requireString(eventRecord.event, "history.event") };
      if (eventRecord.detail !== undefined) {
        revived.detail = requireString(eventRecord.detail, "history.detail");
      }
      return revived;
    }),
  };
}

function requireInt(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new AllocationError("CORRUPTION", `${field} must be an integer in [${min}, ${max}]`);
  }
  return value;
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AllocationError("CORRUPTION", `${field} must be a finite number`);
  }
  return value;
}
