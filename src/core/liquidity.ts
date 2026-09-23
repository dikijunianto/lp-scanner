import Decimal from "decimal.js";
import type { Pool, Token } from "./model";
const D = Decimal.clone({ precision: 80 });
export type LiquiditySource = "OFFICIAL_API" | "ONCHAIN_DERIVED" | "ESTIMATED" | "UNAVAILABLE";
export interface LiquidityDetails {
  method: "DLMM_ACTIVE_BIN_V1" | "V3_VIRTUAL_RESERVES_V1";
  block: string;
  blockTime: number;
  rpcSource: string;
  token0Address: string;
  token1Address: string;
  decimals0: number;
  decimals1: number;
  amount0: string;
  amount1: string;
  price0Usd: number;
  price1Usd: number;
  priceSource: string;
  priceObservedAt: number;
  pairPrice: string;
  activeBinId?: number;
  binStep?: number;
  tick?: number;
  tickSpacing?: number;
  sqrtPriceX96?: string;
  liquidityRaw?: string;
  rawAmount0?: string;
  rawAmount1?: string;
}
export const liquidityDefaults = {
  activeLiquidityUsd: null as number | null,
  activeLiquiditySource: "UNAVAILABLE" as LiquiditySource,
  activeLiquidityConfidence: "UNAVAILABLE" as "HIGH" | "MEDIUM" | "LOW" | "UNAVAILABLE",
  activeLiquidityUpdatedAt: null as number | null,
  activeLiquidityExpiresAt: null as number | null,
  activeLiquidityReason: "Not enriched",
  activeLiquidityDetails: null as LiquidityDetails | null,
};
export function unavailableLiquidity(pool: Pool, reason: string) {
  Object.assign(pool, liquidityDefaults, { activeLiquidityReason: reason });
}
export function fresh(timestamp: number | null | undefined, now: number, maxAgeMs: number) {
  return (
    timestamp != null &&
    Number.isFinite(timestamp) &&
    timestamp > 0 &&
    timestamp <= now + 30000 &&
    now - timestamp <= maxAgeMs
  );
}
export function reliableLiquidity(pool: Pool, now: number): boolean {
  return (
    pool.activeLiquidityUsd != null &&
    Number.isFinite(pool.activeLiquidityUsd) &&
    pool.activeLiquidityUsd >= 0 &&
    ["HIGH", "MEDIUM"].includes(pool.activeLiquidityConfidence) &&
    pool.activeLiquiditySource !== "UNAVAILABLE" &&
    pool.activeLiquidityUpdatedAt != null &&
    pool.activeLiquidityUpdatedAt <= now + 30000 &&
    pool.activeLiquidityExpiresAt != null &&
    now <= pool.activeLiquidityExpiresAt
  );
}
export function decimals(value: number) {
  if (!Number.isInteger(value) || value < 0 || value > 255)
    throw new Error("Invalid token decimals");
  return value;
}
export function tokenUnits(raw: string, digits: number) {
  if (!/^\d+$/.test(raw)) throw new Error("Invalid token amount");
  return new D(raw).div(new D(10).pow(decimals(digits)));
}
export function binPairPrice(id: number, step: number, d0: number, d1: number) {
  if (
    !Number.isInteger(id) ||
    Math.abs(id) > 443636 ||
    !Number.isInteger(step) ||
    step < 1 ||
    step > 65535
  )
    throw new Error("Invalid bin state");
  return new D(1)
    .plus(new D(step).div(10000))
    .pow(id)
    .mul(new D(10).pow(decimals(d0) - decimals(d1)));
}
export function tickPairPrice(tick: number, d0: number, d1: number) {
  if (!Number.isInteger(tick) || tick < -887272 || tick > 887272) throw new Error("Invalid tick");
  return new D("1.0001").pow(tick).mul(new D(10).pow(decimals(d0) - decimals(d1)));
}
export function v3VirtualAmounts(
  liquidity: string,
  sqrtPriceX96: string,
  tick: number,
  d0: number,
  d1: number,
) {
  if (!/^\d+$/.test(liquidity) || BigInt(liquidity) >= 2n ** 128n || !/^\d+$/.test(sqrtPriceX96))
    throw new Error("Invalid V3 state");
  const q = BigInt(sqrtPriceX96);
  if (q < 4295128739n || q >= 1461446703485210103287273052203988822378723970342n)
    throw new Error("Invalid square-root price");
  const s = new D(sqrtPriceX96).div(new D(2).pow(96));
  const price = s.pow(2).mul(new D(10).pow(decimals(d0) - decimals(d1)));
  const tickPrice = tickPairPrice(tick, d0, d1);
  // slot0.tick can be one below the mathematical tick at a crossed boundary.
  const relative = price.div(tickPrice);
  if (relative.lt("0.99999999") || relative.gt("1.00010001"))
    throw new Error("Tick/price mismatch");
  return {
    amount0: new D(liquidity).div(s).div(new D(10).pow(d0)),
    amount1: new D(liquidity).mul(s).div(new D(10).pow(d1)),
    pairPrice: price,
  };
}
export function usdValue(
  amount0: Decimal,
  amount1: Decimal,
  price0: number | null,
  price1: number | null,
) {
  if (
    price0 == null ||
    price1 == null ||
    !Number.isFinite(price0) ||
    !Number.isFinite(price1) ||
    price0 <= 0 ||
    price1 <= 0
  )
    throw new Error("USD pricing unavailable");
  const value = amount0.mul(price0).plus(amount1.mul(price1));
  const number = value.toNumber();
  if (value.isNegative() || !Number.isFinite(number) || (number === 0 && !value.isZero()))
    throw new Error("USD valuation out of range");
  return number;
}
export function priceEvidence(
  t0: Token,
  t1: Token,
  pairPrice: Decimal,
  now: number,
  maxAge: number,
  maxDivergence: number,
) {
  if (!fresh(t0.usdPriceObservedAt, now, maxAge) || !fresh(t1.usdPriceObservedAt, now, maxAge))
    throw new Error("USD pricing unavailable or stale");
  if (
    t0.usdPrice == null ||
    t1.usdPrice == null ||
    !Number.isFinite(t0.usdPrice) ||
    !Number.isFinite(t1.usdPrice) ||
    t0.usdPrice <= 0 ||
    t1.usdPrice <= 0
  )
    throw new Error("USD pricing unavailable");
  if (new D(t0.usdPrice).div(t1.usdPrice).div(pairPrice).minus(1).abs().gt(maxDivergence))
    throw new Error("USD prices disagree with on-chain pair price");
  return {
    price0Usd: t0.usdPrice,
    price1Usd: t1.usdPrice,
    priceSource: `${t0.usdPriceSource} / ${t1.usdPriceSource}`,
    priceObservedAt: Math.min(t0.usdPriceObservedAt!, t1.usdPriceObservedAt!),
  };
}
export function applyLiquidity(
  pool: Pool,
  details: LiquidityDetails,
  value: number,
  expiresAt: number,
) {
  pool.activeLiquidityUsd = value;
  pool.activeLiquiditySource =
    details.method === "DLMM_ACTIVE_BIN_V1" ? "ONCHAIN_DERIVED" : "ESTIMATED";
  // Both indexers lack a source publication timestamp. Never claim HIGH confidence from retrieval time alone.
  pool.activeLiquidityConfidence = "MEDIUM";
  pool.activeLiquidityUpdatedAt = details.blockTime;
  pool.activeLiquidityExpiresAt = expiresAt;
  pool.activeLiquidityDetails = details;
  pool.activeLiquidityReason =
    details.method === "DLMM_ACTIVE_BIN_V1"
      ? "Actual active-bin balances; indexer USD price freshness is unverified"
      : "Virtual reserves from current L and price; not deposited capital or total TVL";
}
