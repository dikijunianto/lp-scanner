import { z } from "zod";
import { env } from "../config/env";
import type { Pool, PriceRecord, Token } from "../core/model";
import { applyPrice, priceConfidence, priceConsensus, minConfidence, independentEvidence, priceLineage, derivePriceGraph, isDerivedPrice, type PricePolicy, type CrossAssetPricePolicy, type PriceProvenance, type EvidencedPrice } from "../core/pricing";
import type { Store } from "../db/store";
import { HttpClient } from "./http";

const llama = new HttpClient(250);
const gecko = new HttpClient(1100, fetch, 0);
let fallbackRotation=0;
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
export interface PriceFailure {
  source: string;
  reason: "MISSING" | "RATE_LIMITED" | "HTTP_ERROR" | "TIMEOUT" | "INVALID_RESPONSE" | "STALE" | "FUTURE_TIMESTAMP" | "NO_RELIABLE_SOURCE" | "DISAGREEMENT";
  observedAt: number;
}
type FailureMap = Map<string, PriceFailure[]>;
type PriceToken = Token & { priceFailures?: PriceFailure[]; priceProvenance?: PriceProvenance | null };
const failure = (failures: FailureMap | undefined, key: string, source: string, reason: PriceFailure["reason"]) => {
  if (failures) failures.set(key, [...(failures.get(key) ?? []), { source, reason, observedAt: Date.now() }]);
};
const transportReason = (error: unknown): PriceFailure["reason"] => {
  const message = error instanceof Error ? error.message : "";
  return /HTTP 429/.test(message) ? "RATE_LIMITED" : /HTTP \d{3}/.test(message) ? "HTTP_ERROR" :
    /validation/.test(message) ? "INVALID_RESPONSE" : /timed out|timeout/i.test(message) ? "TIMEOUT" : "HTTP_ERROR";
};
export interface PriceEnrichmentOptions {
  primarySource?: PriceSource;
  fallbackSource?: PriceSource;
  additionalSources?: PriceSource[];
  derivationPolicy?: CrossAssetPricePolicy;
}
export interface PriceSource {
  name: string;
  fetch(keys: string[], assets: Map<string, Asset>, failures?: FailureMap): Promise<PriceRecord[]>;
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
  async fetch(keys, assets, failures) {
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
          else failure(failures, key, this.name, data.coins[key] == null ? "MISSING" : "INVALID_RESPONSE");
        }
      } catch (error) {
        for (const key of chunk) failure(failures, key, this.name, transportReason(error));
      }
    }
    return records;
  },
};
export const geckoSource: PriceSource = {
  name: "CoinGecko Token Price API",
  async fetch(keys, assets, failures) {
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
          else failure(failures, key, this.name,
            data[asset.token.address.toLowerCase()] == null && data[asset.token.address] == null ? "MISSING" : "INVALID_RESPONSE");
        }
      } catch (error) {
        for (const key of chainKeys) failure(failures, key, this.name, transportReason(error));
      }
    }
    return records;
  },
};

