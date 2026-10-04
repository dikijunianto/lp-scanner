import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { BN } = require("@coral-xyz/anchor") as typeof import("@coral-xyz/anchor");
import { Connection, PublicKey } from "@solana/web3.js";
import type { LbPair, BinArray } from "@meteora-ag/dlmm";
// Official SDK ESM bundle currently imports Anchor's CommonJS BN as a named export.
const { createProgram, decodeAccount, deriveBinArray, binIdToBinArrayIndex, getBinFromBinArray } =
  require("@meteora-ag/dlmm") as typeof import("@meteora-ag/dlmm");
import { z } from "zod";
import { env } from "../config/env";
import type { Pool, Token } from "../core/model";
import { approvedReferenceAssets, type PairPriceState, type PriceProvenance } from "../core/pricing";
import {
  applyLiquidity,
  binPairPrice,
  fresh,
  priceEvidence,
  tokenUnits,
  unavailableLiquidity,
  usdValue,
} from "../core/liquidity";
import { ReadOnlyRpc } from "./liquidity-rpc";
export const SOLANA_PUBLIC_RPC = "https://api.mainnet-beta.solana.com";
export const PROGRAM = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
const mintOwners = [
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
];
const mintCache = new Map<string, { value: number; until: number }>();
const accountSchema = z
  .object({
    owner: z.string(),
    executable: z.boolean(),
    data: z.tuple([z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/), z.literal("base64")]),
  })
  .nullable();
