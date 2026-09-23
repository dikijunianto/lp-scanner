import { Interface } from "@ethersproject/abi";
import type { Pool } from "../core/model";
import {
  applyLiquidity,
  decimals,
  fresh,
  priceEvidence,
  unavailableLiquidity,
  usdValue,
  v3VirtualAmounts,
} from "../core/liquidity";
import { env } from "../config/env";
import {
  ReadOnlyRpc,
  blockSchema,
  hexQuantity,
  words,
  wordAddress,
  signedTick,
} from "./liquidity-rpc";
export const evmNetworks = {
  base: {
    chainId: 8453,
    url: "https://mainnet.base.org",
    factory: "0x33128a8fc17869897dce68ed026d694621f6fdfd",
  },
  bsc: {
    chainId: 56,
    url: "https://bsc-dataseed.bnbchain.org",
    factory: "0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865",
  },
};
const selectors = [
  "0x3850c7bd",
  "0x1a686502",
  "0x0dfe1681",
  "0xd21220a7",
  "0xddca3f43",
  "0xd0c93a7c",
  "0xc45a0155",
];
export const multicallAbi = new Interface([
  "function aggregate3(tuple(address target,bool allowFailure,bytes callData)[] calls) payable returns (tuple(bool success,bytes returnData)[] returnData)",
]);
// eth_call only: no transaction or wallet. Limit each aggregate to 140 read calls.
async function readContracts(
  rpc: ReadOnlyRpc,
  calls: { to: string; data: string }[],
  block: string,
) {
  const output: unknown[] = [];
  for (let i = 0; i < calls.length; i += 140) {
    const chunk = calls.slice(i, i + 140);
    const data = multicallAbi.encodeFunctionData("aggregate3", [
      chunk.map((c) => [c.to, true, c.data]),
    ]);
    const raw = await rpc.call("eth_call", [
      { to: "0xca11bde05977b3631167028862be2a173976ca11", data },
      block,
    ]);
    if (typeof raw !== "string") throw new Error("RPC multicall unavailable");
    const [results] = multicallAbi.decodeFunctionResult("aggregate3", raw);
    if (results.length !== chunk.length) throw new Error("Malformed multicall response");
    output.push(
      ...results.map((r: { success: boolean; returnData: string }) =>
        r.success ? r.returnData : undefined,
      ),
    );
  }
  return output;
}
const errorReason = (e: unknown) =>
  e instanceof Error &&
  /^(Invalid|Malformed|USD|Stale|Token|Factory|Tick|Locked|Wrong|Block)/.test(e.message)
    ? e.message
    : "RPC unavailable";
