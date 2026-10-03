import type { Confidence, Pool, PriceRecord, Token } from "./model";

export interface PricePolicy {
  highAgeMs: number;
  mediumAgeMs: number;
  lowAgeMs: number;
  disagreement: number;
  unavailableDisagreement: number;
}

export function priceConfidence(
  sourceTimestamp: number | null,
  observedAt: number,
  scanAt: number,
  policy: PricePolicy,
): Confidence {
  if (
    !Number.isFinite(observedAt) ||
    observedAt > scanAt + 30000 ||
    scanAt - observedAt > policy.lowAgeMs
  )
    return "UNAVAILABLE";
  if (
    sourceTimestamp !== null &&
    Number.isFinite(sourceTimestamp) &&
    sourceTimestamp > scanAt + 30000
  )
    return "UNAVAILABLE";
  if (sourceTimestamp === null || !Number.isFinite(sourceTimestamp)) return "LOW";
  const age = scanAt - sourceTimestamp;
  if (age > policy.lowAgeMs) return "UNAVAILABLE";
  if (age <= policy.highAgeMs) return "HIGH";
  if (age <= policy.mediumAgeMs) return "MEDIUM";
  return "LOW";
}

export function comparePrices(a: number, b: number, policy: PricePolicy) {
  if (!(a > 0) || !(b > 0) || !Number.isFinite(a) || !Number.isFinite(b))
    return { disagreement: null, confidence: "UNAVAILABLE" as Confidence };
  const disagreement = Math.max(a, b) / Math.min(a, b) - 1;
  return {
    disagreement,
    confidence:
      disagreement >= policy.unavailableDisagreement
        ? ("UNAVAILABLE" as Confidence)
        : disagreement >= policy.disagreement
          ? ("LOW" as Confidence)
          : ("HIGH" as Confidence),
  };
}

export function priceConsensus(
  records: PriceRecord[],
  highDeviationPct: number,
  mediumDeviationPct: number,
) {
  const usable = independentEvidence(records);
  if (!usable.length)
    return { medianPrice: null, maxDeviationPct: null, sourceCount: 0, confidence: "UNAVAILABLE" as Confidence };
  const values = usable.map((r) => r.priceUsd).sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  const medianPrice = values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
  const maxDeviationPct = Math.max(...values.map((p) => Math.abs(p / medianPrice - 1) * 100));
  const sourceCount = new Set(usable.flatMap(priceLineage)).size;
  const confidence: Confidence = maxDeviationPct > mediumDeviationPct
    ? "UNAVAILABLE"
    : sourceCount >= 2 && maxDeviationPct <= highDeviationPct && usable.every((r) => r.confidence === "HIGH" && !isDerivedPrice(r))
      ? "HIGH"
      : maxDeviationPct <= mediumDeviationPct
        ? "MEDIUM"
        : "LOW";
  return { medianPrice, maxDeviationPct, sourceCount, confidence };
}

const rank: Record<Confidence, number> = { UNAVAILABLE: 0, LOW: 1, MEDIUM: 2, HIGH: 3 };
export function minConfidence(...values: Confidence[]): Confidence {
  return values.reduce((a, b) => (rank[a] <= rank[b] ? a : b), "HIGH");
}

export function applyPrice(token: Token, record: PriceRecord, pool: Pool, policy: PricePolicy) {
  let confidence = isDerivedPrice(record) ? minConfidence(record.confidence, "MEDIUM") : record.confidence;
  (token as Token & { priceProvenance?: PriceProvenance | null }).priceProvenance =
    (record as EvidencedPrice).provenance ?? { kind: "DIRECT", sources: priceLineage(record) };
  if (token.usdPrice !== null && token.usdPriceSource !== record.source) {
    const compared = comparePrices(record.priceUsd, token.usdPrice, policy);
    if (token.usdPriceSourceTimestamp != null)
      confidence = minConfidence(confidence, compared.confidence);
    if (
      compared.disagreement !== null &&
      compared.disagreement >= policy.disagreement &&
      !pool.warnings.includes("PRICE_DISAGREEMENT")
    )
      pool.warnings.push("PRICE_DISAGREEMENT");
  }
  token.usdPriceConfidence = confidence;
  token.usdPriceSourceTimestamp = record.sourceTimestamp;
  if (confidence === "UNAVAILABLE") {
    token.usdPrice = null;
    token.usdPriceObservedAt = null;
    token.usdPriceSource = null;
    return;
  }
  token.usdPrice = record.priceUsd;
  token.usdPriceObservedAt = record.observedAt;
  token.usdPriceSource = record.source;
  if (confidence === "LOW" && !pool.warnings.includes("PRICE_STALE"))
    pool.warnings.push("PRICE_STALE");
}


