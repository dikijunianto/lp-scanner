"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useData } from "./use-data";
import { usd, efficiency, multiple } from "./format";
import type { Snapshot } from "@/core/model";
import type { Outcome, Horizon } from "@/core/research";
import { strictSample, type CohortAggregate } from "@/core/cohorts";

const when = (time: number | null) => (time ? new Date(time).toLocaleString() : "—");
const pct = (n: number | null | undefined) => (n == null ? "—" : `${(n * 100).toFixed(1)}%`);
const num = (n: number | null | undefined, digits = 1) => (n == null ? "—" : n.toFixed(digits));
const median = (values: (number | null | undefined)[]) => {
  const valid = values
    .filter((n): n is number => n != null && Number.isFinite(n))
    .sort((a, b) => a - b);
  if (!valid.length) return null;
  const mid = Math.floor(valid.length / 2);
  return valid.length % 2 ? valid[mid] : (valid[mid - 1] + valid[mid]) / 2;
};
const pageNav = (
  <nav className="research-nav">
    <Link href="/research/signals">Signals</Link>
    <Link href="/research/summary">Summary</Link>
    <Link href="/research/coverage">Data quality</Link>
    <Link href="/diagnostics/data-health">Data health</Link>
  </nav>
);
interface SignalBrief {
  id: number;
  poolId: string;
  signalType: string;
  episodeStart: number;
  episodeLastSeen: number;
  episodeEnd: number | null;
  peakScore: number | null;
  chain: string;
  protocol: string;
  pair: string;
  activity: number | null;
  risk: number;
  confidence: string;
}
export function SignalList() {
  const { data, error } = useData<{ signals: SignalBrief[] }>("/api/research/signals", 30000);
  const [chain, setChain] = useState("all"),
    [kind, setKind] = useState("all"),
    [query, setQuery] = useState("");
  const signals = (data?.signals ?? []).filter(
    (s) =>
      (chain === "all" || s.chain === chain) &&
      (kind === "all" || s.signalType === kind) &&
      `${s.pair} ${s.poolId}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <>
      <div className="eyebrow">READ-ONLY RESEARCH</div>
      <h1>Signal episodes</h1>
      <p>
        One row per continuous signal. Historical observations and later outcomes are descriptive,
        not recommendations.
      </p>
      {pageNav}
      {error && (
        <div role="alert" className="warning">
          {error}
        </div>
      )}
      <section className="panel">
        <div className="research-filters">
          <label>
            CHAIN
            <select value={chain} onChange={(e) => setChain(e.target.value)}>
              <option value="all">All</option>
              <option value="solana">Solana</option>
              <option value="base">Base</option>
              <option value="bsc">BSC</option>
            </select>
          </label>
          <label>
            SIGNAL
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="all">All</option>
              {[...new Set((data?.signals ?? []).map((s) => s.signalType))].map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </label>
          <label>
            PAIR
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Pair or pool"
            />
          </label>
        </div>
        <p>{signals.length} matching episodes · newest 500 retained in this view</p>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>START</th>
                <th>SIGNAL</th>
                <th>PAIR / CHAIN</th>
                <th>ACTIVITY</th>
                <th>RISK</th>
                <th>CONFIDENCE</th>
                <th>EPISODE</th>
              </tr>
            </thead>
            <tbody>
              {signals.map((s) => (
                <tr key={s.id}>
                  <td>
                    <Link className="pair-link" href={`/research/signals/${s.id}`}>
                      {when(s.episodeStart)}
                    </Link>
                  </td>
                  <td>{s.signalType.replaceAll("_", " ")}</td>
                  <td>
                    <Link href={`/pool/${encodeURIComponent(s.poolId)}`}>{s.pair}</Link>
                    <small className="network">
                      {s.chain.toUpperCase()} · {s.protocol}
                    </small>
                  </td>
                  <td>{s.activity ?? "—"}</td>
                  <td>{s.risk}</td>
                  <td>{s.confidence ?? "—"}</td>
                  <td>{s.episodeEnd ? `Ended ${when(s.episodeEnd)}` : "Active"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
interface SignalFull {
  id: number;
  poolId: string;
  signalType: string;
  episodeStart: number;
  episodeLastSeen: number;
  episodeEnd: number | null;
  peakScore: number | null;
  scannerVersion: string;
  activityScoreVersion: string;
  riskScoreVersion: string;
  signalRuleVersion: string;
  reasonJson: string;
  data: Snapshot;
}
interface OutcomeRecord {
  signalId: number;
  horizon: Horizon;
  dueAt: number;
  status: string;
  completedAt: number | null;
  data: Outcome | null;
}
export function SignalDetail({ id }: { id: number }) {
  const { data, error } = useData<{ signal: SignalFull; outcomes: OutcomeRecord[] }>(
    `/api/research/signals/${id}`,
    60000,
  );
  if (!data)
    return (
      <>
        <Link href="/research/signals" className="back">
          ← Signals
        </Link>
        <h1>{error ?? "Loading signal…"}</h1>
      </>
    );
  const s = data.signal,
    p = s.data.pool,
    m = s.data.metrics;
  return (
    <>
      <Link href="/research/signals" className="back">
        ← Signals
      </Link>
      <div className="eyebrow">
        HISTORICAL SIGNAL · {p.chain.toUpperCase()} / {p.protocol}
      </div>
      <h1>{s.signalType.replaceAll("_", " ")}</h1>
      <p>
        <Link className="pair-link" href={`/pool/${encodeURIComponent(s.poolId)}`}>
          {p.pair}
        </Link>{" "}
        · began {when(s.episodeStart)} ·{" "}
        {s.episodeEnd ? `ended ${when(s.episodeEnd)}` : "active episode"}
      </p>
      {pageNav}
      <section className="stats">
        <Mini label="ACTIVITY" value={String(m.activity ?? "—")} />
        <Mini label="RISK" value={String(m.risk)} />
        <Mini label="CONFIDENCE" value={m.dataQuality ?? "—"} />
        <Mini label="PEAK SCORE" value={num(s.peakScore)} />
      </section>
      <section className="panel">
        <div className="eyebrow">AT SIGNAL TIME</div>
        <div className="facts">
          <Mini label="PAIR PRICE" value={num(p.price, 6)} />
          <Mini label="FEES 1H / 24H" value={`${usd(p.fees1h)} / ${usd(p.fees24h)}`} />
          <Mini label="VOLUME 1H / 24H" value={`${usd(p.volume1h)} / ${usd(p.volume24h)}`} />
          <Mini label="ACTIVE LIQUIDITY" value={usd(p.activeLiquidityUsd)} />
          <Mini label="±5% DEPTH" value={usd(p.depth5PctUsd ?? null)} />
          <Mini label="FEE / ACTIVE 1H" value={efficiency(m.feeEfficiency1h)} />
          <Mini label="FEE / DEPTH 1H" value={efficiency(m.feeEfficiencyDepth1h ?? null)} />
          <Mini label="VOLUME / DEPTH 1H" value={multiple(m.volumeDepthRatio1h ?? null)} />
        </div>
        <p>Reason: {JSON.parse(s.reasonJson).reason}</p>
        <p>
          Scanner {s.scannerVersion}; activity {s.activityScoreVersion}; risk {s.riskScoreVersion};
          rule {s.signalRuleVersion}.
        </p>
      </section>
      <section className="panel">
        <div className="eyebrow">AFTER THE SIGNAL</div>
        <p>
          Historical observations at +30m, +1h, +4h and +24h. Missing coverage remains unavailable.
        </p>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>HORIZON</th>
                <th>STATUS</th>
                <th>FIELD COVERAGE</th>
                <th>OVERALL</th>
                <th>PRICE RETURN</th>
                <th>FEES GENERATED</th>
                <th>VOLUME GENERATED</th>
                <th>FEE PERSISTENCE</th>
                <th>ACTIVITY PERSISTENCE</th>
                <th>RISK CHANGE</th>
              </tr>
            </thead>
            <tbody>
              {data.outcomes.map((o) => (
                <tr key={o.horizon}>
                  <td>{o.horizon}</td>
                  <td>{o.status}</td>
                  <td>{o.data?.fieldCompleteness?Object.entries(o.data.fieldCompleteness)
                    .map(([name,state])=>`${name} ${state.toLowerCase()}`).join(" · "):"Not evaluated"}</td>
                  <td>{o.data?.overallCompletenessPct==null?"—":`${Math.round(o.data.overallCompletenessPct)}%`}</td>
                  <td>{pct(o.data?.priceReturn)}</td>
                  <td>{usd(o.data?.feesGenerated ?? null)}</td>
                  <td>{usd(o.data?.volumeGenerated ?? null)}</td>
                  <td>{pct(o.data?.feePersistence)}</td>
                  <td>{pct(o.data?.activityPersistence)}</td>
                  <td>{num(o.data?.riskChange)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="panel">
        <div className="eyebrow">HISTORICAL RANGE OUTCOME, NOT SIMULATED FUTURE RETURN</div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>HORIZON</th>
                <th>RANGE</th>
                <th>REMAINED</th>
                <th>FIRST OBSERVED EXIT</th>
                <th>EXITS</th>
                <th>TIME IN RANGE</th>
                <th>MAX ADVERSE MOVE</th>
                <th>COVERAGE</th>
              </tr>
            </thead>
            <tbody>
              {data.outcomes.flatMap((o) =>
                (["2.5", "5", "10"] as const).map((b) => {
                  const r = o.data?.ranges[b];
                  return (
                    <tr key={`${o.horizon}-${b}`}>
                      <td>{o.horizon}</td>
                      <td>±{b}%</td>
                      <td>{r?.remainedInRange == null ? "—" : r.remainedInRange ? "Yes" : "No"}</td>
                      <td>
                        {r?.timeUntilFirstExitMs == null
                          ? "—"
                          : `${Math.round(r.timeUntilFirstExitMs / 60000)}m`}
                      </td>
                      <td>{r?.numberOfExits ?? "—"}</td>
                      <td>
                        {r?.timeSpentInRangePct == null
                          ? "—"
                          : `${r.timeSpentInRangePct.toFixed(1)}%`}
                      </td>
                      <td>{pct(o.data?.maxPriceMoveDown)}</td>
                      <td>{o.data ? `${o.data.observationCoveragePct.toFixed(0)}%` : "—"}</td>
                    </tr>
                  );
                }),
              )}
            </tbody>
          </table>
        </div>
        <p>
          Range observations use saved pool prices and require sufficient path coverage. Fees/volume
          generated require complete indexed EVM events; Meteora does not publish event-level
          history here.
        </p>
      </section>
    </>
  );
}
function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
interface Fact {
  id: number;
  signalType: string;
  episodeStart: number;
  chain: string;
  protocol: string;
  pair: string;
  tokenAge: number | null;
  poolAge: number | null;
  activity: number | null;
  risk: number;
  confidence: string;
  feeEfficiency: number | null;
  volumeDepth: number | null;
  volatility: number | null;
  trend: string;
  horizon: Horizon;
  outcomeStatus: string;
  outcomeData: string | null;
  sampleMeta?: string | null;
}
const bucket = (value: number | null, kind: "fee" | "depth" | "vol") =>
  value == null
    ? "unknown"
    : kind === "fee"
      ? value < 0.001
        ? "low"
        : value < 0.01
          ? "medium"
          : "high"
      : kind === "depth"
        ? value < 0.5
          ? "low"
          : value < 2
            ? "medium"
            : "high"
        : value < 5
          ? "low"
          : value < 20
            ? "medium"
            : "high";
export function ResearchSummary() {
  const { data, error } = useData<{ facts: Fact[]; cohorts: CohortAggregate[]; minSample: number;
    counts: {signals:number;completeOutcomes:number}; outcomes: {horizon:string;status:string;n:number}[] }>("/api/research/summary", 60000);
  const [chain, setChain] = useState("all"),
    [protocol, setProtocol] = useState("all"),
    [kind, setKind] = useState("all"),
    [confidence, setConfidence] = useState("HIGH_MEDIUM"),
    [trend, setTrend] = useState("all"),
    [pair, setPair] = useState("");
  const [minActivity, setMinActivity] = useState(""),
    [maxActivity, setMaxActivity] = useState(""),
    [minRisk, setMinRisk] = useState(""),
    [maxRisk, setMaxRisk] = useState(""),
    [minTokenAge, setMinTokenAge] = useState(""),
    [minPoolAge, setMinPoolAge] = useState("");
  const [feeBucket, setFeeBucket] = useState("all"),
    [depthBucket, setDepthBucket] = useState("all"),
    [volBucket, setVolBucket] = useState("all");
  const selected = useMemo(
    () =>
      (data?.facts ?? []).filter(
        (f) =>
          (chain === "all" || f.chain === chain) &&
          (protocol === "all" || f.protocol === protocol) &&
          (kind === "all" || f.signalType === kind) &&
          (confidence === "ALL" || (confidence === "STRICT" ? strictSample(f) :
            confidence === "HIGH_MEDIUM" ? ["HIGH","MEDIUM"].includes(f.confidence) : f.confidence === "HIGH")) &&
          (trend === "all" || f.trend === trend) &&
          f.pair.toLowerCase().includes(pair.toLowerCase()) &&
          (minActivity === "" || (f.activity != null && f.activity >= Number(minActivity))) &&
          (maxActivity === "" || (f.activity != null && f.activity <= Number(maxActivity))) &&
          (minRisk === "" || f.risk >= Number(minRisk)) &&
          (maxRisk === "" || f.risk <= Number(maxRisk)) &&
          (minTokenAge === "" || (f.tokenAge != null && f.tokenAge >= Number(minTokenAge))) &&
          (minPoolAge === "" || (f.poolAge != null && f.poolAge >= Number(minPoolAge))) &&
          (feeBucket === "all" || bucket(f.feeEfficiency, "fee") === feeBucket) &&
          (depthBucket === "all" || bucket(f.volumeDepth, "depth") === depthBucket) &&
          (volBucket === "all" || bucket(f.volatility, "vol") === volBucket),
      ),
    [
      data,
      chain,
      protocol,
      kind,
      confidence,
      trend,
      pair,
      minActivity,
      maxActivity,
      minRisk,
      maxRisk,
      minTokenAge,
      minPoolAge,
      feeBucket,
      depthBucket,
      volBucket,
    ],
  );
  const groups = useMemo(() => {
    const byType = new Map<string, Fact[]>();
    for (const f of selected) byType.set(f.signalType, [...(byType.get(f.signalType) ?? []), f]);
    return [...byType]
      .map(([type, rows]) => ({ type, rows, signals: new Set(rows.map((r) => r.id)).size }))
      .sort((a, b) => b.signals - a.signals);
  }, [selected]);
  const outcome = (rows: Fact[], h: Horizon): Outcome[] =>
    rows
      .filter((r) => r.horizon === h && r.outcomeStatus === "COMPLETE" && r.outcomeData &&
        (confidence!=="STRICT" || (JSON.parse(r.outcomeData) as Outcome).outcomeCompletenessPct!>=80))
      .map((r) => JSON.parse(r.outcomeData!) as Outcome);
  const render = (rows: Fact[], label: string, count: number) => {
    const one = outcome(rows, "1h"),
      four = outcome(rows, "4h");
    const enough = one.length >= (data?.minSample ?? 30);
    return (
      <tr key={label}>
        <td>{label.replaceAll("_", " ")}</td>
        <td>{count}</td>
        <td>{one.length}</td>
        <td>{enough ? pct(median(one.map((o) => o.feePersistence))) : "INSUFFICIENT SAMPLE"}</td>
        <td>{four.length >= (data?.minSample ?? 30) ? pct(median(four.map((o) => o.activityPersistence))) : "INSUFFICIENT SAMPLE"}</td>
        <td>
          {four.length >= (data?.minSample ?? 30) ? pct(
            median(
              four.map((o) =>
                o.ranges["5"].timeSpentInRangePct == null
                  ? null
                  : o.ranges["5"].timeSpentInRangePct! / 100,
              ),
            ),
          ) : "INSUFFICIENT SAMPLE"}
        </td>
        <td>{four.length >= (data?.minSample ?? 30) ? pct(median(four.map((o) => o.maxPriceMoveDown))) : "INSUFFICIENT SAMPLE"}</td>
      </tr>
    );
  };
  const curve = (data?.cohorts ?? []).filter((c) => c.confidenceFilter === confidence &&
    c.dimension === "all" && c.status === "VALID" && (kind === "all" || c.signalType === kind))
    .sort((a,b) => b.outcomeCounts["1h"]-a.outcomeCounts["1h"])[0];
  const curveRows = curve ? [{horizon:"0",activity:1,range2_5:1,range5:1,range10:1},
    ...curve.curves.map((c) => ({horizon:c.horizon,activity:c.activityRatio.median,
      range2_5:c.ranges["2.5"].survivalRate,range5:c.ranges["5"].survivalRate,
      range10:c.ranges["10"].survivalRate}))] : [];
  return (
    <>
      <div className="eyebrow">DESCRIPTIVE HISTORICAL ANALYSIS</div>
      <h1>Research summary</h1>
      <p>
        Filter observed signal episodes and compare later measurements. Selection effects and
        missing data can dominate these medians.
      </p>
      {pageNav}
      {error && (
        <div role="alert" className="warning">
          {error}
        </div>
      )}
      <section className="stats">
        <Mini label="TOTAL SIGNALS" value={String(data?.counts.signals ?? "—")} />
        <Mini label="COMPLETED OUTCOMES" value={String(data?.counts.completeOutcomes ?? "—")} />
        {(["30m","1h","4h","24h"] as const).map((h) => <Mini key={h} label={`${h.toUpperCase()} OUTCOMES`}
          value={String(data?.outcomes.find((o) => o.horizon === h && o.status === "COMPLETE")?.n ?? 0)} />)}
      </section>
      <section className="panel">
        <div className="research-filters">
          <label>
            CHAIN
            <select value={chain} onChange={(e) => setChain(e.target.value)}>
              <option value="all">All</option>
              {["solana", "base", "bsc"].map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </label>
          <label>
            PROTOCOL
            <select value={protocol} onChange={(e) => setProtocol(e.target.value)}>
              <option value="all">All</option>
              {["meteora-dlmm", "uniswap-v3", "pancakeswap-v3"].map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </label>
          <label>
            SIGNAL
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="all">All</option>
              {[...new Set((data?.facts ?? []).map((f) => f.signalType))].map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </label>
          <label>
            CONFIDENCE
            <select value={confidence} onChange={(e) => setConfidence(e.target.value)}>
              <option value="HIGH_MEDIUM">Standard · high + medium</option>
              <option value="STRICT">Strict · complete evidence</option>
              <option value="HIGH">High only</option>
              <option value="ALL">All · with provenance</option>
            </select>
          </label>
          <label>
            TREND
            <select value={trend} onChange={(e) => setTrend(e.target.value)}>
              <option value="all">All</option>
              {["RANGING", "TRENDING_UP", "TRENDING_DOWN", "EXTREME_MOVE", "UNKNOWN"].map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </label>
          <label>
            PAIR
            <input value={pair} onChange={(e) => setPair(e.target.value)} placeholder="Any pair" />
          </label>
          {[
            ["Min activity", minActivity, setMinActivity],
            ["Max activity", maxActivity, setMaxActivity],
            ["Min risk", minRisk, setMinRisk],
            ["Max risk", maxRisk, setMaxRisk],
            ["Min token age (h)", minTokenAge, setMinTokenAge],
            ["Min pool age (h)", minPoolAge, setMinPoolAge],
          ].map(([label, value, set]) => (
            <label key={label as string}>
              {label as string}
              <input
                type="number"
                min="0"
                value={value as string}
                onChange={(e) => (set as (s: string) => void)(e.target.value)}
                placeholder="Any"
              />
            </label>
          ))}
          {[
            ["Fee efficiency", feeBucket, setFeeBucket],
            ["Volume / depth", depthBucket, setDepthBucket],
            ["Volatility", volBucket, setVolBucket],
          ].map(([label, value, set]) => (
            <label key={label as string}>
              {label as string}
              <select
                value={value as string}
                onChange={(e) => (set as (s: string) => void)(e.target.value)}
              >
                <option value="all">All</option>
                <option value="unknown">Unknown</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </label>
          ))}
        </div>
      </section>
      <section className="panel">
        <div className="eyebrow">MATCHED COHORT</div>
        <p>Minimum {data?.minSample ?? 30} complete outcomes per statistic. Confidence composition follows selected filter.</p>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>COHORT</th>
                <th>SIGNALS</th>
                <th>COMPLETE 1H</th>
                <th>MEDIAN 1H FEE PERSISTENCE</th>
                <th>MEDIAN 4H ACTIVITY PERSISTENCE</th>
                <th>MEDIAN 4H TIME INSIDE ±5%</th>
                <th>MEDIAN 4H ADVERSE MOVE</th>
              </tr>
            </thead>
            <tbody>
              {render(selected, "All matching", new Set(selected.map((r) => r.id)).size)}
              {groups.map((g) => render(g.rows, g.type, g.signals))}
            </tbody>
          </table>
        </div>
        <p>
          Percentages describe saved observations, not LP returns. At most the latest 5,000 signal
          episodes appear; missing outcomes are excluded from each median and counts remain visible.
        </p>
      </section>
      <section className="panel">
        <div className="eyebrow">PERSISTED COHORT VALIDATION · HISTORICAL OBSERVATIONS</div>
        <p>Grouped by signal, chain, protocol, trend, risk, activity, volatility, confidence, token age, and pool age. Filters other than signal and confidence apply only to the matched cohort above.</p>
        <div className="table-scroll"><table><thead><tr>
          <th>SIGNAL</th><th>GROUP</th><th>1H N</th><th>CONFIDENCE H/M/L/U</th><th>1H ACTIVITY</th><th>1H ±5% SURVIVAL</th><th>4H ±5% SURVIVAL</th>
        </tr></thead><tbody>
          {(data?.cohorts ?? []).filter((c) => c.confidenceFilter === confidence &&
            (kind === "all" || c.signalType === kind))
            .sort((a,b) => b.outcomeCounts["1h"]-a.outcomeCounts["1h"]).slice(0,30).map((c) => {
              const one = c.curves.find((x) => x.horizon === "1h")!, four = c.curves.find((x) => x.horizon === "4h")!;
              return <tr key={c.key}><td>{c.signalType.replaceAll("_"," ")}</td>
                <td>{c.dimension}: {c.value}</td><td>{c.outcomeCounts["1h"]}</td>
                <td>{["HIGH","MEDIUM","LOW","UNAVAILABLE"].map((x) => c.confidenceComposition[x] ?? 0).join("/")}</td>
                <td>{one.activityPersistence.median == null ? "INSUFFICIENT SAMPLE" : pct(one.activityPersistence.median)}</td>
                <td>{one.ranges["5"].survivalRate == null ? "INSUFFICIENT SAMPLE" : pct(one.ranges["5"].survivalRate)}</td>
                <td>{four.ranges["5"].survivalRate == null ? "INSUFFICIENT SAMPLE" : pct(four.ranges["5"].survivalRate)}</td></tr>;
            })}
        </tbody></table></div>
      </section>
      <section className="panel"><div className="eyebrow">HISTORICAL RANGE SURVIVAL</div>
        <p>{curve ? `${curve.signalType.replaceAll("_"," ")} · ${curve.outcomeCounts["1h"]} complete 1h outcomes` :
          `INSUFFICIENT SAMPLE · minimum ${data?.minSample ?? 30} complete 1h outcomes`}</p>
        {curve && <div style={{width:"100%",height:250}}><ResponsiveContainer>
          <LineChart data={curveRows}><CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="horizon" /><YAxis domain={[0,1]} tickFormatter={(x:number)=>`${Math.round(x*100)}%`} />
            <Tooltip formatter={(x)=>x == null ? "unavailable" : `${(Number(x)*100).toFixed(1)}%`} />
            <Legend /><Line dataKey="range2_5" name="±2.5%" stroke="#72a5ff" connectNulls={false} />
            <Line dataKey="range5" name="±5%" stroke="#56c6a9" connectNulls={false} />
            <Line dataKey="range10" name="±10%" stroke="#f4b45f" connectNulls={false} />
          </LineChart></ResponsiveContainer></div>}
      </section>
      <section className="panel"><div className="eyebrow">SIGNAL ACTIVITY DECAY</div>
        <p>Median endpoint activity divided by activity at signal creation. Missing endpoints remain gaps.</p>
        {curve && <div style={{width:"100%",height:220}}><ResponsiveContainer>
          <LineChart data={curveRows}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="horizon" />
            <YAxis domain={[0,"auto"]} /><Tooltip /><Line dataKey="activity" name="Normalized activity" stroke="#56c6a9" connectNulls={false} />
          </LineChart></ResponsiveContainer></div>}
        {!curve && <p>INSUFFICIENT SAMPLE</p>}
      </section>
    </>
  );
}
interface CoverageRow {
  chain: string;
  pools: number;
  price_timestamped: number;
  price_reliable: number;
  fee_1h: number;
  depth: number;
  high_confidence: number;
}
export function CoveragePage() {
  const { data, error } = useData<{
    coverage: CoverageRow[];
    counts: {
      events: number;
      signals: number;
      completeOutcomes: number;
      pendingOutcomes: number;
      queueLength: number;
    };
    scan: Record<string, number> | null;
    worker: Record<string, number | string> | null;
    jobs: {
      poolId: string;
      chain: string;
      status: string;
      startBlock: number | null;
      endBlock: number | null;
      retryCount: number;
      failureReason: string | null;
    }[];
  }>("/api/research/coverage", 30000);
  const rows = data?.coverage ?? [];
  const total = rows.reduce((n, r) => n + r.pools, 0);
  return (
    <>
      <div className="eyebrow">SCANNER DIAGNOSTICS</div>
      <h1>Data quality and coverage</h1>
      <p>Coverage uses the latest completed scan. Unknown values remain visible as gaps.</p>
      {pageNav}
      {error && (
        <div role="alert" className="warning">
          {error}
        </div>
      )}
      <section className="stats">
        <Mini label="DISCOVERED POOLS" value={String(total)} />
        <Mini label="INDEXED SWAPS" value={String(data?.counts.events ?? "—")} />
        <Mini label="SIGNAL EPISODES" value={String(data?.counts.signals ?? "—")} />
        <Mini label="COMPLETE OUTCOMES" value={String(data?.counts.completeOutcomes ?? "—")} />
      </section>
      <section className="panel">
        <div className="eyebrow">COVERAGE BY CHAIN</div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>CHAIN</th>
                <th>POOLS</th>
                <th>TIMESTAMPED PAIR PRICE</th>
                <th>RELIABLE PRICE</th>
                <th>1H FEES</th>
                <th>±5% DEPTH</th>
                <th>HIGH DATA CONFIDENCE</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.chain}>
                  <td>{r.chain.toUpperCase()}</td>
                  <td>{r.pools}</td>
                  <td>
                    {r.price_timestamped} · {pct(r.price_timestamped / r.pools)}
                  </td>
                  <td>
                    {r.price_reliable} · {pct(r.price_reliable / r.pools)}
                  </td>
                  <td>
                    {r.fee_1h ?? 0} · {pct((r.fee_1h ?? 0) / r.pools)}
                  </td>
                  <td>
                    {r.depth ?? 0} · {pct((r.depth ?? 0) / r.pools)}
                  </td>
                  <td>{r.high_confidence ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="panel">
        <div className="eyebrow">PERFORMANCE</div>
        <div className="facts">
          <Mini
            label="LATEST SCAN"
            value={data?.scan ? `${(data.scan.duration_ms / 1000).toFixed(1)}s` : "—"}
          />
          <Mini
            label="SCAN HTTP / RPC"
            value={data?.scan ? `${data.scan.api_requests} / ${data.scan.rpc_requests}` : "—"}
          />
          <Mini label="SCAN CACHE HITS" value={String(data?.scan?.cache_hits ?? "—")} />
          <Mini
            label="BACKGROUND CYCLE"
            value={
              data?.worker?.ended_at && data.worker?.started_at
                ? `${((Number(data.worker.ended_at) - Number(data.worker.started_at)) / 1000).toFixed(1)}s`
                : "—"
            }
          />
          <Mini
            label="WORKER HTTP / RPC"
            value={data?.worker ? `${data.worker.api_requests} / ${data.worker.rpc_requests}` : "—"}
          />
          <Mini label="BACKFILL QUEUE" value={String(data?.counts.queueLength ?? "—")} />
          <Mini label="PENDING OUTCOMES" value={String(data?.counts.pendingOutcomes ?? "—")} />
        </div>
        <p>{String(data?.worker?.notes ?? "")}</p>
      </section>
      <section className="panel">
        <div className="eyebrow">RECENT BACKFILL JOBS</div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>POOL</th>
                <th>CHAIN</th>
                <th>STATUS</th>
                <th>BLOCK RANGE</th>
                <th>RETRIES</th>
                <th>REASON</th>
              </tr>
            </thead>
            <tbody>
              {(data?.jobs ?? []).map((j) => (
                <tr key={j.poolId}>
                  <td>
                    <Link href={`/pool/${encodeURIComponent(j.poolId)}`}>
                      {j.poolId.split(":").at(-1)?.slice(0, 12)}…
                    </Link>
                  </td>
                  <td>{j.chain}</td>
                  <td>{j.status}</td>
                  <td>
                    {j.startBlock ?? "—"} → {j.endBlock ?? "—"}
                  </td>
                  <td>{j.retryCount}</td>
                  <td>{j.failureReason ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
