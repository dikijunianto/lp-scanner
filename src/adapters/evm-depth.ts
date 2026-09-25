import { Interface } from "@ethersproject/abi";
import { env } from "../config/env";
import { depthDriftPct, v3DepthKey, dlmmDepthKey, tickDepth, type TickNet } from "../core/depth";
import { priorityTier } from "../core/research";
import { priorityPolicy } from "../config/env";
import type { Pool } from "../core/model";
import type { Store, DepthRow } from "../db/store";
import { readContracts } from "./evm-liquidity";
import { ReadOnlyRpc, words } from "./liquidity-rpc";

const abi = new Interface([
  "function tickBitmap(int16) view returns (uint256)",
  "function ticks(int24) view returns (uint128,int128,uint256,uint256,int56,uint160,uint32,bool)",
]);
const wordOf = (tick: number, spacing: number) => Math.floor(Math.floor(tick / spacing) / 256);
export function applyDepth(pool: Pool, row: DepthRow, ttlMs = env.DEPTH_REFRESH_SECONDS * 1000) {
  const drift = depthDriftPct(row.priceAtCalculation,pool.price);
  const stale = drift === null || drift > env.DEPTH_PRICE_DRIFT_PCT;
  pool.depth1PctUsd = stale ? null : row.depth1PctUsd;
  pool.depth2_5PctUsd = stale ? null : row.depth2_5PctUsd;
  pool.depth5PctUsd = stale ? null : row.depth5PctUsd;
  pool.depth10PctUsd = stale ? null : row.depth10PctUsd;
  pool.depthConfidence = stale ? "UNAVAILABLE" : row.confidence;
  pool.depthSource = row.source;
  pool.depthUpdatedAt = row.updatedAt;
  pool.depthExpiresAt = row.updatedAt + ttlMs;
  pool.depthBlock = row.blockId;
  pool.depthPriceAtCalculation = row.priceAtCalculation ?? null;
  pool.depthCurrentPrice = pool.price;
  pool.depthPriceDriftPct = drift;
  pool.depthState = stale ? "STALE" : "CURRENT";
}
export function depthRefreshMs(pool: Pool, watched: boolean, activeSignal: boolean) {
  if (watched || activeSignal) return 120000;
  const tier = priorityTier(pool,false,undefined,priorityPolicy());
  return tier === 1 ? 300000 : tier === 2 ? 900000 : 2700000;
}
export function depthTargets(pools: Pool[], store: Store, cacheOnly: boolean,
  watched: Set<string>, limit: number) {
  const active = store.activeSignalIds();
  const rows = pools.map((pool) => ({pool,old:store.latestDepth(pool.id)}));
  if (cacheOnly) return rows;
  return rows.filter(({pool,old})=>{
    if(!old) return true;
    const d=pool.activeLiquidityDetails!;
    const key=d.method==="V3_VIRTUAL_RESERVES_V1"
      ? v3DepthKey(d.tick!,d.tickSpacing!,d.liquidityRaw!,d.price0Usd,d.price1Usd)
      : dlmmDepthKey(d.activeBinId!,d.binStep!,d.price0Usd,d.price1Usd);
    return old.stateKey!==key || Date.now()-old.updatedAt>=depthRefreshMs(pool,watched.has(pool.id),active.has(pool.id))
      || (depthDriftPct(old.priceAtCalculation,pool.price)??Infinity)>env.DEPTH_PRICE_DRIFT_PCT;
  }).sort((a,b) => {
    const score = (x: typeof a) => (watched.has(x.pool.id) ? 100000 : active.has(x.pool.id) ? 80000 : 0)
      + (4-priorityTier(x.pool,false,undefined,priorityPolicy()))*10000
      + (!x.old ? 5000 : Math.min(4000,(Date.now()-x.old.updatedAt)/60000));
    return score(b)-score(a);
  }).slice(0,limit);
}
export async function enrichEvmDepth(pools: Pool[], rpc: ReadOnlyRpc, store: Store, cacheOnly = false, watched = new Set<string>()) {
  const eligible = pools
    .filter(
      (p) =>
        p.activeLiquidityDetails?.method === "V3_VIRTUAL_RESERVES_V1" &&
        ["HIGH", "MEDIUM"].includes(p.token0.usdPriceConfidence ?? "UNAVAILABLE") &&
        ["HIGH", "MEDIUM"].includes(p.token1.usdPriceConfidence ?? "UNAVAILABLE"),
    );
  const active = store.activeSignalIds();
  const targets = depthTargets(eligible,store,cacheOnly,watched,env.DEPTH_EVM_LIMIT);
  let enriched = 0,
    cached = 0;
  const reasons = new Map<string, number>();
  for (const {pool,old} of targets) {
    const details = pool.activeLiquidityDetails!;
    const stateKey = v3DepthKey(details.tick!,details.tickSpacing!,details.liquidityRaw!,
      details.price0Usd,details.price1Usd);
    if (
      old &&
      old.stateKey === stateKey &&
      Date.now() - old.updatedAt < depthRefreshMs(pool,watched.has(pool.id),active.has(pool.id)) &&
      (depthDriftPct(old.priceAtCalculation,pool.price) ?? Infinity) <= env.DEPTH_PRICE_DRIFT_PCT
    ) {
      applyDepth(pool, old, depthRefreshMs(pool,watched.has(pool.id),active.has(pool.id)));
      cached++;
      continue;
    }
    if (cacheOnly) continue;
    try {
      const spacing = details.tickSpacing!,
        tick = details.tick!;
      const lowerTick = Math.max(-887272, tick + Math.floor(Math.log(0.95) / Math.log(1.0001)) - 3);
      const upperTick = Math.min(
        887272,
        tick + Math.ceil(Math.log(1 / 0.95) / Math.log(1.0001)) + 3,
      );
      const firstWord = wordOf(lowerTick, spacing),
        lastWord = wordOf(upperTick, spacing);
      if (lastWord - firstWord + 1 > env.DEPTH_MAX_TICK_WORDS) {
        reasons.set("tick word cap", (reasons.get("tick word cap") ?? 0) + 1);
        store.recordDepthFailure(pool.id,"tick word cap");
        continue;
      }
      const positions = Array.from({ length: lastWord - firstWord + 1 }, (_, i) => firstWord + i);
      const rawBitmap = await readContracts(
        rpc,
        positions.map((pos) => ({
          to: pool.poolAddress,
          data: abi.encodeFunctionData("tickBitmap", [pos]),
        })),
        details.block,
      );
      const ticks: number[] = [];
      for (let i = 0; i < positions.length; i++) {
        const bits = words(rawBitmap[i], 1)[0];
        for (let b = 0; b < 256; b++)
          if (((bits >> BigInt(b)) & 1n) === 1n) {
            const t = (positions[i] * 256 + b) * spacing;
            if (t >= lowerTick && t <= upperTick) ticks.push(t);
          }
      }
      if (ticks.length > env.DEPTH_MAX_INITIALIZED_TICKS) {
        reasons.set("initialized tick cap", (reasons.get("initialized tick cap") ?? 0) + 1);
        store.recordDepthFailure(pool.id,"initialized tick cap");
        continue;
      }
      const rawTicks = await readContracts(
        rpc,
        ticks.map((t) => ({ to: pool.poolAddress, data: abi.encodeFunctionData("ticks", [t]) })),
        details.block,
      );
      const nets: TickNet[] = ticks.map((t, i) => {
        const state = words(rawTicks[i], 8);
        if (state[0] === 0n || state[7] !== 1n) throw new Error("Invalid initialized tick");
        return { tick: t, liquidityNet: BigInt.asIntN(128, state[1]).toString() };
      });
      const values = tickDepth(
        nets,
        details.liquidityRaw!,
        details.sqrtPriceX96!,
        details.decimals0,
        details.decimals1,
        details.price0Usd,
        details.price1Usd,
        { lowerTick: firstWord * 256 * spacing, upperTick: ((lastWord + 1) * 256 - 1) * spacing },
        details.token0Address.toLowerCase() !== pool.token0Address.toLowerCase(),
      );
      if (values.depth5PctUsd === null) {
        reasons.set("incomplete range", (reasons.get("incomplete range") ?? 0) + 1);
        store.recordDepthFailure(pool.id,"incomplete range");
        continue;
      }
      const row: DepthRow = {
        ...values,
        confidence: "MEDIUM",
        source: "V3_TICK_WALK",
        updatedAt: Date.now(),
        blockId: details.block,
        stateKey,
        priceAtCalculation: pool.price,
        methodologyVersion: "sprint5-v2",
      };
      store.saveDepth(pool.id, row);
      applyDepth(pool, row, depthRefreshMs(pool,watched.has(pool.id),active.has(pool.id)));
      enriched++;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "RPC error";
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
      store.recordDepthFailure(pool.id,reason);
    }
  }
  return `Depth: ${enriched} V3 refreshed, ${cached} cached; ${rpc.requests} RPC batches; ${[...reasons].map(([k, v]) => `${k} ${v}`).join(", ")}`;
}
