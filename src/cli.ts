#!/usr/bin/env node
import { parseArgs } from "node:util";
import { isAllocationError } from "./errors.js";
import { Allocator, parseStrategy } from "./allocator.js";
import type { AgentInput, AgentPatch, AllocationStrategy, TaskInput, TaskStatus } from "./types.js";
import { loadState, saveState } from "./persistence.js";
import { createAllocatorServer } from "./server.js";

const USAGE = `agent-decentralized-task-allocation-framework

Assign queued tasks to capable agents under fairness and load-balancing
strategies, with heartbeat-based lease recovery and optional durable state.

Usage:
  alloc demo
  alloc register <agent-id> --caps web,gpu [--capacity N] [--weight W] [--drained]
  alloc task <task-id> [--requires a,b] [--cost N] [--priority P] [--max-attempts N]
  alloc allocate [--strategy least-loaded|round-robin|pack] [--max N]
  alloc complete <task-id> [--note text]
  alloc fail <task-id> [--note text]
  alloc heartbeat <agent-id>
  alloc patch <agent-id> [--caps a,b] [--capacity N] [--weight W] [--status active|drained]
  alloc remove-agent <agent-id>
  alloc agents
  alloc tasks [--status queued|running|completed|dead] [--assigned-to agent-id]
  alloc stats
  alloc tick
  alloc serve --port N [--token secret]

Global options:
  --state <file>   load + persist allocator state at <file> (mutations save)
  -h, --help       show this help

Exit codes: 0 success, 1 runtime error, 2 usage error.`;

interface CliValues {
  help?: boolean;
  state?: string;
  caps?: string;
  capacity?: string;
  weight?: string;
  drained?: boolean;
  requires?: string;
  cost?: string;
  priority?: string;
  "max-attempts"?: string;
  strategy?: string;
  max?: string;
  note?: string;
  status?: string;
  "assigned-to"?: string;
  port?: string;
  token?: string;
}

interface Parsed {
  command: string;
  positionals: string[];
  values: CliValues;
}

function parse(argv: readonly string[]): Parsed {
  let parsed: { values: CliValues; positionals: string[] };
  try {
    parsed = parseArgs({ args: [...argv], options: CLI_OPTIONS, allowPositionals: true, strict: true }) as { values: CliValues; positionals: string[] };
  } catch (error) {
    throw new UsageError(`invalid arguments: ${(error as Error).message}`);
  }
  const positionals = [...parsed.positionals];
  const command = positionals.shift();
  if (command === undefined) {
    if (parsed.values.help === true) return { command: "help", positionals, values: parsed.values };
    throw new UsageError("missing command; try --help");
  }
  return { command, positionals, values: parsed.values };
}

const CLI_OPTIONS = {
  help: { type: "boolean", default: false, short: "h" },
  state: { type: "string" },
  caps: { type: "string" },
  capacity: { type: "string" },
  weight: { type: "string" },
  drained: { type: "boolean", default: false },
  requires: { type: "string" },
  cost: { type: "string" },
  priority: { type: "string" },
  "max-attempts": { type: "string" },
  strategy: { type: "string" },
  max: { type: "string" },
  note: { type: "string" },
  status: { type: "string" },
  "assigned-to": { type: "string" },
  port: { type: "string" },
  token: { type: "string" },
} as const;

class UsageError extends Error {}

function requireInt(values: CliValues, flag: keyof CliValues, min: number, max: number): number | undefined {
  const raw = values[flag];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new UsageError(`--${String(flag)} must be an integer in [${min}, ${max}]`);
  }
  return value;
}

function requireNumber(values: CliValues, flag: keyof CliValues, min: number, max: number): number | undefined {
  const raw = values[flag];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new UsageError(`--${String(flag)} must be a finite number in [${min}, ${max}]`);
  }
  return value;
}