export async function enrichEvmLiquidity(
  pools: Pool[],
  chain: keyof typeof evmNetworks,
  rpc: ReadOnlyRpc,
  now = Date.now(),
) {
  const started = Date.now();
  const network = evmNetworks[chain];
  const targets = pools.slice(0, env.ACTIVE_LIQUIDITY_EVM_LIMIT);
  for (const p of pools)
    unavailableLiquidity(
      p,
      env.ACTIVE_LIQUIDITY_EVM_LIMIT ? "Outside enrichment limit" : "Enrichment disabled by limit",
    );
  if (!targets.length) return { enriched: 0, requests: 0, durationMs: 0 };
  try {
    const [chainId, rawBlock] = await rpc.batch([
      { method: "eth_chainId", params: [] },
      { method: "eth_getBlockByNumber", params: ["latest", false] },
    ]);
    if (Number(hexQuantity.parse(chainId)) !== network.chainId) throw new Error("Wrong RPC chain");
    const block = blockSchema.parse(rawBlock),
      blockTime = Number(BigInt(block.timestamp)) * 1000;
    if (!fresh(blockTime, Date.now(), env.ACTIVE_LIQUIDITY_MAX_AGE_SECONDS * 1000))
      throw new Error("Stale RPC block");
    const state = await readContracts(
      rpc,
      targets.flatMap((p) => selectors.map((data) => ({ to: p.poolAddress, data }))),
      block.number,
    );
    const decoded = targets.map((pool, i) => {
      try {
        const values = state.slice(i * selectors.length, (i + 1) * selectors.length);
        const slot = words(values[0], 7),
          liquidity = words(values[1], 1)[0],
          token0 = wordAddress(values[2]),
          token1 = wordAddress(values[3]);
        const fee = Number(words(values[4], 1)[0]),
          spacing = Number(words(values[5], 1)[0]),
          factory = wordAddress(values[6]);
        if (factory !== network.factory) throw new Error("Factory mismatch");
        if (slot[6] !== 1n) throw new Error("Locked pool");
        if (
          ![pool.token0Address.toLowerCase(), pool.token1Address.toLowerCase()].includes(token0) ||
          ![pool.token0Address.toLowerCase(), pool.token1Address.toLowerCase()].includes(token1) ||
          token0 === token1
        )
          throw new Error("Token address mismatch");
        if (
          !Number.isInteger(fee) ||
          fee < 0 ||
          fee >= 1e6 ||
          !Number.isInteger(spacing) ||
          spacing < 1 ||
          spacing > 32767
        )
          throw new Error("Invalid fee or tick spacing");
        return {
          pool,
          sqrt: slot[0].toString(),
          tick: signedTick(slot[1]),
          liquidity: liquidity.toString(),
          token0,
          token1,
          fee,
          spacing,
        };
      } catch (e) {
        unavailableLiquidity(pool, errorReason(e));
        return null;
      }
    });
    const addresses = [...new Set(decoded.flatMap((s) => (s ? [s.token0, s.token1] : [])))];
    const rawDecimals = await readContracts(
      rpc,
      addresses.map((to) => ({ to, data: "0x313ce567" })),
      block.number,
    );
    const tokenDecimals = new Map(
      addresses.map((address, i) => {
        try {
          return [address, decimals(Number(words(rawDecimals[i], 1)[0]))] as const;
        } catch {
          return [address, null] as const;
        }
      }),
    );
    // Re-read this exact block hash after all calls to catch a reorg or inconsistent backend.
    const finalBlock = blockSchema.parse(
      await rpc.call("eth_getBlockByNumber", [block.number, false]),
    );
    if (finalBlock.hash !== block.hash || finalBlock.timestamp !== block.timestamp)
      throw new Error("Block changed during read");
    if (!fresh(blockTime, Date.now(), env.ACTIVE_LIQUIDITY_MAX_AGE_SECONDS * 1000))
      throw new Error("Stale RPC block");
    for (const state of decoded) {
      if (!state) continue;
      const { pool } = state;
      try {
        const d0 = tokenDecimals.get(state.token0),
          d1 = tokenDecimals.get(state.token1);
        if (d0 == null || d1 == null) throw new Error("Invalid token decimals");
        const t0 = pool.token0Address.toLowerCase() === state.token0 ? pool.token0 : pool.token1;
        const t1 = t0 === pool.token0 ? pool.token1 : pool.token0;
        t0.decimals = d0;
        t1.decimals = d1;
        pool.feeTier = state.fee / 1e6;
        pool.tickSpacing = state.spacing;
        const amounts = v3VirtualAmounts(state.liquidity, state.sqrt, state.tick, d0, d1);
        const pricing = priceEvidence(
          t0,
          t1,
          amounts.pairPrice,
          Math.max(now, Date.now()),
          env.ACTIVE_LIQUIDITY_PRICE_MAX_AGE_SECONDS * 1000,
          env.ACTIVE_LIQUIDITY_MAX_PRICE_DIVERGENCE,
        );
        applyLiquidity(
          pool,
          {
            method: "V3_VIRTUAL_RESERVES_V1",
            block: block.number,
            blockTime,
            rpcSource: `${chain} RPC`,
            token0Address: state.token0,
            token1Address: state.token1,
            decimals0: d0,
            decimals1: d1,
            amount0: amounts.amount0.toString(),
            amount1: amounts.amount1.toString(),
            ...pricing,
            pairPrice: amounts.pairPrice.toString(),
            tick: state.tick,
            tickSpacing: state.spacing,
            sqrtPriceX96: state.sqrt,
            liquidityRaw: state.liquidity,
          },
          usdValue(amounts.amount0, amounts.amount1, pricing.price0Usd, pricing.price1Usd),
          Math.min(
            blockTime + env.ACTIVE_LIQUIDITY_MAX_AGE_SECONDS * 1000,
            pricing.priceObservedAt + env.ACTIVE_LIQUIDITY_PRICE_MAX_AGE_SECONDS * 1000,
          ),
        );
      } catch (e) {
        unavailableLiquidity(pool, errorReason(e));
      }
    }
  } catch (e) {
    for (const p of targets) unavailableLiquidity(p, errorReason(e));
  }
  return {
    enriched: targets.filter((p) => p.activeLiquidityUsd !== null).length,
    requests: rpc.requests,
    durationMs: Date.now() - started,
  };
}
