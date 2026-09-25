import { reliableLiquidity } from "./liquidity";
import { minConfidence } from "./pricing";
import {
  type Pool,
  type Metrics,
  type Snapshot,
  type Nullable,
  type Candle,
  windows,
  windowMs,
} from "./model";
export const ratio = (a: Nullable, b: Nullable): Nullable =>
  a !== null && b !== null && Number.isFinite(a) && Number.isFinite(b) && b > 0
    ? Number.isFinite(a / b)
      ? a / b
      : null
    : null;
export const change = (current: Nullable, previous: Nullable): Nullable => {
  const r = ratio(current, previous);
  return r === null ? null : (r - 1) * 100;
};
export function enrichHistory(pool: Pool, history: Pool[], candles: Candle[] = []): Pool {
  history = history.filter(
    (h) =>
      h.token0Address === pool.token0Address &&
      h.token1Address === pool.token1Address &&
      h.source === pool.source,
  );
  const p = { ...pool };
  for (const w of windows) {
    if (p[`priceChange${w}`] !== null) continue;
    const target = p.timestamp - windowMs[w];
    const old = history
      .filter((h) => h.timestamp <= target && target - h.timestamp <= 120000)
      .at(-1);
    if (old) p[`priceChange${w}`] = change(p.price, old.price);
  }
  for (const [w, key] of [
    ["1h", "realizedVolatility1h"],
    ["24h", "realizedVolatility24h"],
  ] as const) {
    const slice = candles.filter(
      (c) =>
        c.timestamp >= p.timestamp - windowMs[w] - 300000 && c.timestamp + 300000 <= p.timestamp,
    );
    p[key] = realizedVolatility(slice, windowMs[w]);
  }
  return p;
}
export function realizedVolatility(candles: Candle[], duration: number): Nullable {
  const expected = duration / 300000;
  if (
    candles.length < expected ||
    !candles.every((c, i) => i === 0 || c.timestamp - candles[i - 1].timestamp === 300000)
  )
    return null;
  const rows = candles.slice(-expected);
  const returns = rows.map((c, i) => Math.log(c.close / (i ? rows[i - 1].close : c.open)));
  return Math.sqrt(returns.reduce((n, r) => n + r * r, 0)) * 100;
}
export function analyze(
  pool: Pool,
  history: Pool[],
  options = { surgeMultiplier: 3, minHourlyFees: 10 },
): Metrics {
  history = history.filter(
    (h) =>
      h.token0Address === pool.token0Address &&
      h.token1Address === pool.token1Address &&
      h.source === pool.source,
  );
  const activeLiquidity = reliableLiquidity(pool, pool.timestamp) ? pool.activeLiquidityUsd : null;
  const priceConfidence = minConfidence(
    pool.token0.usdPriceConfidence ?? "UNAVAILABLE",
    pool.token1.usdPriceConfidence ?? "UNAVAILABLE",
  );
  const liquidityConfidence =
    activeLiquidity === null ? "UNAVAILABLE" : pool.activeLiquidityConfidence;
  const feeConfidence =
    pool.feeConfidence === "UNAVAILABLE" && pool.chain === "solana" && pool.fees1h !== null
      ? "MEDIUM"
      : (pool.feeConfidence ?? "UNAVAILABLE");
  const depth5 =
    pool.depth5PctUsd !== null &&
    pool.depth5PctUsd !== undefined &&
    ["HIGH", "MEDIUM"].includes(pool.depthConfidence ?? "UNAVAILABLE") &&
    pool.depthExpiresAt != null &&
    pool.timestamp <= pool.depthExpiresAt
      ? pool.depth5PctUsd
      : null;
  const depthFees1h =
    pool.chain === "solana"
      ? pool.fees1h
      : pool.feeWindows?.["1h"]?.methodology === "EVENT_DERIVED"
        ? pool.feeWindows["1h"].feesUsd
        : null;
  const depthFees24h =
    pool.chain === "solana"
      ? pool.fees24h
      : pool.feeWindows?.["24h"]?.methodology === "EVENT_DERIVED"
        ? pool.feeWindows["24h"].feesUsd
        : null;
  const depthVolume1h =
    pool.chain === "solana"
      ? pool.volume1h
      : pool.feeWindows?.["1h"]?.methodology === "EVENT_DERIVED"
        ? pool.feeWindows["1h"].volumeUsd
        : null;
  const depthVolume24h =
    pool.chain === "solana"
      ? pool.volume24h
      : pool.feeWindows?.["24h"]?.methodology === "EVENT_DERIVED"
        ? pool.feeWindows["24h"].volumeUsd
        : null;
  const dataQuality = minConfidence(
    priceConfidence,
    liquidityConfidence,
    feeConfidence,
    depth5 === null ? "UNAVAILABLE" : (pool.depthConfidence ?? "UNAVAILABLE"),
  );
  const feeEfficiency1h = ratio(pool.fees1h, activeLiquidity),
    feeEfficiency24h = ratio(pool.fees24h, activeLiquidity);
  const capitalTurnover1h = ratio(pool.volume1h, activeLiquidity),
    capitalTurnover24h = ratio(pool.volume24h, activeLiquidity);
  const feeAcceleration = ratio(pool.fees1h, pool.fees24h === null ? null : pool.fees24h / 24);
  const volumeAcceleration = ratio(
    pool.volume1h,
    pool.volume24h === null ? null : pool.volume24h / 24,
  );
  const old = history
    .filter(
      (h) => h.timestamp <= pool.timestamp - 1800000 && h.timestamp >= pool.timestamp - 1920000,
    )
    .at(-1);
  const feeSurge = old ? ratio(pool.fees1h, old.fees1h) : null,
    volumeSurge = old ? ratio(pool.volume1h, old.volume1h) : null;
  const swapAcceleration = old ? ratio(pool.swapCount, old.swapCount) : null;
  const tvlChange30m = old ? change(pool.tvlUsd, old.tvlUsd) : null,
    activeLiquidityChange30m =
      old &&
      reliableLiquidity(old, old.timestamp) &&
      old.activeLiquidityDetails?.method === pool.activeLiquidityDetails?.method
        ? change(activeLiquidity, old.activeLiquidityUsd)
        : null;
  const changes = [pool.priceChange30m, pool.priceChange1h, pool.priceChange4h];
  let trend: Metrics["trend"] = "UNKNOWN";
  if (changes.every((v) => v !== null)) {
    const values = changes as number[];
    if (Math.abs(values[1]) >= 20 || Math.abs(values[2]) >= 35) trend = "EXTREME_MOVE";
    else if (values.every((v) => v > 1) && values[2] > 3) trend = "TRENDING_UP";
    else if (values.every((v) => v < -1) && values[2] < -3) trend = "TRENDING_DOWN";
    else if (values.every((v) => Math.abs(v) < 3)) trend = "RANGING";
  }
  const surge =
    feeSurge !== null &&
    volumeSurge !== null &&
    feeSurge >= options.surgeMultiplier &&
    volumeSurge >= options.surgeMultiplier &&
    (pool.fees1h ?? 0) >= options.minHourlyFees;
  const quietSurge = surge && trend === "RANGING";
  const activityReasons: string[] = [];
  let points = 0,
    availableWeight = 0;
  const component = (value: Nullable, target: number, weight: number, label: string) => {
    if (value === null) return;
    availableWeight += weight;
    const score = Math.min(1, Math.max(0, value / target)) * weight;
    points += score;
    if (score >= weight * 0.6) activityReasons.push(`${label}: ${value.toFixed(3)}`);
  };
  component(feeEfficiency1h, 0.01, 25, "Fee / active liquidity 1h");
  component(capitalTurnover1h, 5, 20, "Volume / active liquidity 1h");
  component(volumeAcceleration, 3, 15, "Volume rate / 24h hourly average");
  component(feeAcceleration, 3, 15, "Fee rate / 24h hourly average");
  component(pool.swapCount, 1000, 10, "Swaps in 1h");
  component(pool.uniqueTraderCount, 300, 10, "Unique traders in 1h");
  const consistency = ratio(
    pool.fees4h === null ? null : pool.fees4h / 4,
    pool.fees24h === null ? null : pool.fees24h / 24,
  );
  component(consistency, 1, 5, "4h fee rate / 24h hourly average");
  let risk = 0,
    known = 0;
  const riskReasons = [...pool.warnings];
  const riskCheck = (
    value: Nullable,
    condition: (v: number) => boolean,
    weight: number,
    reason: string,
  ) => {
    if (value === null) return;
    known++;
    if (condition(value)) {
      risk += weight;
      riskReasons.push(reason);
    }
  };
  riskCheck(pool.tvlUsd, (v) => v < 25000, 20, "Low liquidity: TVL below $25,000");
  riskCheck(pool.poolAge, (v) => v < 72, 15, `New pool: ${pool.poolAge?.toFixed(1)} hours old`);
  riskCheck(pool.tokenAge, (v) => v < 168, 15, `New token: ${pool.tokenAge?.toFixed(1)} hours old`);
  riskCheck(
    pool.realizedVolatility1h,
    (v) => v > 10,
    25,
    "High volatility: 1h realized volatility exceeds 10%",
  );
  riskCheck(
    pool.priceChange1h,
    (v) => Math.abs(v) > 20,
    25,
    `Extreme price movement: ${pool.priceChange1h?.toFixed(1)}% in 1h`,
  );
  riskCheck(
    tvlChange30m,
    (v) => v < -25,
    25,
    `TVL dropped ${Math.abs(tvlChange30m ?? 0).toFixed(1)}% in 30m`,
  );
  riskCheck(
    activeLiquidityChange30m,
    (v) => v < -25,
    25,
    "Active liquidity dropped more than 25% in 30m",
  );
  riskCheck(
    feeAcceleration,
    (v) => v > 10,
    15,
    "Abnormal fee spike: hourly rate exceeds 10× the 24h average",
  );
  for (const token of [pool.token0, pool.token1]) {
    riskCheck(
      token.holderConcentration,
      (v) => v > 0.5,
      20,
      `${token.symbol}: top-holder concentration above 50%`,
    );
    riskCheck(
      token.freezeAuthority === null ? null : Number(token.freezeAuthority),
      (v) => v === 1,
      10,
      `${token.symbol}: freeze authority remains enabled`,
    );
    riskCheck(
      token.mintAuthority === null ? null : Number(token.mintAuthority),
      (v) => v === 1,
      10,
      `${token.symbol}: mint authority remains enabled`,
    );
    riskCheck(
      token.verified === null ? null : Number(token.verified),
      (v) => v === 0,
      5,
      `${token.symbol}: provider metadata is unverified`,
    );
  }
  if (trend === "TRENDING_UP" || trend === "TRENDING_DOWN") {
    risk += 10;
    riskReasons.push("Directional trend across multiple timeframes");
  }
  if (pool.warnings.some((w) => w.includes("blacklisted"))) risk += 50;
  const riskCoverage = Math.round((known / 16) * 100);
  if (known < 16) {
    risk += Math.ceil(((16 - known) / 16) * 35);
    riskReasons.push(
      "Incomplete risk data: token age, authorities, holder distribution or market history may be unknown",
    );
  }
  if (pool.chain !== "solana")
    riskReasons.push(
      "Transfer restrictions, buy/sell taxes and verified contract source are not checked",
    );
  if (activeLiquidity === null)
    riskReasons.push(
      "Active liquidity unavailable; capital efficiency and price impact cannot be assessed",
    );
  if (activeLiquidity !== null)
    riskReasons.push(
      pool.activeLiquiditySource === "ESTIMATED"
        ? "Active liquidity is a virtual-reserve depth estimate, not deposited capital. Fee and turnover ratios are not yields and are not directly comparable to DLMM active-bin ratios."
        : "Pool-wide historical fees and volume are divided by current active-bin capital; bins and active liquidity change over time. Ratios are not position returns.",
    );
  let activityPattern = "INSUFFICIENT HISTORY";
  if (surge) activityPattern = "FRESH ACTIVITY SURGE";
  else if (
    pool.fees30m !== null &&
    pool.fees1h !== null &&
    pool.fees4h !== null &&
    pool.fees24h !== null
  ) {
    const recent = ratio(pool.fees30m * 2, pool.fees1h),
      sustained = ratio(pool.fees4h / 4, pool.fees24h / 24);
    if (recent !== null && recent < 0.3 && (feeAcceleration ?? 0) > 2)
      activityPattern = "FADING SPIKE";
    else if (recent !== null && recent >= 0.7 && recent <= 1.5 && (sustained ?? 0) >= 1)
      activityPattern = "SUSTAINED ACTIVITY";
    else activityPattern = "MIXED ACTIVITY";
  }
  const badges: string[] = [];
  if (surge) badges.push("ACTIVITY SURGE");
  if ((pool.realizedVolatility1h ?? 0) > 10) badges.push("HIGH VOLATILITY");
  if (pool.poolAge !== null && pool.poolAge < 72) badges.push("NEW POOL");
  if (pool.tokenAge !== null && pool.tokenAge < 168) badges.push("NEW TOKEN");
  if (pool.tvlUsd !== null && pool.tvlUsd < 25000) badges.push("LOW LIQUIDITY");
  if (trend !== "UNKNOWN") badges.push(trend.replaceAll("_", " "));
  if (quietSurge)
    activityReasons.push(
      "Fee and volume rates surged while measured multi-timeframe price changes stayed within ±3%; not a candle-range guarantee",
    );
  if (surge)
    activityReasons.push(
      `Hourly fees ${feeSurge!.toFixed(1)}× and volume ${volumeSurge!.toFixed(1)}× their rates 30m ago`,
    );
  if (pool.warnings.includes("PRICE_STALE")) badges.push("PRICE STALE");
  if (pool.warnings.includes("PRICE_DISAGREEMENT")) badges.push("PRICE DISAGREEMENT");
  if (Object.values(pool.feeWindows ?? {}).some((v) => v?.methodology === "EVENT_DERIVED"))
    badges.push("FEE MEASURED");
  else if (Object.values(pool.feeWindows ?? {}).some((v) => v?.methodology === "APPROXIMATED"))
    badges.push("FEE ESTIMATED");
  if (dataQuality === "LOW" || dataQuality === "UNAVAILABLE") badges.push("LOW DATA CONFIDENCE");
  return {
    feeEfficiency1h,
    feeEfficiency24h,
    capitalTurnover1h,
    capitalTurnover24h,
    tvlTurnover: ratio(pool.volume24h, pool.tvlUsd),
    feeAcceleration,
    volumeAcceleration,
    swapAcceleration,
    tvlChange30m,
    activeLiquidityChange30m,
    trend,
    surge,
    quietSurge,
    activityPattern,
    activity: availableWeight ? Math.round(points) : null,
    risk: Math.min(100, risk),
    activityCoverage: availableWeight,
    riskCoverage,
    activityReasons,
    riskReasons,
    badges,
    feeEfficiencyDepth1h: ratio(depthFees1h, depth5),
    feeEfficiencyDepth24h: ratio(depthFees24h, depth5),
    volumeDepthRatio1h: ratio(depthVolume1h, depth5),
    volumeDepthRatio24h: ratio(depthVolume24h, depth5),
    dataQuality,
    priceConfidence,
    liquidityConfidence,
    feeConfidence,
  };
}
export function snapshot(
  pool: Pool,
  history: Pool[],
  candles: Candle[] = [],
  options?: { surgeMultiplier: number; minHourlyFees: number },
): Snapshot {
  const enriched = enrichHistory(pool, history, candles);
  const metrics = analyze(enriched, history, options);
  enriched.priceConfidence = metrics.priceConfidence;
  enriched.dataQuality = metrics.dataQuality;
  enriched.feeConfidence = metrics.feeConfidence;
  return { pool: enriched, metrics };
}
export function simulateRanges(price: Nullable, candles: Candle[]) {
  if (price === null || price <= 0 || candles.length < 2) return [];
  const rows = [...new Map(candles.map((c) => [c.timestamp, c])).values()].sort(
    (a, b) => a.timestamp - b.timestamp,
  );
  return [0.025, 0.05, 0.1, 0.15].map((width) => {
    const lower = price * (1 - width),
      upper = price * (1 + width);
    let insideCount = 0,
      exits = 0,
      transitions = 0,
      run = 0,
      longest = 0,
      totalRuns = 0,
      runCount = 0;
    let previousInside: boolean | null = null;
    rows.forEach((c, i) => {
      const continuous = i > 0 && c.timestamp - rows[i - 1].timestamp === 300000;
      if (!continuous) {
        if (run) {
          totalRuns += run;
          runCount++;
          run = 0;
        }
        previousInside = null;
      }
      const inside = c.low >= lower && c.high <= upper;
      if (previousInside !== null) {
        transitions++;
        if (previousInside && !inside) exits++;
      }
      if (inside) {
        insideCount++;
        run += 5;
        longest = Math.max(longest, run);
      } else if (run) {
        totalRuns += run;
        runCount++;
        run = 0;
      }
      previousInside = inside;
    });
    if (run) {
      totalRuns += run;
      runCount++;
    }
    return {
      width,
      lower,
      upper,
      candles: rows.length,
      insidePercent: (insideCount / rows.length) * 100,
      meanObservedRunMinutes: runCount ? totalRuns / runCount : 0,
      longestObservedRunMinutes: longest,
      exitCount: exits,
      exitFrequency: transitions ? exits / transitions : null,
      relativeConcentration: 2 / (2 - Math.sqrt(1 - width) - 1 / Math.sqrt(1 + width)),
    };
  });
}

