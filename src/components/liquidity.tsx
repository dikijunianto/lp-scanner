import type { Pool } from "@/core/model";
import { reliableLiquidity } from "@/core/liquidity";
import { usd } from "./format";
export function LiquidityValue({ pool, now }: { pool: Pool; now: number }) {
  const available = reliableLiquidity(pool, now);
  return (
    <div title={pool.activeLiquidityReason}>
      <span>{available ? usd(pool.activeLiquidityUsd) : "Unavailable"}</span>
      <small className="liquidity-provenance">
        {available
          ? `${pool.activeLiquiditySource} · ${pool.activeLiquidityConfidence}`
          : "UNAVAILABLE"}
      </small>
    </div>
  );
}
export function LiquidityProvenance({ pool, now }: { pool: Pool; now: number }) {
  const d = pool.activeLiquidityDetails,
    available = reliableLiquidity(pool, now);
  return (
    <section className="panel">
      <div className="eyebrow">ACTIVE LIQUIDITY PROVENANCE</div>
      <h2>
        <LiquidityValue pool={pool} now={now} />
      </h2>
      <p>
        {available
          ? pool.activeLiquidityReason
          : pool.activeLiquidityReason || "No verified liquidity observation"}
      </p>
      {d && (
        <>
          <dl className="addresses">
            <dt>Method</dt>
            <dd>{d.method}</dd>
            <dt>State</dt>
            <dd>
              {d.rpcSource} · {d.method === "DLMM_ACTIVE_BIN_V1" ? "slot" : "block"} {d.block}
            </dd>
            <dt>Updated</dt>
            <dd>
              {new Date(d.blockTime).toLocaleString()}
              {!available ? " (historical evidence; excluded from current ratios)" : ""}
            </dd>
            <dt>Location</dt>
            <dd>
              {d.activeBinId != null
                ? `Active bin ${d.activeBinId}, bin step ${d.binStep}`
                : `Current tick ${d.tick}, tick spacing ${d.tickSpacing}`}
            </dd>
            <dt>Token 0</dt>
            <dd>
              {d.token0Address} · decimals {d.decimals0} · amount {d.amount0}
            </dd>
            <dt>Token 1</dt>
            <dd>
              {d.token1Address} · decimals {d.decimals1} · amount {d.amount1}
            </dd>
            <dt>USD prices</dt>
            <dd>
              {usd(d.price0Usd)} / {usd(d.price1Usd)} · {d.priceSource}
            </dd>
            <dt>Price observed</dt>
            <dd>
              {new Date(d.priceObservedAt).toLocaleString()} · publication times are listed in
              Economic Data Quality
            </dd>
          </dl>
          <p>
            {d.method === "DLMM_ACTIVE_BIN_V1"
              ? "USD = active-bin token X amount × USD price X + active-bin token Y amount × USD price Y. Amounts use on-chain mint decimals; protocol fees and limit orders are excluded."
              : "s = sqrtPriceX96 / 2^96. Virtual amounts: X = L / s / 10^decimals0; Y = L × s / 10^decimals1. USD = X × USD price0 + Y × USD price1. Virtual reserves can exceed TVL; this is a depth estimate, not withdrawable capital."}
          </p>
        </>
      )}
      <p className="muted">
        Pool-wide historical fees and volume / current liquidity are activity ratios, not position
        yields. DLMM active-bin capital and V3 virtual reserves use different denominators; compare
        within the same methodology. Missing, expired, or zero denominators produce no ratio.
      </p>
    </section>
  );
}
