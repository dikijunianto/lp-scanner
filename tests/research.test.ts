import { describe, expect, it, vi } from "vitest";
import { createStore } from "../src/db/store";
import { emptyPool, emptyToken, type PriceRecord } from "../src/core/model";
import { snapshot } from "../src/core/analytics";
import { priceConsensus } from "../src/core/pricing";
import { enrichPrices, geckoSource, llamaSource } from "../src/adapters/pricing";
import { readRange, validateCursor } from "../src/adapters/evm-fees";
import type { ReadOnlyRpc } from "../src/adapters/liquidity-rpc";
import {
  horizons,
  priorityTier,
  evaluateOutcome,
  scannerVersion,
  signalRuleVersion,
  type SignalPolicy,
} from "../src/core/research";
import { swapTopic } from "../src/core/fees";

const now = Date.now() - 30 * 3600000;
const addr = (digit: string) => `0x${digit.repeat(40)}`;
const hash = (digit: string) => `0x${digit.repeat(64)}`;
const pool = (time = now) =>
  emptyPool(
    {
      chain: "base",
      protocol: "uniswap-v3",
      dex: "Uniswap V3",
      poolAddress: addr("3"),
      token0: emptyToken(addr("1"), "A"),
      token1: emptyToken(addr("2"), "B"),
      source: "fixture",
    },
    time,
  );
const policy: SignalPolicy = {
  feeEfficiency: 0.001,
  volumeDepth: 1,
  activity: 70,
  risk: 60,
  breakoutPct: 5,
  collapsePct: 20,
  persistenceFraction: 0.5,
  maxObservationGapMs: 86400000,
};
const evidence = (
  source: string,
  priceUsd: number,
  confidence: "HIGH" | "MEDIUM" = "HIGH",
): PriceRecord => ({
  chain: "base",
  assetAddress: addr("1"),
  symbol: "A",
  priceUsd,
  source,
  sourceTimestamp: Date.now(),
  observedAt: Date.now(),
  blockNumber: null,
  confidence,
});

describe("independent prices", () => {
  it("uses median and distinguishes agreement, stale evidence, and severe disagreement", () => {
    expect(priceConsensus([evidence("A", 100), evidence("B", 100.5)], 1, 15)).toMatchObject({
      sourceCount: 2,
      confidence: "HIGH",
    });
    expect(priceConsensus([evidence("A", 100)], 1, 15)).toMatchObject({
      sourceCount: 1,
      confidence: "MEDIUM",
    });
    expect(priceConsensus([evidence("A", 100), evidence("B", 150)], 1, 15).confidence).toBe(
      "UNAVAILABLE",
    );
    expect(
      priceConsensus([{ ...evidence("A", 100), confidence: "LOW" }], 1, 15).medianPrice,
    ).toBeNull();
  });
  it("uses cached independent evidence when live sources are unavailable", async () => {
    const s = createStore(":memory:");
    const primary = vi.spyOn(llamaSource, "fetch").mockResolvedValue([]);
    const fallback = vi.spyOn(geckoSource, "fetch").mockResolvedValue([]);
    try {
      s.savePrices([
        evidence("DefiLlama Coins API", 2),
        { ...evidence("DefiLlama Coins API", 3), assetAddress: addr("2") },
      ]);
      const p = pool(Date.now());
      p.token0.usdPrice = 2;
      p.token1.usdPrice = 3;
      const result = await enrichPrices([p], s);
      expect(result.note).toContain("2/2 timestamped");
      expect(p.token0.usdPriceSource).toBe("DefiLlama Coins API");
      expect(p.token0.priceSourceCount).toBe(1);
      expect(fallback).toHaveBeenCalled();
    } finally {
      primary.mockRestore();
      fallback.mockRestore();
      s.close();
    }
  });
  it("cross-checks independent sources without letting discovery quotes veto them", async () => {
    const primary = vi.spyOn(llamaSource, "fetch").mockResolvedValue([
      evidence("DefiLlama Coins API", 100),
      { ...evidence("DefiLlama Coins API", 1), assetAddress: addr("2") },
    ]);
    const fallback = vi.spyOn(geckoSource, "fetch").mockResolvedValue([
      evidence("CoinGecko Token Price API", 101),
      { ...evidence("CoinGecko Token Price API", 1), assetAddress: addr("2") },
    ]);
    try {
      const p = pool(Date.now());
      p.token0.usdPrice = 50;
      p.token0.usdPriceSource = "GeckoTerminal discovery";
      await enrichPrices([p]);
      expect(p.token0.usdPrice).toBe(100.5);
      expect(p.token0.priceSourceCount).toBe(2);
      expect(p.token0.usdPriceConfidence).toBe("HIGH");
      expect(p.warnings).toContain("PRICE_DISAGREEMENT");
      fallback.mockResolvedValueOnce([evidence("CoinGecko Token Price API", 150)]);
      const conflicted = pool(Date.now());
      await enrichPrices([conflicted]);
      expect(conflicted.token0.usdPrice).toBeNull();
      expect(conflicted.token0.priceConsensusConfidence).toBe("UNAVAILABLE");
    } finally {
      primary.mockRestore();
      fallback.mockRestore();
    }
  });
});

