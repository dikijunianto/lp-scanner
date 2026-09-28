import { z } from "zod";
import { env } from "../config/env";
import type { Pool, PriceRecord, Token } from "../core/model";
import { applyPrice, priceConfidence, priceConsensus, type PricePolicy } from "../core/pricing";
import type { Store } from "../db/store";
import { HttpClient } from "./http";

const llama = new HttpClient(250);
const gecko = new HttpClient(1100, fetch, 0);
const llamaResponse = z.object({ coins: z.record(z.string(), z.unknown()) });
const llamaCoin = z.object({
  price: z.number().finite().positive(),
  timestamp: z.number().int().positive(),
});
const geckoCoin = z.object({
  usd: z.number().finite().positive(),
  last_updated_at: z.number().int().positive(),
});
type Asset = { pool: Pool; token: Token };
export interface PriceSource {
  name: string;
  fetch(keys: string[], assets: Map<string, Asset>): Promise<PriceRecord[]>;
}
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
const makeRecord = (
  asset: Asset,
  price: number,
  sourceTimestamp: number,
  source: string,
  observedAt: number,
): PriceRecord => ({
  assetAddress:
    asset.pool.chain === "solana" ? asset.token.address : asset.token.address.toLowerCase(),
  chain: asset.pool.chain,
  symbol: asset.token.symbol,
  priceUsd: price,
  source,
  sourceTimestamp,
  observedAt,
  blockNumber: null,
  confidence: priceConfidence(
    sourceTimestamp,
    observedAt,
    observedAt,
    policyFor(asset.token, price),
  ),
});

// Providers remain separate so a source can fail without promoting an untimestamped discovery quote.
export const llamaSource: PriceSource = {
  name: "DefiLlama Coins API",
  async fetch(keys, assets) {
    const records: PriceRecord[] = [];
    for (let i = 0; i < keys.length; i += 50) {
      const chunk = keys.slice(i, i + 50);
      try {
        const data = await llama.json(
          `${env.PRICE_API_URL}/prices/current/${chunk.join(",")}`,
          llamaResponse,
          { ttl: 30000 },
        );
        const observedAt = Date.now();
        for (const key of chunk) {
          const coin = llamaCoin.safeParse(data.coins[key]);
          if (coin.success)
            records.push(
              makeRecord(
                assets.get(key)!,
                coin.data.price,
                coin.data.timestamp * 1000,
                "DefiLlama Coins API",
                observedAt,
              ),
            );
        }
      } catch {
        /* A failed source cannot create price evidence. */
      }
    }
    return records;
  },
};
export const geckoSource: PriceSource = {
  name: "CoinGecko Token Price API",
  async fetch(keys, assets) {
    const records: PriceRecord[] = [];
    const byChain = new Map<string, string[]>();
    for (const key of keys) {
      const chain = assets.get(key)!.pool.chain;
      byChain.set(chain, [...(byChain.get(chain) ?? []), key]);
    }
    for (const [chain, chainKeys] of byChain) {
      const platform = chain === "bsc" ? "binance-smart-chain" : chain;
      try {
        const addresses = chainKeys.map((key) => assets.get(key)!.token.address).join(",");
        const data = await gecko.json(
          `https://api.coingecko.com/api/v3/simple/token_price/${platform}?contract_addresses=${encodeURIComponent(addresses)}&vs_currencies=usd&include_last_updated_at=true`,
          z.record(z.string(), z.unknown()),
          { ttl: 30000 },
        );
        const observedAt = Date.now();
        for (const key of chainKeys) {
          const asset = assets.get(key)!;
          const coin = geckoCoin.safeParse(
            data[asset.token.address.toLowerCase()] ?? data[asset.token.address],
          );
          if (coin.success)
            records.push(
              makeRecord(
                asset,
                coin.data.usd,
                coin.data.last_updated_at * 1000,
                "CoinGecko Token Price API",
                observedAt,
              ),
            );
        }
      } catch {
        /* Public CoinGecko may rate-limit; primary evidence remains intact. */
      }
    }
    return records;
  },
};

