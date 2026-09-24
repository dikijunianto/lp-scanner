import { describe, expect, it } from "vitest";
import { priceConfidence, comparePrices, applyPrice } from "../src/core/pricing";
import { emptyPool, emptyToken } from "../src/core/model";
import { binDepth, tickDepth } from "../src/core/depth";
import {
  decodeSwap,
  measuredWindow,
  swapLogSchema,
  swapTopic,
  pancakeSwapTopic,
  swapUsd,
} from "../src/core/fees";
import { createStore } from "../src/db/store";
import { analyze, snapshot } from "../src/core/analytics";

const policy = {
  highAgeMs: 120000,
  mediumAgeMs: 600000,
  lowAgeMs: 1800000,
  disagreement: 0.1,
  unavailableDisagreement: 0.3,
};
const now = 1790000000000;
const a = "0x0000000000000000000000000000000000000001";
const b = "0x0000000000000000000000000000000000000002";
const pool = () =>
  emptyPool(
    {
      chain: "base",
      protocol: "uniswap-v3",
      dex: "Uniswap V3",
      poolAddress: "0x0000000000000000000000000000000000000003",
      token0: emptyToken(a, "A"),
      token1: emptyToken(b, "B"),
      source: "fixture",
    },
    now,
  );

describe("timestamped independent pricing", () => {
  it("classifies publication age separately from fetch age", () => {
    expect(priceConfidence(now - 60000, now, now, policy)).toBe("HIGH");
    expect(priceConfidence(now - 300000, now, now, policy)).toBe("MEDIUM");
    expect(priceConfidence(now - 900000, now, now, policy)).toBe("LOW");
    expect(priceConfidence(now - 1900000, now, now, policy)).toBe("UNAVAILABLE");
    expect(priceConfidence(null, now, now, policy)).toBe("LOW");
    expect(priceConfidence(now + 31000, now, now, policy)).toBe("UNAVAILABLE");
  });
  it("flags source disagreement, never averages or values severe conflicts", () => {
    const p = pool();
    p.token0.usdPrice = 100;
    p.token0.usdPriceSource = "GeckoTerminal";
    applyPrice(
      p.token0,
      {
        assetAddress: a,
        chain: "base",
        symbol: "A",
        priceUsd: 115,
        source: "DefiLlama Coins API",
        sourceTimestamp: now,
        observedAt: now,
        blockNumber: null,
        confidence: "HIGH",
      },
      p,
      policy,
    );
    expect(p.token0.usdPrice).toBe(115);
    expect(p.token0.usdPriceConfidence).toBe("HIGH");
    expect(p.warnings).toContain("PRICE_DISAGREEMENT");
    expect(comparePrices(100, 140, policy).confidence).toBe("UNAVAILABLE");
    applyPrice(
      p.token1,
      {
        assetAddress: b,
        chain: "base",
        symbol: "B",
        priceUsd: 140,
        source: "DefiLlama Coins API",
        sourceTimestamp: now,
        observedAt: now,
        blockNumber: null,
        confidence: "HIGH",
      },
      p,
      policy,
    );
    expect(p.token1.usdPriceConfidence).toBe("HIGH");
  });
});

describe("bounded range depth", () => {
  it("does not use discovery volume for EVM depth ratios before measured coverage", () => {
    const p = pool();
    p.depth5PctUsd = 100;
    p.depthConfidence = "MEDIUM";
    p.depthUpdatedAt = now;
    p.depthExpiresAt = now + 600000;
    p.volume1h = 1000;
    expect(analyze(p, []).volumeDepthRatio1h).toBeNull();
    p.feeWindows = {
      "1h": {
        volumeUsd: 100,
        feesUsd: 0.3,
        windowStart: now - 3600000,
        windowEnd: now,
        startBlock: 1,
        endBlock: 2,
        methodology: "EVENT_DERIVED",
        confidence: "MEDIUM",
      },
    };
    expect(analyze(p, []).volumeDepthRatio1h).toBe(1);
  });
  it("sums actual bins only inside each band, with decimals and coverage", () => {
    const bins = [-2, -1, 0, 1, 2, 5, 10].map((id) => ({
      id,
      amountX: "1000000",
      amountY: "1000000000",
    }));
    const depth = binDepth(bins, 0, 100, 6, 9, 2, 3, { lowerId: -12, upperId: 12 });
    expect(depth.depth1PctUsd).toBe(15);
    expect(depth.depth2_5PctUsd).toBe(25);
    expect(depth.depth5PctUsd).toBe(25);
    expect(depth.depth10PctUsd).toBe(30);
    expect(
      binDepth(bins, 0, 100, 6, 9, 2, 3, { lowerId: -2, upperId: 2 }).depth10PctUsd,
    ).toBeNull();
    expect(
      binDepth(bins, 0, 100, 6, 9, null, 3, { lowerId: -12, upperId: 12 }).depth1PctUsd,
    ).toBeNull();
  });
  it("walks liquidityNet across ticks and handles reversed ordering", () => {
    const q = (2n ** 96n).toString();
    const coverage = { lowerTick: -2000, upperTick: 2000 };
    const base = tickDepth([], "1000000", q, 6, 6, 1, 1, coverage);
    const withTick = tickDepth(
      [{ tick: 100, liquidityNet: "1000000" }],
      "1000000",
      q,
      6,
      6,
      1,
      1,
      coverage,
    );
    expect(base.depth1PctUsd).toBeGreaterThan(0);
    expect(base.depth10PctUsd!).toBeGreaterThan(base.depth5PctUsd!);
    expect(withTick.depth10PctUsd!).toBeGreaterThan(base.depth10PctUsd!);
    expect(tickDepth([], "1000000", q, 6, 6, 1, 1, coverage, true).depth5PctUsd).toBeGreaterThan(0);
    expect(tickDepth([], "0", q, 6, 6, 1, 1, coverage).depth5PctUsd).toBe(0);
    expect(tickDepth([], "1000000", q, 6, 6, 1, null, coverage).depth5PctUsd).toBeNull();
    expect(
      tickDepth([], "1000000", q, 6, 6, 1, 1, { lowerTick: -100, upperTick: 100 }).depth10PctUsd,
    ).toBeNull();
    expect(
      tickDepth([], "1", "4295128739", 18, 6, 1, 1, { lowerTick: -887272, upperTick: -885000 })
        .depth10PctUsd,
    ).toBeNull();
  });
});