describe("persistent fees and reorgs", () => {
  it("resumes a queued cursor, deduplicates events and aggregates priced windows", () => {
    const s = createStore(":memory:");
    try {
      const p = pool();
      s.save([snapshot(p, [])]);
      s.enqueueBackfill(p, 10);
      expect(s.watch(p.id,true)).toBe(true);
      expect(s.watchedIds().has(p.id)).toBe(true);
      expect(s.watch(p.id,false)).toBe(true);
      expect(s.watchedIds().has(p.id)).toBe(false);
      const event = {
        poolId: p.id,
        chain: "base",
        poolAddress: p.poolAddress,
        blockNumber: 10,
        blockHash: hash("a"),
        txHash: hash("b"),
        logIndex: 0,
        timestamp: now + 60000,
        volumeUsd: 100,
        grossFeeUsd: 0.3,
        lpFeeUsd: 0.3,
        feesUsd: 0.3,
        confidence: "MEDIUM" as const,
      };
      s.saveFeeBatch(p.id, [event], 10, now, 10, hash("a"), now + 120000);
      s.saveFeeBatch(p.id, [event], 10, now, 10, hash("a"), now + 120000);
      expect(s.feeEvents(p.id, now, now + 300000)).toHaveLength(1);
      expect(s.materializedFeeWindow(p.id, "5m", now + 300000, true, 10, 10)).toMatchObject({
        volumeUsd: 100,
        feesUsd: 0.3,
        swapCount: 1,
      });
      expect(s.backfillJobs(1)[0].job.status).toBe("NOT_STARTED");
      s.setBackfillJob(p.id, { status: "FAILED", nextAttemptAt: Date.now() - 1 });
      expect(s.backfillJobs(1)[0].job.status).toBe("FAILED");
      s.setBackfillJob(p.id, { nextAttemptAt: Date.now() + 60000 });
      expect(s.backfillJobs(1)).toHaveLength(0);
      expect(s.feeCursor(p.id)?.blockNumber).toBe(10);
      s.restartFeeCursorFromHead(p.id);
      expect(s.feeCursor(p.id)).toBeNull();
      expect(s.feeEvents(p.id, now, now + 300000)).toHaveLength(1);
    } finally {
      s.close();
    }
  });
  it("rolls back a changed tip to a matching checkpoint and rejects removed logs", async () => {
    const s = createStore(":memory:");
    try {
      const p = pool();
      s.save([snapshot(p, [])]);
      const event = (blockNumber: number) => ({
        poolId: p.id,
        chain: "base",
        txHash: hash(String(blockNumber)),
        logIndex: 0,
        blockNumber,
        blockHash: hash(String(blockNumber)),
        timestamp: now + blockNumber * 60000,
        volumeUsd: 10,
        feesUsd: 0.03,
        confidence: "MEDIUM" as const,
      });
      s.saveFeeBatch(p.id, [event(10)], 10, now + 600000, 10, hash("a"), now + 600000);
      s.checkpoint(p.id, 10, hash("a"), now + 600000);
      s.saveFeeBatch(p.id, [event(11)], 10, now + 600000, 11, hash("b"), now + 660000);
      s.checkpoint(p.id, 11, hash("b"), now + 660000);
      const rpc = {
        call: vi.fn(async (_method: string, params: unknown[]) => ({
          number: params[0],
          hash: params[0] === "0xa" ? hash("a") : hash("c"),
          timestamp: `0x${Math.floor((now + 600000) / 1000).toString(16)}`,
        })),
      } as unknown as ReadOnlyRpc;
      const cursor = await validateCursor(p.id, s.feeCursor(p.id), rpc, s);
      expect(cursor?.blockNumber).toBe(10);
      expect(s.feeEvents(p.id, now, now + 1000000)).toHaveLength(1);
      const removed = {
        address: p.poolAddress,
        blockNumber: "0xa",
        blockHash: hash("a"),
        transactionHash: hash("b"),
        logIndex: "0x0",
        topics: [swapTopic, hash("1"), hash("2")],
        data: `0x${"0".repeat(64 * 5)}`,
        removed: true,
      };
      const logRpc = { call: vi.fn(async () => [removed]) } as unknown as ReadOnlyRpc;
      await expect(readRange(p, logRpc, s, 10, 10)).rejects.toThrow("Removed log");
    } finally {
      s.close();
    }
  });
});

