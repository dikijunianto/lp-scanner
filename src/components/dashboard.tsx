"use client";
import { expireLiquidity } from "@/core/analytics";
import { LiquidityValue } from "./liquidity";
import { reliableLiquidity } from "@/core/liquidity";
import { useState } from "react";
import Link from "next/link";
import type { Snapshot } from "@/core/model";
import type { SourceStatus } from "@/db/schema";
import { useData } from "./use-data";
import { usd, price, percent, efficiency, multiple } from "./format";
interface Run {
  id: number;
  startedAt: number;
  endedAt: number | null;
  status: string;
  data: SourceStatus[];
}
interface DashboardData {
  pools: Snapshot[];
  runs: Run[];
  settings: {
    scanInterval: number;
    retentionDays: number;
    meteoraMinTvl: number;
    meteoraMaxPools: number;
    evmPages: number;
    telegramConfigured: boolean;
  };
}
export function Score({
  value,
  coverage,
  risk = false,
}: {
  value: number | null;
  coverage: number;
  risk?: boolean;
}) {
  return (
    <div
      className={`score ${risk ? "risk" : ""}`}
      title={`${coverage}% of scoring inputs available. ${risk ? "Higher = more observed risk." : "Activity is not expected return."}`}
    >
      <b>{value ?? "—"}</b>
      <span className="score-track">
        <i style={{ width: `${value ?? 0}%` }} />
      </span>
      <small>{coverage}% data</small>
    </div>
  );
}
export function Dashboard() {
  const { data, error, observedAt, refresh } = useData<DashboardData>("/api/pools");
  const [chain, setChain] = useState("all"),
    [search, setSearch] = useState(""),
    [protocol, setProtocol] = useState("all"),
    [sort, setSort] = useState("activity");
  const [tvl, setTvl] = useState(""),
    [active, setActive] = useState(""),
    [risk, setRisk] = useState(""),
    [activity, setActivity] = useState(""),
    [tokenAge, setTokenAge] = useState(""),
    [poolAge, setPoolAge] = useState("");
  const [onlySurges, setOnlySurges] = useState(false);
  const [onlyReliable, setOnlyReliable] = useState(false);
  const pools = (data?.pools ?? []).map((s) => expireLiquidity(s, observedAt));
  const knownMin = (value: number | null, min: string) =>
    min === "" || (value !== null && value >= Number(min));
  const filtered = pools.filter(
    ({ pool: p, metrics: m }) =>
      (chain === "all" || p.chain === chain) &&
      (protocol === "all" || p.protocol === protocol) &&
      `${p.pair} ${p.poolAddress} ${p.token0Address} ${p.token1Address}`
        .toLowerCase()
        .includes(search.toLowerCase()) &&
      knownMin(p.tvlUsd, tvl) &&
      knownMin(p.activeLiquidityUsd, active) &&
      knownMin(m.activity, activity) &&
      (risk === "" || m.risk <= Number(risk)) &&
      knownMin(p.tokenAge, tokenAge) &&
      knownMin(p.poolAge, poolAge) &&
      (!onlySurges || m.surge) &&
      (!onlyReliable || reliableLiquidity(p, observedAt)),
  );
  const value = (s: Snapshot): number | null => {
    switch (sort) {
      case "risk":
        return s.metrics.risk;
      case "tvl":
        return s.pool.tvlUsd;
      case "newest":
        return s.pool.poolAge;
      case "fee1h":
        return s.metrics.feeEfficiency1h;
      case "fee24h":
        return s.metrics.feeEfficiency24h;
      case "feeDepth":
        return s.metrics.feeEfficiencyDepth1h ?? null;
      case "volumeDepth":
        return s.metrics.volumeDepthRatio1h ?? null;
      case "turnover":
        return s.metrics.capitalTurnover1h;
      case "volume":
        return s.metrics.volumeAcceleration;
      case "fees":
        return s.metrics.feeAcceleration;
      default:
        return s.metrics.activity;
    }
  };
  filtered.sort((a, b) => {
    const av = value(a),
      bv = value(b);
    if (av === null) return bv === null ? 0 : 1;
    if (bv === null) return -1;
    return sort === "risk" || sort === "newest" ? av - bv : bv - av;
  });
  const latest = data?.runs[0],
    finished = data?.runs.find((r) => r.endedAt !== null);
  const staleAfter = (data?.settings.scanInterval ?? 60) * 3000;
  const stale = finished?.endedAt ? observedAt - finished.endedAt > staleAfter : false;
  const sourceStatus = finished?.data ?? [];
  return (
    <>
      <section className="intro">
        <div>
          <div className="eyebrow">
            LIQUIDITY INTELLIGENCE <span>/</span> LOCAL MONITOR
          </div>
          <h1>
            Activity is opportunity.
            <br />
            <span>Risk is a separate question.</span>
          </h1>
          <p>Find concentrated-liquidity activity across Solana, Base and BSC.</p>
        </div>
        <div className="scan-status">
          <span className={`dot ${error || stale ? "amber" : ""}`} />
          <b>
            {error
              ? "DISCONNECTED"
              : stale
                ? "STALE DATA"
                : latest?.status === "running"
                  ? "SCANNING"
                  : finished
                    ? "SCANNER ONLINE"
                    : "INITIALIZING"}
          </b>
          <small>
            {finished?.endedAt
              ? `Last scan ${new Date(finished.endedAt).toLocaleTimeString()}`
              : "Waiting for first scan"}
          </small>
          <button className="text-button" onClick={refresh}>
            Refresh view ↻
          </button>
        </div>
      </section>
      {error && (
        <div role="alert" className="warning">
          {error}
        </div>
      )}
      <section className="stats">
        <Stat
          label="POOLS OBSERVED"
          value={String(pools.length)}
          note="Within configured discovery limits"
        />
        <Stat
          label="OBSERVED TVL"
          value={usd(pools.reduce((n, s) => n + (s.pool.tvlUsd ?? 0), 0))}
          note="Total liquidity, not active liquidity"
        />
        <Stat
          label="ACTIVITY SURGES"
          value={String(pools.filter((s) => s.metrics.surge).length)}
          note="Requires a 30-minute baseline"
        />
        <Stat
          label="OBSERVATION INTERVAL"
          value={`${data?.settings.scanInterval ?? 60}s`}
          note="Next scan starts after the prior scan"
        />
      </section>
      <section className="workspace">
        <div className="workspace-top">
          <nav className="chain-tabs" aria-label="Chain filter">
            {["all", "solana", "base", "bsc"].map((c) => (
              <button
                key={c}
                aria-pressed={chain === c}
                className={chain === c ? "selected" : ""}
                onClick={() => setChain(c)}
              >
                {c === "all" ? "ALL NETWORKS" : c.toUpperCase()}
                <small>
                  {c === "all" ? pools.length : pools.filter((s) => s.pool.chain === c).length}
                </small>
              </button>
            ))}
          </nav>
          <label
            className="surge-toggle"
            title="Fresh on-chain state, available USD pricing and price-consistency checks. MEDIUM/HIGH confidence; V3 remains an estimate."
          >
            <input
              type="checkbox"
              checked={onlyReliable}
              onChange={(e) => setOnlyReliable(e.target.checked)}
            />
            Reliable active liquidity
          </label>
          <label className="surge-toggle">
            <input
              type="checkbox"
              checked={onlySurges}
              onChange={(e) => setOnlySurges(e.target.checked)}
            />
            Surges only
          </label>
        </div>
        <div className="filters">
          <label className="search">
            PAIR OR ADDRESS
            <input
              placeholder="Search tokens or pool address…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <label>
            PROTOCOL
            <select value={protocol} onChange={(e) => setProtocol(e.target.value)}>
              <option value="all">All protocols</option>
              <option value="meteora-dlmm">Meteora DLMM</option>
              <option value="uniswap-v3">Uniswap V3</option>
              <option value="pancakeswap-v3">PancakeSwap V3</option>
            </select>
          </label>
          <label>
            SORT BY
            <select value={sort} onChange={(e) => setSort(e.target.value)}>
              {[
                ["activity", "Activity score ↓"],
                ["risk", "Risk score ↑"],
                ["fee1h", "Fee efficiency 1h ↓"],
                ["fee24h", "Fee efficiency 24h ↓"],
                ["feeDepth", "Fees / ±5% depth ↓"],
                ["volumeDepth", "Volume / ±5% depth ↓"],
                ["turnover", "Volume / active liq ↓"],
                ["volume", "Volume acceleration ↓"],
                ["fees", "Fee acceleration ↓"],
                ["tvl", "TVL ↓"],
                ["newest", "Newest pools"],
              ].map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="numeric-filters">
          {[
            { label: "Min TVL ($)", v: tvl, set: setTvl },
            { label: "Min active liq ($)", v: active, set: setActive },
            { label: "Max risk", v: risk, set: setRisk },
            { label: "Min activity", v: activity, set: setActivity },
            { label: "Min token age (h)", v: tokenAge, set: setTokenAge },
            { label: "Min pool age (h)", v: poolAge, set: setPoolAge },
          ].map((f) => (
            <label key={f.label}>
              {f.label}
              <input
                type="number"
                min="0"
                placeholder="Any"
                value={f.v}
                onChange={(e) => f.set(e.target.value)}
              />
            </label>
          ))}
        </div>
        <div className="table-caption">
          <span>
            <b>{filtered.length}</b> matching pools
          </span>
          <span>— unavailable · Score bars show observed signals · Price in quote token</span>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                {[
                  "PAIR / NETWORK",
                  "PROTOCOL",
                  "PRICE",
                  "TVL",
                  "ACTIVE LIQ.",
                  "VOLUME 1H",
                  "FEES 1H",
                  "FEE / ACTIVE",
                  "VOL / ACTIVE",
                  "PRICE Δ 1H",
                  "ACTIVITY",
                  "RISK",
                  "STATUS",
                ].map((h) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, 300).map(({ pool: p, metrics: m }) => (
                <tr key={p.id}>
                  <td>
                    <Link href={`/pool/${encodeURIComponent(p.id)}`} className="pair-link">
                      {p.pair}
                    </Link>
                    <small className="network">
                      <span className={`network-dot ${p.chain}`} />
                      {p.chain.toUpperCase()}
                      {observedAt - p.timestamp > staleAfter ? " · STALE" : ""}
                    </small>
                  </td>
                  <td>
                    <span className="protocol">{p.dex}</span>
                  </td>
                  <td title={p.priceUnit}>{price(p.price)}</td>
                  <td>{usd(p.tvlUsd)}</td>
                  <td>
                    <LiquidityValue pool={p} now={observedAt} />
                  </td>
                  <td>{usd(p.volume1h)}</td>
                  <td>{usd(p.fees1h)}</td>
                  <td>{efficiency(m.feeEfficiency1h)}</td>
                  <td>{multiple(m.capitalTurnover1h)}</td>
                  <td className={(p.priceChange1h ?? 0) < 0 ? "negative" : "positive"}>
                    {percent(p.priceChange1h)}
                  </td>
                  <td>
                    <Score value={m.activity} coverage={m.activityCoverage} />
                    <small>Confidence: {m.dataQuality ?? "UNAVAILABLE"}</small>
                  </td>
                  <td>
                    <Score value={m.risk} coverage={m.riskCoverage} risk />
                  </td>
                  <td>
                    <div className="badges">
                      {m.badges.length ? (
                        m.badges.slice(0, 2).map((b) => (
                          <span
                            key={b}
                            className={`badge ${b === "ACTIVITY SURGE" ? "green" : ""}`}
                          >
                            {b}
                          </span>
                        ))
                      ) : (
                        <span className="muted">OBSERVING</span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!filtered.length && (
          <div className="empty">
            <h2>
              {!data
                ? "Connecting to the scanner…"
                : !pools.length
                  ? "Building your first observation"
                  : "No pools match these filters"}
            </h2>
            <p>
              {!pools.length
                ? "Live pools will appear when a source completes its first scan. No sample data is shown."
                : "Unknown values are excluded when you filter that metric."}
            </p>
          </div>
        )}
        {filtered.length > 300 && (
          <p className="table-caption">
            Showing the first 300 rows. Narrow filters to inspect additional pools.
          </p>
        )}
      </section>
      <section className="bottom-grid">
        <div className="panel">
          <div className="eyebrow">SOURCE HEALTH</div>
          {sourceStatus.length ? (
            sourceStatus.map((s) => (
              <div className="source" key={s.name}>
                <div>
                  <b>{s.name}</b>
                  <span className={`badge ${s.status === "error" ? "red" : ""}`}>
                    {s.status === "degraded" ? "PARTIAL DATA" : s.status.toUpperCase()}
                  </span>
                </div>
                <p>
                  {s.pools} pools · {s.notes.join(" · ")}
                </p>
              </div>
            ))
          ) : (
            <p className="muted">Sources are initializing.</p>
          )}
        </div>
        <div className="panel">
          <div className="eyebrow">READ THE SIGNAL, NOT A PROMISE</div>
          <h2>High fees ≠ profit.</h2>
          <p>
            Activity measures observed fee generation. Risk measures warnings independently. Neither
            estimates your returns.
          </p>
          <p>
            Missing inputs reduce activity coverage and add a risk uncertainty penalty. Low scores
            with sparse data do not imply low risk.
          </p>
          <p className="muted">
            Active liquidity is never replaced by TVL. V3 virtual reserves and DLMM active bins are
            different denominators; compare within the same method. Trend metrics warm up over 4
            hours; 24h history needs a full day.
          </p>
        </div>
      </section>
    </>
  );
}
function Stat({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="stat">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{note}</small>
    </div>
  );
}