// Expire the read view only; persisted snapshots remain valid historical observations.
export function expireLiquidity<T extends Snapshot>(data: T, now: number): T {
  const depthExpired =
    data.pool.depth5PctUsd != null &&
    data.pool.depthExpiresAt != null &&
    now > data.pool.depthExpiresAt;
  const activeExpired = data.pool.activeLiquidityUsd !== null && !reliableLiquidity(data.pool, now);
  if (!activeExpired && !depthExpired) return data;
  const pool = {
    ...data.pool,
    ...(activeExpired
      ? {
          activeLiquidityUsd: null,
          activeLiquidityConfidence: "UNAVAILABLE" as const,
          activeLiquidityReason: "Stale or unverified liquidity observation",
        }
      : {}),
    ...(depthExpired
      ? {
          depth1PctUsd: null,
          depth2_5PctUsd: null,
          depth5PctUsd: null,
          depth10PctUsd: null,
          depthConfidence: "UNAVAILABLE" as const,
          depthState: "STALE" as const,
        }
      : {}),
  };
  const withoutLiquidity = analyze(pool, []);
  pool.dataQuality = withoutLiquidity.dataQuality;
  return {
    ...data,
    pool,
    metrics: {
      ...data.metrics,
      ...(activeExpired
        ? {
            feeEfficiency1h: null,
            feeEfficiency24h: null,
            capitalTurnover1h: null,
            capitalTurnover24h: null,
            activeLiquidityChange30m: null,
          }
        : {}),
      feeEfficiencyDepth1h: depthExpired ? null : data.metrics.feeEfficiencyDepth1h,
      feeEfficiencyDepth24h: depthExpired ? null : data.metrics.feeEfficiencyDepth24h,
      volumeDepthRatio1h: depthExpired ? null : data.metrics.volumeDepthRatio1h,
      volumeDepthRatio24h: depthExpired ? null : data.metrics.volumeDepthRatio24h,
      dataQuality: withoutLiquidity.dataQuality,
      liquidityConfidence: withoutLiquidity.liquidityConfidence,
      badges:
        withoutLiquidity.dataQuality === "UNAVAILABLE" &&
        !data.metrics.badges.includes("LOW DATA CONFIDENCE")
          ? [...data.metrics.badges, "LOW DATA CONFIDENCE"]
          : data.metrics.badges,
      activity: activeExpired ? withoutLiquidity.activity : data.metrics.activity,
      activityCoverage: activeExpired
        ? withoutLiquidity.activityCoverage
        : data.metrics.activityCoverage,
      activityReasons: activeExpired
        ? data.metrics.activityReasons.filter(
            (reason) =>
              !reason.startsWith("Fee / active liquidity") &&
              !reason.startsWith("Volume / active liquidity"),
          )
        : data.metrics.activityReasons,
      // Preserve historical risk and surge evidence; expiry does not erase those observations.
      riskReasons: activeExpired
        ? [
            ...data.metrics.riskReasons,
            "Active liquidity expired; current capital ratios are unavailable",
          ]
        : data.metrics.riskReasons,
    },
  };
}
