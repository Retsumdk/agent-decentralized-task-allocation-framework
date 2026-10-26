(() => {
  // src/errors.ts
  var HTTP_STATUS = {
    VALIDATION: 400,
    NOT_FOUND: 404,
    CONFLICT: 409,
    CORRUPTION: 500,
    CONFIG: 500,
    UNAUTHORIZED: 401
  };

  class AllocationError extends Error {
    code;
    constructor(code, message) {
      super(message);
      this.name = "AllocationError";
      this.code = code;
    }
    get httpStatus() {
      return HTTP_STATUS[this.code];
    }
  }

  // src/fairness.ts
  function jainFairnessIndex(shares) {
    if (shares.length === 0)
      return 1;
    const sum = shares.reduce((total, x) => total + x, 0);
    const sumSquares = shares.reduce((total, x) => total + x * x, 0);
    if (sumSquares === 0)
      return 1;
    return sum * sum / (shares.length * sumSquares);
  }
  function weightedShares(assignmentsPerAgent, weights) {
    const shares = [];
    for (const [id, count] of Object.entries(assignmentsPerAgent)) {
      const weight = weights[id] ?? 0;
      shares.push(weight > 0 ? count / weight : count > 0 ? Number.POSITIVE_INFINITY : 0);
    }
    return shares;
  }
  function replenishDeficit(deficit, weight, quantum, maxDeficit) {
    return Math.min(deficit + weight * quantum, maxDeficit);
  }
  function canPay(deficit, cost) {
    return deficit >= cost;
  }
  function payDeficit(deficit, cost) {
    if (cost < 0)
      throw new AllocationError("VALIDATION", "cost must be non-negative");
    return Math.max(deficit - cost, 0);
  }

  // src/registry.ts
  var MAX_CAPACITY = 1024;
  function requireNonEmptyString(value, field) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new AllocationError("VALIDATION", `${field} must be a non-empty string`);
    }
    return value;
  }
  function requireInt(value, field, min, max) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
      throw new AllocationError("VALIDATION", `${field} must be an integer in [${min}, ${max}]`);
    }
    return value;
  }
  function normalizeCapabilities(raw, field) {
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new AllocationError("VALIDATION", `${field} must be a non-empty array of strings`);
    }
    const seen = new Set;
    for (const entry of raw) {
      if (typeof entry !== "string" || entry.trim().length === 0) {
        throw new AllocationError("VALIDATION", `${field} entries must be non-empty strings`);
      }
      seen.add(entry.trim());
    }
    return [...seen].sort();
  }
  function satisfiesCapabilities(agentCaps, requires) {
    const owned = new Set(agentCaps);
    return requires.every((capability) => owned.has(capability));
  }

  class AgentRegistry {
    agents = new Map;
    agentSeq = 0;
    register(input, now) {
      const capabilities = normalizeCapabilities(input.capabilities ?? [], "capabilities");
      const capacity = input.capacity === undefined ? 4 : requireInt(input.capacity, "capacity", 1, MAX_CAPACITY);
      const weight = input.weight === undefined ? 1 : requireWeight(input.weight);
      const status = input.status ?? "active";
      let id;
      if (input.id === undefined) {
        this.agentSeq += 1;
        id = `agent-${this.agentSeq}`;
      } else {
        id = requireNonEmptyString(input.id, "id").trim();
        if (this.agents.has(id)) {
          throw new AllocationError("CONFLICT", `agent '${id}' is already registered`);
        }
      }
      const agent = {
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
        deficit: 0
      };
      this.agents.set(id, agent);
      return agent;
    }
    get(id) {
      const agent = this.agents.get(id);
      if (agent === undefined) {
        throw new AllocationError("NOT_FOUND", `agent '${id}' is not registered`);
      }
      return agent;
    }
    has(id) {
      return this.agents.has(id);
    }
    requireAgent(id, field) {
      if (id === null) {
        throw new AllocationError("VALIDATION", `${field} must reference a registered agent`);
      }
      return this.get(id);
    }
    patch(id, patch) {
      const agent = this.get(id);
      if (patch.capabilities !== undefined) {
        agent.capabilities = normalizeCapabilities(patch.capabilities, "capabilities");
      }
      if (patch.capacity !== undefined) {
        const capacity = requireInt(patch.capacity, "capacity", 1, MAX_CAPACITY);
        if (capacity < agent.runningTasks.length) {
          throw new AllocationError("CONFLICT", `capacity ${capacity} is below the agent's ${agent.runningTasks.length} running tasks`);
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
    heartbeat(id, now) {
      const agent = this.get(id);
      agent.lastHeartbeat = now;
      return agent;
    }
    remove(id) {
      const agent = this.get(id);
      if (agent.runningTasks.length > 0) {
        throw new AllocationError("CONFLICT", `agent '${id}' still holds ${agent.runningTasks.length} running task(s); drain first`);
      }
      this.agents.delete(id);
      return agent;
    }
    list() {
      return [...this.agents.values()].sort((a, b) => a.id.localeCompare(b.id));
    }
    activeAgents() {
      return this.list().filter((agent) => agent.status === "active");
    }
    loadOf(agent) {
      return agent.runningTasks.length;
    }
    utilizationOf(agent) {
      return agent.runningTasks.length / agent.capacity;
    }
    toState() {
      return { agents: this.list(), agentSeq: this.agentSeq };
    }
    static fromState(state) {
      if (typeof state !== "object" || state === null) {
        throw new AllocationError("CORRUPTION", "agent registry state must be an object");
      }
      const record = state;
      const rawAgents = record.agents;
      if (!Array.isArray(rawAgents)) {
        throw new AllocationError("CORRUPTION", "agent registry state.agents must be an array");
      }
      const registry = new AgentRegistry;
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
  function requireWeight(value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
      throw new AllocationError("VALIDATION", "weight must be a finite number in [0, 100]");
    }
    return value;
  }
  function reviveAgent(raw) {
    if (typeof raw !== "object" || raw === null) {
      throw new AllocationError("CORRUPTION", "agent entry must be an object");
    }
    const record = raw;
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
      capabilities: normalizeCapabilities(record.capabilities, "agent.capabilities"),
      capacity: requireInt(record.capacity, "agent.capacity", 1, MAX_CAPACITY),
      weight: requireWeight(record.weight),
      status,
      runningTasks: [...runningTasks],
      completedCount: requireInt(record.completedCount, "agent.completedCount", 0, Number.MAX_SAFE_INTEGER),
      failedCount: requireInt(record.failedCount, "agent.failedCount", 0, Number.MAX_SAFE_INTEGER),
      reassignments: requireInt(record.reassignments, "agent.reassignments", 0, Number.MAX_SAFE_INTEGER),
      lastHeartbeat: requireNumber(record.lastHeartbeat, "agent.lastHeartbeat"),
      registeredAt: requireNumber(record.registeredAt, "agent.registeredAt"),
      deficit: requireNumber(record.deficit, "agent.deficit")
    };
  }
  function requireNumber(value, field) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new AllocationError("CORRUPTION", `${field} must be a finite number`);
    }
    return value;
  }

  // src/types.ts
  var DEFAULT_CONFIG = {
    heartbeatTimeoutMs: 30000,
    defaultMaxAttempts: 3,
    deficitQuantum: 10,
    maxDeficit: 100
  };
  var MAX_TASK_COST = 100;
  var MAX_PRIORITY = 1000;

  // src/tasks.ts
  var MAX_ATTEMPTS_LIMIT = 10;
  function requireString(value, field) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new AllocationError("VALIDATION", `${field} must be a non-empty string`);
    }
    return value.trim();
  }
  function sortQueued(tasks) {
    return [...tasks].sort((a, b) => {
      if (a.priority !== b.priority)
        return b.priority - a.priority;
      if (a.createdAt !== b.createdAt)
        return a.createdAt - b.createdAt;
      return a.id.localeCompare(b.id);
    });
  }

  class TaskStore {
    tasks = new Map;
    taskSeq = 0;
    add(input, now, defaultMaxAttempts) {
      const requires = (input.requires ?? []).map((entry) => requireString(entry, "requires")).filter((entry, index, all) => all.indexOf(entry) === index).sort();
      const cost = input.cost === undefined ? 1 : requireCost(input.cost);
      const priority = input.priority === undefined ? 0 : requirePriority(input.priority);
      const maxAttempts = input.maxAttempts === undefined ? defaultMaxAttempts : requireAttempts(input.maxAttempts);
      let id;
      if (input.id === undefined) {
        this.taskSeq += 1;
        id = `task-${this.taskSeq}`;
      } else {
        id = requireString(input.id, "id");
        if (this.tasks.has(id)) {
          throw new AllocationError("CONFLICT", `task '${id}' already exists`);
        }
      }
      const task = {
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
        history: [{ at: now, event: "queued" }]
      };
      this.tasks.set(id, task);
      return task;
    }
    get(id) {
      const task = this.tasks.get(id);
      if (task === undefined) {
        throw new AllocationError("NOT_FOUND", `task '${id}' does not exist`);
      }
      return task;
    }
    requireRunning(id) {
      const task = this.get(id);
      if (task.status !== "running") {
        throw new AllocationError("CONFLICT", `task '${id}' is ${task.status}, not running`);
      }
      return task;
    }
    list(filter) {
      const all = [...this.tasks.values()];
      const filtered = all.filter((task) => {
        if (filter?.status !== undefined && task.status !== filter.status)
          return false;
        if (filter?.assignedTo !== undefined && task.assignedTo !== filter.assignedTo)
          return false;
        return true;
      });
      return sortQueued(filtered);
    }
    queued() {
      return sortQueued(this.list({ status: "queued" }));
    }
    running() {
      return this.list({ status: "running" });
    }
    record(task, at, event, detail) {
      const entry = { at, event };
      if (detail !== undefined)
        entry.detail = detail;
      task.history.push(entry);
    }
    toState() {
      return { tasks: this.list(), taskSeq: this.taskSeq };
    }
    static fromState(state) {
      if (typeof state !== "object" || state === null) {
        throw new AllocationError("CORRUPTION", "task store state must be an object");
      }
      const record = state;
      const rawTasks = record.tasks;
      if (!Array.isArray(rawTasks)) {
        throw new AllocationError("CORRUPTION", "task store state.tasks must be an array");
      }
      const seq = record.taskSeq;
      if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0) {
        throw new AllocationError("CORRUPTION", "task store state.taskSeq must be a non-negative integer");
      }
      const store = new TaskStore;
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
  function requireCost(value) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_TASK_COST) {
      throw new AllocationError("VALIDATION", `cost must be an integer in [1, ${MAX_TASK_COST}]`);
    }
    return value;
  }
  function requirePriority(value) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < -MAX_PRIORITY || value > MAX_PRIORITY) {
      throw new AllocationError("VALIDATION", `priority must be an integer in [-${MAX_PRIORITY}, ${MAX_PRIORITY}]`);
    }
    return value;
  }
  function requireAttempts(value) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_ATTEMPTS_LIMIT) {
      throw new AllocationError("VALIDATION", `maxAttempts must be an integer in [1, ${MAX_ATTEMPTS_LIMIT}]`);
    }
    return value;
  }
  function reviveTask(raw) {
    if (typeof raw !== "object" || raw === null) {
      throw new AllocationError("CORRUPTION", "task entry must be an object");
    }
    const record = raw;
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
      requires: [...requires],
      cost: requireCost(record.cost),
      priority: requirePriority(record.priority),
      maxAttempts: requireAttempts(record.maxAttempts),
      attempts: requireInt2(record.attempts, "task.attempts", 0, MAX_ATTEMPTS_LIMIT),
      status,
      assignedTo,
      assignedAt: typeof assignedAt === "number" ? assignedAt : null,
      createdAt: requireNumber2(record.createdAt, "task.createdAt"),
      settledAt: typeof settledAt === "number" ? settledAt : null,
      note,
      history: history.map((event) => {
        if (typeof event !== "object" || event === null) {
          throw new AllocationError("CORRUPTION", `task '${id}' has a malformed history entry`);
        }
        const eventRecord = event;
        const revived = { at: requireNumber2(eventRecord.at, "history.at"), event: requireString(eventRecord.event, "history.event") };
        if (eventRecord.detail !== undefined) {
          revived.detail = requireString(eventRecord.detail, "history.detail");
        }
        return revived;
      })
    };
  }
  function requireInt2(value, field, min, max) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
      throw new AllocationError("CORRUPTION", `${field} must be an integer in [${min}, ${max}]`);
    }
    return value;
  }
  function requireNumber2(value, field) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new AllocationError("CORRUPTION", `${field} must be a finite number`);
    }
    return value;
  }

  // src/allocator.ts
  var STRATEGIES = ["least-loaded", "round-robin", "pack"];
  function parseStrategy(value) {
    if (typeof value === "string" && STRATEGIES.includes(value)) {
      return value;
    }
    throw new AllocationError("VALIDATION", `strategy must be one of: ${STRATEGIES.join(", ")}`);
  }

  class Allocator {
    agents;
    tasks;
    config;
    allocationCount = 0;
    constructor(options = {}) {
      this.agents = new AgentRegistry;
      this.tasks = new TaskStore;
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
    allocate(now, options = {}) {
      const strategy = options.strategy ?? "least-loaded";
      if (options.max !== undefined && (!Number.isInteger(options.max) || options.max < 1 || options.max > 1000)) {
        throw new AllocationError("VALIDATION", "max must be an integer in [1, 1000]");
      }
      const max = options.max ?? 1000;
      const breakdown = {
        strategy,
        candidates: 0,
        eligible: 0,
        skippedNoCapacity: 0,
        skippedNoCapability: 0,
        deferredInsufficientDeficit: 0
      };
      const candidates = this.candidateAgents(now);
      breakdown.candidates = candidates.length;
      if (strategy === "round-robin") {
        for (const agent of candidates) {
          agent.deficit = replenishDeficit(agent.deficit, agent.weight, this.config.deficitQuantum, this.config.maxDeficit);
        }
      }
      const assignments = [];
      let deferred = 0;
      for (const task of this.tasks.queued()) {
        if (assignments.length >= max) {
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
    pick(strategy, candidates, cost) {
      switch (strategy) {
        case "least-loaded": {
          let best = null;
          for (const agent of candidates) {
            if (best === null || this.agents.utilizationOf(agent) < this.agents.utilizationOf(best) || this.agents.utilizationOf(agent) === this.agents.utilizationOf(best) && agent.id < best.id) {
              best = agent;
            }
          }
          return best;
        }
        case "pack": {
          let best = null;
          for (const agent of candidates) {
            if (best === null || this.agents.utilizationOf(agent) > this.agents.utilizationOf(best) || this.agents.utilizationOf(agent) === this.agents.utilizationOf(best) && agent.id < best.id) {
              best = agent;
            }
          }
          return best;
        }
        case "round-robin": {
          let best = null;
          for (const agent of candidates) {
            if (!canPay(agent.deficit, cost))
              continue;
            if (best === null || agent.deficit > best.deficit || agent.deficit === best.deficit && agent.id < best.id) {
              best = agent;
            }
          }
          return best;
        }
      }
    }
    attach(task, agent, now, strategy) {
      task.status = "running";
      task.assignedTo = agent.id;
      task.assignedAt = now;
      agent.runningTasks.push(task.id);
      this.tasks.record(task, now, "assigned", `agent=${agent.id} strategy=${strategy}`);
    }
    complete(taskId, now, note) {
      const task = this.tasks.requireRunning(taskId);
      const agent = this.agents.requireAgent(task.assignedTo, "assignedTo");
      task.status = "completed";
      task.settledAt = now;
      task.note = note ?? null;
      detach(agent, task.id);
      agent.completedCount += 1;
      this.tasks.record(task, now, "completed", note === undefined ? undefined : `note=${note}`);
    }
    fail(taskId, now, reason) {
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
    heartbeat(agentId, now) {
      this.agents.heartbeat(agentId, now);
    }
    tick(now) {
      const stale = this.agents.list().filter((agent) => agent.runningTasks.length > 0 && now - agent.lastHeartbeat > this.config.heartbeatTimeoutMs);
      const result = { at: now, staleAgents: [], reassigned: 0, deadLettered: 0 };
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
    stats(now) {
      const all = this.agents.list();
      const running = this.tasks.running();
      const runningByAgent = new Map;
      for (const task of running) {
        if (task.assignedTo !== null) {
          runningByAgent.set(task.assignedTo, (runningByAgent.get(task.assignedTo) ?? 0) + 1);
        }
      }
      const assignmentsPerAgent = {};
      const utilizationPerAgent = {};
      const weights = {};
      let activeAgents = 0;
      let drainedAgents = 0;
      let staleAgents = 0;
      for (const agent of all) {
        const currentLoad = runningByAgent.get(agent.id) ?? 0;
        assignmentsPerAgent[agent.id] = agent.completedCount + agent.failedCount + currentLoad;
        utilizationPerAgent[agent.id] = round3(currentLoad / agent.capacity);
        weights[agent.id] = agent.weight;
        if (agent.status === "active")
          activeAgents += 1;
        else
          drainedAgents += 1;
        if (now - agent.lastHeartbeat > this.config.heartbeatTimeoutMs)
          staleAgents += 1;
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
          dead: this.tasks.list({ status: "dead" }).length
        },
        allocations: this.allocationCount,
        assignmentsPerAgent,
        utilizationPerAgent,
        jainFairnessIndex: round6(jainFairnessIndex(shares))
      };
    }
    toState() {
      return {
        version: 1,
        config: { ...this.config },
        allocationCount: this.allocationCount,
        registry: this.agents.toState(),
        taskStore: this.tasks.toState()
      };
    }
    static fromState(state) {
      if (typeof state !== "object" || state === null) {
        throw new AllocationError("CORRUPTION", "allocator state must be an object");
      }
      const record = state;
      if (record.version !== 1) {
        throw new AllocationError("CORRUPTION", `unsupported state version ${String(record.version)}`);
      }
      const config = record.config;
      if (typeof config !== "object" || config === null) {
        throw new AllocationError("CORRUPTION", "allocator state.config must be an object");
      }
      const allocator = new Allocator({ config });
      const allocationCount = record.allocationCount;
      if (typeof allocationCount !== "number" || !Number.isInteger(allocationCount) || allocationCount < 0) {
        throw new AllocationError("CORRUPTION", "allocator state.allocationCount must be a non-negative integer");
      }
      allocator.allocationCount = allocationCount;
      allocator.agents = AgentRegistry.fromState(record.registry);
      allocator.tasks = TaskStore.fromState(record.taskStore);
      return allocator;
    }
    candidateAgents(now) {
      return this.agents.activeAgents().filter((agent) => now - agent.lastHeartbeat <= this.config.heartbeatTimeoutMs);
    }
  }
  function detach(agent, taskId) {
    const index = agent.runningTasks.indexOf(taskId);
    if (index !== -1)
      agent.runningTasks.splice(index, 1);
  }
  function round3(value) {
    return Math.round(value * 1000) / 1000;
  }
  function round6(value) {
    return Math.round(value * 1e6) / 1e6;
  }

  // demo/main.ts
  var $ = (id) => {
    const node = document.getElementById(id);
    if (!node)
      throw new Error(`missing #${id}`);
    return node;
  };
  var allocator = new Allocator;
  var clock = 1e6;
  var lapsed = null;
  var logLines = [];
  var AGENTS = [
    { id: "render-1", capabilities: ["gpu", "web"], capacity: 2, weight: 1 },
    { id: "worker-1", capabilities: ["web"], capacity: 3, weight: 2 },
    { id: "mailer-1", capabilities: ["email"], capacity: 1, weight: 1 }
  ];
  var TASKS = [
    { id: "t1", requires: ["web"], cost: 4, priority: 9 },
    { id: "t2", requires: ["gpu"], cost: 10, priority: 8 },
    { id: "t3", requires: ["web"], cost: 2, priority: 7 },
    { id: "t4", requires: ["email"], cost: 1, priority: 6 },
    { id: "t5", requires: ["web", "gpu"], cost: 8, priority: 9 },
    { id: "t6", requires: ["web"], cost: 3, priority: 5 },
    { id: "t7", requires: ["gpu"], cost: 6, priority: 4 },
    { id: "t8", requires: ["email"], cost: 2, priority: 3 },
    { id: "t9", requires: ["archive"], cost: 1, priority: 2 }
  ];
  var log = (line) => {
    logLines.unshift(line);
    logLines.splice(40);
    $("log").textContent = logLines.join(`
`);
  };
  var pill = (text, cls = "") => `<span class="badge ${cls}">${text}</span>`;
  var caps = (values) => values.length ? values.map((v) => `<span class="cap">${v}</span>`).join(" ") : "any";
  var render = () => {
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
      ["rounds", String(stats.allocations)]
    ].map(([label, value]) => `<div class="stat"><span>${label}</span><strong>${value}</strong></div>`).join("");
    $("agents").innerHTML = agents.map((agent) => {
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
    }).join("");
    $("tasks").innerHTML = tasks.map((task) => `<tr>
        <td><code>${task.id}</code></td>
        <td>${caps(task.requires)}</td>
        <td class="num">${task.priority}</td>
        <td>${pill(task.status, task.status)}</td>
        <td>${task.assignedTo ?? "-"}</td>
      </tr>`).join("");
  };
  var heartbeatAll = () => {
    for (const agent of allocator.agents.list()) {
      if (agent.id === lapsed)
        continue;
      allocator.agents.heartbeat(agent.id, clock);
    }
  };
  var reset = () => {
    allocator = new Allocator;
    clock = 1e6;
    lapsed = null;
    logLines.length = 0;
    for (const agent of AGENTS)
      allocator.agents.register(agent, clock);
    for (const task of TASKS)
      allocator.tasks.add(task, clock, allocator.config.defaultMaxAttempts);
    log(`seeded ${AGENTS.length} agents and ${TASKS.length} tasks at t=${clock}`);
    render();
  };
  var allocateRound = () => {
    heartbeatAll();
    clock += 1000;
    const strategy = parseStrategy($("strategy") instanceof HTMLSelectElement ? $("strategy").value : "");
    const result = allocator.allocate(clock, { strategy });
    const assigned = result.assignments.map((a) => `${a.taskId}->${a.agentId}`).join(", ");
    log(`${strategy} at t=${clock}: ${result.assignments.length} assigned` + (assigned ? ` (${assigned})` : "") + `, ${result.deferred} deferred, ${result.breakdown.candidates} candidate agents`);
    render();
  };
  var completeRunning = () => {
    const running = allocator.tasks.running();
    if (!running.length) {
      log("nothing running to complete");
      return;
    }
    for (const task of running)
      allocator.complete(task.id, clock);
    log(`completed ${running.length} task(s): ${running.map((t) => t.id).join(", ")}`);
    render();
  };
  var lapseAgent = () => {
    const candidate = allocator.agents.list().find((agent) => agent.id !== lapsed);
    if (!candidate) {
      log("every agent has already lapsed - reset to start over");
      return;
    }
    lapsed = candidate.id;
    clock += allocator.config.heartbeatTimeoutMs + 1000;
    const tick = allocator.tick(clock);
    log(`t=${clock}: ${candidate.id} stopped heartbeating; tick recovered ` + `${tick.reassigned} task(s) from ${tick.staleAgents.length} stale agent(s)`);
    render();
  };
  var bind = (id, handler) => {
    $(id).addEventListener("click", handler);
  };
  bind("allocate", allocateRound);
  bind("complete", completeRunning);
  bind("lapse", lapseAgent);
  bind("reset", reset);
  reset();
})();
