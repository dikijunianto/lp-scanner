import { describe, it, expect } from "vitest";
import { emptyPool, emptyToken, type Candle } from "../src/core/model";
import {
  analyze,
  enrichHistory,
  ratio,
  realizedVolatility,
  simulateRanges,
  snapshot,
} from "../src/core/analytics";
const now = 1790000000000;
export const pool = () => ({
  ...emptyPool(
    {
      chain: "solana",
      protocol: "meteora-dlmm",
      dex: "Meteora DLMM",
      poolAddress: "test-pool",
      token0: emptyToken("x", "X"),
      token1: emptyToken("y", "Y"),
      source: "test fixture",
    },
    now,
  ),
  price: 100,
  tvlUsd: 100000,
  activeLiquidityUsd: 10000,
  activeLiquiditySource: "ONCHAIN_DERIVED" as const,
  activeLiquidityConfidence: "MEDIUM" as const,
  activeLiquidityUpdatedAt: now,
  activeLiquidityExpiresAt: now + 120000,
  fees1h: 100,
  fees24h: 1200,
  fees4h: 400,
  fees30m: 50,
  volume1h: 50000,
  volume24h: 600000,
  poolAge: 1000,
  priceChange30m: 1,
  priceChange1h: 2,
  priceChange4h: 2,
});
describe("metrics and scores", () => {
  it("uses active liquidity for fee efficiency and turnover, TVL separately", () => {
    const m = analyze(pool(), []);
    expect(m.feeEfficiency1h).toBe(0.01);
    expect(m.capitalTurnover1h).toBe(5);
    expect(m.tvlTurnover).toBe(6);
    expect(m.feeAcceleration).toBe(2);
    expect(m.volumeAcceleration).toBe(2);
  });
  it("never substitutes TVL or divides by zero", () => {
    for (const x of [null, 0]) {
      expect(ratio(1, x)).toBeNull();
      expect(analyze({ ...pool(), activeLiquidityUsd: x }, []).feeEfficiency1h).toBeNull();
    }
    expect(ratio(Infinity, 10)).toBeNull();
  });
  it("keeps activity independent from risk and explains contributions", () => {
    const a = analyze(pool(), []),
      b = analyze({ ...pool(), tokenAge: 1 }, []);
    expect(a.activity).toBe(b.activity);
    expect(b.risk).toBeGreaterThan(a.risk);
    expect(a.activityReasons.length).toBeGreaterThan(0);
    expect(a.activity).toBeLessThanOrEqual(a.activityCoverage);
  });
  it("does not call missing data safe, or give unknown activity a zero", () => {
    const p = emptyPool({
      chain: "base",
      protocol: "uniswap-v3",
      dex: "Uniswap V3",
      poolAddress: "x",
      token0: emptyToken("x", "X"),
      token1: emptyToken("y", "Y"),
      source: "test fixture",
    });
    const m = analyze(p, []);
    expect(m.activity).toBeNull();
    expect(m.risk).toBe(35);
    expect(m.riskCoverage).toBe(0);
  });
  it("requires own history for surge, rejects zero baseline and stale baseline", () => {
    const p = pool();
    expect(analyze(p, []).surge).toBe(false);
    const old = { ...p, timestamp: now - 1800000, fees1h: 20, volume1h: 10000 };
    expect(analyze(p, [old]).surge).toBe(true);
    expect(analyze(p, [old]).quietSurge).toBe(true);
    expect(analyze(p, [{ ...old, fees1h: 0 }]).surge).toBe(false);
    expect(analyze(p, [{ ...old, timestamp: now - 3600000 }]).surge).toBe(false);
  });
  it("does not call a surge quiet when price timeframes are missing", () => {
    const p = { ...pool(), priceChange4h: null };
    expect(
      analyze(p, [{ ...p, timestamp: now - 1800000, fees1h: 20, volume1h: 10000 }]).quietSurge,
    ).toBe(false);
  });
  it("uses several timeframes for direction and identifies liquidity collapse", () => {
    expect(analyze({ ...pool(), priceChange1h: 10, priceChange30m: null }, []).trend).toBe(
      "UNKNOWN",
    );
    const p = { ...pool(), priceChange30m: 2, priceChange1h: 4, priceChange4h: 8, tvlUsd: 40000 };
    const m = analyze(p, [{ ...p, timestamp: now - 1800000, tvlUsd: 100000 }]);
    expect(m.trend).toBe("TRENDING_UP");
    expect(m.tvlChange30m).toBe(-60);
    expect(m.riskReasons.join(" ")).toContain("TVL dropped");
  });
  it("bounds scores for extreme inputs", () => {
    const m = analyze(
      {
        ...pool(),
        fees1h: 1e20,
        volume1h: 1e20,
        tokenAge: 0,
        poolAge: 0,
        tvlUsd: 1,
        realizedVolatility1h: 100,
        priceChange1h: 100,
      },
      [],
    );
    expect(m.activity).toBeLessThanOrEqual(100);
    expect(m.risk).toBeLessThanOrEqual(100);
  });
  it("uses only past snapshots near a target and retains null for gaps", () => {
    const p = { ...pool(), priceChange1h: null };
    expect(enrichHistory(p, [{ ...p, price: 50, timestamp: now - 3600000 }]).priceChange1h).toBe(
      100,
    );
    expect(
      enrichHistory(p, [{ ...p, price: 50, timestamp: now - 3000000 }]).priceChange1h,
    ).toBeNull();
  });
  it("returns an immutable pool snapshot", () => {
    const p = pool();
    expect(snapshot(p, []).pool).not.toBe(p);
  });
});
const candle = (timestamp: number, low = 99, high = 101): Candle => ({
  timestamp,
  open: 100,
  close: 100,
  low,
  high,
  volume: 10,
});
describe("historical candle analysis", () => {
  it("calculates nonannualized volatility and refuses gapped history", () => {
    const c = Array.from({ length: 12 }, (_, i) => candle(i * 300000));
    expect(realizedVolatility(c, 3600000)).toBe(0);
    expect(realizedVolatility(c.slice(1), 3600000)).toBeNull();
    expect(realizedVolatility([...c.slice(0, 11), candle(13 * 300000)], 3600000)).toBeNull();
  });
  it("uses high/low instead of closes and counts observed exits", () => {
    const result = simulateRanges(100, [candle(0), candle(300000), candle(600000, 90, 110)]);
    expect(result[0].insidePercent).toBeCloseTo(200 / 3);
    expect(result[0].exitCount).toBe(1);
    expect(result[0].longestObservedRunMinutes).toBe(10);
    expect(result[3].insidePercent).toBe(100);
    expect(result[0].relativeConcentration).toBeGreaterThan(result[3].relativeConcentration);
  });
  it("breaks survival runs at missing candles", () => {
    const r = simulateRanges(100, [candle(0), candle(600000)])[0];
    expect(r.longestObservedRunMinutes).toBe(5);
    expect(r.exitFrequency).toBeNull();
    expect(simulateRanges(null, [candle(0), candle(300000)])).toEqual([]);
  });
});

it("does not compare history across provider or token orientation changes", () => {
  const p = { ...pool(), priceChange1h: null };
  const before = {
    ...p,
    timestamp: p.timestamp - 3600000,
    price: 50,
    source: "different provider",
  };
  expect(enrichHistory(p, [before]).priceChange1h).toBeNull();
  expect(
    analyze(p, [{ ...before, timestamp: p.timestamp - 1800000, fees1h: 1, volume1h: 1 }]).surge,
  ).toBe(false);
});
