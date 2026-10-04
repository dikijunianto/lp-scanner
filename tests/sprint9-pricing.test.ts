import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyPool, emptyToken, type Pool } from "../src/core/model";
import { deriveCrossAssetPrices, priceConsensus, type EvidencedPrice, type PairPriceState } from "../src/core/pricing";
import { applyCachedPrices, enrichPrices, type PriceSource } from "../src/adapters/pricing";
import { createStore } from "../src/db/store";

const now = 1_780_000_000_000;
const address = (digit: string) => `0x${digit.repeat(40)}`;
const referenceAddress = "0x4200000000000000000000000000000000000006";
const pool = (poolAddress = address("1")) => emptyPool({
  chain: "base", protocol: "uniswap-v3", dex: "fixture", poolAddress,
  token0: emptyToken(address("a"), "THIN"), token1: emptyToken(referenceAddress, "WETH"), source: "fixture",
}, now);
const reference = (): EvidencedPrice => ({
  chain: "base", assetAddress: referenceAddress, symbol: "WETH", priceUsd: 100,
  source: "DefiLlama Coins API", sourceTimestamp: now - 10_000, observedAt: now - 5_000,
  blockNumber: null, confidence: "HIGH", provenance: { kind: "DIRECT", sources: ["DefiLlama Coins API"] },
});
const otherPool = (): Pool => ({ ...pool(address("2")), pairState: {
  pairPrice: 2, sourceTimestamp: now - 8_000, observedAt: now - 4_000, blockNumber: "123",
  token0Address: address("a"), token1Address: referenceAddress, depositedLiquidityUsd: 200_000,
  liquiditySourceTimestamp: now - 10_000, source: "confirmed deposited balances",
} });
const policy = { minimumLiquidityUsd: 100_000, maxAgeMs: 120_000, maxAlignmentMs: 30_000, maxPools: 10, maxDerivations: 2 };
const derive = (other = otherPool(), quote = reference()) => {
  const target = pool();
  return deriveCrossAssetPrices(target, target.token0, [other], [quote], now, policy);
};
const emptySource: PriceSource = { name: "Empty fixture", fetch: async () => [] };

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(() => vi.useRealTimers());

describe("Sprint9 cross-asset price evidence", () => {
  it("derives USD from another deposited pool with complete independent timestamp provenance", () => {
    const record = derive()[0];
    expect(record).toMatchObject({ priceUsd: 200, confidence: "MEDIUM", sourceTimestamp: now - 10_000,
      observedAt: now - 5_000, blockNumber: "123", provenance: {
        kind: "CROSS_POOL", poolId: otherPool().id, poolAddress: address("2"), referenceAddress,
        referencePriceUsd: 100, referenceSourceTimestamp: now - 10_000,
        pairTimestamp: now - 8_000, depositedLiquidityUsd: 200_000,
      } });
    expect(priceConsensus([record], 1, 15).confidence).toBe("MEDIUM");
  });

  it("uses inverse quote orientation and decimal-adjusted ratio", () => {
    const target = pool();
    const other = otherPool();
    other.token0Address = referenceAddress;
    other.token1Address = address("a");
    other.pairState = { ...other.pairState!, token0Address: referenceAddress, token1Address: address("a"), pairPrice: 0.5 };
    expect(deriveCrossAssetPrices(target, target.token0, [other], [reference()], now, policy)[0].priceUsd).toBe(200);
  });

  it.each([
    ["below deposited liquidity floor", { depositedLiquidityUsd: 99_999 }],
    ["nonfinite deposited liquidity", { depositedLiquidityUsd: Infinity }],
    ["stale pair publication", { sourceTimestamp: now - 120_001 }],
    ["future pair publication", { sourceTimestamp: now + 30_001 }],
    ["stale deposited balance valuation", { liquiditySourceTimestamp: now - 120_001 }],
    ["misaligned deposited balance valuation", { liquiditySourceTimestamp: now - 40_000 }],
    ["wrong token identity", { token0Address: address("b") }],
    ["invalid ratio", { pairPrice: 0 }],
  ] as [string, Partial<PairPriceState>][]) ("rejects %s", (_name, mutation) => {
    const other = otherPool(); other.pairState = { ...other.pairState!, ...mutation };
    expect(derive(other)).toEqual([]);
  });

  it("excludes its own pool by identity or address and excludes other chains", () => {
    const target = pool();
    const other = otherPool();
    expect(derive({ ...other, id: target.id })).toEqual([]);
    expect(derive({ ...other, poolAddress: target.poolAddress })).toEqual([]);
    expect(derive({ ...other, chain: "bsc" })).toEqual([]);
  });

  it.each([
    ["untimestamped", { sourceTimestamp: null }],
    ["stale", { sourceTimestamp: now - 120_001 }],
    ["misaligned", { sourceTimestamp: now - 40_000 }],
    ["LOW", { confidence: "LOW" as const }],
    ["unapproved address despite WETH symbol", { assetAddress: address("b") }],
    ["recursive derivation", { provenance: { kind: "CROSS_POOL" as const, sources: ["DefiLlama Coins API"] } }],
  ])("rejects %s reference", (_name, mutation) => {
    expect(derive(otherPool(), { ...reference(), ...mutation })).toEqual([]);
  });

  it("does not infer USDT approval from symbol or discovery TVL/virtual liquidity", () => {
    const other = otherPool(); other.token1Address = address("b"); other.pairState!.token1Address = address("b");
    expect(derive(other, { ...reference(), assetAddress: address("b"), symbol: "USDT" })).toEqual([]);
    const virtual = otherPool(); virtual.pairState = undefined;
    virtual.tvlUsd = 1_000_000; virtual.activeLiquidityUsd = 1_000_000;
    expect(derive(virtual)).toEqual([]);
  });

  it("does not count a cached aggregate and its constituent twice", () => {
    const direct = reference();
    const aggregate = { ...direct, source: "Independent median (DefiLlama Coins API, CoinGecko Token Price API)",
      provenance: { kind: "CONSENSUS" as const, sources: ["DefiLlama Coins API", "CoinGecko Token Price API"] } };
    expect(priceConsensus([aggregate, direct], 1, 15)).toMatchObject({ sourceCount: 1, confidence: "MEDIUM" });
    expect(priceConsensus([{ ...direct, confidence: "LOW" }], 1, 15).confidence).toBe("UNAVAILABLE");
  });

  it("preserves stored MEDIUM when cached single-source evidence is fresh", () => {
    const store = createStore(":memory:");
    try {
      store.savePrices([{ ...reference(), assetAddress: address("a"), confidence: "MEDIUM" }]);
      const target = pool(); applyCachedPrices([target], store);
      expect(target.token0.usdPriceConfidence).toBe("MEDIUM");
      expect(target.token0.priceSourceCount).toBe(1);
    } finally { store.close(); }
  });

  it("classifies missing data separately from provider transport failures", async () => {
    const missing = pool();
    await enrichPrices([missing], undefined, { primarySource: emptySource, fallbackSource: emptySource });
    expect(missing.token0.priceFailures?.some((f) => f.reason === "MISSING")).toBe(true);
    const failed = pool();
    await enrichPrices([failed], undefined, { primarySource: {
      name: "Rate limited fixture", fetch: async () => { throw new Error("Upstream HTTP 429"); },
    }, fallbackSource: emptySource });
    expect(failed.token0.priceFailures).toContainEqual({ source: "Rate limited fixture", reason: "RATE_LIMITED", observedAt: now });
    expect(failed.token0.usdPriceConfidence).toBe("UNAVAILABLE");
  });
});
