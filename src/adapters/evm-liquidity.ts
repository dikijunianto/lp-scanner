import { Interface } from "@ethersproject/abi";
import type { Pool } from "../core/model";
import {
  applyLiquidity,
  decimals,
  fresh,
  priceEvidence,
  unavailableLiquidity,
  usdValue,
  tokenUnits,
  v3VirtualAmounts,
} from "../core/liquidity";
import { approvedReferenceAssets } from "../core/pricing";
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
const decimalsCache = new Map<string, { value: number; until: number }>();
export interface V3FeeMetadata {
  token0Address: string;
  token1Address: string;
  decimals0: number;
  decimals1: number;
  feeTier: number;
  blockNumber: string;
  blockTime: number;
}
// Fee ingestion needs validated token units and fee tier, independently of USD valuation.
// Object lifetime bounds this cache; metadata never makes USD liquidity available.
const feeMetadata = new WeakMap<Pool, V3FeeMetadata>();
export function getV3FeeMetadata(pool: Pool): V3FeeMetadata | null {
  const captured = feeMetadata.get(pool);
  if (captured) return captured;
  const details = pool.activeLiquidityDetails;
  if (details?.method !== "V3_VIRTUAL_RESERVES_V1" || pool.feeTier == null ||
      !Number.isFinite(pool.feeTier) || pool.feeTier < 0 || pool.feeTier >= 1) return null;
  const addresses = [pool.token0Address.toLowerCase(), pool.token1Address.toLowerCase()];
  if (details.token0Address.toLowerCase() === details.token1Address.toLowerCase() ||
      !addresses.includes(details.token0Address.toLowerCase()) ||
      !addresses.includes(details.token1Address.toLowerCase())) return null;
  try { decimals(details.decimals0); decimals(details.decimals1); } catch { return null; }
  return { token0Address: details.token0Address, token1Address: details.token1Address,
    decimals0: details.decimals0, decimals1: details.decimals1, feeTier: pool.feeTier,
    blockNumber: details.block, blockTime: details.blockTime };
}

