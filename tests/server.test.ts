import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import { Allocator } from "../src/allocator.js";
import { createAllocatorServer } from "../src/server.js";

interface TestServer {
  url: string;
  close: () => Promise<void>;
}

async function startServer(options: { token?: string; statePath?: string }): Promise<TestServer> {
  const allocator = new Allocator();
  const server = createAllocatorServer({
    allocator,
    port: 0,
    ...(options.token !== undefined ? { token: options.token } : {}),
    ...(options.statePath !== undefined ? { statePath: options.statePath } : {}),
  });
  await new Promise<void>((resolve) => server.on("listening", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function request(
  url: string,
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  return fetch(`${url}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (response) => ({ status: response.status, json: await response.json() }));
}

describe("allocation HTTP API", () => {
  let server: TestServer;
  let secured: TestServer;

  beforeAll(async () => {
    server = await startServer({});
    secured = await startServer({ token: "sekrit" });
  });

  afterAll(async () => {
    await server.close();
    await secured.close();
  });

  test("healthz responds ok", async () => {
    const { status, json } = await request(server.url, "GET", "/healthz");
    expect(status).toBe(200);
    expect(json.status).toBe("ok");
  });

  test("register, list, get, patch, heartbeat, remove agents", async () => {
    const created = await request(server.url, "POST", "/agents", { id: "alpha", capabilities: ["web"], capacity: 2 });
    expect(created.status).toBe(201);
    expect(created.json.id).toBe("alpha");

    expect((await request(server.url, "POST", "/agents", { capabilities: [] })).status).toBe(400);
    expect((await request(server.url, "POST", "/agents", { id: "alpha", capabilities: ["web"] })).status).toBe(409);
    expect((await request(server.url, "GET", "/agents")).status).toBe(200);
    expect((await request(server.url, "GET", "/agents/alpha")).status).toBe(200);
    expect((await request(server.url, "GET", "/agents/nope")).status).toBe(404);

    const patched = await request(server.url, "PATCH", "/agents/alpha", { capacity: 3 });
    expect(patched.status).toBe(200);
    expect(patched.json.capacity).toBe(3);

    const beat = await request(server.url, "POST", "/agents/alpha/heartbeat");
    expect(beat.status).toBe(200);

    await request(server.url, "POST", "/agents", { id: "temp", capabilities: ["web"] });
    expect((await request(server.url, "DELETE", "/agents/temp")).status).toBe(200);
  });

  test("add tasks, allocate, complete, fail", async () => {
    await request(server.url, "POST", "/agents", { id: "worker", capabilities: ["web", "gpu"] });
    const created = await request(server.url, "POST", "/tasks", { id: "job-1", requires: ["web"], cost: 2 });
    expect(created.status).toBe(201);
    expect((await request(server.url, "POST", "/tasks", { cost: 0 })).status).toBe(400);

    const listed = await request(server.url, "GET", "/tasks?status=queued");
    expect(listed.json.tasks).toHaveLength(1);

    const allocated = await request(server.url, "POST", "/allocate", { strategy: "least-loaded" });
    expect(allocated.status).toBe(200);
    // shared server: whichever capable idle agent wins the tie, job-1 goes running
    expect(allocated.json.assignments[0]?.taskId).toBe("job-1");
    expect(allocated.json.assignments[0]?.agentId).toBeDefined();
    expect((await request(server.url, "POST", "/allocate", { strategy: "chaos" })).status).toBe(400);

    expect((await request(server.url, "GET", "/tasks/job-1")).json.status).toBe("running");
    expect((await request(server.url, "POST", "/tasks/job-1/complete", { note: "ok" })).status).toBe(200);
    expect((await request(server.url, "GET", "/tasks/job-1")).json.status).toBe("completed");

    await request(server.url, "POST", "/tasks", { id: "job-2", maxAttempts: 1 });
    await request(server.url, "POST", "/allocate", {});
    const failed = await request(server.url, "POST", "/tasks/job-2/fail", { note: "boom" });
    expect(failed.status).toBe(200);
    expect(failed.json.deadLettered).toBe(true);
    expect(failed.json.task.status).toBe("dead");

    expect((await request(server.url, "POST", "/tasks/job-2/complete", {})).status).toBe(409);
    expect((await request(server.url, "GET", "/tasks/missing")).status).toBe(404);
  });

  test("stats, tick, and 404 fallback", async () => {
    const stats = await request(server.url, "GET", "/stats");
    expect(stats.status).toBe(200);
    expect(stats.json.agents).toBeGreaterThanOrEqual(1);
    expect(stats.json).toHaveProperty("jainFairnessIndex");

    const tick = await request(server.url, "POST", "/tick");
    expect(tick.status).toBe(200);
    expect(tick.json).toHaveProperty("staleAgents");

    expect((await request(server.url, "GET", "/nope")).status).toBe(404);
  });

  test("mutations require the bearer token when configured", async () => {
    expect((await request(secured.url, "POST", "/agents", { capabilities: ["web"] })).status).toBe(401);
    expect((await request(secured.url, "POST", "/agents", { capabilities: ["web"] }, "wrong")).status).toBe(401);
    expect((await request(secured.url, "POST", "/agents", { capabilities: ["web"] }, "sekrit")).status).toBe(201);
    expect((await request(secured.url, "GET", "/agents")).status).toBe(200);
  });

  test("malformed bodies are rejected with 400", async () => {
    const response = await fetch(`${server.url}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(response.status).toBe(400);
  });
});
