import { AllocationError } from "./errors.js";

/**
 * Jain's fairness index: (Σx)² / (n·Σx²) ∈ [0, 1], where 1 means every
 * share is equal. We feed it capacity-weighted shares so that an agent
 * with weight 2 "deserving" twice the work of a weight-1 agent is
 * treated as fair.
 */
export function jainFairnessIndex(shares: number[]): number {
  if (shares.length === 0) return 1;
  const sum = shares.reduce((total, x) => total + x, 0);
  const sumSquares = shares.reduce((total, x) => total + x * x, 0);
  if (sumSquares === 0) return 1;
  return (sum * sum) / (shares.length * sumSquares);
}

/**
 * Weighted shares: assignment count divided by the agent's weight.
 * Under proportional fairness the quotient is identical for every
 * agent, giving a Jain index of exactly 1.
 */
export function weightedShares(
  assignmentsPerAgent: Record<string, number>,
  weights: Record<string, number>,
): number[] {
  const shares: number[] = [];
  for (const [id, count] of Object.entries(assignmentsPerAgent)) {
    const weight = weights[id] ?? 0;
    shares.push(weight > 0 ? count / weight : count > 0 ? Number.POSITIVE_INFINITY : 0);
  }
  return shares;
}

/** Add one round of credits (weight × quantum), capped at maxDeficit. */
export function replenishDeficit(deficit: number, weight: number, quantum: number, maxDeficit: number): number {
  return Math.min(deficit + weight * quantum, maxDeficit);
}

/** An agent can pay for a task when its deficit covers the task's cost. */
export function canPay(deficit: number, cost: number): boolean {
  return deficit >= cost;
}

/** Deduct the task cost from the deficit. Never below zero. */
export function payDeficit(deficit: number, cost: number): number {
  if (cost < 0) throw new AllocationError("VALIDATION", "cost must be non-negative");
  return Math.max(deficit - cost, 0);
}
