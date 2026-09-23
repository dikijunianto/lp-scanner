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
import type { Pool } from "../core/model";
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
const PROGRAM = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
const mintOwners = [
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
];
const accountSchema = z
  .object({
    owner: z.string(),
    executable: z.boolean(),
    data: z.tuple([z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/), z.literal("base64")]),
  })
  .nullable();
const accountsSchema = z.object({
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
export function decodePair(account: Account) {
  return decodeAccount<LbPair>(program, "lbPair", bytes(account, PROGRAM.toBase58()));
}
export function decodeBinArray(account: Account) {
  return decodeAccount<BinArray>(program, "binArray", bytes(account, PROGRAM.toBase58()));
}
export async function enrichMeteoraLiquidity(pools: Pool[], rpc: ReadOnlyRpc, now = Date.now()) {
  const started = Date.now();
  const targets = pools.slice(0, env.ACTIVE_LIQUIDITY_METEORA_LIMIT);
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
    for (let start = 0; start < targets.length; start += 20) {
      const chunk = targets.slice(start, start + 20);
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
          ...new Set(prepared.flatMap((p) => [p.pool.poolAddress, p.binAddress, p.mint0, p.mint1])),
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
            const d0 = mintDecimals(accounts.get(row.mint0)!),
              d1 = mintDecimals(accounts.get(row.mint1)!);
            const amount0 = tokenUnits(bin.amountX.toString(), d0),
              amount1 = tokenUnits(bin.amountY.toString(), d1);
            const pairPrice = binPairPrice(pair.activeId, pair.binStep, d0, d1);
            const pricing = priceEvidence(
              pool.token0,
              pool.token1,
              pairPrice,
              Math.max(now, Date.now()),
              env.ACTIVE_LIQUIDITY_PRICE_MAX_AGE_SECONDS * 1000,
              env.ACTIVE_LIQUIDITY_MAX_PRICE_DIVERGENCE,
            );
            pool.token0.decimals = d0;
            pool.token1.decimals = d1;
            pool.binStep = pair.binStep;
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