export async function enrichPrices(
  pools: Pool[],
  store?: Store,
  options: PriceEnrichmentOptions = {},
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
      token.usdPriceConfidence = token.usdPrice === null ? "UNAVAILABLE" : "LOW";
      token.priceSourceCount = 0;
      token.priceMaxDeviationPct = null;
      token.priceConsensusConfidence = "UNAVAILABLE";
      (token as PriceToken).priceProvenance = null;
      (token as PriceToken).priceFailures = [];
    }
  const keys = [...assets.keys()];
  const failures: FailureMap = new Map();
  const fetchSource = async (source: PriceSource, requested: string[]) => {
    let fetched: PriceRecord[];
    try { fetched = await source.fetch(requested, assets, failures); }
    catch (error) {
      requested.forEach((key) => failure(failures, key, source.name, transportReason(error)));
      return [];
    }
    for (const key of requested) {
      const record = fetched.find((r) => `${r.chain}:${r.assetAddress}` === key);
      if (!record && !failures.get(key)?.some((f) => f.source === source.name)) failure(failures, key, source.name, "MISSING");
      else if (record) {
        const timestamp = record.sourceTimestamp;
        const reason = timestamp == null || !Number.isFinite(timestamp) || timestamp <= 0 ||
          !Number.isFinite(record.priceUsd) || record.priceUsd <= 0 ? "INVALID_RESPONSE" :
          timestamp > Date.now() + 30000 || record.observedAt > Date.now() + 30000 ? "FUTURE_TIMESTAMP" :
          !["HIGH", "MEDIUM"].includes(minConfidence(record.confidence, priceConfidence(timestamp,
            record.observedAt, Date.now(), policyFor(assets.get(key)!.token, record.priceUsd)))) ? "STALE" : null;
        if (reason) failure(failures, key, source.name, reason);
      }
    }
    return fetched.filter((r) => requested.includes(`${r.chain}:${r.assetAddress}`) &&
      Number.isFinite(r.priceUsd) && r.priceUsd > 0 && Number.isFinite(r.observedAt) &&
      r.sourceTimestamp !== null && Number.isFinite(r.sourceTimestamp) && r.sourceTimestamp > 0).map((r) => ({
      ...r, confidence: minConfidence(r.confidence, priceConfidence(r.sourceTimestamp, r.observedAt,
        Date.now(), policyFor(assets.get(`${r.chain}:${r.assetAddress}`)!.token, r.priceUsd))),
      provenance: (r as EvidencedPrice).provenance ?? { kind: "DIRECT" as const, sources: [r.source] },
    }));
  };
  const primary = await fetchSource(options.primarySource ?? llamaSource, keys);
  const byKey = new Map<string, PriceRecord[]>();
  for (const record of primary) byKey.set(`${record.chain}:${record.assetAddress}`, [record]);
  for (const key of keys)
    if (!byKey.get(key)?.some((r) => ["HIGH", "MEDIUM"].includes(r.confidence))) {
      const cached = store?.latestIndependentPrice(
        assets.get(key)!.pool.chain,
        assets.get(key)!.token.address,
      );
      if (
        cached && !isDerivedPrice(cached) &&
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
            confidence: minConfidence(cached.confidence, priceConfidence(
              cached.sourceTimestamp,
              cached.observedAt,
              Date.now(),
              policyFor(assets.get(key)!.token, cached.priceUsd),
            )),
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
  const rotation=stale.length?fallbackRotation++%stale.length:0;
  const fairStale=[...stale.slice(rotation),...stale.slice(0,rotation)];
  const fallbackKeys = [
    ...fairStale.slice(0, env.PRICE_FALLBACK_LIMIT - crossCheckCount),
    ...current.slice(0, crossCheckCount),
  ].slice(0, env.PRICE_FALLBACK_LIMIT);
  const fallback = await fetchSource(options.fallbackSource ?? geckoSource, fallbackKeys);
  for (const source of options.additionalSources ?? []) fallback.push(...await fetchSource(source, keys));
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
    const eligible = independentEvidence(evidence);
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
            provenance: { kind: "CONSENSUS" as const, sources: [...new Set(eligible.flatMap(priceLineage))] },
          };
    chosen.set(key, record);
    records.push(record);
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
          if (consensus.confidence === "UNAVAILABLE") failure(failures, key, "Consensus", "DISAGREEMENT");
        }
  }
  let derived = 0;
  const referenceRecords = [...chosen.values()].filter((r) => ["HIGH", "MEDIUM"].includes(r.confidence));
  for (const pool of targets) for (const token of [pool.token0, pool.token1]) {
    const key = keyFor(pool, token);
    if (options.derivationPolicy && !["HIGH", "MEDIUM"].includes(token.usdPriceConfidence ?? "UNAVAILABLE") &&
        !failures.get(key)?.some((f) => f.reason === "DISAGREEMENT")) {
      const evidence = derivePriceGraph(pool, token, pools, referenceRecords, Date.now(), options.derivationPolicy);
      const consensus = priceConsensus(evidence, env.PRICE_CONSENSUS_HIGH_DEVIATION_PCT, env.PRICE_CONSENSUS_MEDIUM_DEVIATION_PCT);
      if (evidence.length && consensus.medianPrice !== null && consensus.confidence !== "UNAVAILABLE") {
        // Select an actual derivation so persisted provenance identifies the pool to exclude.
        const record = evidence.slice().sort((a, b) => Math.abs(a.priceUsd - consensus.medianPrice!) - Math.abs(b.priceUsd - consensus.medianPrice!))[0];
        applyPrice(token, { ...record, confidence: "MEDIUM" }, pool, pricePolicy());
        token.priceConsensusConfidence = "MEDIUM";
        token.priceSourceCount = consensus.sourceCount;
        token.priceMaxDeviationPct = consensus.maxDeviationPct;
        records.push(record);
        derived++;
      }
    }
    if (!["HIGH", "MEDIUM"].includes(token.usdPriceConfidence ?? "UNAVAILABLE") && !failures.get(key)?.length)
      failure(failures, key, "Pricing", "NO_RELIABLE_SOURCE");
    (token as PriceToken).priceFailures = failures.get(key) ?? [];
  }
  for(const [key,items] of failures) {
    const asset=assets.get(key)!;
    for(const f of items)store?.recordPriceSource(asset.pool.chain,asset.token.address,f.source,false,f.observedAt,{reason:f.reason});
  }
  records.push(...primary, ...fallback);
  return {
    records,
    note: `Prices: ${chosen.size}/${assets.size} timestamped; ${derived} cross-pool observations; ${Math.ceil(keys.length / 50)} Llama batches, ${fallbackKeys.length} CoinGecko assets in ${new Set(fallbackKeys.map((k) => assets.get(k)!.pool.chain)).size} batches`,
  };
}

