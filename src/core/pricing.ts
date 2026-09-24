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
  const usable = records.filter(
    (r) => r.sourceTimestamp !== null && (r.confidence === "HIGH" || r.confidence === "MEDIUM"),
  );
  if (!usable.length)
    return { medianPrice: null, maxDeviationPct: null, sourceCount: 0, confidence: "UNAVAILABLE" as Confidence };
  const values = usable.map((r) => r.priceUsd).sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  const medianPrice = values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
  const maxDeviationPct = Math.max(...values.map((p) => Math.abs(p / medianPrice - 1) * 100));
  const sourceCount = new Set(usable.map((r) => r.source)).size;
  const confidence: Confidence = maxDeviationPct > mediumDeviationPct
    ? "UNAVAILABLE"
    : sourceCount >= 2 && maxDeviationPct <= highDeviationPct && usable.every((r) => r.confidence === "HIGH")
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
  let confidence = record.confidence;
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