export const accountsSchema = z.object({
  context: z.object({ slot: z.number().int().nonnegative() }),
  value: z.array(accountSchema),
});
type Account = z.infer<typeof accountSchema>;
// Construct only the official account coder. No wallet, signing, transactions or send methods are used.
const program = createProgram(new Connection(SOLANA_PUBLIC_RPC));
function bytes(account: Account, owner?: string) {
  if (!account || account.executable || (owner && account.owner !== owner))
    throw new Error("Invalid account owner");
  return Buffer.from(account.data[0], "base64");
}
export function mintDecimals(account: Account) {
  const data = bytes(account);
  if (!account || !mintOwners.includes(account.owner) || data.length < 82 || data[45] !== 1)
    throw new Error("Invalid mint account");
  return data[44];
}
// SPL Token account amount is a little-endian u64 at byte 64, including Token-2022 extensions.
export function vaultAmount(account:Account,mint:string,decimals:number) {
  const data=bytes(account);
  if(!account || !mintOwners.includes(account.owner) || data.length<165 || data[108]!==1 ||
    new PublicKey(data.subarray(0,32)).toBase58()!==mint)throw new Error('Invalid token vault');
  return tokenUnits(data.readBigUInt64LE(64).toString(),decimals).toNumber();
}
export function decodePair(account: Account) {
  return decodeAccount<LbPair>(program, "lbPair", bytes(account, PROGRAM.toBase58()));
}
export function decodeBinArray(account: Account) {
  return decodeAccount<BinArray>(program, "binArray", bytes(account, PROGRAM.toBase58()));
}
export async function enrichMeteoraLiquidity(pools: Pool[], rpc: ReadOnlyRpc, now = Date.now()) {
  const started = Date.now();
  const targets = pools.slice(0, env.ACTIVE_LIQUIDITY_METEORA_LIMIT);
  for (const pool of targets) (pool as Pool & { pairState?: PairPriceState }).pairState = undefined;
  for (const p of pools)
    unavailableLiquidity(
      p,
      env.ACTIVE_LIQUIDITY_METEORA_LIMIT
        ? "Outside enrichment limit"
        : "Enrichment disabled by limit",
    );
  if (!targets.length) return { enriched: 0, requests: 0, durationMs: 0 };
  try {
    const genesis = await rpc.call("getGenesisHash", []);
    if (genesis !== "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d")
      throw new Error("Wrong Solana cluster");
    for (let start = 0; start < targets.length; start += 16) {
      const chunk = targets.slice(start, start + 16);
      try {
        const first = accountsSchema.parse(
          await rpc.call("getMultipleAccounts", [
            chunk.map((p) => p.poolAddress),
            { encoding: "base64", commitment: "confirmed" },
          ]),
        );
        if (first.value.length !== chunk.length) throw new Error("Malformed RPC account count");
        const prepared = chunk
          .map((pool, i) => {
            try {
              const pair = decodePair(first.value[i]);
              const binIndex = binIdToBinArrayIndex(new BN(pair.activeId));
              return {
                pool,
                pair,
                binIndex,
                binAddress: deriveBinArray(
                  new PublicKey(pool.poolAddress),
                  binIndex,
                  PROGRAM,
                )[0].toBase58(),
                mint0: pair.tokenXMint.toBase58(),
                mint1: pair.tokenYMint.toBase58(),
              };
            } catch {
              unavailableLiquidity(pool, "Invalid DLMM pair account");
              return null;
            }
          })
          .filter((p) => p !== null);
        const keys = [
          ...new Set(
            prepared.flatMap((p) => [
              p.pool.poolAddress,
              p.binAddress,
              p.pair.reserveX.toBase58(),p.pair.reserveY.toBase58(),
              ...[p.mint0, p.mint1].filter(
                (mint) => (mintCache.get(mint)?.until ?? 0) <= Date.now(),
              ),
            ]),
          ),
        ];
        if (!keys.length) continue;
        // Pair + active bin array + both mints are reread in the same bank/context.
        const batch = accountsSchema.parse(
          await rpc.call("getMultipleAccounts", [
            keys,
            { encoding: "base64", commitment: "confirmed", minContextSlot: first.context.slot },
          ]),
        );
        if (batch.value.length !== keys.length || batch.context.slot < first.context.slot)
          throw new Error("Invalid RPC account context");
        const blockTime =
          z
            .number()
            .int()
            .positive()
            .parse(await rpc.call("getBlockTime", [batch.context.slot])) * 1000;
        if (!fresh(blockTime, Date.now(), env.ACTIVE_LIQUIDITY_MAX_AGE_SECONDS * 1000))
          throw new Error("Stale RPC slot");
        const accounts = new Map(keys.map((key, i) => [key, batch.value[i]]));
        for (const row of prepared) {
          const { pool } = row;
          try {
            const pair = decodePair(accounts.get(pool.poolAddress)!);
            if (pair.status !== 0) throw new Error("DLMM pool is disabled");
            if (
              pair.tokenXMint.toBase58() !== pool.token0Address ||
              pair.tokenYMint.toBase58() !== pool.token1Address
            )
              throw new Error("Token address mismatch");
            if (!binIdToBinArrayIndex(new BN(pair.activeId)).eq(row.binIndex))
              throw new Error("Active bin array changed during read");
            const array = decodeBinArray(accounts.get(row.binAddress)!);
            if (array.lbPair.toBase58() !== pool.poolAddress || !array.index.eq(row.binIndex))
              throw new Error("Bin array identity mismatch");
            const bin = getBinFromBinArray(pair.activeId, array);
            const getDecimals = (mint: string) => {
              const cached = mintCache.get(mint);
              if (cached && cached.until > Date.now()) return cached.value;
              const value = mintDecimals(accounts.get(mint)!);
              mintCache.set(mint, {
                value,
                until: Date.now() + env.TOKEN_METADATA_REFRESH_SECONDS * 1000,
              });
              return value;
            };
            const d0 = getDecimals(row.mint0),
              d1 = getDecimals(row.mint1);
            const amount0 = tokenUnits(bin.amountX.toString(), d0),
              amount1 = tokenUnits(bin.amountY.toString(), d1);
            const pairPrice = binPairPrice(pair.activeId, pair.binStep, d0, d1);
            const observedAt = Math.max(now, Date.now());
            const referenceTime = (token: Token): number | null => {
              const provenance = (token as Token & { priceProvenance?: PriceProvenance | null }).priceProvenance;
              const sources = provenance?.sources ?? [token.usdPriceSource ?? ""];
              if (!approvedReferenceAssets.solana.includes(token.address) ||
                  !["HIGH", "MEDIUM"].includes(token.usdPriceConfidence ?? "UNAVAILABLE") ||
                  provenance?.kind === "CROSS_POOL" ||
                  !sources.length || !sources.every((source) => /^(DefiLlama|CoinGecko|Pyth)/.test(source)) ||
                  token.usdPrice == null || !Number.isFinite(token.usdPrice) || token.usdPrice <= 0 ||
                  !fresh(token.usdPriceSourceTimestamp, observedAt, env.PRICE_MEDIUM_AGE_SECONDS * 1000) ||
                  !fresh(token.usdPriceObservedAt, observedAt, env.ACTIVE_LIQUIDITY_PRICE_MAX_AGE_SECONDS * 1000) ||
                  Math.abs(token.usdPriceSourceTimestamp! - blockTime) > env.CROSS_PRICE_MAX_ALIGNMENT_SECONDS * 1000) return null;
              return token.usdPriceSourceTimestamp!;
            };
            const reference0 = referenceTime(pool.token0), reference1 = referenceTime(pool.token1);
            // Only actual active-bin deposits of independently priced approved references count.
            // This lower bound remains useful when the other token has no USD valuation.
            const lowerBound = amount0.mul(reference0 === null ? 0 : pool.token0.usdPrice!)
              .plus(amount1.mul(reference1 === null ? 0 : pool.token1.usdPrice!)).toNumber();
            const numericPairPrice = pairPrice.toNumber();
            if (!Number.isFinite(numericPairPrice) || numericPairPrice <= 0) throw new Error("Invalid pair price");
            (pool as Pool & { pairState?: PairPriceState | null }).pairState = {
              pairPrice: numericPairPrice, sourceTimestamp: blockTime, observedAt,
              blockNumber: String(batch.context.slot), token0Address: pair.tokenXMint.toBase58(),
              token1Address: pair.tokenYMint.toBase58(),
              depositedToken0Amount:(()=>{try{return vaultAmount(accounts.get(pair.reserveX.toBase58())??null,pair.tokenXMint.toBase58(),d0)}catch{return undefined}})(),
              depositedToken1Amount:(()=>{try{return vaultAmount(accounts.get(pair.reserveY.toBase58())??null,pair.tokenYMint.toBase58(),d1)}catch{return undefined}})(),
              execution:{kind:'DLMM_BIN',amount0:amount0.toNumber(),amount1:amount1.toNumber()},
              depositedLiquidityUsd: Number.isFinite(lowerBound) && lowerBound > 0 ? lowerBound : 0,
              liquiditySourceTimestamp: Math.min(blockTime, reference0 ?? blockTime, reference1 ?? blockTime),
              source: "Solana confirmed RPC active-bin deposits",
            };
            pool.token0.decimals = d0;
            pool.token1.decimals = d1;
            pool.binStep = pair.binStep;
            const pricing = priceEvidence(
              pool.token0,
              pool.token1,
              pairPrice,
              Math.max(now, Date.now()),
              env.ACTIVE_LIQUIDITY_PRICE_MAX_AGE_SECONDS * 1000,
              env.ACTIVE_LIQUIDITY_MAX_PRICE_DIVERGENCE,
            );
            applyLiquidity(
              pool,
              {
                method: "DLMM_ACTIVE_BIN_V1",
                block: String(batch.context.slot),
                blockTime,
                rpcSource: "Solana confirmed RPC",
                token0Address: pool.token0Address,
                token1Address: pool.token1Address,
                decimals0: d0,
                decimals1: d1,
                amount0: amount0.toString(),
                amount1: amount1.toString(),
                ...pricing,
                pairPrice: pairPrice.toString(),
                activeBinId: pair.activeId,
                binStep: pair.binStep,
                rawAmount0: bin.amountX.toString(),
                rawAmount1: bin.amountY.toString(),
              },
              usdValue(amount0, amount1, pricing.price0Usd, pricing.price1Usd),
              Math.min(
                blockTime + env.ACTIVE_LIQUIDITY_MAX_AGE_SECONDS * 1000,
                pricing.priceObservedAt + env.ACTIVE_LIQUIDITY_PRICE_MAX_AGE_SECONDS * 1000,
              ),
            );
          } catch (e) {
            unavailableLiquidity(
              pool,
              e instanceof Error && /^(Invalid|USD|Token|Active|Bin|DLMM|Stale)/.test(e.message)
                ? e.message
                : "Invalid DLMM state",
            );
          }
        }
      } catch (e) {
        for (const pool of chunk)
          unavailableLiquidity(
            pool,
            e instanceof Error && /^Stale/.test(e.message)
              ? e.message
              : "Solana RPC batch unavailable or malformed",
          );
      }
    }
  } catch {
    for (const pool of targets)
      unavailableLiquidity(pool, "Solana RPC unavailable or wrong cluster");
  }
  return {
    enriched: targets.filter((p) => p.activeLiquidityUsd !== null).length,
    requests: rpc.requests,
    durationMs: Date.now() - started,
  };
}
