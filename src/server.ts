import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { AllocationError, isAllocationError } from "./errors.js";
import { parseStrategy } from "./allocator.js";
import { saveState } from "./persistence.js";
import type { Allocator } from "./allocator.js";
import type { AgentInput, AgentPatch, AllocationStrategy, TaskInput, TaskStatus } from "./types.js";

export interface ServerOptions {
  allocator: Allocator;
  port: number;
  /** when set, mutating routes require `Authorization: Bearer <token>` */
  token?: string;
  /** when set, every successful mutation is persisted to this path */
  statePath?: string;
}

const TASK_STATUSES: readonly TaskStatus[] = ["queued", "running", "completed", "dead"];

function bearerToken(request: IncomingMessage): string | null {
  const header = request.headers.authorization;
  if (header === undefined || !header.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length);
}

function authorized(request: IncomingMessage, token: string | undefined): boolean {
  if (token === undefined) return true;
  const provided = bearerToken(request);
  if (provided === null) return false;
  const a = Buffer.from(provided, "utf-8");
  const b = Buffer.from(token, "utf-8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, null, 2) + "\n";
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(json);
}

function errorBody(error: AllocationError): { code: string; message: string } {
  return { code: error.code, message: error.message };
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
    if (chunks.reduce((total, c) => total + c.length, 0) > 1_000_000) {
      throw new AllocationError("VALIDATION", "request body exceeds 1MB");
    }
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (raw.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new AllocationError("VALIDATION", "request body must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof AllocationError) throw error;
    throw new AllocationError("VALIDATION", "request body is not valid JSON");
  }
}

/** Create the HTTP API around an allocator. */
export function createAllocatorServer(options: ServerOptions): Server {
  const { allocator, port, token, statePath } = options;

  async function persist(): Promise<void> {
    if (statePath !== undefined) await saveState(allocator, statePath);
  }

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (isAllocationError(error)) {
        sendJson(response, error.httpStatus, errorBody(error));
        return;
      }
      sendJson(response, 500, { code: "INTERNAL", message: String(error) });
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", `http://localhost:${port}`);
    const path = url.pathname;
    const method = request.method ?? "GET";
    const mutating = method !== "GET" && method !== "HEAD";

    if (mutating && !authorized(request, token)) {
      sendJson(response, 401, { code: "UNAUTHORIZED", message: "missing or invalid bearer token" });
      return;
    }

    if (method === "GET" && path === "/healthz") {
      sendJson(response, 200, { status: "ok" });
      return;
    }

    if (method === "GET" && path === "/stats") {
      sendJson(response, 200, allocator.stats(Date.now()));
      return;
    }

    if (method === "GET" && path === "/config") {
      sendJson(response, 200, allocator.config);
      return;
    }

    if (method === "GET" && path === "/agents") {
      sendJson(response, 200, { agents: allocator.agents.list() });
      return;
    }

    if (method === "POST" && path === "/agents") {
      const body = await readJsonBody(request);
      const input: AgentInput = {};
      if (typeof body.id === "string") input.id = body.id;
      if (Array.isArray(body.capabilities)) input.capabilities = body.capabilities as string[];
      if (typeof body.capacity === "number") input.capacity = body.capacity;
      if (typeof body.weight === "number") input.weight = body.weight;
      if (body.status === "active" || body.status === "drained") input.status = body.status;
      const agent = allocator.agents.register(input, Date.now());
      await persist();
      sendJson(response, 201, agent);
      return;
    }

    const agentMatch = path.match(/^\/agents\/([^/]+)$/);
    if (agentMatch !== null) {
      const id = decodeURIComponent(agentMatch[1] ?? "");
      if (method === "GET") {
        sendJson(response, 200, allocator.agents.get(id));
        return;
      }
      if (method === "PATCH") {
        const body = await readJsonBody(request);
        const patch: AgentPatch = {};
        if (Array.isArray(body.capabilities)) patch.capabilities = body.capabilities as string[];
        if (typeof body.capacity === "number") patch.capacity = body.capacity;
        if (typeof body.weight === "number") patch.weight = body.weight;
        if (body.status === "active" || body.status === "drained") patch.status = body.status;
        const agent = allocator.agents.patch(id, patch);
        await persist();
        sendJson(response, 200, agent);
        return;
      }
      if (method === "DELETE") {
        const agent = allocator.agents.remove(id);
        await persist();
        sendJson(response, 200, agent);
        return;
      }
    }

    const heartbeatMatch = path.match(/^\/agents\/([^/]+)\/heartbeat$/);
    if (heartbeatMatch !== null && method === "POST") {
      const id = decodeURIComponent(heartbeatMatch[1] ?? "");
      allocator.heartbeat(id, Date.now());
      await persist();
      sendJson(response, 200, allocator.agents.get(id));
      return;
    }

    if (method === "GET" && path === "/tasks") {
      const statusParam = url.searchParams.get("status");
      const assignedToParam = url.searchParams.get("assignedTo");
      const filter: { status?: TaskStatus; assignedTo?: string } = {};
      if (statusParam !== null) {
        if (!(TASK_STATUSES as readonly string[]).includes(statusParam)) {
          throw new AllocationError("VALIDATION", `status must be one of: ${TASK_STATUSES.join(", ")}`);
        }
        filter.status = statusParam as TaskStatus;
      }
      if (assignedToParam !== null) filter.assignedTo = assignedToParam;
      sendJson(response, 200, { tasks: allocator.tasks.list(filter) });
      return;
    }

    if (method === "POST" && path === "/tasks") {
      const body = await readJsonBody(request);
      const input: TaskInput = {};
      if (typeof body.id === "string") input.id = body.id;
      if (Array.isArray(body.requires)) input.requires = body.requires as string[];
      if (typeof body.cost === "number") input.cost = body.cost;
      if (typeof body.priority === "number") input.priority = body.priority;
      if (typeof body.maxAttempts === "number") input.maxAttempts = body.maxAttempts;
      const task = allocator.tasks.add(input, Date.now(), allocator.config.defaultMaxAttempts);
      await persist();
      sendJson(response, 201, task);
      return;
    }

    if (method === "POST" && path === "/allocate") {
      const body = await readJsonBody(request);
      const options: { strategy?: AllocationStrategy; max?: number } = {};
      if (body.strategy !== undefined) options.strategy = parseStrategy(body.strategy);
      if (typeof body.max === "number") options.max = body.max;
      const result = allocator.allocate(Date.now(), options);
      await persist();
      sendJson(response, 200, result);
      return;
    }

    const taskAction = path.match(/^\/tasks\/([^/]+)\/(complete|fail)$/);
    if (taskAction !== null && method === "POST") {
      const id = decodeURIComponent(taskAction[1] ?? "");
      const action = taskAction[2] ?? "";
      const body = await readJsonBody(request);
      const note = typeof body.note === "string" ? body.note : undefined;
      if (action === "complete") {
        if (note === undefined) {
          allocator.complete(id, Date.now());
        } else {
          allocator.complete(id, Date.now(), note);
        }
      } else {
        const outcome = note === undefined ? allocator.fail(id, Date.now()) : allocator.fail(id, Date.now(), note);
        await persist();
        sendJson(response, 200, { task: allocator.tasks.get(id), ...outcome });
        return;
      }
      await persist();
      sendJson(response, 200, allocator.tasks.get(id));
      return;
    }

    const taskMatch = path.match(/^\/tasks\/([^/]+)$/);
    if (taskMatch !== null && method === "GET") {
      sendJson(response, 200, allocator.tasks.get(decodeURIComponent(taskMatch[1] ?? "")));
      return;
    }

    if (method === "POST" && path === "/tick") {
      const result = allocator.tick(Date.now());
      await persist();
      sendJson(response, 200, result);
      return;
    }

    sendJson(response, 404, { code: "NOT_FOUND", message: `no route for ${method} ${path}` });
  }

  server.listen(port);
  return server;
}
