import { horizons, type Horizon, type Outcome } from "./research";

export const cohortVersion = "sprint5-v1";
export function signalEvidenceConfidence(type: string, quality: string,
  fee: string, liquidity: string, price: string, depth: string) {
  const paired = (a: string,b: string) => a === "HIGH" && b === "HIGH" ? "HIGH" :
    ["HIGH","MEDIUM"].includes(a) && ["HIGH","MEDIUM"].includes(b) ? "MEDIUM" : "UNAVAILABLE";
  if (type === "HIGH_FEE_EFFICIENCY") return paired(fee,liquidity);
  if (type === "HIGH_VOLUME_DEPTH") return paired(price,depth);
  if (type === "ACTIVITY_SURGE") return ["HIGH","MEDIUM"].includes(fee) ? fee : "UNAVAILABLE";
  return quality;
}
export type ConfidenceFilter = "HIGH" | "HIGH_MEDIUM" | "ALL";
export interface CohortFact {
  id: number; signalType: string; chain: string; protocol: string; trend: string;
  risk: number; activity: number | null; volatility: number | null;
  confidence: string; tokenAge: number | null; poolAge: number | null;
  horizon: Horizon; outcomeStatus: string; outcomeData: string | null;
}
export interface Stats { n: number; median: number | null; p25: number | null; p75: number | null }
export function quantiles(values: (number | null | undefined)[], min = 1): Stats {
  const sorted = values.filter((x): x is number => x != null && Number.isFinite(x)).sort((a,b)=>a-b);
  const q = (p: number) => {
    const i = (sorted.length-1)*p, lo = Math.floor(i), hi = Math.ceil(i);
    return sorted[lo]+(sorted[hi]-sorted[lo])*(i-lo);
  };
  return {n:sorted.length,median:sorted.length>=min ? q(0.5) : null,
    p25:sorted.length>=min ? q(0.25) : null,p75:sorted.length>=min ? q(0.75) : null};
}
export function observedRate(values: (boolean | null | undefined)[], min = 1) {
  const known = values.filter((x): x is boolean => x != null);
  return known.length >= min ? known.filter(Boolean).length / known.length : null;
}
const bucket = (value: number | null, low: number, high: number) => value == null ? "UNKNOWN"
  : value < low ? `UNDER_${low}` : value <= high ? `${low}_TO_${high}` : `OVER_${high}`;
const dimensionValue = (f: CohortFact, dimension: string) => {
  switch (dimension) {
    case "chain": return f.chain;
    case "protocol": return f.protocol;
    case "trend": return f.trend;
    case "risk": return bucket(f.risk,20,60);
    case "activity": return bucket(f.activity,30,70);
    case "volatility": return bucket(f.volatility,5,20);
    case "confidence": return f.confidence;
    case "tokenAge": return bucket(f.tokenAge,24,168);
    case "poolAge": return bucket(f.poolAge,24,168);
    default: return "ALL";
  }
};
const primary = new Set(["ACTIVITY_SURGE","HIGH_FEE_EFFICIENCY","HIGH_VOLUME_DEPTH","LOW_RISK_HIGH_ACTIVITY"]);
const dimensions = ["all","chain","protocol","trend","risk","activity","volatility","confidence","tokenAge","poolAge"];
const allowed = (confidence: string, filter: ConfidenceFilter) => filter === "ALL" || confidence === "HIGH" ||
  (filter === "HIGH_MEDIUM" && confidence === "MEDIUM");
export function buildCohorts(facts: CohortFact[], minSample = 30) {
  const signalMap = new Map<number,{fact:CohortFact;outcomes:Partial<Record<Horizon,Outcome>>}>();
  for (const f of facts) {
    if (!primary.has(f.signalType)) continue;
    const entry = signalMap.get(f.id) ?? {fact:f,outcomes:{}};
    if (f.outcomeStatus === "COMPLETE" && f.outcomeData) {
      try { entry.outcomes[f.horizon] = JSON.parse(f.outcomeData) as Outcome; } catch { /* malformed historical row excluded */ }
    }
    signalMap.set(f.id,entry);
  }
  const result = [] as ReturnType<typeof aggregate>[];
  for (const filter of ["HIGH","HIGH_MEDIUM","ALL"] as const) {
    const groups = new Map<string,{fact:CohortFact;outcomes:Partial<Record<Horizon,Outcome>>}[]>();
    for (const entry of signalMap.values()) {
      if (!allowed(entry.fact.confidence,filter)) continue;
      for (const dimension of dimensions) {
        const value = dimensionValue(entry.fact,dimension);
        const key = `${filter}|${entry.fact.signalType}|${dimension}|${value}`;
        groups.set(key,[...(groups.get(key) ?? []),entry]);
      }
    }
    for (const [key,entries] of groups) result.push(aggregate(key,entries,minSample));
  }
  return result;
}
function aggregate(key: string, entries: {fact:CohortFact;outcomes:Partial<Record<Horizon,Outcome>>}[], minSample: number) {
  const [confidenceFilter,signalType,dimension,value] = key.split("|");
  const counts = Object.fromEntries((Object.keys(horizons) as Horizon[]).map((h)=>[h,entries.filter((e)=>e.outcomes[h]).length])) as Record<Horizon,number>;
  const composition = Object.fromEntries(["HIGH","MEDIUM","LOW","UNAVAILABLE"].map((c)=>
    [c,entries.filter((e)=>e.fact.confidence===c).length]));
  const curves = (Object.keys(horizons) as Horizon[]).map((h) => {
    const outcomes = entries.map((e)=>e.outcomes[h]).filter((o):o is Outcome=>!!o);
    const stat = (read:(o:Outcome)=>number|null|undefined) => quantiles(outcomes.map(read),minSample);
    const range = (band:"2.5"|"5"|"10") => ({
      survival:stat((o)=>o.ranges[band]?.remainedInRange == null ? null : Number(o.ranges[band].remainedInRange)),
      survivalRate:observedRate(outcomes.map((o)=>o.ranges[band]?.remainedInRange),minSample),
      observedTimeMs:stat((o)=>o.ranges[band]?.timeUntilFirstExitMs ?? (o.ranges[band]?.remainedInRange ? horizons[h] : null)),
    });
    return {horizon:h,n:outcomes.length,activityPersistence:stat((o)=>o.activityPersistence),
      activityRatio:stat((o)=>o.activityRatioAtEndpoint),feeGeneration:stat((o)=>o.feesGenerated),
      volumeGeneration:stat((o)=>o.volumeGenerated),adverseMove:stat((o)=>o.maxPriceMoveDown),
      favorableMove:stat((o)=>o.maxPriceMoveUp),liquidityChange:stat((o)=>o.activeLiquidityChange),
      depthChange:stat((o)=>o.depth5PctChange),ranges:{"2.5":range("2.5"),"5":range("5"),"10":range("10")}};
  });
  return {key,version:cohortVersion,confidenceFilter,signalType,dimension,value,
    signalCount:entries.length,status:counts["1h"]>=minSample ? "VALID" : "INSUFFICIENT_SAMPLE",
    outcomeCounts:counts,confidenceComposition:composition,curves};
}
export type CohortAggregate = ReturnType<typeof aggregate>;
