import type { Snapshot, Pool, Metrics, Confidence } from "./model";

export const scannerVersion = "6.0.0";
export const activityScoreVersion = "sprint3-v1";
export const riskScoreVersion = "sprint3-v1";
export const signalRuleVersion = "sprint4-v1";
export const horizons = { "30m": 1800000, "1h": 3600000, "4h": 14400000, "24h": 86400000 } as const;
export type Horizon = keyof typeof horizons;
export const signalTypes = [
  "ACTIVITY_SURGE",
  "HIGH_FEE_EFFICIENCY",
  "HIGH_VOLUME_DEPTH",
  "LOW_RISK_HIGH_ACTIVITY",
  "PRICE_BREAKOUT",
  "LIQUIDITY_COLLAPSE",
] as const;
export type SignalType = (typeof signalTypes)[number];
export interface SignalPolicy {
  feeEfficiency: number;
  volumeDepth: number;
  activity: number;
  risk: number;
  breakoutPct: number;
  collapsePct: number;
  persistenceFraction: number;
  maxObservationGapMs: number;
}
export interface SignalMatch {
  type: SignalType;
  score: number;
  reason: string;
}
const reliable = (c: Confidence | undefined) => c === "HIGH" || c === "MEDIUM";
const valid = (n: number | null | undefined): n is number => n != null && Number.isFinite(n);
const change = (a: number | null | undefined, b: number | null | undefined) =>
  valid(a) && valid(b) && a > 0 ? b / a - 1 : null;

export function detectSignals(s: Snapshot, policy: SignalPolicy): SignalMatch[] {
  const { pool: p, metrics: m } = s;
  const matches: SignalMatch[] = [];
  if (m.surge)
    matches.push({
      type: "ACTIVITY_SURGE",
      score: m.activity ?? 0,
      reason: m.activityReasons.join("; ") || "Activity surge rule fired",
    });
  if (
    valid(m.feeEfficiency1h) &&
    m.feeEfficiency1h >= policy.feeEfficiency &&
    reliable(m.liquidityConfidence) &&
    reliable(m.feeConfidence)
  )
    matches.push({
      type: "HIGH_FEE_EFFICIENCY",
      score: m.feeEfficiency1h,
      reason: `1h fee / active liquidity ≥ ${policy.feeEfficiency}`,
    });
  if (
    valid(m.volumeDepthRatio1h) &&
    m.volumeDepthRatio1h >= policy.volumeDepth &&
    reliable(p.depthConfidence)
  )
    matches.push({
      type: "HIGH_VOLUME_DEPTH",
      score: m.volumeDepthRatio1h,
      reason: `1h volume / ±5% depth ≥ ${policy.volumeDepth}`,
    });
  if (
    valid(m.activity) &&
    m.activity >= policy.activity &&
    m.activityCoverage >= 50 &&
    m.risk <= policy.risk &&
    reliable(m.dataQuality)
  )
    matches.push({
      type: "LOW_RISK_HIGH_ACTIVITY",
      score: m.activity,
      reason: `Activity ≥ ${policy.activity}, risk ≤ ${policy.risk}, coverage ≥ 50%`,
    });
  if (
    valid(p.priceChange1h) &&
    Math.abs(p.priceChange1h) >= policy.breakoutPct &&
    reliable(m.priceConfidence)
  )
    matches.push({
      type: "PRICE_BREAKOUT",
      score: Math.abs(p.priceChange1h),
      reason: `|1h price change| ≥ ${policy.breakoutPct}%`,
    });
  if (
    valid(m.activeLiquidityChange30m) &&
    m.activeLiquidityChange30m <= -policy.collapsePct &&
    reliable(m.liquidityConfidence)
  )
    matches.push({
      type: "LIQUIDITY_COLLAPSE",
      score: -m.activeLiquidityChange30m,
      reason: `30m active-liquidity drop ≥ ${policy.collapsePct}%`,
    });
  return matches;
}

