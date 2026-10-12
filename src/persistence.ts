import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { AllocationError } from "./errors.js";
import { Allocator } from "./allocator.js";

const STATE_VERSION = 1;

/**
 * Persist allocator state atomically: the JSON is written to a temp
 * file in the same directory and renamed over the target. A crash
 * mid-write leaves the previous state intact.
 */
export async function saveState(allocator: Allocator, path: string): Promise<void> {
  const json = JSON.stringify(toStateEnvelope(allocator), null, 2) + "\n";
  const dir = dirname(path);
  const tmp = join(dir, `.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(tmp, json, "utf-8");
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    if (error instanceof AllocationError) throw error;
    throw new AllocationError("CORRUPTION", `failed to save state to ${path}: ${String(error)}`);
  }
}

/**
 * Load state previously written by saveState. Returns null when the
 * file does not exist yet (fresh start); throws CORRUPTION when it
 * exists but cannot be parsed or validated.
 */
export async function loadState(allocator: Allocator, path: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return false;
    throw new AllocationError("CORRUPTION", `failed to read state from ${path}: ${String(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new AllocationError("CORRUPTION", `state file ${path} is not valid JSON`);
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new AllocationError("CORRUPTION", `state file ${path} must contain a JSON object`);
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== STATE_VERSION) {
    throw new AllocationError("CORRUPTION", `state file ${path} has unsupported version ${String(record.version)}`);
  }
  if (record.kind !== "allocator") {
    throw new AllocationError("CORRUPTION", `state file ${path} is not an allocator state file`);
  }
  if (record.state === undefined) {
    throw new AllocationError("CORRUPTION", `state file ${path} is missing the state payload`);
  }

  const revived = Allocator.fromState(record.state);
  allocator.agents = revived.agents;
  allocator.tasks = revived.tasks;
  allocator.config = revived.config;
  allocator.allocationCount = revived.allocationCount;
  return true;
}

export function toStateEnvelope(allocator: Allocator): Record<string, unknown> {
  return { version: STATE_VERSION, kind: "allocator", state: allocator.toState() };
}
