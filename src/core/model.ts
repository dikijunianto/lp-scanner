import { liquidityDefaults, type LiquidityDetails, type LiquiditySource } from "./liquidity";
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
export type Confidence = "HIGH" | "MEDIUM" | "LOW" | "UNAVAILABLE";
export interface PriceRecord {
  assetAddress: string;
  chain: string;
  symbol: string;
  priceUsd: number;
  source: string;
  sourceTimestamp: number | null;
  observedAt: number;
  blockNumber: string | null;
  confidence: Confidence;
}
export interface FeeWindow {
  volumeUsd: Nullable;
  feesUsd: Nullable;
  grossFeesUsd?: Nullable;
  lpFeesUsd?: Nullable;
  swapCount?: number | null;
  uniqueTraderCount?: number | null;
  windowStart: number;
  windowEnd: number;
  startBlock: number | null;
  endBlock: number | null;
  methodology: "EVENT_DERIVED" | "INDEXER_DERIVED" | "APPROXIMATED" | "UNAVAILABLE";
  confidence: Confidence;
}
export interface Token {
  address: string;
  symbol: string;
  decimals: Nullable;
  usdPrice: Nullable;
  usdPriceObservedAt: Nullable;
  usdPriceSource: string | null;
  usdPriceSourceTimestamp?: Nullable;
  usdPriceConfidence?: Confidence;
  priceSourceCount?: number;
  priceMaxDeviationPct?: Nullable;
  priceConsensusConfidence?: Confidence;
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
  activeLiquiditySource: LiquiditySource;
  activeLiquidityConfidence: "HIGH" | "MEDIUM" | "LOW" | "UNAVAILABLE";
  activeLiquidityUpdatedAt: Nullable;
  activeLiquidityExpiresAt: Nullable;
  activeLiquidityReason: string;
  activeLiquidityDetails: LiquidityDetails | null;
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
  priceConfidence?: Confidence;
  dataQuality?: Confidence;
  feeConfidence?: Confidence;
  feeWindows?: Partial<Record<Window, FeeWindow>>;
  depth1PctUsd?: Nullable;
  depth2_5PctUsd?: Nullable;
  depth5PctUsd?: Nullable;
  depth10PctUsd?: Nullable;
  depthConfidence?: Confidence;
  depthSource?: string | null;
  depthUpdatedAt?: Nullable;
  depthExpiresAt?: Nullable;
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
  feeEfficiencyDepth1h?: Nullable;
  feeEfficiencyDepth24h?: Nullable;
  volumeDepthRatio1h?: Nullable;
  volumeDepthRatio24h?: Nullable;
  dataQuality?: Confidence;
  priceConfidence?: Confidence;
  liquidityConfidence?: Confidence;
  feeConfidence?: Confidence;
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
    ...liquidityDefaults,
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
    priceConfidence: "UNAVAILABLE",
    dataQuality: "UNAVAILABLE",
    feeConfidence: "UNAVAILABLE",
    feeWindows: {},
    depth1PctUsd: null,
    depth2_5PctUsd: null,
    depth5PctUsd: null,
    depth10PctUsd: null,
    depthConfidence: "UNAVAILABLE",
    depthSource: null,
    depthUpdatedAt: null,
    depthExpiresAt: null,
  };
}
export const emptyToken = (address: string, symbol: string): Token => ({
  address,
  symbol,
  decimals: null,
  usdPrice: null,
  usdPriceObservedAt: null,
  usdPriceSource: null,
  usdPriceSourceTimestamp: null,
  usdPriceConfidence: "UNAVAILABLE",
  priceSourceCount: 0,
  priceMaxDeviationPct: null,
  priceConsensusConfidence: "UNAVAILABLE",
  ageHours: null,
  mintAuthority: null,
  freezeAuthority: null,
  holderConcentration: null,
  verified: null,
});
