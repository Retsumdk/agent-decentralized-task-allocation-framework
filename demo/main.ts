/**
 * Live browser demo for the allocator: the same published modules the CLI and
 * the HTTP API use, driven from a handful of buttons. The clock is virtual so
 * a lease expiry is one click instead of a 30 second wait.
 */
import { Allocator, parseStrategy } from "../src/allocator.js";
import type { Task } from "../src/types.js";

const $ = (id: string): HTMLElement => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node;
};

let allocator = new Allocator();
let clock = 1_000_000;
let lapsed: string | null = null;
const logLines: string[] = [];

const AGENTS = [
  { id: "render-1", capabilities: ["gpu", "web"], capacity: 2, weight: 1 },
  { id: "worker-1", capabilities: ["web"], capacity: 3, weight: 2 },
  { id: "mailer-1", capabilities: ["email"], capacity: 1, weight: 1 },
];

const TASKS = [
  { id: "t1", requires: ["web"], cost: 4, priority: 9 },
  { id: "t2", requires: ["gpu"], cost: 10, priority: 8 },
  { id: "t3", requires: ["web"], cost: 2, priority: 7 },
  { id: "t4", requires: ["email"], cost: 1, priority: 6 },
  { id: "t5", requires: ["web", "gpu"], cost: 8, priority: 9 },
  { id: "t6", requires: ["web"], cost: 3, priority: 5 },
  { id: "t7", requires: ["gpu"], cost: 6, priority: 4 },
  { id: "t8", requires: ["email"], cost: 2, priority: 3 },
  { id: "t9", requires: ["archive"], cost: 1, priority: 2 },
];

const log = (line: string): void => {
  logLines.unshift(line);
  logLines.splice(40);
  $("log").textContent = logLines.join("\n");
};

const pill = (text: string, cls = ""): string =>
  `<span class="badge ${cls}">${text}</span>`;

const caps = (values: string[]): string =>
  values.length ? values.map((v) => `<span class="cap">${v}</span>`).join(" ") : "any";

const render = (): void => {
  const now = clock;
  const stats = allocator.stats(now);
  const agents = allocator.agents.list();
  const tasks = allocator.tasks.list();

  const queued = stats.tasks.queued;
  const running = stats.tasks.running;
  const completed = stats.tasks.completed;
  const dead = stats.tasks.dead;
  $("stats").innerHTML = [
    ["queued", String(queued)],
    ["running", String(running)],
    ["completed", String(completed)],
    ["dead-lettered", String(dead)],
    ["Jain fairness", stats.jainFairnessIndex.toFixed(3)],
    ["rounds", String(stats.allocations)],
  ]
    .map(([label, value]) => `<div class="stat"><span>${label}</span><strong>${value}</strong></div>`)
    .join("");

  $("agents").innerHTML = agents
    .map((agent) => {
      const isLapsed = lapsed === agent.id;
      const utilisation = Math.round(allocator.agents.utilizationOf(agent) * 100);
      const stale = isLapsed && now - agent.lastHeartbeat > allocator.config.heartbeatTimeoutMs;
      return `<tr class="${stale ? "stale" : ""}">
        <td><code>${agent.id}</code> ${stale ? pill("stale lease", "stale") : ""}</td>
        <td>${caps(agent.capabilities)}</td>
        <td class="num">${agent.capacity} / ${agent.weight}</td>
        <td class="num">${agent.runningTasks.length}</td>
        <td class="num">${agent.completedCount}</td>
        <td><span class="bar"><span style="width:${utilisation}%"></span></span>${utilisation}%</td>
      </tr>`;
    })
    .join("");

  $("tasks").innerHTML = tasks
    .map(
      (task: Task) => `<tr>
        <td><code>${task.id}</code></td>
        <td>${caps(task.requires)}</td>
        <td class="num">${task.priority}</td>
        <td>${pill(task.status, task.status)}</td>
        <td>${task.assignedTo ?? "-"}</td>
      </tr>`,
    )
    .join("");
};

const heartbeatAll = (): void => {
  for (const agent of allocator.agents.list()) {
    if (agent.id === lapsed) continue;
    allocator.agents.heartbeat(agent.id, clock);
  }
};

const reset = (): void => {
  allocator = new Allocator();
  clock = 1_000_000;
  lapsed = null;
  logLines.length = 0;
  for (const agent of AGENTS) allocator.agents.register(agent, clock);
  for (const task of TASKS) allocator.tasks.add(task, clock, allocator.config.defaultMaxAttempts);
  log(`seeded ${AGENTS.length} agents and ${TASKS.length} tasks at t=${clock}`);
  render();
};

const allocateRound = (): void => {
  heartbeatAll();
  clock += 1_000;
  const strategy = parseStrategy($("strategy") instanceof HTMLSelectElement ? ($("strategy") as HTMLSelectElement).value : "");
  const result = allocator.allocate(clock, { strategy });
  const assigned = result.assignments.map((a) => `${a.taskId}->${a.agentId}`).join(", ");
  log(
    `${strategy} at t=${clock}: ${result.assignments.length} assigned` +
      (assigned ? ` (${assigned})` : "") +
      `, ${result.deferred} deferred, ${result.breakdown.candidates} candidate agents`,
  );
  render();
};

const completeRunning = (): void => {
  const running = allocator.tasks.running();
  if (!running.length) {
    log("nothing running to complete");
    return;
  }
  for (const task of running) allocator.complete(task.id, clock);
  log(`completed ${running.length} task(s): ${running.map((t) => t.id).join(", ")}`);
  render();
};

const lapseAgent = (): void => {
  const candidate = allocator.agents.list().find((agent) => agent.id !== lapsed);
  if (!candidate) {
    log("every agent has already lapsed - reset to start over");
    return;
  }
  lapsed = candidate.id;
  clock += allocator.config.heartbeatTimeoutMs + 1_000;
  const tick = allocator.tick(clock);
  log(
    `t=${clock}: ${candidate.id} stopped heartbeating; tick recovered ` +
      `${tick.reassigned} task(s) from ${tick.staleAgents.length} stale agent(s)`,
  );
  render();
};

const bind = (id: string, handler: () => void): void => {
  $(id).addEventListener("click", handler);
};

bind("allocate", allocateRound);
bind("complete", completeRunning);
bind("lapse", lapseAgent);
bind("reset", reset);

reset();