export interface RangeOutcome {
  remainedInRange: boolean | null;
  timeUntilFirstExitMs: number | null;
  numberOfExits: number | null;
  timeSpentInRangePct: number | null;
}
export interface Outcome {
  endpointAt: number | null;
  priceAtSignal?: number | null;
  priceAtHorizon?: number | null;
  observationCoveragePct: number;
  priceReturn: number | null;
  feesGenerated: number | null;
  volumeGenerated: number | null;
  feeEfficiencyAfter: number | null;
  volumeDepthRatioAfter: number | null;
  activeLiquidityChange: number | null;
  depth5PctChange: number | null;
  maxPriceMoveUp: number | null;
  maxPriceMoveDown: number | null;
  maxObservedVolatility: number | null;
  activityPersistence: number | null;
  activityRatioAtEndpoint?: number | null;
  feePersistence: number | null;
  volumePersistence: number | null;
  riskChange: number | null;
  ranges: Record<"2.5" | "5" | "10", RangeOutcome>;
  outcomeCompletenessPct?: number;
  overallCompletenessPct?: number;
  fieldCompleteness?: Record<"price"|"range"|"fee"|"depth"|"liquidity", "COMPLETE"|"PARTIAL"|"UNAVAILABLE">;
  completenessClasses?: ("PRICE_RANGE_COMPLETE"|"FEE_COMPLETE"|"DEPTH_COMPLETE"|"FULL_COMPLETE")[];
  missingReasons?: string[];
}

export function outcomeMissingReasons(value: Pick<Outcome,"endpointAt"|"priceReturn"|"feesGenerated"|
  "depth5PctChange"|"ranges"|"observationCoveragePct">) {
  const reasons:string[]=[];
  if (value.endpointAt===null) reasons.push("NO_SNAPSHOT");
  if (value.priceReturn===null) reasons.push("MISSING_PRICE");
  if (value.feesGenerated===null) reasons.push("MISSING_FEE_DATA");
  if (value.depth5PctChange===null) reasons.push("MISSING_DEPTH");
  if (value.observationCoveragePct<80) reasons.push("INSUFFICIENT_OBSERVATIONS");
  return reasons;
}

