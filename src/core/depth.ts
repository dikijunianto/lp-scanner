import Decimal from "decimal.js";
import { tokenUnits } from "./liquidity";

const D = Decimal.clone({ precision: 80 });
export const depthBands = [0.01, 0.025, 0.05, 0.1] as const;
export function depthDriftPct(at: number | null | undefined, current: number | null | undefined) {
  return at != null && current != null && at > 0 && Number.isFinite(at) && Number.isFinite(current)
    ? Math.abs(current / at - 1) * 100 : null;
}
const priceBand = (price: number) => Math.round(Math.log(price)*20);
export function v3DepthKey(tick: number, spacing: number, liquidity: string, price0: number, price1: number) {
  return `${Math.floor(tick/(spacing*2))}:${Math.round(Math.log1p(Number(liquidity))*10)}:${priceBand(price0)}:${priceBand(price1)}`;
}
export function dlmmDepthKey(activeId: number, step: number, price0: number, price1: number) {
  const binsPerBand = Math.max(1,Math.ceil(Math.log1p(0.02)/Math.log1p(step/10000)));
  return `${Math.floor(activeId/binsPerBand)}:${priceBand(price0)}:${priceBand(price1)}`;
}
export interface DepthValues {
  depth1PctUsd: number | null;
  depth2_5PctUsd: number | null;
  depth5PctUsd: number | null;
  depth10PctUsd: number | null;
}
const names = ["depth1PctUsd", "depth2_5PctUsd", "depth5PctUsd", "depth10PctUsd"] as const;
export interface BinBalance {
  id: number;
  amountX: string;
  amountY: string;
}

export function binDepth(
  bins: BinBalance[],
  activeId: number,
  step: number,
  decimals0: number,
  decimals1: number,
  price0: number | null,
  price1: number | null,
  coverage: { lowerId: number; upperId: number },
): DepthValues {
  const result: DepthValues = {
    depth1PctUsd: null,
    depth2_5PctUsd: null,
    depth5PctUsd: null,
    depth10PctUsd: null,
  };
  if (
    price0 === null ||
    price1 === null ||
    price0 <= 0 ||
    price1 <= 0 ||
    !Number.isFinite(price0) ||
    !Number.isFinite(price1) ||
    step <= 0
  )
    return result;
  for (let i = 0; i < depthBands.length; i++) {
    const band = depthBands[i],
      scale = Math.log1p(step / 10000);
    const lower = activeId + Math.ceil(Math.log1p(-band) / scale);
    const upper = activeId + Math.floor(Math.log1p(band) / scale);
    if (coverage.lowerId > lower || coverage.upperId < upper) continue;
    let value = new D(0);
    for (const bin of bins)
      if (bin.id >= lower && bin.id <= upper) {
        value = value
          .plus(tokenUnits(bin.amountX, decimals0).mul(price0))
          .plus(tokenUnits(bin.amountY, decimals1).mul(price1));
      }
    const usd = value.toNumber();
    if (Number.isFinite(usd) && usd >= 0) result[names[i]] = usd;
  }
  return result;
}

export interface TickNet {
  tick: number;
  liquidityNet: string;
}
export function tickDepth(
  ticks: TickNet[],
  liquidity: string,
  sqrtPriceX96: string,
  decimals0: number,
  decimals1: number,
  price0: number | null,
  price1: number | null,
  coverage: { lowerTick: number; upperTick: number },
  reversed = false,
): DepthValues {
  const result: DepthValues = {
    depth1PctUsd: null,
    depth2_5PctUsd: null,
    depth5PctUsd: null,
    depth10PctUsd: null,
  };
  if (
    price0 === null ||
    price1 === null ||
    price0 <= 0 ||
    price1 <= 0 ||
    !Number.isFinite(price0) ||
    !Number.isFinite(price1) ||
    !/^-?\d+$/.test(liquidity) ||
    !/^\d+$/.test(sqrtPriceX96)
  )
    return result;
  const current = new D(sqrtPriceX96).div(new D(2).pow(96));
  if (!current.isFinite() || !current.gt(0)) return result;
  const ordered = [...ticks].sort((a, b) => a.tick - b.tick);
  const tickSqrt = (tick: number) => new D("1.0001").pow(new D(tick).div(2));
  const rawL = new D(liquidity);
  if (!rawL.isInteger() || rawL.isNegative()) return result;
  for (let i = 0; i < depthBands.length; i++) {
    const width = depthBands[i];
    const lowRatio = reversed ? 1 / (1 + width) : 1 - width;
    const highRatio = reversed ? 1 / (1 - width) : 1 + width;
    const low = current.mul(new D(lowRatio).sqrt()),
      high = current.mul(new D(highRatio).sqrt());
    const lowTick = Math.floor(new D(low).ln().mul(2).div(new D("1.0001").ln()).toNumber());
    const highTick = Math.ceil(new D(high).ln().mul(2).div(new D("1.0001").ln()).toNumber());
    if (coverage.lowerTick > lowTick || coverage.upperTick < highTick) continue;
    let upward = new D(0),
      downward = new D(0),
      cursor = current,
      L = rawL,
      invalid = false;
    for (const row of ordered) {
      const edge = tickSqrt(row.tick);
      if (edge.lte(current) || edge.gte(high)) continue;
      upward = upward.plus(L.mul(new D(1).div(cursor).minus(new D(1).div(edge))));
      L = L.plus(row.liquidityNet);
      if (L.isNegative()) {
        invalid = true;
        break;
      }
      cursor = edge;
    }
    if (invalid) continue;
    upward = upward.plus(L.mul(new D(1).div(cursor).minus(new D(1).div(high))));
    cursor = current;
    L = rawL;
    for (const row of ordered.toReversed()) {
      const edge = tickSqrt(row.tick);
      if (edge.gte(current) || edge.lte(low)) continue;
      downward = downward.plus(L.mul(cursor.minus(edge)));
      L = L.minus(row.liquidityNet);
      if (L.isNegative()) {
        invalid = true;
        break;
      }
      cursor = edge;
    }
    if (invalid) continue;
    downward = downward.plus(L.mul(cursor.minus(low)));
    const usd = upward
      .div(new D(10).pow(decimals0))
      .mul(price0)
      .plus(downward.div(new D(10).pow(decimals1)).mul(price1))
      .toNumber();
    if (Number.isFinite(usd) && usd >= 0) result[names[i]] = usd;
  }
  return result;
}
