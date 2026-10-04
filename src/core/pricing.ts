import type { Confidence, Pool, PriceRecord, Token } from "./model";
import Decimal from "decimal.js";
const D = Decimal.clone({ precision: 80 });

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
  path?: PriceDerivationHop[];
}
export interface PriceDerivationHop {
  poolId: string; poolAddress: string; source: string; blockNumber: string | null;
  assetAddress: string; referenceAddress: string; pairPrice: number;
  sourceTimestamp: number; observedAt: number; liquiditySourceTimestamp: number;
  referenceDepositUsd: number; notionalReserveRatio: number;
  priceImpact: number; impactMethodology: "DLMM_ACTIVE_BIN_NO_CROSS" | "V3_CURRENT_RANGE_SPOT";
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
  // Decimal-adjusted deposits read from actual token balances or bins, never virtual reserves.
  depositedToken0Amount?: number;
  depositedToken1Amount?: number;
  execution?: { kind: "DLMM_BIN"; amount0: number; amount1: number } |
    { kind: "V3_CURRENT_RANGE"; sqrtPriceX96: string; liquidityRaw: string; tick: number;
      tickSpacing: number; decimals0: number; decimals1: number };
}
export interface CrossAssetPricePolicy {
  minimumLiquidityUsd: number;
  maxAgeMs: number;
  maxAlignmentMs: number;
  maxPools: number;
  maxDerivations: number;
  approvedReferences?: Record<string, readonly string[]>;
  maxHops?: number;
  notionalUsd?: number;
  maxPriceImpact?: number;
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

function executionImpact(state: PairPriceState, targetIs0: boolean, referenceUsd: number,
  targetUsd: number, notionalUsd: number): { impact: number; method: PriceDerivationHop["impactMethodology"] } | null {
  const execution = state.execution;
  if (!execution) return null;
  if (execution.kind === "DLMM_BIN") {
    const amount = targetIs0 ? execution.amount0 : execution.amount1;
    // No fee subtraction overestimates output required, so this cannot understate bin depletion.
    if (!Number.isFinite(amount) || amount <= 0 || new D(notionalUsd).div(targetUsd).gt(amount)) return null;
    return { impact: 0, method: "DLMM_ACTIVE_BIN_NO_CROSS" };
  }
  if (!Number.isInteger(execution.tick) || Math.abs(execution.tick) > 887272 ||
      !Number.isInteger(execution.tickSpacing) || execution.tickSpacing < 1 || execution.tickSpacing > 32767 ||
      ![execution.decimals0, execution.decimals1].every(d => Number.isInteger(d) && d >= 0 && d <= 36) ||
      !/^\d+$/.test(execution.liquidityRaw) || !/^\d+$/.test(execution.sqrtPriceX96)) return null;
  try {
    const liquidity = new D(execution.liquidityRaw), q = new D(execution.sqrtPriceX96);
    if (liquidity.lte(0) || liquidity.gte(new D(2).pow(128)) || q.lte(0) || q.gte(new D(2).pow(160))) return null;
    const sqrt = q.div(new D(2).pow(96));
    const tickSqrt = new D("1.0001").pow(execution.tick).sqrt();
    // slot0 may retain the preceding tick at an exact crossed boundary.
    if (sqrt.lt(tickSqrt) || sqrt.gt(new D("1.0001").pow(execution.tick + 1).sqrt())) return null;
    const actualPrice = sqrt.pow(2).mul(new D(10).pow(execution.decimals0 - execution.decimals1));
    if (actualPrice.div(state.pairPrice).sub(1).abs().gt("0.00000001")) return null;
    const lowerTick = Math.max(-887272, Math.floor(execution.tick / execution.tickSpacing) * execution.tickSpacing);
    const upperTick = Math.min(887272, (Math.floor(execution.tick / execution.tickSpacing) + 1) * execution.tickSpacing);
    const lower = new D("1.0001").pow(lowerTick).sqrt(), upper = new D("1.0001").pow(upperTick).sqrt();
    if (sqrt.lt(lower) || sqrt.gt(upper)) return null;
    const units = new D(notionalUsd).div(referenceUsd).mul(new D(10).pow(targetIs0 ? execution.decimals1 : execution.decimals0)).ceil();
    // Include the whole input (fees only reduce actual movement), then reject any tick-spacing crossing.
    const next = targetIs0 ? sqrt.plus(units.div(liquidity)) : liquidity.mul(sqrt).div(liquidity.plus(units.mul(sqrt)));
    if (next.lte(lower) || next.gte(upper)) return null;
    const impact = (targetIs0 ? next.div(sqrt).pow(2) : sqrt.div(next).pow(2)).sub(1).abs().toNumber();
    return Number.isFinite(impact) ? { impact, method: "V3_CURRENT_RANGE_SPOT" } : null;
  } catch { return null; }
}

// Bounded paths terminate in independent address-approved USD anchors. Deposited custody
// establishes the liquidity floor; current executable state independently proves impact.
export function derivePriceGraph(targetPool: Pool, token: Token, pools: Pool[],
  anchors: PriceRecord[], now: number, policy: CrossAssetPricePolicy): EvidencedPrice[] {
  const maxHops = policy.maxHops ?? 2, notionalUsd = policy.notionalUsd ?? 1000,
    maxImpact = policy.maxPriceImpact ?? 0.01;
  if (!Number.isFinite(now) || !Number.isInteger(maxHops) || maxHops < 1 || maxHops > 8 ||
      !Number.isFinite(notionalUsd) || notionalUsd <= 0 || !Number.isFinite(maxImpact) || maxImpact <= 0 || maxImpact > 1 ||
      !Number.isFinite(policy.minimumLiquidityUsd) || policy.minimumLiquidityUsd <= 0 ||
      !Number.isFinite(policy.maxAgeMs) || policy.maxAgeMs <= 0 ||
      !Number.isFinite(policy.maxAlignmentMs) || policy.maxAlignmentMs < 0 ||
      !Number.isInteger(policy.maxPools) || policy.maxPools <= 0 ||
      !Number.isInteger(policy.maxDerivations) || policy.maxDerivations <= 0) return [];
  const chain = targetPool.chain, normalize = (a: string) => normalizedAddress(chain, a);
  const approved = (policy.approvedReferences ?? approvedReferenceAssets)[chain] ?? [];
  const fresh = (at: number | null) => at !== null && Number.isFinite(at) && at > 0 && at <= now + 30000 && now - at <= policy.maxAgeMs;
  const direct = independentEvidence(anchors.filter(r => r.chain === chain && !isDerivedPrice(r) &&
    !priceLineage(r).some(s => s.startsWith("Cross-pool USD")) &&
    approved.some(a => normalize(a) === normalize(r.assetAddress)) && fresh(r.sourceTimestamp) && fresh(r.observedAt)));
  const candidates = pools.slice(0, policy.maxPools).filter(p => p.chain === chain &&
    p.id !== targetPool.id && normalize(p.poolAddress) !== normalize(targetPool.poolAddress));
  const adjacent = new Map<string, Pool[]>();
  for (const pool of candidates) for (const address of [normalize(pool.token0Address), normalize(pool.token1Address)]) {
    const edges = adjacent.get(address) ?? [];
    edges.push(pool); adjacent.set(address, edges);
  }
  let examined = 0;
  type Quote = { price: number; anchor: PriceRecord; path: PriceDerivationHop[]; timestamps: number[]; observed: number[] };
  const walk = (address: string, remaining: number, visited: Set<string>, usedPools: Set<string>): Quote[] => {
    if (visited.has(address)) return [];
    const seen = new Set(visited).add(address);
    const quotes: Quote[] = direct.filter(r => normalize(r.assetAddress) === address).map(r => ({
      price: r.priceUsd, anchor: r, path: [], timestamps: [r.sourceTimestamp!], observed: [r.observedAt],
    }));
    if (!remaining) return quotes;
    for (const pool of adjacent.get(address) ?? []) {
      // Bound dense graphs even when a larger hop limit is explicitly configured.
      if (++examined > policy.maxPools * maxHops * 4) return quotes;
      const poolKey = normalize(pool.poolAddress), state = pool.pairState;
      if (usedPools.has(poolKey) || !state || !Number.isFinite(state.pairPrice) || state.pairPrice <= 0 ||
          !fresh(state.sourceTimestamp) || !fresh(state.observedAt) || !fresh(state.liquiditySourceTimestamp)) continue;
      const a0 = normalize(state.token0Address), a1 = normalize(state.token1Address);
      const canonical = [normalize(pool.token0Address), normalize(pool.token1Address)];
      if (a0 === a1 || !canonical.includes(a0) || !canonical.includes(a1)) continue;
      const referenceAddress = address === a0 ? a1 : address === a1 ? a0 : null;
      if (!referenceAddress || seen.has(referenceAddress)) continue;
      const amount = address === a0 ? state.depositedToken1Amount : state.depositedToken0Amount;
      if (amount == null || !Number.isFinite(amount) || amount <= 0) continue;
      for (const reference of walk(referenceAddress, remaining - 1, seen, new Set(usedPools).add(poolKey))) {
        const timestamps = [...reference.timestamps, state.sourceTimestamp, state.liquiditySourceTimestamp];
        if (Math.max(...timestamps) - Math.min(...timestamps) > policy.maxAlignmentMs) continue;
        const deposited = amount * reference.price, impact = notionalUsd / deposited;
        if (!Number.isFinite(deposited) || deposited < policy.minimumLiquidityUsd || impact > maxImpact) continue;
        const price = address === a0 ? state.pairPrice * reference.price : reference.price / state.pairPrice;
        if (!Number.isFinite(price) || price <= 0) continue;
        const executable = executionImpact(state, address === a0, reference.price, price, notionalUsd);
        if (!executable || executable.impact > maxImpact) continue;
        quotes.push({ price, anchor: reference.anchor, timestamps, observed: [...reference.observed, state.observedAt],
          path: [{ poolId: pool.id, poolAddress: pool.poolAddress, source: state.source, blockNumber: state.blockNumber,
            assetAddress: address, referenceAddress, pairPrice: state.pairPrice, sourceTimestamp: state.sourceTimestamp,
            observedAt: state.observedAt, liquiditySourceTimestamp: state.liquiditySourceTimestamp,
            referenceDepositUsd: deposited, notionalReserveRatio: impact,
            priceImpact: executable.impact, impactMethodology: executable.method }, ...reference.path] });
        if (quotes.length >= policy.maxDerivations) return quotes;
      }
    }
    return quotes;
  };
  return walk(normalize(token.address), maxHops, new Set(), new Set()).filter(q => q.path.length)
    .slice(0, policy.maxDerivations).map(q => ({ chain, assetAddress: normalize(token.address), symbol: token.symbol,
      priceUsd: q.price, source: `Cross-pool USD (${q.path.map(p => p.poolAddress).join(" -> ")}; ${q.anchor.source})`,
      sourceTimestamp: Math.min(...q.timestamps), observedAt: Math.min(...q.observed), blockNumber: q.path[0].blockNumber,
      confidence: minConfidence(q.anchor.confidence, "MEDIUM"), provenance: { kind: "CROSS_POOL",
        sources: [...priceLineage(q.anchor), ...q.path.map(p => `${p.source}:${p.poolAddress}`)],
        poolId: q.path[0].poolId, poolAddress: q.path[0].poolAddress, referenceAddress: q.anchor.assetAddress,
        referencePriceUsd: q.anchor.priceUsd, referenceSourceTimestamp: q.anchor.sourceTimestamp!,
        referenceObservedAt: q.anchor.observedAt, depositedLiquidityUsd: Math.min(...q.path.map(p => p.referenceDepositUsd)),
        path: q.path } }));
}
