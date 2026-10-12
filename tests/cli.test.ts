import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], options: { cwd: string; input?: string; timeoutMs?: number }): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn("bun", [CLI, ...args], { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    if (options.input !== undefined) child.stdin.write(options.input);
    child.stdin.end();
  });
}

describe("CLI", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "alloc-cli-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("help exits 0 and mentions the strategies", async () => {
    const result = await run(["--help"], { cwd: dir });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("round-robin");
    expect(result.stdout).toContain("Exit codes");
  });

  test("usage errors exit 2", async () => {
    expect((await run(["allocate", "--strategy", "chaos"], { cwd: dir })).code).toBe(2);
    expect((await run(["bogus-command"], { cwd: dir })).code).toBe(2);
    expect((await run(["register"], { cwd: dir })).code).toBe(2);
    expect((await run([], { cwd: dir })).code).toBe(2);
  });

  test("full end-to-end workflow with --state persistence", async () => {
    expect((await run(["register", "alpha", "--caps", "web,email", "--capacity", "2"], { cwd: dir })).code).toBe(0);
    expect((await run(["register", "beta", "--caps", "web"], { cwd: dir })).code).toBe(0);
    expect((await run(["task", "job-1", "--requires", "web,email", "--cost", "4"], { cwd: dir })).code).toBe(0);
    expect((await run(["task", "job-2", "--requires", "web"], { cwd: dir })).code).toBe(0);

    const allocated = await run(["allocate", "--strategy", "least-loaded"], { cwd: dir });
    expect(allocated.code).toBe(0);
    const result = JSON.parse(allocated.stdout);
    expect(result.assignments).toHaveLength(2);
    expect(result.assignments[0].agentId).toBe("alpha"); // email requires alpha

    expect((await run(["complete", "job-1", "--note", "done"], { cwd: dir })).code).toBe(0);

    const failed = await run(["fail", "job-2", "--note", "boom"], { cwd: dir });
    expect(failed.code).toBe(0);
    const outcome = JSON.parse(failed.stdout);
    expect(outcome.retried).toBe(true);

    const stats = await run(["stats"], { cwd: dir });
    expect(stats.code).toBe(0);
    const parsed = JSON.parse(stats.stdout);
    expect(parsed.tasks.completed).toBe(1);
    expect(parsed.tasks.queued).toBe(1);
    expect(parsed.jainFairnessIndex).toBeGreaterThan(0);
    expect(parsed.jainFairnessIndex).toBeLessThanOrEqual(1);

    const tick = await run(["tick"], { cwd: dir });
    expect(JSON.parse(tick.stdout).staleAgents).toEqual([]);

    const tasks = await run(["tasks", "--status", "queued"], { cwd: dir });
    expect(JSON.parse(tasks.stdout).tasks[0].id).toBe("job-2");
  });

  test("state file is created and reloads across invocations", async () => {
    expect((await run(["register", "solo", "--caps", "gpu"], { cwd: dir })).code).toBe(0);
    const agents = await run(["agents"], { cwd: dir });
    const list = JSON.parse(agents.stdout).agents.map((a: { id: string }) => a.id);
    expect(list).toContain("solo");
  });

  test("demo runs deterministically and ends with the fairness summary", async () => {
    const first = await run(["demo"], { cwd: dir });
    const second = await run(["demo"], { cwd: dir });
    expect(first.code).toBe(0);
    expect(first.stdout).toBe(second.stdout);
    expect(first.stdout).toContain("fairness");
  });

  test("demo matches the README transcript byte-for-byte", async () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf-8");
    const demo = await run(["demo"], { cwd: dir });
    const match = readme.match(/```\n\$ .*demo\n([\s\S]*?)```/);
    expect(match).not.toBeNull();
    if (match && match[1] !== undefined) {
      expect(demo.stdout).toBe(match[1]);
    }
  });

});
