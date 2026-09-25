import { z } from "zod";
import { env } from "../config/env";
import { swapUsd } from "../core/fees";
import type { PriceRecord } from "../core/model";
import type { Store } from "../db/store";
import type { UnpricedEvent } from "../db/reliability";
import { HttpClient } from "./http";

const source = "DefiLlama Coins API historical";
const response = z.object({ coins: z.record(z.string(), z.unknown()) });
const coin = z.object({ price: z.number().positive().finite(), timestamp: z.number().int().positive() });
const http = new HttpClient(250,fetch,0,5000);
export const priceBackfillVersion = "sprint5-v1";
export const priceBucket = (timestamp: number) => Math.floor(timestamp/300000)*300000;
export const historicalQuoteReason = (sourceTimestamp: number | null, eventTimestamp: number) =>
  sourceTimestamp === null || !Number.isFinite(sourceTimestamp) || sourceTimestamp <= 0
    ? "HISTORICAL_PRICE_UNAVAILABLE" : sourceTimestamp > eventTimestamp ? "FUTURE_PRICE" :
    eventTimestamp-sourceTimestamp > 300000 ? "STALE_PRICE" : null;
export interface HistoricalPriceSource {
  name: string;
  resolution: PriceRecord["resolution"];
  fetch(chain: string, address: string, symbol: string, timestamp: number): Promise<PriceRecord | null>;
}
export const llamaHistoricalSource: HistoricalPriceSource = {
  name: source, resolution: "5M",
  async fetch(chain,address,symbol,timestamp) {
    const bucket = priceBucket(timestamp), key = `${chain}:${address}`;
    const data = await http.json(`${env.PRICE_API_URL}/prices/historical/${Math.floor(bucket/1000)}/${key}?searchWidth=10m`,response,{ttl:300000});
    const parsed = coin.safeParse(data.coins[key]);
    if (!parsed.success) return null;
    const sourceTimestamp = parsed.data.timestamp*1000;
    const reason = historicalQuoteReason(sourceTimestamp,timestamp);
    if (reason) throw new Error(reason);
    return {chain,assetAddress:address,symbol,priceUsd:parsed.data.price,source,
      sourceTimestamp,observedAt:Date.now(),blockNumber:null,confidence:"MEDIUM",
      resolution:"5M",algorithmVersion:priceBackfillVersion};
  },
};
export function historicalPriceReason(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (message === "STALE_PRICE" || message === "FUTURE_PRICE") return message;
  return /HTTP|timed out|request failed/i.test(message) ? "PROVIDER_FAILURE" : "HISTORICAL_PRICE_UNAVAILABLE";
}
export async function backfillEventPrices(events: UnpricedEvent[], store: Store) {
  let priced = 0, missing = 0, requests = 0;
  const seen = new Map<string, PriceRecord | null>();
  const metadata = new Map<string, ReturnType<Store["latestFeeMetadata"]>>();
  for (const e of events) {
    if (!e.token0Address || !e.token1Address) {
      if (!metadata.has(e.poolId)) metadata.set(e.poolId,store.latestFeeMetadata(e.poolId));
      const prior = metadata.get(e.poolId);
      const details = prior?.activeLiquidityDetails;
      if (details) {
        e.token0Address = details.token0Address; e.token1Address = details.token1Address;
        e.decimals0 = details.decimals0; e.decimals1 = details.decimals1;
        e.symbol0 = prior!.token0.symbol; e.symbol1 = prior!.token1.symbol;
      }
    }
    if (!/^0x[0-9a-f]{40}$/i.test(e.token0Address ?? "") ||
      !/^0x[0-9a-f]{40}$/i.test(e.token1Address ?? "") ||
      !Number.isInteger(e.decimals0) || !Number.isInteger(e.decimals1)) {
      store.markPriceAttempt(e,"UNSUPPORTED_ASSET",Date.now()+86400000); missing++; continue;
    }
    const paid = BigInt(e.amount0) > 0n ? 0 : 1;
    const address = (paid ? e.token1Address : e.token0Address).toLowerCase();
    const symbol = paid ? e.symbol1 : e.symbol0;
    const key = `${e.chain}:${address}`;
    const bucket = priceBucket(e.timestamp);
    let record = store.priceAt(e.chain,address,e.timestamp,300000);
    const cacheKey = `${key}:${bucket}`;
    if (!record && seen.has(cacheKey)) {
      const candidate = seen.get(cacheKey);
      if (candidate && !historicalQuoteReason(candidate.sourceTimestamp,e.timestamp)) record = candidate;
    }
    let reason = "HISTORICAL_PRICE_UNAVAILABLE";
    if (!record) {
      const cached = store.cachedHistoricalPrice(e.chain,address,bucket,source);
      if (cached?.status === "FOUND" && !historicalQuoteReason(Number(cached.source_timestamp),e.timestamp))
        record = {chain:e.chain,assetAddress:address,symbol,priceUsd:Number(cached.price_usd),
          source,sourceTimestamp:Number(cached.source_timestamp),observedAt:Number(cached.observed_at),
          blockNumber:null,confidence:"MEDIUM",resolution:"5M",algorithmVersion:priceBackfillVersion};
      else if (!cached || Date.now()-Number(cached.observed_at)>3600000) {
        if (requests >= env.PRICE_BACKFILL_CALLS_PER_CYCLE || !store.reservePriceCall(e.chain,env.PRICE_CALLS_PER_MINUTE)) {
          store.markPriceAttempt(e,"PRICE_REQUEST_BUDGET",Date.now()+60000); missing++; continue;
        }
        try {
          requests++;
          record = await llamaHistoricalSource.fetch(e.chain,address,symbol,e.timestamp);
          if (record) store.savePrices([record]);
          else reason = "NO_TOKEN_PRICE";
          store.saveHistoricalPrice(record,e.chain,address,bucket,source,record ? "FOUND" : reason);
        } catch (error) {
          reason = historicalPriceReason(error);
          store.saveHistoricalPrice(null,e.chain,address,bucket,source,reason);
        }
      } else reason = cached.status === "FOUND"
        ? historicalQuoteReason(Number(cached.source_timestamp),e.timestamp) ?? "HISTORICAL_PRICE_UNAVAILABLE"
        : String(cached.status);
    }
    seen.set(cacheKey,record);
    if (!record) {
      store.markPriceAttempt(e,reason,Date.now()+(reason === "PROVIDER_FAILURE" ? 300000 : 3600000));
      missing++; continue;
    }
    const p0 = paid === 0 ? record.priceUsd : null;
    const p1 = paid === 1 ? record.priceUsd : null;
    const amount = swapUsd(BigInt(e.amount0),BigInt(e.amount1),e.decimals0,e.decimals1,
      p0,p1,e.feeTier,e.protocolFeeRaw === null ? null : BigInt(e.protocolFeeRaw));
    if (amount.volumeUsd === null) {
      store.markPriceAttempt(e,"VALUATION_ERROR",Date.now()+3600000); missing++; continue;
    }
    store.saveBackfilledEvent(e,record,amount.volumeUsd,amount.feesUsd,
      amount.volumeUsd*e.feeTier,p0,p1);
    priced++;
  }
  return {priced,missing,requests};
}