export interface PriceProvenance {
  kind: "DIRECT" | "CONSENSUS" | "CROSS_POOL";
  sources: string[];
  poolId?: string;
  poolAddress?: string;
  referenceAddress?: string;
  referenceSourceTimestamp?: number;
  referencePriceUsd?: number;
  referenceObservedAt?: number;
  pairObservedAt?: number;
  liquiditySourceTimestamp?: number;
  pairTimestamp?: number;
  pairPrice?: number;
  depositedLiquidityUsd?: number;
}
export type EvidencedPrice = PriceRecord & { provenance?: PriceProvenance };
export interface PairPriceState {
  pairPrice: number;
  sourceTimestamp: number;
  observedAt: number;
  blockNumber: string | null;
  token0Address: string;
  token1Address: string;
  depositedLiquidityUsd: number;
  liquiditySourceTimestamp: number;
  source: string;
}
export interface CrossAssetPricePolicy {
  minimumLiquidityUsd: number;
  maxAgeMs: number;
  maxAlignmentMs: number;
  maxPools: number;
  maxDerivations: number;
  approvedReferences?: Record<string, readonly string[]>;
}
export const approvedReferenceAssets: Record<string, readonly string[]> = {
  solana: ["So11111111111111111111111111111111111111112", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"],
  base: ["0x4200000000000000000000000000000000000006", "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"],
};
const normalizedAddress = (chain: string, address: string) => chain === "solana" ? address : address.toLowerCase();
export function priceLineage(record: PriceRecord): string[] {
  const provenance = (record as EvidencedPrice).provenance;
  if (provenance?.sources.length) return [...new Set(provenance.sources)];
  const aggregate = /^Independent median \((.*)\)$/.exec(record.source);
  return aggregate ? aggregate[1].split(", ") : [record.source];
}
export function isDerivedPrice(record: PriceRecord): boolean {
  return (record as EvidencedPrice).provenance?.kind === "CROSS_POOL" || record.source.startsWith("Cross-pool USD");
}
// Prefer constituent observations over cached aggregates; overlapping lineage never votes twice.
export function independentEvidence(records: PriceRecord[]): PriceRecord[] {
  const seen = new Set<string>();
  const usable: PriceRecord[] = [];
  const candidates = records.filter((r) => Number.isFinite(r.priceUsd) && r.priceUsd > 0 &&
    r.sourceTimestamp !== null && Number.isFinite(r.sourceTimestamp) && r.sourceTimestamp > 0 &&
    ["HIGH", "MEDIUM"].includes(r.confidence)).sort((a, b) =>
      priceLineage(a).length - priceLineage(b).length || (b.sourceTimestamp! - a.sourceTimestamp!));
  for (const record of candidates) {
    const lineage = priceLineage(record);
    if (lineage.some((source) => seen.has(source))) continue;
    lineage.forEach((source) => seen.add(source));
    usable.push(record);
  }
  return usable;
}

// One-hop derivation from another deposited pool and an approved, independent USD reference.
// State is captured before USD valuation; discovery fetch time and V3 virtual reserves are not evidence.
export function deriveCrossAssetPrices(
  targetPool: Pool,
  token: Token,
  pools: Pool[],
  references: PriceRecord[],
  now: number,
  policy: CrossAssetPricePolicy,
): EvidencedPrice[] {
  if (!Number.isFinite(policy.minimumLiquidityUsd) || policy.minimumLiquidityUsd <= 0 ||
      !Number.isFinite(policy.maxAgeMs) || policy.maxAgeMs <= 0 ||
      !Number.isFinite(policy.maxAlignmentMs) || policy.maxAlignmentMs < 0 ||
      !Number.isInteger(policy.maxPools) || policy.maxPools <= 0 ||
      !Number.isInteger(policy.maxDerivations) || policy.maxDerivations <= 0) return [];
  const results: EvidencedPrice[] = [];
  const address = normalizedAddress(targetPool.chain, token.address);
  const approved = (policy.approvedReferences ?? approvedReferenceAssets)[targetPool.chain] ?? [];
  const freshAt = (timestamp: number) => Number.isFinite(timestamp) && timestamp > 0 &&
    timestamp <= now + 30000 && now - timestamp <= policy.maxAgeMs;
  for (const pool of pools.slice(0, policy.maxPools)) {
    if (pool.chain !== targetPool.chain || pool.id === targetPool.id ||
        normalizedAddress(pool.chain, pool.poolAddress) === normalizedAddress(targetPool.chain, targetPool.poolAddress)) continue;
    const state = (pool as Pool & { pairState?: PairPriceState | null }).pairState;
    if (!state || !Number.isFinite(state.pairPrice) || state.pairPrice <= 0 ||
        !freshAt(state.sourceTimestamp) || !freshAt(state.observedAt) || !freshAt(state.liquiditySourceTimestamp) ||
        Math.abs(state.sourceTimestamp - state.liquiditySourceTimestamp) > policy.maxAlignmentMs ||
        !Number.isFinite(state.depositedLiquidityUsd) || state.depositedLiquidityUsd < policy.minimumLiquidityUsd) continue;
    const a0 = normalizedAddress(pool.chain, state.token0Address);
    const a1 = normalizedAddress(pool.chain, state.token1Address);
    if (a0 === a1 || a0 !== normalizedAddress(pool.chain, pool.token0Address) ||
        a1 !== normalizedAddress(pool.chain, pool.token1Address)) continue;
    const referenceAddress = address === a0 ? a1 : address === a1 ? a0 : null;
    if (!referenceAddress || !approved.some((a) => normalizedAddress(pool.chain, a) === referenceAddress)) continue;
    const reference = independentEvidence(references.filter((r) => r.chain === pool.chain &&
      normalizedAddress(r.chain, r.assetAddress) === referenceAddress && !isDerivedPrice(r) &&
      !priceLineage(r).some((s) => s.startsWith("Cross-pool USD")) &&
      freshAt(r.sourceTimestamp!) && freshAt(r.observedAt) &&
      Math.abs(r.sourceTimestamp! - state.sourceTimestamp) <= policy.maxAlignmentMs))[0];
    if (!reference) continue;
    const priceUsd = address === a0 ? state.pairPrice * reference.priceUsd : reference.priceUsd / state.pairPrice;
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) continue;
    results.push({
      chain: pool.chain, assetAddress: address, symbol: token.symbol, priceUsd,
      source: `Cross-pool USD (${pool.poolAddress}; ${reference.source})`,
      sourceTimestamp: Math.min(state.sourceTimestamp, state.liquiditySourceTimestamp, reference.sourceTimestamp!),
      observedAt: Math.min(state.observedAt, reference.observedAt), blockNumber: state.blockNumber,
      confidence: minConfidence(reference.confidence, "MEDIUM"),
      provenance: { kind: "CROSS_POOL", sources: [...priceLineage(reference), `${state.source}:${pool.poolAddress}`],
        poolId: pool.id, poolAddress: pool.poolAddress, referenceAddress,
        referenceSourceTimestamp: reference.sourceTimestamp!, referencePriceUsd: reference.priceUsd,
        referenceObservedAt: reference.observedAt, pairTimestamp: state.sourceTimestamp,
        pairObservedAt: state.observedAt, liquiditySourceTimestamp: state.liquiditySourceTimestamp,
        pairPrice: state.pairPrice, depositedLiquidityUsd: state.depositedLiquidityUsd },
    });
    if (results.length >= policy.maxDerivations) break;
  }
  return results;
}
