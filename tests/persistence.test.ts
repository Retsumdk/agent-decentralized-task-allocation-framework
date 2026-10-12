import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Allocator } from "../src/allocator.js";
import { loadState, saveState, toStateEnvelope } from "../src/persistence.js";
import { AllocationError } from "../src/errors.js";

const BASE = 1_700_000_000_000;

describe("persistence", () => {
  test("save + load round-trips the full allocator state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "alloc-test-"));
    try {
      const path = join(dir, "state.json");
      const allocator = new Allocator({ config: { heartbeatTimeoutMs: 5_000 } });
      allocator.agents.register({ id: "a", capabilities: ["web"], capacity: 2, weight: 2 }, BASE);
      allocator.tasks.add({ id: "t1", requires: ["web"], cost: 4 }, BASE, 3);
      allocator.allocate(BASE, { strategy: "round-robin", max: 1 });
      await saveState(allocator, path);

      const revived = new Allocator();
      const loaded = await loadState(revived, path);
      expect(loaded).toBe(true);
      expect(revived.agents.get("a")).toEqual(allocator.agents.get("a"));
      expect(revived.tasks.get("t1")).toEqual(allocator.tasks.get("t1"));
      expect(revived.config.heartbeatTimeoutMs).toBe(5_000);
      expect(revived.stats(BASE).allocations).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("loadState returns false for a missing file (fresh start)", async () => {
    const allocator = new Allocator();
    expect(await loadState(allocator, join(tmpdir(), "alloc-does-not-exist", "state.json"))).toBe(false);
  });

  test("loadState throws CORRUPTION on invalid payloads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "alloc-test-"));
    try {
      const badJson = join(dir, "bad.json");
      await writeFile(badJson, "{not json", "utf-8");
      expect(await loadState(new Allocator(), badJson).catch((error: unknown) => error)).toBeInstanceOf(AllocationError);

      const badVersion = join(dir, "bad-version.json");
      await writeFile(badVersion, JSON.stringify({ version: 2, kind: "allocator", state: {} }), "utf-8");
      let message = "";
      await loadState(new Allocator(), badVersion).catch((error: unknown) => {
        message = (error as Error).message;
      });
      expect(message).toContain("unsupported version");

      const badKind = join(dir, "bad-kind.json");
      await writeFile(badKind, JSON.stringify({ version: 1, kind: "other", state: {} }), "utf-8");
      await expect(loadState(new Allocator(), badKind)).rejects.toThrow(AllocationError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("toStateEnvelope wraps the state with kind and version", () => {
    const envelope = toStateEnvelope(new Allocator());
    expect(envelope.kind).toBe("allocator");
    expect(envelope.version).toBe(1);
  });

  test("the on-disk artifact is valid JSON with a trailing newline", async () => {
    const dir = await mkdtemp(join(tmpdir(), "alloc-test-"));
    try {
      const path = join(dir, "state.json");
      await saveState(new Allocator(), path);
      const raw = await readFile(path, "utf-8");
      expect(raw.endsWith("\n")).toBe(true);
      expect(JSON.parse(raw)).toHaveProperty("state");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