// Foreground reads price evidence already saved by the independent economic worker.
export function applyCachedPrices(pools:Pool[],store:Store) {
  const cached=new Map<string,PriceRecord|null>();
  let applied=0;
  for(const pool of pools) for(const token of [pool.token0,pool.token1]) {
    token.usdPriceConfidence=token.usdPrice===null?"UNAVAILABLE":"LOW";
    token.priceSourceCount=0;
    token.priceMaxDeviationPct=null;
    token.priceConsensusConfidence="UNAVAILABLE";
    (token as PriceToken).priceProvenance=null;
    (token as PriceToken).priceFailures=[];
    const key=keyFor(pool,token);
    if(!cached.has(key)) cached.set(key,store.latestIndependentPrice(pool.chain,token.address));
    const record=cached.get(key);
    if(!record) {
      (token as PriceToken).priceFailures=[{source:"Cache",reason:"MISSING",observedAt:Date.now()}];
      continue;
    }
    if (isDerivedPrice(record)) {
      const provenance = (record as EvidencedPrice).provenance;
      if (provenance?.path?.some(hop=>hop.poolId===pool.id ||
        (pool.chain==='solana'?hop.poolAddress===pool.poolAddress:hop.poolAddress.toLowerCase()===pool.poolAddress.toLowerCase())))continue;
      if (!provenance?.poolId || !provenance.poolAddress || provenance.poolId === pool.id || (pool.chain==='solana'?provenance.poolAddress===pool.poolAddress:provenance.poolAddress.toLowerCase()===pool.poolAddress.toLowerCase())) continue;
    }
    const confidence=minConfidence(record.confidence, priceConfidence(record.sourceTimestamp,record.observedAt,Date.now(),
      policyFor(token,record.priceUsd)), isDerivedPrice(record) || priceLineage(record).length<2 ? "MEDIUM" : "HIGH");
    if(confidence!=="HIGH" && confidence!=="MEDIUM") {
      (token as PriceToken).priceFailures=[{source:record.source,
        reason:record.sourceTimestamp!=null && record.sourceTimestamp>Date.now()+30000 ? "FUTURE_TIMESTAMP" : "STALE",observedAt:Date.now()}];
      continue;
    }
    if(!Number.isFinite(record.priceUsd) || record.priceUsd<=0) {
      (token as PriceToken).priceFailures=[{source:record.source,reason:"INVALID_RESPONSE",observedAt:Date.now()}];
      continue;
    }
    token.priceSourceCount=priceLineage(record).length;
    token.priceConsensusConfidence=confidence;
    applyPrice(token,{...record,confidence},pool,pricePolicy());
    applied++;
  }
  return `Cached prices: ${applied} token observations`;
}
