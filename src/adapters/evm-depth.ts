import { Interface } from "@ethersproject/abi";
import { env } from "../config/env";
import { tickDepth, type TickNet } from "../core/depth";
import type { Pool } from "../core/model";
import type { Store, DepthRow } from "../db/store";
import { readContracts } from "./evm-liquidity";
import { ReadOnlyRpc, words } from "./liquidity-rpc";

const abi = new Interface([
  "function tickBitmap(int16) view returns (uint256)",
  "function ticks(int24) view returns (uint128,int128,uint256,uint256,int56,uint160,uint32,bool)",
]);
const wordOf = (tick: number, spacing: number) => Math.floor(Math.floor(tick / spacing) / 256);
export function applyDepth(pool: Pool, row: DepthRow) {
  pool.depth1PctUsd = row.depth1PctUsd;
  pool.depth2_5PctUsd = row.depth2_5PctUsd;
  pool.depth5PctUsd = row.depth5PctUsd;
  pool.depth10PctUsd = row.depth10PctUsd;
  pool.depthConfidence = row.confidence;
  pool.depthSource = row.source;
  pool.depthUpdatedAt = row.updatedAt;
  pool.depthExpiresAt = row.updatedAt + env.DEPTH_REFRESH_SECONDS * 2000;
}
export async function enrichEvmDepth(pools: Pool[], rpc: ReadOnlyRpc, store: Store) {
  const targets = pools
    .filter(
      (p) =>
        p.activeLiquidityDetails?.method === "V3_VIRTUAL_RESERVES_V1" &&
        ["HIGH", "MEDIUM"].includes(p.token0.usdPriceConfidence ?? "UNAVAILABLE") &&
        ["HIGH", "MEDIUM"].includes(p.token1.usdPriceConfidence ?? "UNAVAILABLE"),
    )
    .slice(0, env.DEPTH_EVM_LIMIT);
  let enriched = 0,
    cached = 0;
  const reasons = new Map<string, number>();
  for (const pool of targets) {
    const details = pool.activeLiquidityDetails!;
    const stateKey = `${details.liquidityRaw}:${Math.round(Math.log(Number(details.sqrtPriceX96)) * 200)}:${Math.round(
      Math.log(details.price0Usd) * 200,
    )}:${Math.round(Math.log(details.price1Usd) * 200)}`;
    const old = store.latestDepth(pool.id);
    if (
      old &&
      old.stateKey === stateKey &&
      Date.now() - old.updatedAt < env.DEPTH_REFRESH_SECONDS * 1000
    ) {
      applyDepth(pool, old);
      cached++;
      continue;
    }
    try {
      const spacing = details.tickSpacing!,
        tick = details.tick!;
      const lowerTick = Math.max(-887272, tick + Math.floor(Math.log(0.9) / Math.log(1.0001)) - 3);
      const upperTick = Math.min(
        887272,
        tick + Math.ceil(Math.log(1 / 0.9) / Math.log(1.0001)) + 3,
      );
      const firstWord = wordOf(lowerTick, spacing),
        lastWord = wordOf(upperTick, spacing);
      if (lastWord - firstWord + 1 > env.DEPTH_MAX_TICK_WORDS) {
        reasons.set("tick word cap", (reasons.get("tick word cap") ?? 0) + 1);
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
      if (values.depth10PctUsd === null) {
        reasons.set("incomplete range", (reasons.get("incomplete range") ?? 0) + 1);
        continue;
      }
      const row: DepthRow = {
        ...values,
        confidence: "MEDIUM",
        source: "V3_TICK_WALK",
        updatedAt: Date.now(),
        blockId: details.block,
        stateKey,
      };
      store.saveDepth(pool.id, row);
      applyDepth(pool, row);
      enriched++;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "RPC error";
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
  }
  return `Depth: ${enriched} V3 refreshed, ${cached} cached; ${rpc.requests} RPC batches; ${[...reasons].map(([k, v]) => `${k} ${v}`).join(", ")}`;
}
