import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyPool, emptyToken, type Pool } from "../src/core/model";
import { expireLiquidity, snapshot } from "../src/core/analytics";
import { evaluateOutcome, type SignalPolicy } from "../src/core/research";
import { applyDepth } from "../src/adapters/evm-depth";

const now = 1_780_000_000_000;
const address = (digit: string) => `0x${digit.repeat(40)}`;
const pool = (timestamp = now): Pool => ({ ...emptyPool({
  chain: "base", protocol: "uniswap-v3", dex: "fixture", poolAddress: address("3"),
  token0: emptyToken(address("1"), "A"), token1: emptyToken(address("2"), "B"), source: "fixture",
}, timestamp), price: 100, fees1h: 10, volume1h: 100, feeConfidence: "MEDIUM", feeWindows: {
  "1h": { volumeUsd: 100, feesUsd: 10, windowStart: timestamp - 3_600_000, windowEnd: timestamp,
    startBlock: 1, endBlock: 2, methodology: "EVENT_DERIVED", confidence: "MEDIUM" },
} });
const depth = (updatedAt = now) => ({ depth1PctUsd: 1_000, depth2_5PctUsd: 2_500,
  depth5PctUsd: 5_000, depth10PctUsd: 10_000, confidence: "MEDIUM" as const, source: "fixture",
  updatedAt, blockId: "123", stateKey: "fixture", priceAtCalculation: 100 });
const policy: SignalPolicy = { feeEfficiency: 0.001, volumeDepth: 1, activity: 70, risk: 60,
  breakoutPct: 5, collapsePct: 20, persistenceFraction: 0.5, maxObservationGapMs: 60_000 };

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(() => vi.useRealTimers());

describe("Sprint9 depth freshness", () => {
  it("rejects an expired observation before calculating USD depth metrics", () => {
    const target = pool(); applyDepth(target, depth(now - 120_001), 120_000);
    expect(target).toMatchObject({ depthState: "STALE", depthConfidence: "UNAVAILABLE", depth5PctUsd: null });
    expect(snapshot(target, []).metrics.volumeDepthRatio1h).toBeNull();
  });

  it("expires the read view without mutating historical depth", () => {
    const target = pool(); applyDepth(target, depth(), 120_000);
    const persisted = snapshot(target, []);
    expect(persisted.metrics.volumeDepthRatio1h).not.toBeNull();
    expect(expireLiquidity(persisted, now + 120_000).pool.depthState).toBe("CURRENT");
    const expired = expireLiquidity(persisted, now + 120_001);
    expect(expired.pool).toMatchObject({ depthState: "STALE", depth5PctUsd: null });
    expect(expired.metrics.volumeDepthRatio1h).toBeNull();
    expect(expired.metrics.feeEfficiencyDepth1h).toBeNull();
    expect(persisted.pool.depth5PctUsd).toBe(5_000);
  });

  it("rejects depth after material pair price drift", () => {
    const target = pool(); target.price = 200;
    applyDepth(target, depth(), 120_000);
    expect(target.depthState).toBe("STALE");
    expect(target.depth5PctUsd).toBeNull();
  });
});

describe("Sprint9 outcome completeness", () => {
  it("keeps an endpoint with large observation gaps PARTIAL and excludes PRICE_RANGE_COMPLETE", () => {
    const start = snapshot(pool(), []);
    const endpoint = snapshot({ ...pool(now + 1_800_000), price: 108 }, []);
    const result = evaluateOutcome(start, [endpoint], "30m", policy);
    expect(result.priceReturn).toBeCloseTo(0.08);
    expect(result.fieldCompleteness).toMatchObject({ price: "PARTIAL", range: "PARTIAL" });
    expect(result.completenessClasses).not.toContain("PRICE_RANGE_COMPLETE");
  });

  it("includes PRICE_RANGE_COMPLETE only with sufficient observed coverage and all price/range fields", () => {
    const start = snapshot(pool(), []);
    const path = Array.from({ length: 30 }, (_, i) => snapshot(pool(now + (i + 1) * 60_000), []));
    const result = evaluateOutcome(start, path, "30m", policy);
    expect(result.observationCoveragePct).toBe(100);
    expect(result.fieldCompleteness).toMatchObject({ price: "COMPLETE", range: "COMPLETE" });
    expect(result.completenessClasses).toContain("PRICE_RANGE_COMPLETE");
    expect(result.completenessClasses).not.toContain("FULL_COMPLETE");
  });

  it("excludes expired depth from horizon changes even when cached numeric depth remains", () => {
    const first = pool(); applyDepth(first, depth(), 120_000);
    const endpoint = pool(now + 1_800_000);
    Object.assign(endpoint, { depthState: "CURRENT", depthConfidence: "MEDIUM", depth5PctUsd: 10_000,
      depthUpdatedAt: now, depthExpiresAt: now + 120_000 });
    const result = evaluateOutcome(snapshot(first, []), [snapshot(endpoint, [])], "30m", policy);
    expect(result.depth5PctChange).toBeNull();
    expect(result.completenessClasses).not.toContain("DEPTH_COMPLETE");
  });
});
