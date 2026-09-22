import { z } from "zod";
import { env } from "../config/env";
import { emptyPool, emptyToken, type Adapter, type Pool } from "../core/model";
import { HttpClient, numeric, optionalPositive, candleSchema } from "./http";
const address = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const relationship = z.object({ data: z.object({ id: z.string() }) });
const frames = z.record(z.string(), optionalPositive).nullish();
export const geckoPoolSchema = z.object({
  attributes: z.object({
    address,
    name: z.string().max(300),
    base_token_price_quote_token: optionalPositive,
    reserve_in_usd: optionalPositive,
    pool_created_at: z.string().nullish(),
    volume_usd: frames,
    transactions: z
      .record(z.string(), z.object({ buys: optionalPositive, sells: optionalPositive }))
      .nullish(),
  }),
  relationships: z.object({
    base_token: relationship,
    quote_token: relationship,
    dex: relationship,
  }),
});
export interface EvmConfig {
  chain: string;
  dexId: string;
  protocol: string;
  name: string;
  subgraph?: string;
  rpc?: string;
  chainId: number;
}
export function normalizeEvm(raw: unknown, config: EvmConfig, now = Date.now()): Pool {
  const data = geckoPoolSchema.parse(raw);
  const a = data.attributes;
  if (data.relationships.dex.data.id !== config.dexId) throw new Error("Unexpected DEX");
  const names = a.name.replace(/\s+\d+(\.\d+)?%$/, "").split(" / ");
  const tokenAddress = (id: string) => address.parse(id.replace(`${config.chain}_`, ""));
  const token0 = emptyToken(tokenAddress(data.relationships.base_token.data.id), names[0] || "?");
  const token1 = emptyToken(tokenAddress(data.relationships.quote_token.data.id), names[1] || "?");
  const p = emptyPool(
    {
      chain: config.chain,
      protocol: config.protocol,
      dex: config.name,
      poolAddress: a.address.toLowerCase(),
      token0,
      token1,
      source: "GeckoTerminal",
    },
    now,
  );
  p.price =
    a.base_token_price_quote_token && a.base_token_price_quote_token > 0
      ? a.base_token_price_quote_token
      : null;
  p.tvlUsd = a.reserve_in_usd;
  const created = a.pool_created_at ? Date.parse(a.pool_created_at) : NaN;
  p.poolAge = Number.isFinite(created) && created <= now ? (now - created) / 3600000 : null;
  for (const [w, key] of [
    ["5m", "m5"],
    ["30m", "m30"],
    ["1h", "h1"],
    ["24h", "h24"],
  ] as const)
    p[`volume${w}`] = a.volume_usd?.[key] ?? null;
  // Provider price-change percentages are USD based, not quote-token based. Do not mix them with pair prices.
  const tx = a.transactions?.h1;
  p.swapCount = tx?.buys != null && tx.sells != null ? tx.buys + tx.sells : null;
  // Buyers and sellers overlap; their sum is not a unique-trader count.
  return p;
}
const graphToken = z.object({ id: address, symbol: z.string().max(100) });
const graphPool = z.object({
  id: address,
  token0: graphToken,
  token1: graphToken,
  token0Price: optionalPositive,
  token1Price: optionalPositive,
  totalValueLockedUSD: optionalPositive,
  createdAtTimestamp: optionalPositive,
  feeTier: optionalPositive,
});
export class EvmPoolAdapter implements Adapter {
  name: string;
  constructor(
    public config: EvmConfig,
    private http: HttpClient,
  ) {
    this.name = config.name;
  }
  async scan() {
    const pools: Pool[] = [];
    const notes: string[] = [];
    if (this.config.subgraph) {
      try {
        const end = Math.floor(Date.now() / 3600000) * 3600;
        const hourly = z.object({
          periodStartUnix: numeric,
          volumeUSD: optionalPositive,
          feesUSD: optionalPositive,
        });
        for (let page = 0; page < env.EVM_PAGES; page++) {
          const query = `query { pools(first: 20, skip: ${page * 20}, orderBy: totalValueLockedUSD, orderDirection: desc) { id token0 { id symbol } token1 { id symbol } token0Price token1Price totalValueLockedUSD createdAtTimestamp feeTier poolHourData(first: 24, orderBy: periodStartUnix, orderDirection: desc, where: {periodStartUnix_gte: ${end - 86400}, periodStartUnix_lt: ${end}}) { periodStartUnix volumeUSD feesUSD } } }`;
          const result = await this.http.json(
            this.config.subgraph,
            z.object({
              data: z.object({
                pools: z.array(graphPool.extend({ poolHourData: z.array(hourly) })),
              }),
            }),
            { body: { query } },
          );
          for (const raw of result.data.pools) {
            const p = emptyPool({
              chain: this.config.chain,
              protocol: this.config.protocol,
              dex: this.config.name,
              poolAddress: raw.id.toLowerCase(),
              token0: emptyToken(raw.token0.id, raw.token0.symbol),
              token1: emptyToken(raw.token1.id, raw.token1.symbol),
              source: "Protocol V3 subgraph (completed UTC hours)",
            });
            p.price = raw.token1Price && raw.token1Price > 0 ? raw.token1Price : null;
            p.tvlUsd = raw.totalValueLockedUSD;
            p.poolAge =
              raw.createdAtTimestamp && raw.createdAtTimestamp * 1000 <= p.timestamp
                ? (p.timestamp - raw.createdAtTimestamp * 1000) / 3600000
                : null;
            p.feeTier = raw.feeTier == null ? null : raw.feeTier / 1e6;
            for (const [w, count] of [
              ["1h", 1],
              ["4h", 4],
              ["24h", 24],
            ] as const) {
              const hours = raw.poolHourData.filter(
                (h) => h.periodStartUnix >= end - count * 3600 && h.periodStartUnix < end,
              );
              const complete = Array.from({ length: count }, (_, i) => end - (i + 1) * 3600).every(
                (t) => hours.some((h) => h.periodStartUnix === t),
              );
              if (complete && hours.length === count) {
                p[`volume${w}`] = hours.every((h) => h.volumeUSD !== null)
                  ? hours.reduce((sum, h) => sum + h.volumeUSD!, 0)
                  : null;
                p[`fees${w}`] = hours.every((h) => h.feesUSD !== null)
                  ? hours.reduce((sum, h) => sum + h.feesUSD!, 0)
                  : null;
              }
            }
            pools.push(p);
          }
          if (result.data.pools.length < 20) break;
        }
        notes.push("Protocol subgraph: fee/volume windows end at the last completed UTC hour");
      } catch {
        pools.length = 0;
        notes.push("Configured subgraph unavailable; using public discovery");
      }
    }
    if (!pools.length) {
      for (let page = 1; page <= env.EVM_PAGES; page++) {
        const result = await this.http.json(
          `${env.GECKO_API_URL}/networks/${this.config.chain}/dexes/${this.config.dexId}/pools?page=${page}`,
          z.object({ data: z.array(z.unknown()) }),
        );
        let invalid = 0;
        for (const raw of result.data) {
          try {
            pools.push(normalizeEvm(raw, this.config));
          } catch {
            invalid++;
          }
        }
        if (invalid) notes.push(`${invalid} invalid pool records skipped`);
        if (invalid === result.data.length && invalid)
          throw new Error("Upstream response failed validation");
        if (result.data.length < 20) break;
      }
      notes.push("Public discovery: fees, active liquidity and unique traders unavailable");
    }
    if (this.config.rpc) {
      try {
        const rpc = new HttpClient(200);
        const chain = await rpc.json(this.config.rpc, z.object({ result: z.string() }), {
          body: { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] },
        });
        if (Number(chain.result) !== this.config.chainId) throw new Error("Wrong RPC chain");
        for (const p of pools.slice(0, env.RPC_ENRICH_LIMIT)) {
          const response = await rpc.json(
            this.config.rpc,
            z.array(
              z.object({
                id: z.number(),
                result: z
                  .string()
                  .regex(/^0x[a-fA-F0-9]{64}$/)
                  .optional(),
              }),
            ),
            {
              body: ["0xddca3f43", "0xd0c93a7c"].map((data, id) => ({
                jsonrpc: "2.0",
                id,
                method: "eth_call",
                params: [{ to: p.poolAddress, data }, "latest"],
              })),
              ttl: 3600000,
            },
          );
          const fee = response.find((r) => r.id === 0)?.result,
            tick = response.find((r) => r.id === 1)?.result;
          if (fee && Number(BigInt(fee)) <= 1e6) p.feeTier = Number(BigInt(fee)) / 1e6;
          if (tick && Number(BigInt(tick)) < 1e6) p.tickSpacing = Number(BigInt(tick));
        }
      } catch {
        notes.push("Optional RPC enrichment unavailable; discovery continues");
      }
    }
    notes.push(`Discovery capped at ${env.EVM_PAGES * 20} pools per chain`);
    return { pools, notes };
  }
  async candles(pool: Pool) {
    if (pool.source.startsWith("Protocol")) return []; // Canonical token order may differ from the fallback provider's base token.
    // Gecko OHLCV token=base, currency=token matches the normalized quote/base pair price.
    const response = await this.http.json(
      `${env.GECKO_API_URL}/networks/${this.config.chain}/pools/${pool.poolAddress}/ohlcv/minute?aggregate=5&limit=288&currency=token&token=base`,
      z.object({
        data: z.object({
          attributes: z.object({
            ohlcv_list: z.array(z.tuple([numeric, numeric, numeric, numeric, numeric, numeric])),
          }),
        }),
      }),
      { ttl: 300000 },
    );
    return response.data.attributes.ohlcv_list
      .map(([timestamp, open, high, low, close, volume]) =>
        candleSchema.parse({ timestamp: timestamp * 1000, open, high, low, close, volume }),
      )
      .filter((c) => c.timestamp + 300000 <= Date.now())
      .sort((a, b) => a.timestamp - b.timestamp);
  }
}
export const geckoHttp = new HttpClient(60000 / env.GECKO_REQUESTS_PER_MINUTE);
export class UniswapV3Adapter extends EvmPoolAdapter {
  constructor(http = geckoHttp) {
    super(
      {
        chain: "base",
        chainId: 8453,
        dexId: "uniswap-v3-base",
        protocol: "uniswap-v3",
        name: "Uniswap V3",
        subgraph: env.BASE_SUBGRAPH_URL,
        rpc: env.BASE_RPC_URL,
      },
      http,
    );
  }
}
export class PancakeV3Adapter extends EvmPoolAdapter {
  constructor(http = geckoHttp) {
    super(
      {
        chain: "bsc",
        chainId: 56,
        dexId: "pancakeswap-v3-bsc",
        protocol: "pancakeswap-v3",
        name: "PancakeSwap V3",
        subgraph: env.BSC_SUBGRAPH_URL,
        rpc: env.BSC_RPC_URL,
      },
      http,
    );
  }
}
