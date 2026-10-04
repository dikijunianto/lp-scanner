import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import { emptyPool, emptyToken, type Pool } from "../src/core/model";
import { derivePriceGraph, type CrossAssetPricePolicy, type EvidencedPrice } from "../src/core/pricing";

const now = 1_790_000_000_000;
const address = (digit: string) => `0x${digit.repeat(40)}`;
const anchorAddress = "0x4200000000000000000000000000000000000006";
const targetToken = address("a"), bridgeToken = address("b");
function pool(id: string, token0 = targetToken, token1 = anchorAddress, ratio = 2): Pool {
  const p = emptyPool({ chain: "base", protocol: "uniswap-v3", dex: "fixture", poolAddress: address(id),
    token0: emptyToken(token0, "T0"), token1: emptyToken(token1, "T1"), source: "fixture" }, now);
  p.pairState = { pairPrice: ratio, sourceTimestamp: now - 1000, observedAt: now - 500, blockNumber: "100",
    token0Address: token0, token1Address: token1, depositedLiquidityUsd: 0, liquiditySourceTimestamp: now - 1000,
    source: "actual deposited balances", depositedToken0Amount: 2000, depositedToken1Amount: 2000,
    execution: { kind: "DLMM_BIN", amount0: 2000, amount1: 2000 } };
  return p;
}
const anchor: EvidencedPrice = { chain: "base", assetAddress: anchorAddress, symbol: "WETH", priceUsd: 100,
  source: "DefiLlama Coins API", sourceTimestamp: now - 1000, observedAt: now - 500,
  blockNumber: null, confidence: "HIGH", provenance: { kind: "DIRECT", sources: ["DefiLlama Coins API"] } };
const policy: CrossAssetPricePolicy = { minimumLiquidityUsd: 100000, maxAgeMs: 120000,
  maxAlignmentMs: 10000, maxPools: 20, maxDerivations: 2 };
const target = pool("1");
const derive = (pools: Pool[], overrides: Partial<CrossAssetPricePolicy> = {}, anchors = [anchor]) =>
  derivePriceGraph(target, target.token0, pools, anchors, now, { ...policy, ...overrides });