export function evaluateOutcome(
  signal: Snapshot,
  subsequent: Snapshot[],
  horizon: Horizon,
  policy: SignalPolicy,
  generated: { fees: number | null; volume: number | null } = { fees: null, volume: null },
): Outcome {
  const start = signal.pool.timestamp;
  const due = start + horizons[horizon];
  const observations = subsequent
    .filter(
      (s) =>
        s.pool.timestamp > start &&
        s.pool.timestamp <= due + policy.maxObservationGapMs &&
        s.pool.id === signal.pool.id && valid(s.pool.price) && s.pool.price > 0,
    )
    .sort((a, b) => a.pool.timestamp - b.pool.timestamp);
  const endpoint = observations.find((s) => s.pool.timestamp >= due) ?? null;
  const path = [
    signal,
    ...observations.filter((s) => s.pool.timestamp <= due),
    ...(endpoint ? [endpoint] : []),
  ];
  const coveredMs = path
    .slice(1)
    .reduce(
      (sum, s, i) =>
        sum + Math.min(policy.maxObservationGapMs, s.pool.timestamp - path[i].pool.timestamp),
      0,
    );
  const coverage = Math.min(100, (coveredMs / horizons[horizon]) * 100);
  const enough = endpoint !== null && coverage >= 80;
  const startPrice = signal.pool.price;
  const priceMoves = path.map((s) => change(startPrice, s.pool.price)).filter(valid);
  const vols = path.map((s) => s.pool.realizedVolatility1h).filter(valid);
  const threshold = policy.persistenceFraction;
  const persistence = observations
    .filter((s) => s.pool.timestamp <= due)
    .map((s) => {
      const feeBase = signal.pool.fees1h,
        volumeBase = signal.pool.volume1h;
      const feeOk =
        valid(feeBase) && feeBase > 0 && valid(s.pool.fees1h)
          ? s.pool.fees1h >= feeBase * threshold
          : null;
      const volumeOk =
        valid(volumeBase) && volumeBase > 0 && valid(s.pool.volume1h)
          ? s.pool.volume1h >= volumeBase * threshold
          : null;
      return {
        feeOk,
        volumeOk,
        both: feeOk === null && volumeOk === null ? null : (feeOk ?? true) && (volumeOk ?? true),
      };
    });
  const fraction = (values: (boolean | null)[]) => {
    const known = values.filter((v): v is boolean => v !== null);
    return enough && known.length ? known.filter(Boolean).length / known.length : null;
  };
  const ranges = {} as Outcome["ranges"];
  for (const band of [2.5, 5, 10] as const) {
    const inRange = (s: Snapshot) =>
      valid(startPrice) &&
      startPrice > 0 &&
      valid(s.pool.price) &&
      s.pool.price >= startPrice * (1 - band / 100) &&
      s.pool.price <= startPrice * (1 + band / 100);
    const first = path.slice(1).find((s) => valid(s.pool.price) && !inRange(s));
    let exits = 0,
      insideMs = 0;
    for (let i = 1; i < path.length; i++) {
      if (inRange(path[i - 1]) && !inRange(path[i])) exits++;
      if (inRange(path[i - 1]))
        insideMs += Math.min(
          Math.max(0, Math.min(path[i].pool.timestamp, due) - path[i - 1].pool.timestamp),
          policy.maxObservationGapMs,
        );
    }
    ranges[String(band) as "2.5" | "5" | "10"] = {
      remainedInRange: !valid(startPrice) ? null : first ? false : enough ? true : null,
      timeUntilFirstExitMs: first ? first.pool.timestamp - start : null,
      numberOfExits: enough ? exits : first ? exits : null,
      timeSpentInRangePct: enough ? Math.min(100, (insideMs / horizons[horizon]) * 100) : null,
    };
  }
  const currentDepth=(s:Snapshot)=>s.pool.depthState==="CURRENT" &&
    ["HIGH","MEDIUM"].includes(s.pool.depthConfidence??"UNAVAILABLE") &&
    valid(s.pool.depthExpiresAt) && s.pool.depthExpiresAt>=s.pool.timestamp &&
    valid(s.pool.depthUpdatedAt) && s.pool.depthUpdatedAt<=s.pool.timestamp+30000
      ?s.pool.depth5PctUsd:null;
  const result:Outcome = {
    endpointAt: endpoint?.pool.timestamp ?? null,
    priceAtSignal: valid(startPrice) && startPrice>0 ? startPrice : null,
    priceAtHorizon: endpoint?.pool.price ?? null,
    observationCoveragePct: coverage,
    priceReturn: endpoint ? change(startPrice, endpoint.pool.price) : null,
    feesGenerated: generated.fees,
    volumeGenerated: generated.volume,
    feeEfficiencyAfter: endpoint?.metrics.feeEfficiency1h ?? null,
    volumeDepthRatioAfter: endpoint?.metrics.volumeDepthRatio1h ?? null,
    activeLiquidityChange: endpoint
      ? change(signal.pool.activeLiquidityUsd, endpoint.pool.activeLiquidityUsd)
      : null,
    depth5PctChange: endpoint ? change(currentDepth(signal),currentDepth(endpoint)) : null,
    maxPriceMoveUp: priceMoves.length ? Math.max(...priceMoves) : null,
    maxPriceMoveDown: priceMoves.length ? Math.min(...priceMoves) : null,
    maxObservedVolatility: vols.length ? Math.max(...vols) : null,
    activityPersistence: fraction(persistence.map((v) => v.both)),
    activityRatioAtEndpoint: endpoint && valid(signal.metrics.activity) && signal.metrics.activity > 0 &&
      valid(endpoint.metrics.activity) ? endpoint.metrics.activity / signal.metrics.activity : null,
    feePersistence: fraction(persistence.map((v) => v.feeOk)),
    volumePersistence: fraction(persistence.map((v) => v.volumeOk)),
    riskChange: endpoint ? endpoint.metrics.risk - signal.metrics.risk : null,
    ranges,
  };
  const complete=[result.endpointAt,result.priceReturn,result.feesGenerated,result.volumeGenerated,
    result.activeLiquidityChange,result.depth5PctChange,result.activityPersistence,
    result.ranges["2.5"].remainedInRange,result.ranges["5"].remainedInRange,
    result.ranges["10"].remainedInRange].filter((v)=>v!==null).length;
  result.outcomeCompletenessPct=complete*10;
  const group=(values:(unknown|null|undefined)[],sufficient:boolean)=>sufficient?"COMPLETE" as const:
    values.some((v)=>v!==null && v!==undefined)?"PARTIAL" as const:"UNAVAILABLE" as const;
  result.fieldCompleteness={
    price:group([result.priceAtSignal,result.priceAtHorizon,result.priceReturn,
      result.maxPriceMoveUp,result.maxPriceMoveDown],enough &&
      [result.priceAtSignal,result.priceAtHorizon,result.priceReturn,result.maxPriceMoveUp,result.maxPriceMoveDown].every(valid)),
    range:group(Object.values(result.ranges).flatMap((r)=>[r.remainedInRange,r.timeSpentInRangePct]),
      enough && Object.values(result.ranges).every((r)=>r.remainedInRange!==null && valid(r.timeSpentInRangePct))),
    fee:group([result.feesGenerated,result.volumeGenerated],
      result.feesGenerated!==null && result.volumeGenerated!==null),
    depth:group([result.depth5PctChange],result.depth5PctChange!==null),
    liquidity:group([result.activeLiquidityChange],result.activeLiquidityChange!==null),
  };
  result.completenessClasses=[];
  if(result.fieldCompleteness.price==="COMPLETE" && result.fieldCompleteness.range==="COMPLETE")
    result.completenessClasses.push("PRICE_RANGE_COMPLETE");
  if(result.fieldCompleteness.fee==="COMPLETE") result.completenessClasses.push("FEE_COMPLETE");
  if(result.fieldCompleteness.depth==="COMPLETE") result.completenessClasses.push("DEPTH_COMPLETE");
  if(Object.values(result.fieldCompleteness).every((value)=>value==="COMPLETE"))
    result.completenessClasses.push("FULL_COMPLETE");
  result.overallCompletenessPct=Object.values(result.fieldCompleteness).reduce((n,v)=>
    n+(v==="COMPLETE"?100:v==="PARTIAL"?50:0),0)/5;
  result.missingReasons=outcomeMissingReasons(result);
  return result;
}

export interface PriorityPolicy {
  tier1Volume1h: number;
  tier2Volume1h: number;
  tier2Tvl: number;
}
export function priorityTier(
  p: Pool,
  watched: boolean,
  prior: Metrics | undefined,
  policy: PriorityPolicy,
): 1 | 2 | 3 {
  if (watched || prior?.surge || (p.volume1h ?? 0) >= policy.tier1Volume1h) return 1;
  if ((p.volume1h ?? 0) >= policy.tier2Volume1h || (p.tvlUsd ?? 0) >= policy.tier2Tvl) return 2;
  return 3;
}
export function priorityScore(
  p: Pool,
  watched: boolean,
  prior?: Metrics,
  policy: PriorityPolicy = { tier1Volume1h: 50000, tier2Volume1h: 5000, tier2Tvl: 100000 },
) {
  return (
    (4 - priorityTier(p, watched, prior, policy)) * 1000 +
    (watched ? 500 : 0) +
    (prior?.surge ? 300 : 0) +
    Math.min(300, (p.volume1h ?? 0) / 10000) +
    Math.min(100, (p.tvlUsd ?? 0) / 100000) +
    (prior?.activity ?? 0)
  );
}
