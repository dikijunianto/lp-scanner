import { z } from "zod";
import { env } from "../config/env";
import type { Pool, PriceRecord, Token } from "../core/model";
import {
  applyPrice,
  comparePrices,
  minConfidence,
  priceConfidence,
  type PricePolicy,
} from "../core/pricing";
import { HttpClient } from "./http";

const client = new HttpClient(250);
const fallbackClient = new HttpClient(1100, fetch, 0);
const responseSchema = z.object({ coins: z.record(z.string(), z.unknown()) });
const coinSchema = z.object({
  price: z.number().finite().positive(),
  timestamp: z.number().int().positive(),
  symbol: z.string().optional(),
});
export const pricePolicy = (): PricePolicy => ({
  highAgeMs: env.PRICE_HIGH_AGE_SECONDS * 1000,
  mediumAgeMs: env.PRICE_MEDIUM_AGE_SECONDS * 1000,
  lowAgeMs: env.PRICE_LOW_AGE_SECONDS * 1000,
  disagreement: env.PRICE_DISAGREEMENT,
  unavailableDisagreement: env.PRICE_UNAVAILABLE_DISAGREEMENT,
});
const keyFor = (pool: Pool, token: Token) =>
  `${pool.chain}:${pool.chain === "solana" ? token.address : token.address.toLowerCase()}`;
const policyFor = (token: Token, price: number): PricePolicy =>
  ["USDC", "USDT"].includes(token.symbol) &&
  price >= 0.99 &&
  price <= 1.01 &&
  token.usdPrice !== null &&
  token.usdPrice >= 0.99 &&
  token.usdPrice <= 1.01
    ? { ...pricePolicy(), mediumAgeMs: env.PRICE_STABLECOIN_MEDIUM_AGE_SECONDS * 1000 }
    : pricePolicy();