describe("Sprint10 deposited-price graph", () => {
  it("defaults to two hops and retains every state and anchor provenance", () => {
    const first = pool("2", targetToken, bridgeToken, 2), second = pool("3", bridgeToken, anchorAddress, 3);
    const price = derive([first, second])[0];
    expect(price).toMatchObject({ priceUsd: 600, confidence: "MEDIUM", sourceTimestamp: now - 1000,
      provenance: { referenceAddress: anchorAddress, referencePriceUsd: 100 } });
    expect(price.provenance?.path).toMatchObject([
      { poolId: first.id, poolAddress: first.poolAddress, blockNumber: "100", referenceDepositUsd: 600000 },
      { poolId: second.id, poolAddress: second.poolAddress, blockNumber: "100", referenceDepositUsd: 200000 },
    ]);
    expect(derive([first, second], { maxHops: 1 })).toEqual([]);
  });
  it("uses inverse token orientation and actual reference-side deposits", () => {
    expect(derive([pool("2", anchorAddress, targetToken, 0.5)])[0].priceUsd).toBe(200);
  });
  it("accepts canonical state with reversed discovery token order", () => {
    const reference = pool("2");
    reference.token0Address = anchorAddress; reference.token1Address = targetToken;
    expect(derive([reference])[0].priceUsd).toBe(200);
  });
  it("rejects custody-only evidence and active-bin crossing", () => {
    const reference = pool("2"); reference.pairState!.execution = undefined;
    expect(derive([reference])).toEqual([]);
    reference.pairState!.execution = { kind: "DLMM_BIN", amount0: 4, amount1: 2000 };
    expect(derive([reference])).toEqual([]);
    reference.pairState!.execution.amount0 = 5;
    expect(derive([reference])[0].provenance?.path?.[0]).toMatchObject({ priceImpact: 0,
      impactMethodology: "DLMM_ACTIVE_BIN_NO_CROSS" });
  });
  it("checks V3 current liquidity independently of large custody balances", () => {
    const reference = pool("2", targetToken, anchorAddress, 1);
    reference.pairState!.execution = { kind: "V3_CURRENT_RANGE", sqrtPriceX96: (2n ** 96n).toString(),
      liquidityRaw: "1000000", tick: 0, tickSpacing: 60, decimals0: 0, decimals1: 0 };
    expect(derive([reference])[0].provenance?.path?.[0]).toMatchObject({ impactMethodology: "V3_CURRENT_RANGE_SPOT" });
    reference.pairState!.execution.liquidityRaw = "1000";
    expect(derive([reference])).toEqual([]);
    reference.pairState!.execution.liquidityRaw = "1000000";
    expect(derive([reference], { maxPriceImpact: 0.00001 })).toEqual([]);
    reference.pairState!.pairPrice = 2;
    expect(derive([reference])).toEqual([]);
  });
  it("uses decimal-adjusted inverse V3 input and rejects exhausted current ranges", () => {
    const D = Decimal.clone({ precision: 80 });
    const sqrt = new D("1.0001").pow(30).sqrt();
    const ratio = sqrt.pow(2).mul(new D(10).pow(12)).toNumber();
    const reference = pool("2", anchorAddress, targetToken, ratio);
    reference.pairState!.execution = { kind: "V3_CURRENT_RANGE", sqrtPriceX96: sqrt.mul(new D(2).pow(96)).floor().toFixed(0),
      liquidityRaw: "10000000000000000000000", tick: 29, tickSpacing: 60, decimals0: 18, decimals1: 6 };
    expect(derive([reference])[0].priceUsd).toBeCloseTo(100 / ratio, 16);
    reference.pairState!.execution.liquidityRaw = "1000000000000000000000";
    expect(derive([reference])).toEqual([]);
  });
  it("rejects a target pool anywhere in the path, including alias addresses", () => {
    const first = pool("2", targetToken, bridgeToken), second = pool("1", bridgeToken, anchorAddress);
    expect(derive([first, second])).toEqual([]);
    second.id = "alias";
    expect(derive([first, second])).toEqual([]);
    expect(derive([target])).toEqual([]);
  });
  it("rejects cycles and does not promote cached derived anchors", () => {
    expect(derive([pool("2", targetToken, bridgeToken), pool("3", bridgeToken, targetToken)])).toEqual([]);
    expect(derive([pool("2")], {}, [{ ...anchor, provenance: { kind: "CROSS_POOL", sources: [anchor.source] } }])).toEqual([]);
  });
  it.each([
    ["missing actual deposits", undefined], ["insufficient reference liquidity", 999],
    ["nonfinite deposits", Infinity], ["negative deposits", -1],
  ])("rejects %s despite discovery TVL and virtual reserve valuations", (_reason, amount) => {
    const reference = pool("2"); reference.pairState!.depositedToken1Amount = amount;
    reference.tvlUsd = reference.activeLiquidityUsd = reference.pairState!.depositedLiquidityUsd = 1_000_000;
    expect(derive([reference])).toEqual([]);
  });
  it("enforces configured notional to reference-deposit ratio independently of liquidity floor", () => {
    expect(derive([pool("2")], { notionalUsd: 3000 })).toEqual([]);
    expect(derive([pool("2")], { notionalUsd: 2000 })[0].provenance?.path?.[0].notionalReserveRatio).toBe(0.01);
  });
  it("requires timestamp alignment across all hops rather than pairwise only", () => {
    const first = pool("2", targetToken, bridgeToken), second = pool("3", bridgeToken, anchorAddress);
    first.pairState!.sourceTimestamp = first.pairState!.liquiditySourceTimestamp = now - 16000;
    second.pairState!.sourceTimestamp = second.pairState!.liquiditySourceTimestamp = now - 8000;
    expect(derive([first, second])).toEqual([]);
  });
  it.each([
    ["stale", { sourceTimestamp: now - 120001 }], ["future", { sourceTimestamp: now + 30001 }],
    ["LOW confidence", { confidence: "LOW" as const }], ["wrong chain", { chain: "solana" }],
    ["symbol-only identity", { assetAddress: address("c") }],
  ])("rejects %s USD anchor", (_reason, mutation) => {
    expect(derive([pool("2")], {}, [{ ...anchor, ...mutation }])).toEqual([]);
  });
  it("rejects malformed policy, wrong state identity and stale observations", () => {
    expect(derive([pool("2")], { maxHops: 0 })).toEqual([]);
    expect(derive([pool("2")], { maxHops: 9 })).toEqual([]);
    expect(derive([pool("2")], { maxPriceImpact: NaN })).toEqual([]);
    const wrong = pool("2"); wrong.pairState!.token0Address = bridgeToken;
    expect(derive([wrong])).toEqual([]);
    const stale = pool("2"); stale.pairState!.observedAt = now - 120001;
    expect(derive([stale])).toEqual([]);
  });
});
