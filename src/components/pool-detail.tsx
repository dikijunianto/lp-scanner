"use client";
import { expireLiquidity } from "@/core/analytics";
import { LiquidityProvenance } from "./liquidity";
import Link from "next/link";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import type { Snapshot, Candle } from "@/core/model";
import { windows } from "@/core/model";
import type { simulateRanges } from "@/core/analytics";
import { Score } from "./dashboard";
import { useData } from "./use-data";
import { WatchButton } from "./watch-button";
import { age, usd, price, number, percent, efficiency, multiple } from "./format";
interface DetailData extends Snapshot {
  history: Snapshot[];
  candles: Candle[];
  candleError: string | null;
  ranges: ReturnType<typeof simulateRanges>;
}
export function PoolDetail({ id }: { id: string }) {
  const { data, error, observedAt, refresh } = useData<DetailData>(
    `/api/pools/${encodeURIComponent(id)}`,
    60000,
  );
  if (!data)
    return (
      <div className="empty">
        <h1>{error ? "Pool unavailable" : "Loading pool history…"}</h1>
        <p>{error ?? "Fetching observed data and historical candles."}</p>
        <button onClick={refresh}>Retry</button> <Link href="/">Back to scanner</Link>
      </div>
    );
  const { pool: p, metrics: m, history, candles, ranges } = expireLiquidity(data, observedAt);
  return (
    <>
      <Link className="back" href="/">
        ← All pools
      </Link>
      <section className="detail-heading">
        <div>
          <div className="eyebrow">
            {p.chain.toUpperCase()} / {p.dex.toUpperCase()}
          </div>
          <h1>{p.pair}</h1>
          <WatchButton poolId={p.id} />
          <div className="badges">
            {m.badges.map((b) => (
              <span className="badge" key={b}>
                {b}
              </span>
            ))}
          </div>
        </div>
        <div className="spot-price">
          <span>CURRENT PAIR PRICE</span>
          <strong>{price(p.price)}</strong>
          <small>{p.priceUnit}</small>
        </div>
      </section>
      {error && (
        <div role="alert" className="warning">
          {error}
        </div>
      )}
      <div className="notice">
        Observed {new Date(p.timestamp).toLocaleString()} · {p.source} ·{" "}
        {observedAt - p.timestamp > 180000
          ? "STALE — source has not refreshed recently"
          : "Source observation time, not a guaranteed block timestamp"}
      </div>
      <section className="stats">
        <Metric label="TVL" value={usd(p.tvlUsd)} />
        <Metric label="ACTIVE LIQUIDITY" value={usd(p.activeLiquidityUsd)} />
        <Metric label="FEE EFFICIENCY 1H" value={efficiency(m.feeEfficiency1h)} />
        <Metric label="CAPITAL TURNOVER 1H" value={multiple(m.capitalTurnover1h)} />
      </section>
      <LiquidityProvenance pool={p} now={observedAt} />
      <section className="panel">
        <div className="eyebrow">ECONOMIC DATA QUALITY</div>
        <div className="facts">
          <Metric label="DATA CONFIDENCE" value={m.dataQuality ?? "UNAVAILABLE"} />
          <Metric label="PRICE CONFIDENCE" value={m.priceConfidence ?? "UNAVAILABLE"} />
          <Metric label="LIQUIDITY CONFIDENCE" value={m.liquidityConfidence ?? "UNAVAILABLE"} />
          <Metric label="FEE CONFIDENCE" value={m.feeConfidence ?? "UNAVAILABLE"} />
        </div>
        {[p.token0, p.token1].map((token) => (
          <p key={token.address} className="muted">
            {token.symbol}: {usd(token.usdPrice)} ·{" "}
            {token.usdPriceSource ?? "Price source unavailable"} · publication{" "}
            {token.usdPriceSourceTimestamp
              ? new Date(token.usdPriceSourceTimestamp).toLocaleString()
              : "unknown"}{" "}
            · observed{" "}
            {token.usdPriceObservedAt
              ? new Date(token.usdPriceObservedAt).toLocaleString()
              : "unknown"}{" "}
            · confidence {token.usdPriceConfidence ?? "UNAVAILABLE"}
            {token.priceSourceCount ? ` · ${token.priceSourceCount} independent source${token.priceSourceCount === 1 ? "" : "s"}` : ""}
            {token.priceMaxDeviationPct != null ? ` · max deviation ${token.priceMaxDeviationPct.toFixed(2)}%` : ""}
            {token.priceConsensusConfidence ? ` · consensus ${token.priceConsensusConfidence}` : ""}
          </p>
        ))}
      </section>
      <section className="panel">
        <div className="eyebrow">BOUNDED LIQUIDITY DEPTH</div>
        <div className="facts">
          <Metric label="DEPTH ±1%" value={usd(p.depth1PctUsd ?? null)} />
          <Metric label="DEPTH ±2.5%" value={usd(p.depth2_5PctUsd ?? null)} />
          <Metric label="DEPTH ±5%" value={usd(p.depth5PctUsd ?? null)} />
          <Metric label="DEPTH ±10%" value={usd(p.depth10PctUsd ?? null)} />
          <Metric
            label="ACTIVE LIQUIDITY EFFICIENCY 1H / 24H"
            value={`${efficiency(m.feeEfficiency1h)} / ${efficiency(m.feeEfficiency24h)}`}
          />
          <Metric
            label="BOUNDED ±5% DEPTH EFFICIENCY 1H / 24H"
            value={`${efficiency(m.feeEfficiencyDepth1h ?? null)} / ${efficiency(m.feeEfficiencyDepth24h ?? null)}`}
          />
          <Metric
            label="VOLUME / ±5% DEPTH 1H / 24H"
            value={`${multiple(m.volumeDepthRatio1h ?? null)} / ${multiple(m.volumeDepthRatio24h ?? null)}`}
          />
        </div>
        <p className="muted">
          {p.depthSource ?? "Depth unavailable"} · {p.depthConfidence ?? "UNAVAILABLE"} ·
          {p.depthUpdatedAt
            ? ` ${new Date(p.depthUpdatedAt).toLocaleString()}`
            : " no completed observation"}
          . Depth measures nearby actual bins or directional V3 inventory, not total TVL.
        </p>
      </section>
      <section className="panel">
        <div className="eyebrow">MEASURED FEE WINDOWS</div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>WINDOW</th>
                <th>VOLUME</th>
                <th>FEES</th>
                <th>SOURCE</th>
                <th>CONFIDENCE</th>
                <th>THROUGH</th>
              </tr>
            </thead>
            <tbody>
              {windows.map((window) => {
                const fee = p.feeWindows?.[window];
                return (
                  <tr key={window}>
                    <td>{window}</td>
                    <td>{usd(fee?.volumeUsd ?? null)}</td>
                    <td>{usd(fee?.feesUsd ?? null)}</td>
                    <td>{fee?.methodology ?? "UNAVAILABLE"}</td>
                    <td>{fee?.confidence ?? "UNAVAILABLE"}</td>
                    <td>{fee ? new Date(fee.windowEnd).toLocaleTimeString() : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="muted">
          EVM fees use swap input volume × immutable pool fee tier. PancakeSwap subtracts the
          protocol fee emitted in each swap; Uniswap reports gross pool fees because its Swap event
          omits the historical protocol share. Windows remain unavailable until contiguous confirmed
          blocks and USD prices cover them.
        </p>
      </section>
      <section className="bottom-grid">
        <div className="panel">
          <div className="score-heading">
            <h2>Activity</h2>
            <Score value={m.activity} coverage={m.activityCoverage} />
          </div>
          <p>{m.activityPattern} · Not expected return.</p>
          <ul>
            {m.activityReasons.length ? (
              m.activityReasons.map((r) => <li key={r}>{r}</li>)
            ) : (
              <li>No elevated activity signals with available data.</li>
            )}
          </ul>
          <p className="muted">
            Fixed weights: efficiency 25, turnover 20, volume acceleration 15, fee acceleration 15,
            swaps 10, unique traders 10, consistency 5. Missing inputs earn no points; available
            weights determine coverage.
          </p>
        </div>
        <div className="panel risk-panel">
          <div className="score-heading">
            <h2>Risk warnings</h2>
            <Score value={m.risk} coverage={m.riskCoverage} risk />
          </div>
          <ul>
            {m.riskReasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          <p className="muted">
            Higher = more observed risk. Includes up to 35 uncertainty points for missing checks.
            Not a safety assessment.
          </p>
        </div>
      </section>
      <section className="panel">
        <div className="eyebrow">MULTI-TIMEFRAME OBSERVATIONS</div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>METRIC</th>
                {windows.map((w) => (
                  <th key={w}>{w.toUpperCase()}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Volume (USD)</td>
                {windows.map((w) => (
                  <td key={w}>{usd(p[`volume${w}`])}</td>
                ))}
              </tr>
              <tr>
                <td>Fees (USD)</td>
                {windows.map((w) => (
                  <td key={w}>{usd(p[`fees${w}`])}</td>
                ))}
              </tr>
              <tr>
                <td>Pair price change</td>
                {windows.map((w) => (
                  <td key={w}>{percent(p[`priceChange${w}`])}</td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
        <p className="muted">
          — means unavailable. Rolling activity is not guaranteed APR. Subgraph metrics, when used,
          cover completed UTC hours.
        </p>
        <div className="facts">
          <Metric label="FEE EFFICIENCY 24H" value={efficiency(m.feeEfficiency24h)} />
          <Metric label="TURNOVER 24H" value={multiple(m.capitalTurnover24h)} />
          <Metric label="VOLUME / TVL 24H" value={multiple(m.tvlTurnover)} />
          <Metric label="FEE ACCELERATION" value={multiple(m.feeAcceleration)} />
          <Metric label="VOLUME ACCELERATION" value={multiple(m.volumeAcceleration)} />
          <Metric label="SWAP ACCELERATION" value={multiple(m.swapAcceleration)} />
          <Metric
            label="VOLATILITY 1H / 24H"
            value={`${percent(p.realizedVolatility1h)} / ${percent(p.realizedVolatility24h)}`}
          />
          <Metric label="TVL CHANGE 30M" value={percent(m.tvlChange30m)} />
          <Metric label="ACTIVE LIQ Δ 30M" value={percent(m.activeLiquidityChange30m)} />
        </div>
      </section>
      <section className="chart-grid">
        <Chart
          title="Pair price · completed 5m candles"
          rows={candles.map((c) => ({ time: c.timestamp, value: c.close }))}
        />
        <Chart
          title="Volume · rolling 1h USD"
          rows={history.map((s) => ({ time: s.pool.timestamp, value: s.pool.volume1h }))}
        />
        <Chart
          title="Fees · rolling 1h USD"
          rows={history.map((s) => ({ time: s.pool.timestamp, value: s.pool.fees1h }))}
        />
        <Chart
          title="Active liquidity · USD"
          rows={history.map((s) => ({ time: s.pool.timestamp, value: s.pool.activeLiquidityUsd }))}
        />
        <Chart
          title="Fee efficiency · 1h ratio"
          rows={history.map((s) => ({ time: s.pool.timestamp, value: s.metrics.feeEfficiency1h }))}
        />
        <Chart
          title="Total liquidity · USD"
          rows={history.map((s) => ({ time: s.pool.timestamp, value: s.pool.tvlUsd }))}
        />
      </section>
      <section className="panel">
        <div className="eyebrow">READ-ONLY RANGE LAB</div>
        <h2>Historical simulation, not a prediction.</h2>
        <p>
          Fixed bands around today’s pair price, tested against available completed 5-minute
          candles. A candle counts inside only if its entire high–low range fits.
        </p>
        {data.candleError && (
          <div className="warning">
            Candles unavailable: {data.candleError}. Any retained candles below may be stale.
          </div>
        )}
        {ranges.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  {[
                    "RANGE",
                    "LOWER",
                    "UPPER",
                    "CANDLES INSIDE",
                    "MEAN OBSERVED RUN",
                    "LONGEST RUN",
                    "EXITS / TRANSITIONS",
                    "CONCENTRATION PROXY",
                  ].map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ranges.map((r) => (
                  <tr key={r.width}>
                    <td>±{r.width * 100}%</td>
                    <td>{price(r.lower)}</td>
                    <td>{price(r.upper)}</td>
                    <td>{number(r.insidePercent)}%</td>
                    <td>{number(r.meanObservedRunMinutes)} min</td>
                    <td>{r.longestObservedRunMinutes} min</td>
                    <td>
                      {r.exitCount} ·{" "}
                      {r.exitFrequency === null ? "—" : `${number(r.exitFrequency * 100)}%`}
                    </td>
                    <td>{multiple(r.relativeConcentration)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty">
            Historical candles unavailable. No simulated result is fabricated.
          </div>
        )}
        <p className="muted">
          {candles.length} candles
          {candles.length
            ? ` · ${new Date(candles[0].timestamp).toLocaleString()} to ${new Date(candles.at(-1)!.timestamp + 300000).toLocaleString()}`
            : ""}
          . Gaps break runs. Runs at data boundaries are censored; average observed runs are not
          expected survival times. Concentration is a continuous V3 geometry proxy versus full
          range, not a DLMM bin or executable position estimate. No fee, loss, slippage or gas
          projection.
        </p>
      </section>
      <section className="panel">
        <div className="eyebrow">POOL METADATA</div>
        <div className="facts">
          <Metric label="POOL AGE" value={age(p.poolAge)} />
          <Metric label="TOKEN AGE" value={age(p.tokenAge)} />
          <Metric label="FEE RATE" value={efficiency(p.feeTier)} />
          <Metric
            label="BIN STEP / TICK SPACING"
            value={`${number(p.binStep)} / ${number(p.tickSpacing)}`}
          />
          <Metric label="SWAPS 1H" value={number(p.swapCount)} />
          <Metric label="UNIQUE TRADERS 1H" value={number(p.uniqueTraderCount)} />
        </div>
        <dl className="addresses">
          <dt>Pool</dt>
          <dd>{p.poolAddress}</dd>
          <dt>{p.token0.symbol}</dt>
          <dd>{p.token0Address}</dd>
          <dt>{p.token1.symbol}</dt>
          <dd>{p.token1Address}</dd>
        </dl>
      </section>
    </>
  );
}
function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
function Chart({ title, rows }: { title: string; rows: { time: number; value: number | null }[] }) {
  const usable = rows.filter((r) => r.value !== null).length;
  return (
    <div className="panel chart">
      <h3>{title}</h3>
      {usable > 1 ? (
        <div
          style={{ height: 210, width: "100%" }}
          role="img"
          aria-label={`${title}, ${usable} historical observations`}
        >
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={rows}>
              <CartesianGrid stroke="#242c31" vertical={false} />
              <XAxis
                dataKey="time"
                tickFormatter={(v) =>
                  new Date(v).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                }
                minTickGap={65}
                stroke="#697980"
                fontSize={10}
              />
              <YAxis
                stroke="#697980"
                fontSize={10}
                width={65}
                tickFormatter={(v) =>
                  new Intl.NumberFormat("en", {
                    notation: "compact",
                    maximumSignificantDigits: 3,
                  }).format(v)
                }
              />
              <Tooltip
                labelFormatter={(v) => new Date(Number(v)).toLocaleString()}
                contentStyle={{
                  background: "#151d23",
                  border: "1px solid #36434c",
                  borderRadius: 8,
                }}
              />
              <Line
                dataKey="value"
                stroke="#91f2bd"
                strokeWidth={2}
                dot={false}
                connectNulls={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="chart-empty">
          {usable ? "Collecting more observations…" : "No available data for this metric"}
        </div>
      )}
    </div>
  );
}
