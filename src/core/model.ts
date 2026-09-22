export const windows = ["5m", "30m", "1h", "4h", "24h"] as const;
export type Window = (typeof windows)[number];
export const windowMs: Record<Window, number> = {
  "5m": 300000,
  "30m": 1800000,
  "1h": 3600000,
  "4h": 14400000,
  "24h": 86400000,
};
export type Nullable = number | null;
export interface Token {
  address: string;
  symbol: string;
  ageHours: Nullable;
  mintAuthority: boolean | null;
  freezeAuthority: boolean | null;
  holderConcentration: Nullable;
  verified: boolean | null;
}
export type Pool = {
  id: string;
  chain: string;
  protocol: string;
  dex: string;
  pair: string;
  poolAddress: string;
  token0: Token;
  token1: Token;
  token0Address: string;
  token1Address: string;
  price: Nullable;
  priceUnit: string;
  tvlUsd: Nullable;
  activeLiquidityUsd: Nullable;
  swapCount: Nullable;
  uniqueTraderCount: Nullable;
  realizedVolatility1h: Nullable;
  realizedVolatility24h: Nullable;
  poolAge: Nullable;
  tokenAge: Nullable;
  feeTier: Nullable;
  binStep: Nullable;
  tickSpacing: Nullable;
  timestamp: number;
  source: string;
  warnings: string[];
} & Record<`volume${Window}` | `fees${Window}` | `priceChange${Window}`, Nullable>;
export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
export interface Metrics {
  feeEfficiency1h: Nullable;
  feeEfficiency24h: Nullable;
  capitalTurnover1h: Nullable;
  capitalTurnover24h: Nullable;
  tvlTurnover: Nullable;
  feeAcceleration: Nullable;
  volumeAcceleration: Nullable;
  swapAcceleration: Nullable;
  tvlChange30m: Nullable;
  activeLiquidityChange30m: Nullable;
  trend: "RANGING" | "TRENDING_UP" | "TRENDING_DOWN" | "EXTREME_MOVE" | "UNKNOWN";
  surge: boolean;
  quietSurge: boolean;
  activityPattern: string;
  activity: Nullable;
  risk: number;
  activityCoverage: number;
  riskCoverage: number;
  activityReasons: string[];
  riskReasons: string[];
  badges: string[];
}
export interface Snapshot {
  pool: Pool;
  metrics: Metrics;
}
export interface Adapter {
  name: string;
  scan(): Promise<{ pools: Pool[]; notes: string[] }>;
  candles(pool: Pool): Promise<Candle[]>;
}
export function emptyPool(
  input: Pick<Pool, "chain" | "protocol" | "dex" | "poolAddress" | "token0" | "token1" | "source">,
  now = Date.now(),
): Pool {
  const frames = Object.fromEntries(
    windows.flatMap((w) => [`volume${w}`, `fees${w}`, `priceChange${w}`].map((k) => [k, null])),
  ) as Pick<Pool, `volume${Window}` | `fees${Window}` | `priceChange${Window}`>;
  return {
    ...frames,
    ...input,
    id: `${input.chain}:${input.protocol}:${input.poolAddress}`,
    pair: `${input.token0.symbol} / ${input.token1.symbol}`,
    token0Address: input.token0.address,
    token1Address: input.token1.address,
    price: null,
    priceUnit: `${input.token1.symbol} per ${input.token0.symbol}`,
    tvlUsd: null,
    activeLiquidityUsd: null,
    swapCount: null,
    uniqueTraderCount: null,
    realizedVolatility1h: null,
    realizedVolatility24h: null,
    poolAge: null,
    tokenAge: null,
    feeTier: null,
    binStep: null,
    tickSpacing: null,
    timestamp: now,
    warnings: [],
  };
}
export const emptyToken = (address: string, symbol: string): Token => ({
  address,
  symbol,
  ageHours: null,
  mintAuthority: null,
  freezeAuthority: null,
  holderConcentration: null,
  verified: null,
});
