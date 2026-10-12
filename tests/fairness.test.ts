import { describe, expect, test } from "bun:test";
import { jainFairnessIndex, weightedShares, replenishDeficit, canPay, payDeficit } from "../src/fairness.js";
import { AllocationError } from "../src/errors.js";

describe("jainFairnessIndex", () => {
  test("returns 1 for equal shares", () => {
    expect(jainFairnessIndex([3, 3, 3])).toBe(1);
  });

  test("returns 1 for the empty set and the all-zero set", () => {
    expect(jainFairnessIndex([])).toBe(1);
    expect(jainFairnessIndex([0, 0, 0])).toBe(1);
  });

  test("penalizes skew", () => {
    const skewed = jainFairnessIndex([10, 0, 0]);
    expect(skewed).toBeGreaterThan(0);
    expect(skewed).toBeLessThan(0.5);
  });
});

describe("weightedShares", () => {
  test("divides assignment counts by agent weight", () => {
    const shares = weightedShares({ a: 6, b: 2 }, { a: 3, b: 1 });
    expect(shares).toEqual([2, 2]);
    expect(jainFairnessIndex(shares)).toBe(1);
  });

  test("zero-weight agents with work produce an infinite share (unfair)", () => {
    const shares = weightedShares({ a: 1, b: 5 }, { a: 0, b: 1 });
    expect(shares[0]).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("deficit arithmetic", () => {
  test("replenishDeficit adds weight × quantum and caps", () => {
    expect(replenishDeficit(0, 1, 10, 100)).toBe(10);
    expect(replenishDeficit(0, 3, 10, 100)).toBe(30);
    expect(replenishDeficit(95, 1, 10, 100)).toBe(100);
  });

  test("canPay requires deficit >= cost", () => {
    expect(canPay(10, 10)).toBe(true);
    expect(canPay(9, 10)).toBe(false);
  });

  test("payDeficit floors at zero and rejects negative cost", () => {
    expect(payDeficit(4, 10)).toBe(0);
    expect(payDeficit(10, 4)).toBe(6);
    expect(() => payDeficit(10, -1)).toThrow(AllocationError);
  });
});