export const multicallAbi = new Interface([
  "function aggregate3(tuple(address target,bool allowFailure,bytes callData)[] calls) payable returns (tuple(bool success,bytes returnData)[] returnData)",
]);
// eth_call only: no transaction or wallet. Limit each aggregate to 140 read calls.
export async function readContracts(
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
  for (const pool of pools) feeMetadata.delete(pool);
  for (const pool of targets) pool.pairState = undefined;
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
    const missingDecimals = addresses.filter(
      (address) => (decimalsCache.get(`${chain}:${address}`)?.until ?? 0) <= Date.now(),
    );
    const decimalCalls = missingDecimals.map((to) => ({ to, data: "0x313ce567" }));
    const balances = decoded.flatMap((state) => state ? [state, state] : []);
    const balanceCalls = balances.map((state, i) => ({
      to: i % 2 === 0 ? state.token0 : state.token1,
      data: `0x70a08231${state.pool.poolAddress.slice(2).toLowerCase().padStart(64, "0")}`,
    }));
    let tokenReads: unknown[];
    try {
      tokenReads = await readContracts(rpc, [...decimalCalls, ...balanceCalls], block.number);
    } catch {
      // Custody evidence is optional; an unavailable balance read must not disable liquidity valuation.
      tokenReads = await readContracts(rpc, decimalCalls, block.number);
    }
    const rawDecimals = tokenReads.slice(0, missingDecimals.length);
    const custodyBalances = new Map<Pool, [unknown, unknown]>();
    for (let i = 0; i < balances.length; i += 2)
      custodyBalances.set(balances[i].pool, [tokenReads[missingDecimals.length + i],
        tokenReads[missingDecimals.length + i + 1]]);
    // Re-read this exact block hash after all calls to catch a reorg or inconsistent backend.
    const finalBlock = blockSchema.parse(
      await rpc.call("eth_getBlockByNumber", [block.number, false]),
    );
    if (finalBlock.hash !== block.hash || finalBlock.timestamp !== block.timestamp)
      throw new Error("Block changed during read");
    if (!fresh(blockTime, Date.now(), env.ACTIVE_LIQUIDITY_MAX_AGE_SECONDS * 1000))
      throw new Error("Stale RPC block");
    for (let i = 0; i < missingDecimals.length; i++) {
      try {
        const value = decimals(Number(words(rawDecimals[i], 1)[0]));
        decimalsCache.set(`${chain}:${missingDecimals[i]}`, {
          value,
          until: Date.now() + env.TOKEN_METADATA_REFRESH_SECONDS * 1000,
        });
      } catch {
        /* Invalid token metadata is not cached. */
      }
    }
    const tokenDecimals = new Map(
      addresses.map(
        (address) => [address, decimalsCache.get(`${chain}:${address}`)?.value ?? null] as const,
      ),
    );
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
        feeMetadata.set(pool, { token0Address: state.token0, token1Address: state.token1,
          decimals0: d0, decimals1: d1, feeTier: state.fee / 1e6,
          blockNumber: block.number, blockTime });
        try {
          const custody = custodyBalances.get(pool)!;
          const amount0 = tokenUnits(words(custody[0], 1)[0].toString(), d0);
          const amount1 = tokenUnits(words(custody[1], 1)[0].toString(), d1);
          const observedAt = Math.max(now, Date.now());
          const referenceTime = (token: typeof t0): number | null => {
            const sources = token.priceProvenance?.sources ?? [token.usdPriceSource ?? ""];
            if (!(approvedReferenceAssets[chain] ?? []).includes(token.address.toLowerCase()) ||
                !["HIGH", "MEDIUM"].includes(token.usdPriceConfidence ?? "UNAVAILABLE") ||
                token.priceProvenance?.kind === "CROSS_POOL" ||
                !sources.length || !sources.every((source) => /^(DefiLlama|CoinGecko|Pyth)/.test(source)) ||
                token.usdPrice == null || !Number.isFinite(token.usdPrice) || token.usdPrice <= 0 ||
                !fresh(token.usdPriceSourceTimestamp, observedAt, env.PRICE_MEDIUM_AGE_SECONDS * 1000) ||
                !fresh(token.usdPriceObservedAt, observedAt, env.ACTIVE_LIQUIDITY_PRICE_MAX_AGE_SECONDS * 1000) ||
                Math.abs(token.usdPriceSourceTimestamp! - blockTime) > env.CROSS_PRICE_MAX_ALIGNMENT_SECONDS * 1000) return null;
            return token.usdPriceSourceTimestamp!;
          };
          const reference0 = referenceTime(t0), reference1 = referenceTime(t1);
          const lowerBound = amount0.mul(reference0 == null ? 0 : t0.usdPrice!)
            .plus(amount1.mul(reference1 == null ? 0 : t1.usdPrice!)).toNumber();
          const numeric0 = amount0.toNumber(), numeric1 = amount1.toNumber();
          if (!Number.isFinite(numeric0) || !Number.isFinite(numeric1) ||
              !Number.isFinite(lowerBound)) throw new Error("Invalid custody balance");
          // Whole-contract custody includes fees and out-of-range deposits; it is not tradable reserves.
          pool.pairState = { pairPrice: amounts.pairPrice.toNumber(), sourceTimestamp: blockTime,
            observedAt, blockNumber: block.number, token0Address: state.token0,
            token1Address: state.token1, depositedToken0Amount: numeric0, depositedToken1Amount: numeric1,
            depositedLiquidityUsd: lowerBound,
            execution: {kind:"V3_CURRENT_RANGE",sqrtPriceX96:state.sqrt,
              liquidityRaw:state.liquidity,tick:state.tick,tickSpacing:state.spacing,
              decimals0:d0,decimals1:d1},
            liquiditySourceTimestamp: Math.min(blockTime, reference0 ?? blockTime, reference1 ?? blockTime),
            source: "EVM pinned ERC20 balanceOf pool custody (not tradable reserves)" };
        } catch {
          // Malformed or unsupported token balance cannot manufacture reference liquidity.
        }
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