export async function enrichPrices(
  pools: Pool[],
  store?: Store,
): Promise<{ records: PriceRecord[]; note: string }> {
  const targets = pools.slice(0, env.PRICE_POOL_LIMIT);
  const assets = new Map<string, Asset>();
  const records: PriceRecord[] = [];
  for (const pool of targets)
    for (const token of [pool.token0, pool.token1]) {
      const key = keyFor(pool, token);
      if (!assets.has(key)) assets.set(key, { pool, token });
      if (
        token.usdPrice !== null &&
        Number.isFinite(token.usdPrice) &&
        token.usdPrice > 0 &&
        !records.some(
          (r) =>
            r.chain === pool.chain &&
            r.assetAddress ===
              (pool.chain === "solana" ? token.address : token.address.toLowerCase()) &&
            r.source === (token.usdPriceSource ?? pool.source),
        )
      )
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
  const keys = [...assets.keys()];
  const primary = await llamaSource.fetch(keys, assets);
  const byKey = new Map<string, PriceRecord[]>();
  for (const record of primary) byKey.set(`${record.chain}:${record.assetAddress}`, [record]);
  for (const key of keys)
    if (!byKey.get(key)?.some((r) => ["HIGH", "MEDIUM"].includes(r.confidence))) {
      const cached = store?.latestIndependentPrice(
        assets.get(key)!.pool.chain,
        assets.get(key)!.token.address,
      );
      if (
        cached &&
        priceConfidence(
          cached.sourceTimestamp,
          cached.observedAt,
          Date.now(),
          policyFor(assets.get(key)!.token, cached.priceUsd),
        ) !== "UNAVAILABLE"
      )
        byKey.set(key, [
          ...(byKey.get(key) ?? []),
          {
            ...cached,
            confidence: priceConfidence(
              cached.sourceTimestamp,
              cached.observedAt,
              Date.now(),
              policyFor(assets.get(key)!.token, cached.priceUsd),
            ),
          },
        ]);
    }
  const occurrences = new Map<string, number>();
  for (const pool of targets)
    for (const token of [pool.token0, pool.token1]) {
      const key = keyFor(pool, token);
      occurrences.set(key, (occurrences.get(key) ?? 0) + 1);
    }
  const ordered = [...keys].sort((a, b) => (occurrences.get(b) ?? 0) - (occurrences.get(a) ?? 0));
  const stale = ordered.filter(
    (key) => !byKey.get(key)?.some((r) => ["HIGH", "MEDIUM"].includes(r.confidence)),
  );
  const current = ordered.filter((key) =>
    byKey.get(key)?.some((r) => ["HIGH", "MEDIUM"].includes(r.confidence)),
  );
  const crossCheckCount = Math.min(4, Math.floor(env.PRICE_FALLBACK_LIMIT / 4));
  const fallbackKeys = [
    ...stale.slice(0, env.PRICE_FALLBACK_LIMIT - crossCheckCount),
    ...current.slice(0, crossCheckCount),
  ].slice(0, env.PRICE_FALLBACK_LIMIT);
  const fallback = await geckoSource.fetch(fallbackKeys, assets);
  for (const record of fallback)
    byKey.set(`${record.chain}:${record.assetAddress}`, [
      ...(byKey.get(`${record.chain}:${record.assetAddress}`) ?? []),
      record,
    ]);
  const chosen = new Map<string, PriceRecord>();
  for (const key of keys) {
    const evidence = byKey.get(key) ?? [];
    const consensus = priceConsensus(
      evidence,
      env.PRICE_CONSENSUS_HIGH_DEVIATION_PCT,
      env.PRICE_CONSENSUS_MEDIUM_DEVIATION_PCT,
    );
    const eligible = evidence.filter((r) => r.confidence === "HIGH" || r.confidence === "MEDIUM");
    if (!eligible.length || consensus.medianPrice === null) continue;
    const record =
      eligible.length === 1
        ? { ...eligible[0], confidence: consensus.confidence }
        : {
            ...eligible[0],
            priceUsd: consensus.medianPrice,
            source: `Independent median (${eligible.map((r) => r.source).join(", ")})`,
            sourceTimestamp: Math.min(...eligible.map((r) => r.sourceTimestamp!)),
            observedAt: Math.max(...eligible.map((r) => r.observedAt)),
            confidence: consensus.confidence,
          };
    chosen.set(key, record);
    if (eligible.length > 1) records.push(record);
    for (const pool of targets)
      for (const token of [pool.token0, pool.token1])
        if (keyFor(pool, token) === key) {
          token.priceSourceCount = consensus.sourceCount;
          token.priceMaxDeviationPct = consensus.maxDeviationPct;
          token.priceConsensusConfidence = consensus.confidence;
          if (
            consensus.maxDeviationPct !== null &&
            consensus.maxDeviationPct > env.PRICE_CONSENSUS_HIGH_DEVIATION_PCT &&
            !pool.warnings.includes("PRICE_DISAGREEMENT")
          )
            pool.warnings.push("PRICE_DISAGREEMENT");
          applyPrice(token, record, pool, pricePolicy());
        }
  }
  records.push(...primary, ...fallback);
  return {
    records,
    note: `Prices: ${chosen.size}/${assets.size} timestamped; ${Math.ceil(keys.length / 50)} Llama batches, ${fallbackKeys.length} CoinGecko assets in ${new Set(fallbackKeys.map((k) => assets.get(k)!.pool.chain)).size} batches`,
  };
}

// Foreground reads price evidence already saved by the independent economic worker.
export function applyCachedPrices(pools:Pool[],store:Store) {
  const cached=new Map<string,PriceRecord|null>();
  let applied=0;
  for(const pool of pools) for(const token of [pool.token0,pool.token1]) {
    token.usdPriceConfidence=token.usdPrice===null?"UNAVAILABLE":"LOW";
    const key=keyFor(pool,token);
    if(!cached.has(key)) cached.set(key,store.latestIndependentPrice(pool.chain,token.address));
    const record=cached.get(key);
    if(!record) continue;
    const confidence=priceConfidence(record.sourceTimestamp,record.observedAt,Date.now(),
      policyFor(token,record.priceUsd));
    if(confidence!=="HIGH" && confidence!=="MEDIUM") continue;
    applyPrice(token,{...record,confidence},pool,pricePolicy());
    applied++;
  }
  return `Cached prices: ${applied} token observations`;
}