// One query per 50 unique assets; records keep the API publication time and local observation separately.
export async function enrichPrices(
  pools: Pool[],
): Promise<{ records: PriceRecord[]; note: string }> {
  const targets = pools.slice(0, env.PRICE_POOL_LIMIT);
  const assets = new Map<string, { pool: Pool; token: Token }>();
  const records: PriceRecord[] = [];
  for (const pool of targets)
    for (const token of [pool.token0, pool.token1]) {
      const key = keyFor(pool, token);
      if (!assets.has(key)) assets.set(key, { pool, token });
      if (token.usdPrice !== null && Number.isFinite(token.usdPrice) && token.usdPrice > 0)
        records.push({
          assetAddress: pool.chain === "solana" ? token.address : token.address.toLowerCase(),
          chain: pool.chain,
          symbol: token.symbol,
          priceUsd: token.usdPrice,
          source: token.usdPriceSource ?? pool.source,
          sourceTimestamp: null,
          observedAt: token.usdPriceObservedAt ?? Date.now(),
          blockNumber: null,
          confidence: "LOW",
        });
      token.usdPriceConfidence = "LOW";
    }
  const prices = new Map<string, PriceRecord>();
  const independent: PriceRecord[] = [];
  const keys = [...assets.keys()];
  for (let i = 0; i < keys.length; i += 50) {
    const chunk = keys.slice(i, i + 50);
    try {
      const data = await client.json(
        `${env.PRICE_API_URL}/prices/current/${chunk.join(",")}`,
        responseSchema,
        { ttl: 30000 },
      );
      const observedAt = Date.now();
      for (const key of chunk) {
        const parsed = coinSchema.safeParse(data.coins[key]);
        if (!parsed.success) continue;
        const { pool, token } = assets.get(key)!;
        const sourceTimestamp = parsed.data.timestamp * 1000;
        prices.set(key, {
          assetAddress: pool.chain === "solana" ? token.address : token.address.toLowerCase(),
          chain: pool.chain,
          symbol: token.symbol,
          priceUsd: parsed.data.price,
          source: "DefiLlama Coins API",
          sourceTimestamp,
          observedAt,
          blockNumber: null,
          confidence: priceConfidence(
            sourceTimestamp,
            observedAt,
            observedAt,
            policyFor(token, parsed.data.price),
          ),
        });
      }
    } catch {
      /* Missing price evidence remains LOW and cannot value reliable liquidity. */
    }
  }
  independent.push(...prices.values());
  const occurrences = new Map<string, number>();
  for (const pool of targets)
    for (const token of [pool.token0, pool.token1]) {
      const key = keyFor(pool, token);
      occurrences.set(key, (occurrences.get(key) ?? 0) + 1);
    }
  const staleKeys = keys
    .filter(
      (key) => !prices.has(key) || ["LOW", "UNAVAILABLE"].includes(prices.get(key)!.confidence),
    )
    .sort((a, b) => (occurrences.get(b) ?? 0) - (occurrences.get(a) ?? 0));
  const currentKeys = keys
    .filter((key) => ["HIGH", "MEDIUM"].includes(prices.get(key)?.confidence ?? ""))
    .sort((a, b) => (occurrences.get(b) ?? 0) - (occurrences.get(a) ?? 0));
  const crossChecks = Math.min(2, Math.floor(env.PRICE_FALLBACK_LIMIT / 2));
  const fallbackKeys = [
    ...staleKeys.slice(0, env.PRICE_FALLBACK_LIMIT - crossChecks),
    ...currentKeys.slice(0, crossChecks),
  ].slice(0, env.PRICE_FALLBACK_LIMIT);
  const conflicts = new Map<string, number>();
  for (const key of fallbackKeys) {
    const { pool, token } = assets.get(key)!;
    const platform = pool.chain === "bsc" ? "binance-smart-chain" : pool.chain;
    try {
      const data = await fallbackClient.json(
        `https://api.coingecko.com/api/v3/simple/token_price/${platform}?contract_addresses=${token.address}&vs_currencies=usd&include_last_updated_at=true`,
        z.record(z.string(), z.unknown()),
        { ttl: 30000 },
      );
      const raw = data[token.address.toLowerCase()] ?? data[token.address];
      const parsed = z
        .object({
          usd: z.number().finite().positive(),
          last_updated_at: z.number().int().positive(),
        })
        .safeParse(raw);
      if (!parsed.success) continue;
      const observedAt = Date.now(),
        sourceTimestamp = parsed.data.last_updated_at * 1000;
      const record: PriceRecord = {
        assetAddress: pool.chain === "solana" ? token.address : token.address.toLowerCase(),
        chain: pool.chain,
        symbol: token.symbol,
        priceUsd: parsed.data.usd,
        source: "CoinGecko Token Price API",
        sourceTimestamp,
        observedAt,
        blockNumber: null,
        confidence: priceConfidence(
          sourceTimestamp,
          observedAt,
          observedAt,
          policyFor(token, parsed.data.usd),
        ),
      };
      independent.push(record);
      if (["HIGH", "MEDIUM"].includes(record.confidence)) {
        const prior = prices.get(key);
        if (prior && ["HIGH", "MEDIUM"].includes(prior.confidence)) {
          const comparison = comparePrices(prior.priceUsd, record.priceUsd, pricePolicy());
          if (
            comparison.disagreement !== null &&
            comparison.disagreement >= pricePolicy().disagreement
          )
            conflicts.set(key, comparison.disagreement);
          record.confidence = minConfidence(record.confidence, comparison.confidence);
        }
        prices.set(key, record);
      }
    } catch {
      /* Rate limits or absent contracts leave original source confidence unchanged. */
    }
  }
  for (const pool of targets)
    for (const token of [pool.token0, pool.token1]) {
      const record = prices.get(keyFor(pool, token));
      if (record) {
        if (conflicts.has(keyFor(pool, token)) && !pool.warnings.includes("PRICE_DISAGREEMENT"))
          pool.warnings.push("PRICE_DISAGREEMENT");
        applyPrice(token, record, pool, pricePolicy());
        if (token.usdPriceConfidence === "UNAVAILABLE") record.confidence = "UNAVAILABLE";
        else if (token.usdPriceConfidence === "LOW" && record.confidence !== "UNAVAILABLE")
          record.confidence = "LOW";
      }
    }
  records.push(...independent);
  return {
    records,
    note: `Prices: ${prices.size}/${assets.size} timestamped; ${Math.ceil(keys.length / 50)} Llama batches, ${fallbackKeys.length} CoinGecko checks`,
  };
}