function splitList(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  return raw.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

function requirePositional(positionals: readonly string[], index: number, what: string): string {
  const value = positionals[index];
  if (value === undefined) throw new UsageError(`missing <${what}> argument; try --help`);
  return value;
}

const DEFAULT_STATE_FILE = "allocator-state.json";

async function openAllocator(statePath: string | undefined): Promise<Allocator> {
  const allocator = new Allocator();
  await loadState(allocator, statePath ?? DEFAULT_STATE_FILE);
  return allocator;
}

function stateTarget(statePath: string | undefined): string {
  return statePath ?? DEFAULT_STATE_FILE;
}

const TASK_STATUS_FILTERS = ["queued", "running", "completed", "dead"] as const;
type StatusFilter = (typeof TASK_STATUS_FILTERS)[number];

function statusFilter(raw: string | undefined): StatusFilter | undefined {
  if (raw === undefined) return undefined;
  if (!(TASK_STATUS_FILTERS as readonly string[]).includes(raw)) {
    throw new UsageError(`--status must be one of: ${TASK_STATUS_FILTERS.join(", ")}`);
  }
  return raw as StatusFilter;
}

async function run(argv: readonly string[]): Promise<number> {
  const { command, positionals, values } = parse(argv);

  if (values.help === true || command === "help") {
    console.log(USAGE);
    return 0;
  }

  const statePath = values.state;

  if (command === "demo") {
    if (positionals.length > 0) throw new UsageError("demo takes no arguments");
    const { demo } = await import("./demo.js");
    await demo();
    return 0;
  }

  if (command === "serve") {
    const port = requireInt(values, "port", 1, 65535) ?? 8613;
    const allocator = await openAllocator(statePath);
    const server = createAllocatorServer({
      allocator,
      port,
      ...(values.token !== undefined ? { token: values.token } : {}),
      ...(statePath !== undefined ? { statePath } : {}),
    });
    await new Promise<void>((resolve) => server.on("listening", resolve));
    console.log(`allocation API listening on http://localhost:${port}`);
    await new Promise<never>(() => undefined); // serve until killed
    return 0; // unreachable
  }

  if (command === "register") {
    const id = requirePositional(positionals, 0, "agent-id");
    const allocator = await openAllocator(statePath);
    const input: AgentInput = { id };
    const capabilities = splitList(values.caps);
    if (capabilities !== undefined) input.capabilities = capabilities;
    const capacity = requireInt(values, "capacity", 1, 1024);
    if (capacity !== undefined) input.capacity = capacity;
    const weight = requireNumber(values, "weight", 0, 100);
    if (weight !== undefined) input.weight = weight;
    if (values.drained === true) input.status = "drained";
    const agent = allocator.agents.register(input, Date.now());
    await saveState(allocator, stateTarget(statePath));
    console.log(JSON.stringify(agent, null, 2));
    return 0;
  }

  if (command === "task") {
    const id = requirePositional(positionals, 0, "task-id");
    const allocator = await openAllocator(statePath);
    const taskInput: TaskInput = { id };
    const requires = splitList(values.requires);
    if (requires !== undefined) taskInput.requires = requires;
    const cost = requireInt(values, "cost", 1, 100);
    if (cost !== undefined) taskInput.cost = cost;
    const priority = requireInt(values, "priority", -1000, 1000);
    if (priority !== undefined) taskInput.priority = priority;
    const maxAttempts = requireInt(values, "max-attempts", 1, 10);
    if (maxAttempts !== undefined) taskInput.maxAttempts = maxAttempts;
    const task = allocator.tasks.add(taskInput, Date.now(), allocator.config.defaultMaxAttempts);
    await saveState(allocator, stateTarget(statePath));
    console.log(JSON.stringify(task, null, 2));
    return 0;
  }

  if (command === "allocate") {
    const allocator = await openAllocator(statePath);
    let strategy: AllocationStrategy | undefined;
    if (values.strategy !== undefined) {
      try {
        strategy = parseStrategy(values.strategy);
      } catch {
        throw new UsageError("--strategy must be one of: least-loaded, round-robin, pack");
      }
    }
    const options: { strategy?: AllocationStrategy; max?: number } = {};
    if (strategy !== undefined) options.strategy = strategy;
    const max = requireInt(values, "max", 1, 1000);
    if (max !== undefined) options.max = max;
    const result = allocator.allocate(Date.now(), options);
    await saveState(allocator, stateTarget(statePath));
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  if (command === "complete" || command === "fail") {
    const id = requirePositional(positionals, 0, "task-id");
    const allocator = await openAllocator(statePath);
    if (command === "complete") {
      if (values.note === undefined) {
        allocator.complete(id, Date.now());
      } else {
        allocator.complete(id, Date.now(), values.note);
      }
      await saveState(allocator, stateTarget(statePath));
      console.log(JSON.stringify(allocator.tasks.get(id), null, 2));
      return 0;
    }
    const outcome =
      values.note === undefined ? allocator.fail(id, Date.now()) : allocator.fail(id, Date.now(), values.note);
    await saveState(allocator, stateTarget(statePath));
    console.log(JSON.stringify({ task: allocator.tasks.get(id), ...outcome }, null, 2));
    return 0;
  }

  if (command === "heartbeat") {
    const id = requirePositional(positionals, 0, "agent-id");
    const allocator = await openAllocator(statePath);
    allocator.heartbeat(id, Date.now());
    await saveState(allocator, stateTarget(statePath));
    console.log(JSON.stringify(allocator.agents.get(id), null, 2));
    return 0;
  }

  if (command === "patch") {
    const id = requirePositional(positionals, 0, "agent-id");
    const allocator = await openAllocator(statePath);
    const agentPatch: AgentPatch = {};
    const capabilities = splitList(values.caps);
    if (capabilities !== undefined) agentPatch.capabilities = capabilities;
    const capacity = requireInt(values, "capacity", 1, 1024);
    if (capacity !== undefined) agentPatch.capacity = capacity;
    const weight = requireNumber(values, "weight", 0, 100);
    if (weight !== undefined) agentPatch.weight = weight;
    const status = values.status;
    if (status !== undefined) {
      if (status !== "active" && status !== "drained") {
        throw new UsageError("--status must be 'active' or 'drained'");
      }
      agentPatch.status = status;
    }
    const agent = allocator.agents.patch(id, agentPatch);
    await saveState(allocator, stateTarget(statePath));
    console.log(JSON.stringify(agent, null, 2));
    return 0;
  }

  if (command === "remove-agent") {
    const id = requirePositional(positionals, 0, "agent-id");
    const allocator = await openAllocator(statePath);
    const agent = allocator.agents.remove(id);
    await saveState(allocator, stateTarget(statePath));
    console.log(`removed agent ${agent.id}`);
    return 0;
  }

  if (command === "agents") {
    const allocator = await openAllocator(statePath);
    console.log(JSON.stringify({ agents: allocator.agents.list() }, null, 2));
    return 0;
  }

  if (command === "tasks") {
    const allocator = await openAllocator(statePath);
    const filter: { status?: TaskStatus; assignedTo?: string } = {};
    const status = statusFilter(values.status);
    if (status !== undefined) filter.status = status;
    if (values["assigned-to"] !== undefined) filter.assignedTo = values["assigned-to"];
    const tasks = allocator.tasks.list(filter);
    console.log(JSON.stringify({ tasks }, null, 2));
    return 0;
  }

  if (command === "stats") {
    const allocator = await openAllocator(statePath);
    console.log(JSON.stringify(allocator.stats(Date.now()), null, 2));
    return 0;
  }

  if (command === "tick") {
    const allocator = await openAllocator(statePath);
    const result = allocator.tick(Date.now());
    await saveState(allocator, stateTarget(statePath));
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  throw new UsageError(`unknown command '${command}'; try --help`);
}

run(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof UsageError) {
    console.error(`usage: ${error.message}`);
    process.exit(2);
  }
  if (isAllocationError(error)) {
    console.error(`error [${error.code}]: ${error.message}`);
    process.exit(1);
  }
  console.error(`error: ${String(error)}`);
  process.exit(1);
});
