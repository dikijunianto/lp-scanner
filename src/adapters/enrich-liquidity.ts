import type { Pool } from "../core/model";
import { unavailableLiquidity } from "../core/liquidity";
import { env } from "../config/env";
import { ReadOnlyRpc } from "./liquidity-rpc";
export async function enrichLiquidity(pools: Pool[]): Promise<string> {
  if (!env.ACTIVE_LIQUIDITY_ENABLED) {
    for (const p of pools) unavailableLiquidity(p, "Enrichment disabled");
    return "Active liquidity enrichment disabled";
  }
  if (!pools.length) return "Active liquidity: no pools";
  try {
    let result: { enriched: number; requests: number; durationMs: number };
    if (pools[0].chain === "solana") {
      const { enrichMeteoraLiquidity, SOLANA_PUBLIC_RPC } = await import("./meteora-liquidity");
      result = await enrichMeteoraLiquidity(
        pools,
        new ReadOnlyRpc(env.SOLANA_RPC_URL ?? SOLANA_PUBLIC_RPC),
      );
    } else if (pools[0].chain === "base" || pools[0].chain === "bsc") {
      const { enrichEvmLiquidity, evmNetworks } = await import("./evm-liquidity");
      const chain = pools[0].chain;
      result = await enrichEvmLiquidity(
        pools,
        chain,
        new ReadOnlyRpc(
          (chain === "base" ? env.BASE_RPC_URL : env.BSC_RPC_URL) ?? evmNetworks[chain].url,
        ),
      );
    } else {
      for (const p of pools) unavailableLiquidity(p, "Unsupported enrichment chain");
      return "Active liquidity unavailable for this chain";
    }
    for (const pool of pools) pool.timestamp = Date.now();
    return `Active liquidity: ${result.enriched}/${pools.length} enriched; ${pools.length - result.enriched} unavailable; ${result.requests} RPC batches; ${result.durationMs}ms`;
  } catch {
    for (const p of pools) unavailableLiquidity(p, "Enrichment unavailable");
    return "Active liquidity enrichment unavailable; discovery continues";
  }
}
