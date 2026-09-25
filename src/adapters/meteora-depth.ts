import { createRequire } from "node:module";
import { PublicKey } from "@solana/web3.js";
import { env } from "../config/env";
import { binDepth, type BinBalance } from "../core/depth";
import type { Pool } from "../core/model";
import type { Store, DepthRow } from "../db/store";
import { applyDepth, depthRefreshMs, depthTargets } from "./evm-depth";
import { depthDriftPct, dlmmDepthKey } from "../core/depth";
import { ReadOnlyRpc } from "./liquidity-rpc";
import { accountsSchema, decodeBinArray, decodePair, PROGRAM } from "./meteora-liquidity";

const require = createRequire(import.meta.url);
const { BN } = require("@coral-xyz/anchor") as typeof import("@coral-xyz/anchor");
const { deriveBinArray, binIdToBinArrayIndex, getBinFromBinArray, MAX_BIN_ARRAY_SIZE } =
  require("@meteora-ag/dlmm") as typeof import("@meteora-ag/dlmm");
const arraySize = MAX_BIN_ARRAY_SIZE.toNumber();

export async function enrichMeteoraDepth(pools: Pool[], rpc: ReadOnlyRpc, store: Store, cacheOnly = false, watched = new Set<string>()) {
  const eligible = pools
    .filter(
      (p) =>
        p.activeLiquidityDetails?.method === "DLMM_ACTIVE_BIN_V1" &&
        ["HIGH", "MEDIUM"].includes(p.token0.usdPriceConfidence ?? "UNAVAILABLE") &&
        ["HIGH", "MEDIUM"].includes(p.token1.usdPriceConfidence ?? "UNAVAILABLE"),
    );
  const active = store.activeSignalIds();
  const targets = depthTargets(eligible,store,cacheOnly,watched,env.DEPTH_METEORA_LIMIT);
  let enriched = 0,
    cached = 0;
  const reasons = new Map<string, number>();
  for (const {pool,old} of targets) {
    const details = pool.activeLiquidityDetails!;
    const stateKey = dlmmDepthKey(details.activeBinId!,details.binStep!,
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
      const activeId = details.activeBinId!,
        step = details.binStep!;
      const scale = Math.log1p(step / 10000);
      const lowerId = activeId + Math.ceil(Math.log1p(-0.1) / scale);
      const upperId = activeId + Math.floor(Math.log1p(0.1) / scale);
      if (lowerId < -443636 || upperId > 443636) {
        reasons.set("bin limits", (reasons.get("bin limits") ?? 0) + 1);
        continue;
      }
      const first = binIdToBinArrayIndex(new BN(lowerId)).toNumber();
      const last = binIdToBinArrayIndex(new BN(upperId)).toNumber();
      if (last - first + 1 > env.DEPTH_MAX_ARRAYS) {
        reasons.set("array cap", (reasons.get("array cap") ?? 0) + 1);
        continue;
      }
      const indexes = Array.from({ length: last - first + 1 }, (_, i) => first + i);
      const keys = indexes.map((index) =>
        deriveBinArray(new PublicKey(pool.poolAddress), new BN(index), PROGRAM)[0].toBase58(),
      );
      const result = accountsSchema.parse(
        await rpc.call("getMultipleAccounts", [
          [pool.poolAddress, ...keys],
          { encoding: "base64", commitment: "confirmed" },
        ]),
      );
      if (result.value.length !== keys.length + 1) throw new Error("Incomplete bin array read");
      const pair = decodePair(result.value[0]);
      if (pair.activeId !== activeId || pair.binStep !== step || pair.status !== 0)
        throw new Error("DLMM state changed");
      const bins: BinBalance[] = [];
      for (let i = 0; i < indexes.length; i++) {
        if (!result.value[i + 1]) continue; // An uninitialized array holds no deposited bins.
        const array = decodeBinArray(result.value[i + 1]);
        if (!array.index.eq(new BN(indexes[i])) || array.lbPair.toBase58() !== pool.poolAddress)
          throw new Error("Bin array identity mismatch");
        const begin = Math.max(lowerId, indexes[i] * arraySize);
        const end = Math.min(upperId, (indexes[i] + 1) * arraySize - 1);
        for (let id = begin; id <= end; id++) {
          const bin = getBinFromBinArray(id, array);
          if (!bin.amountX.isZero() || !bin.amountY.isZero())
            bins.push({ id, amountX: bin.amountX.toString(), amountY: bin.amountY.toString() });
        }
      }
      const values = binDepth(
        bins,
        activeId,
        step,
        details.decimals0,
        details.decimals1,
        details.price0Usd,
        details.price1Usd,
        { lowerId: first * arraySize, upperId: (last + 1) * arraySize - 1 },
      );
      if (values.depth10PctUsd === null) {
        reasons.set("incomplete range", (reasons.get("incomplete range") ?? 0) + 1);
        continue;
      }
      const row: DepthRow = {
        ...values,
        confidence: "MEDIUM",
        source: "DLMM_ACTUAL_BINS",
        updatedAt: Date.now(),
        blockId: String(result.context.slot),
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
  return `Depth: ${enriched} DLMM refreshed, ${cached} cached; ${rpc.requests} RPC batches; ${[...reasons].map(([k, v]) => `${k} ${v}`).join(", ")}`;
}