describe("signal research", () => {
  it("deduplicates episodes, schedules four outcomes and preserves algorithm versions", () => {
    const s = createStore(":memory:");
    try {
      const p = pool();
      const first = snapshot(p, []);
      first.metrics.surge = true;
      first.metrics.activity = 85;
      s.save([first]);
      expect(s.syncSignals(first, policy)).toHaveLength(1);
      const second = snapshot({ ...p, timestamp: now + 60000 }, []);
      second.metrics.surge = true;
      second.metrics.activity = 90;
      expect(s.syncSignals(second, policy)).toHaveLength(0);
      expect(s.listSignals()).toHaveLength(1);
      const signal = s.listSignals()[0];
      expect(signal.episodeLastSeen).toBe(now + 60000);
      expect(signal.peakScore).toBe(90);
      expect(signal.scannerVersion).toBe(scannerVersion);
      expect(signal.signalRuleVersion).toBe(signalRuleVersion);
      expect(s.signalDetail(signal.id)?.outcomes.map((o) => o.horizon)).toEqual([
        "30m",
        "1h",
        "4h",
        "24h",
      ]);
      expect(s.dueOutcomes(now+1800000,10,240000)).toHaveLength(0);
      expect(s.dueOutcomes(now+1800000+240000,10,240000)).toHaveLength(1);
      const third = snapshot({ ...p, timestamp: now + 120000 }, []);
      s.syncSignals(third, policy);
      expect(s.listSignals()[0].episodeEnd).toBe(now + 120000);
      expect(
        priorityTier(p, true, undefined, {
          tier1Volume1h: 50000,
          tier2Volume1h: 5000,
          tier2Tvl: 100000,
        }),
      ).toBe(1);
    } finally {
      s.close();
    }
  });
  it("measures every horizon, range exit, and configurable activity persistence", () => {
    const p = pool();
    p.price = 100;
    p.fees1h = 10;
    p.volume1h = 100;
    const start = snapshot(p, []);
    for (const [h, ms] of Object.entries(horizons)) {
      const after = snapshot(
        { ...p, timestamp: now + ms, price: 108, fees1h: 6, volume1h: 60 },
        [],
      );
      const result = evaluateOutcome(start, [after], h as keyof typeof horizons, policy, {
        fees: 3,
        volume: 1000,
      });
      expect(result.observationCoveragePct).toBe(100);
      expect(result.priceReturn).toBeCloseTo(0.08);
      expect(result.feesGenerated).toBe(3);
      expect(result.ranges["5"].remainedInRange).toBe(false);
      expect(result.ranges["5"].numberOfExits).toBe(1);
      expect(result.ranges["10"].remainedInRange).toBe(true);
      expect(result.activityPersistence).toBe(1);
    }
  });
});