describe("event fees and persistent cursor", () => {
  it("decodes signed swap amounts and values the input token", () => {
    const data =
      "0x" +
      [1000000n, -2000000n, 2n ** 96n, 1000n, 0n]
        .map((n) => BigInt.asUintN(256, n).toString(16).padStart(64, "0"))
        .join("");
    const log = swapLogSchema.parse({
      address: a,
      blockNumber: "0x10",
      blockHash: `0x${"a".repeat(64)}`,
      transactionHash: `0x${"b".repeat(64)}`,
      logIndex: "0x1",
      topics: [swapTopic, `0x${"0".repeat(64)}`, `0x${"0".repeat(64)}`],
      data,
    });
    const swap = decodeSwap(log);
    expect(swap.amount0).toBe(1000000n);
    expect(swap.amount1).toBe(-2000000n);
    expect(swapUsd(swap.amount0, swap.amount1, 6, 6, 2, null, 0.003)).toEqual({
      volumeUsd: 2,
      feesUsd: 0.006,
    });
    expect(swapUsd(-1n, 1000000n, 6, 6, null, 3, 0.0005).feesUsd).toBeCloseTo(0.0015);
    expect(swapUsd(1n, -1n, 6, 6, null, 1, 0.003).feesUsd).toBeNull();
    expect(() => decodeSwap({ ...log, data: "0x123" })).toThrow();
    const pancake = decodeSwap({
      ...log,
      topics: [pancakeSwapTopic, ...log.topics.slice(1)],
      data: data + [1000n, 0n].map((n) => n.toString(16).padStart(64, "0")).join(""),
    });
    expect(pancake.protocolFeeRaw).toBe(1000n);
    expect(
      swapUsd(pancake.amount0, pancake.amount1, 6, 6, 2, null, 0.003, pancake.protocolFeeRaw)
        .feesUsd,
    ).toBeCloseTo(0.004);
  });
  it("requires full block coverage and complete pricing before a measured window", () => {
    const event = {
      poolId: "p",
      blockNumber: 10,
      blockHash: "h",
      txHash: "tx",
      logIndex: 0,
      timestamp: 1000,
      volumeUsd: 100,
      feesUsd: 0.3,
      confidence: "MEDIUM" as const,
    };
    expect(measuredWindow([event], 0, 2000, 10, 20, true).feesUsd).toBe(0.3);
    expect(measuredWindow([event], 0, 2000, 10, 20, false).feesUsd).toBeNull();
    expect(
      measuredWindow([{ ...event, volumeUsd: null }], 0, 2000, 10, 20, true).feesUsd,
    ).toBeNull();
  });
  it("persists price history and removes unsafe fee history on reorg rollback", () => {
    const store = createStore(":memory:");
    try {
      store.save([snapshot({...pool(),id:"p"},[])]);
      store.savePrices([
        {
          chain: "base",
          assetAddress: a,
          symbol: "A",
          priceUsd: 2,
          source: "independent",
          sourceTimestamp: now - 1000,
          observedAt: now,
          blockNumber: "0x20",
          confidence: "HIGH",
        },
      ]);
      expect(store.priceAt("base", a, now, 600000)?.priceUsd).toBe(2);
      expect(store.priceAt("base", a, now - 100000, 600000)).toBeNull();
      store.saveFeeBatch(
        "p",
        [
          {
            poolId: "p",
            blockNumber: 10,
            blockHash: "h",
            txHash: "tx",
            logIndex: 0,
            timestamp: now,
            volumeUsd: 2,
            feesUsd: 0.006,
            confidence: "MEDIUM",
          },
        ],
        10,
        now,
        10,
        "h",
        now,
      );
      expect(store.feeCursor("p")?.blockHash).toBe("h");
      expect(store.feeEvents("p", now - 1, now + 1)).toHaveLength(1);
      store.rewindFeeCursor("p", 8, "earlier", 9, now - 300000);
      expect(store.feeCursor("p")?.blockNumber).toBe(8);
      expect(store.feeEvents("p", now - 1, now + 1)).toHaveLength(1);
      store.rollbackFees("p", 0);
      expect(store.feeCursor("p")).toBeNull();
      expect(store.feeEvents("p", now - 1, now + 1)).toHaveLength(0);
      expect(store.priceAt("base", a, now, 600000)?.priceUsd).toBe(2);
    } finally {
      store.close();
    }
  });
});
