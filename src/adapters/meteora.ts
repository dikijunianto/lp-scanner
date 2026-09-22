import { z } from "zod";
import { env } from "../config/env";
import { emptyPool, emptyToken, windows, type Adapter, type Pool } from "../core/model";
import { candleSchema, HttpClient, optionalPositive } from "./http";
const address = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const token = z.object({
  address,
  symbol: z.string().max(100).default("?"),
  is_verified: z.boolean().nullish(),
  freeze_authority_disabled: z.boolean().nullish(),
});
const frame = z.record(z.string(), optionalPositive).nullish();
export const meteoraSchema = z.object({
  address,
  name: z.string().max(300),
  token_x: token,
  token_y: token,
  tvl: optionalPositive,
  current_price: optionalPositive,
  created_at: optionalPositive,
  volume: frame,
  fees: frame,
  dynamic_fee_pct: optionalPositive,
  pool_config: z.object({ bin_step: optionalPositive }).nullish(),
  is_blacklisted: z.boolean().optional(),
});
export function normalizeMeteora(raw: unknown, now = Date.now()): Pool {
  const data = meteoraSchema.parse(raw);
  const token0 = {
    ...emptyToken(data.token_x.address, data.token_x.symbol),
    verified: data.token_x.is_verified ?? null,
    freezeAuthority:
      data.token_x.freeze_authority_disabled == null
        ? null
        : !data.token_x.freeze_authority_disabled,
  };
  const token1 = {
    ...emptyToken(data.token_y.address, data.token_y.symbol),
    verified: data.token_y.is_verified ?? null,
    freezeAuthority:
      data.token_y.freeze_authority_disabled == null
        ? null
        : !data.token_y.freeze_authority_disabled,
  };
  const pool = emptyPool(
    {
      chain: "solana",
      protocol: "meteora-dlmm",
      dex: "Meteora DLMM",
      poolAddress: data.address,
      token0,
      token1,
      source: "Meteora Data API",
    },
    now,
  );
  pool.price = data.current_price && data.current_price > 0 ? data.current_price : null;
  pool.tvlUsd = data.tvl;
  pool.binStep = data.pool_config?.bin_step ?? null;
  pool.feeTier = data.dynamic_fee_pct == null ? null : data.dynamic_fee_pct / 100;
  pool.poolAge =
    data.created_at && data.created_at <= now ? (now - data.created_at) / 3600000 : null;
  for (const w of windows) {
    pool[`volume${w}`] = data.volume?.[w] ?? null;
    pool[`fees${w}`] = data.fees?.[w] ?? null;
  }
  if (data.is_blacklisted) pool.warnings.push("Provider marks this pool as blacklisted");
  return pool;
}
export class MeteoraAdapter implements Adapter {
  name = "Meteora DLMM";
  constructor(private http = new HttpClient(1000 / env.METEORA_REQUESTS_PER_SECOND)) {}
  async scan() {
    const pools: Pool[] = [];
    const notes: string[] = [];
    let pages = 1;
    let total = 0;
    let invalid = 0;
    for (let page = 1; page <= pages; page++) {
      const url = new URL("/pools", env.METEORA_API_URL);
      url.search = new URLSearchParams({
        page: String(page),
        page_size: "1000",
        sort_by: "tvl:desc",
        filter_by: `tvl>=${env.METEORA_MIN_TVL} && is_blacklisted=false`,
      }).toString();
      const result = await this.http.json(
        url.toString(),
        z.object({
          pages: z.number().int().nonnegative(),
          total: z.number().int().nonnegative(),
          data: z.array(z.unknown()),
        }),
      );
      pages = result.pages;
      total = result.total;
      for (const raw of result.data) {
        try {
          pools.push(normalizeMeteora(raw));
        } catch {
          invalid++;
        }
        if (env.METEORA_MAX_POOLS && pools.length >= env.METEORA_MAX_POOLS) break;
      }
      if (env.METEORA_MAX_POOLS && pools.length >= env.METEORA_MAX_POOLS) break;
      if (!result.data.length) break;
    }
    if (invalid) notes.push(`${invalid} invalid pool records skipped`);
    if (pools.length < total)
      notes.push(
        `Coverage: ${pools.length} of ${total} matching pools (configured cap ${env.METEORA_MAX_POOLS || "none"})`,
      );
    notes.push(`TVL filter ≥ $${env.METEORA_MIN_TVL}; active liquidity unavailable from this API`);
    if (!pools.length && total > 0) throw new Error("Upstream response failed validation");
    return { pools: [...new Map(pools.map((p) => [p.id, p])).values()], notes };
  }
  async candles(pool: Pool) {
    const end = Math.floor(Date.now() / 300000) * 300;
    const candles = [];
    // The live API rejects a 24h range at 5m resolution; request bounded 6h slices.
    for (let start = end - 86400; start < end; start += 21600) {
      const url = new URL(`/pools/${pool.poolAddress}/ohlcv`, env.METEORA_API_URL);
      url.search = new URLSearchParams({
        timeframe: "5m",
        start_time: String(start),
        end_time: String(start + 21600),
      }).toString();
      const data = await this.http.json(url.toString(), z.object({ data: z.array(candleSchema) }), {
        ttl: 300000,
      });
      candles.push(...data.data);
    }
    return [
      ...new Map(
        candles
          .filter((c) => c.timestamp + 300 <= end)
          .map((c) => [c.timestamp, { ...c, timestamp: c.timestamp * 1000 }]),
      ).values(),
    ].sort((a, b) => a.timestamp - b.timestamp);
  }
}
