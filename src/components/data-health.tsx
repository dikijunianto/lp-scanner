"use client";
import Link from "next/link";
import { useData } from "./use-data";

type Provider = {providerId:string;chain:string;providerType:string;supportsArchive:boolean|null;
  supportsGetLogs:boolean|null;supportsBatching:boolean|null;supportsMulticall:boolean|null;
  supportsHistoricalState:boolean|null;healthState:string;safeLogRange:number;latencyMs:number|null;
  errorRate:number;lastSuccessAt:number|null;lastFailureAt:number|null};
type Row = Record<string, string | number | null>;
type Health = {generatedAt:number;providers:Provider[];usage:Row[];priceCalls:Row[];coverage:Row[];currentFees:Row[];
  logSources:{chain:string;sourceId:string;sourceType:string;latestIndexedBlock:number|null;
    latencyMs:number|null;historicalCoverage:string;confidence:string;status:string;failureReason:string|null}[];
  historicalFees:Row[];priceBackfill:{total:number;priced:number;pending:number;backfilled:number};
  missingPriceReasons:{reason:string;n:number}[];counts:{queueLength:number;workerLagMs:number};
  oldestJob:{oldest:number|null};scan:{duration_ms:number}|null;
  worker:{started_at:number;ended_at:number|null;notes:string}|null;
  liveCursors:{poolId:string;chain:string;blockNumber:number;headBlock:number;lagBlocks:number|null;
    lagSeconds:number|null;headAgeSeconds:number|null;state:string;sourceType:string;sourceId:string}[];
  outcomePipeline:{horizon:string;eligible:number;complete:number;overdue:number;oldestReadyAgeMs:number|null;
    completionRate:number|null}[];
  outcomeMissingness:{horizon:string;reason:string;n:number}[];
  outcomeLag:{horizon:string;n:number;medianMs:number;p95Ms:number}[];
  outcomeThroughput:number;outcomeConcurrency:number;
  bscDepthFailures:{reason:string;n:number;pools:number}[];
  databaseGrowth:{databaseBytes:number;walBytes:number;rows:{name:string;total:number;lastDay:number;
    estimatedBytesPerDay:number;estimatedBytesPerWeek:number;estimatedBytesPerMonth:number}[]};};
const yes = (v:boolean|null) => v === null ? "Unknown" : v ? "Yes" : "No";
const age = (v:number|null, now:number) => v == null ? "Unknown" : `${Math.round((now-v)/60000)} min ago`;
export function DataHealthPage() {
  const {data,error} = useData<Health>("/api/diagnostics/data-health",30000);
  const alerts:string[] = [];
  for (const chain of ["base","bsc"])
    if (data && !data.providers.some((p)=>p.chain===chain && p.supportsGetLogs && p.healthState!=="COOLDOWN"))
      alerts.push(`${chain.toUpperCase()} historical log RPC unavailable`);
  if (data?.scan && data.scan.duration_ms > 25000) alerts.push("Foreground scan exceeded 25 seconds");
  if (data?.oldestJob.oldest && data.generatedAt-data.oldestJob.oldest>3600000)
    alerts.push("Fee backfill queue has jobs older than one hour");
  if (data?.outcomePipeline.some((r)=>(r.oldestReadyAgeMs??0)>1800000))
    alerts.push("Outcome queue is more than 30 minutes behind");
  const cursorState=(chain:string)=>{
    const rows=data?.liveCursors.filter((r)=>r.chain===chain)??[];
    if(!rows.length) return "UNAVAILABLE";
    return rows.some((r)=>r.state==="STALE"||r.state==="UNAVAILABLE")?"STALE":
      rows.some((r)=>r.state==="DELAYED")?"DELAYED":"FRESH";
  };
  return <>
    <div className="eyebrow">READ-ONLY OPERATIONS</div><h1>Data health</h1>
    <p>Provider errors and missing prices remain separate from genuine data gaps. Provider URLs and credentials never appear here.</p>
    <nav className="research-nav"><Link href="/research/summary">Research summary</Link>
      <Link href="/research/coverage">Coverage</Link></nav>
    {error && <div className="warning" role="alert">{error}</div>}
    {alerts.length>0 && <section className="panel"><div className="eyebrow">INFRASTRUCTURE ALERTS</div>
      <ul>{alerts.map((a)=><li key={a}>{a}</li>)}</ul></section>}
    <section className="stats">
      <div className="panel"><div className="eyebrow">UNPRICED SWAPS</div><strong>{data?.priceBackfill.pending ?? "—"}</strong></div>
      <div className="panel"><div className="eyebrow">BACKFILLED USD SWAPS</div><strong>{data?.priceBackfill.backfilled ?? "—"}</strong></div>
      <div className="panel"><div className="eyebrow">FEE JOBS WAITING</div><strong>{data?.counts.queueLength ?? "—"}</strong></div>
      <div className="panel"><div className="eyebrow">OUTCOME LAG</div><strong>{data ? `${Math.round(data.counts.workerLagMs/60000)} min` : "—"}</strong></div>
    </section>
    <section className="panel"><div className="eyebrow">PIPELINE PRIORITIES</div>
      <p>Live Base cursor: {cursorState("base")} · Live BSC cursor: {cursorState("bsc")} ·
        Outcome queue: {data?.outcomePipeline.some((r)=>(r.oldestReadyAgeMs??0)>1800000)?"CRITICAL":"CURRENT"} ·
        Fee jobs: {data?.counts.queueLength??"—"} · Outcome throughput: {data?.outcomeThroughput??"—"}/min ·
        Worker concurrency: {data?.outcomeConcurrency??"—"}</p>
      <p>Live event ingestion and overdue outcomes run before historical price backfill.</p></section>
    <section className="panel"><div className="eyebrow">LIVE FEE CURSORS · CURRENT, SEPARATE FROM HISTORY</div>
      <div className="table-scroll"><table><thead><tr><th>CHAIN</th><th>POOL</th><th>STATE</th>
        <th>LAST HEAD</th><th>CURSOR</th><th>OBSERVED BLOCK GAP</th><th>TIME BEHIND</th><th>HEAD AGE</th><th>SOURCE</th></tr></thead><tbody>
        {(data?.liveCursors??[]).map((r)=><tr key={r.poolId}><td>{r.chain}</td><td>{r.poolId.slice(-12)}</td>
          <td>{r.state}</td><td>{r.headBlock}</td><td>{r.blockNumber}</td>
          <td>{r.lagBlocks??"—"}</td><td>{r.lagSeconds==null?"—":Math.round(r.lagSeconds)}</td>
          <td>{r.headAgeSeconds==null?"—":Math.round(r.headAgeSeconds)}</td>
          <td>{r.sourceType} · {r.sourceId}</td></tr>)}</tbody></table></div></section>
    <section className="panel"><div className="eyebrow">OUTCOME PIPELINE · MATURITY AND DELAY</div>
      <div className="table-scroll"><table><thead><tr><th>HORIZON</th><th>ELIGIBLE</th><th>COMPLETE</th>
        <th>RATE</th><th>OVERDUE</th><th>OLDEST READY</th><th>MEDIAN DELAY</th><th>P95 DELAY</th></tr></thead><tbody>
        {(data?.outcomePipeline??[]).map((r)=>{const lag=data?.outcomeLag.find((x)=>x.horizon===r.horizon);
          return <tr key={r.horizon}><td>{r.horizon}</td><td>{r.eligible}</td><td>{r.complete}</td>
            <td>{r.completionRate==null?"—":`${Math.round(r.completionRate*100)}%`}</td><td>{r.overdue}</td>
            <td>{r.oldestReadyAgeMs==null?"—":`${Math.round(r.oldestReadyAgeMs/60000)} min`}</td>
            <td>{lag?`${Math.round(lag.medianMs/60000)} min`:"—"}</td>
            <td>{lag?`${Math.round(lag.p95Ms/60000)} min`:"—"}</td></tr>})}</tbody></table></div>
      <p>Missing outcomes: {(data?.outcomeMissingness??[]).filter((r)=>r.reason!=="COMPLETE")
        .slice(0,16).map((r)=>`${r.horizon} ${r.reason} ${r.n}`).join(" · ")||"None"}</p></section>
    <section className="panel"><div className="eyebrow">LOG SOURCES</div>
      <p>Historical coverage is unknown until a source proves a requested range. Confidence stays low without recorded independent verification.</p>
      <div className="table-scroll"><table><thead><tr><th>CHAIN</th><th>SOURCE</th><th>TYPE</th>
        <th>LATEST INDEXED BLOCK</th><th>RPC LATENCY</th><th>HISTORY</th><th>CONFIDENCE</th><th>STATUS</th></tr></thead><tbody>
        {(data?.logSources??[]).map((s)=><tr key={s.sourceId}><td>{s.chain}</td><td>{s.sourceId}</td>
          <td>{s.sourceType}</td><td>{s.latestIndexedBlock??"—"}</td>
          <td>{s.latencyMs==null?"—":`${Math.round(s.latencyMs)} ms`}</td>
          <td>{s.historicalCoverage}</td><td>{s.confidence}</td>
          <td>{s.status}{s.failureReason?` · ${s.failureReason}`:""}</td></tr>)}</tbody></table></div></section>
    <section className="panel"><div className="eyebrow">RPC PROVIDERS · ROUTER SPRINT6-V1</div>
      <div className="table-scroll"><table><thead><tr><th>CHAIN</th><th>PROVIDER ID</th><th>HEALTH</th>
        <th>LOGS</th><th>ARCHIVE</th><th>HISTORICAL STATE</th><th>BATCH</th><th>MULTICALL</th>
        <th>SAFE LOG RANGE</th><th>LATENCY</th><th>ERROR RATE</th><th>LAST SUCCESS</th></tr></thead>
        <tbody>{(data?.providers ?? []).map((p)=><tr key={p.providerId}><td>{p.chain}</td>
          <td>{p.providerId}</td><td>{p.healthState}</td><td>{yes(p.supportsGetLogs)}</td>
          <td>{yes(p.supportsArchive)}</td><td>{yes(p.supportsHistoricalState)}</td>
          <td>{yes(p.supportsBatching)}</td><td>{yes(p.supportsMulticall)}</td>
          <td>{p.safeLogRange}</td><td>{p.latencyMs == null ? "—" : `${Math.round(p.latencyMs)} ms`}</td>
          <td>{Math.round(p.errorRate*100)}%</td><td>{age(p.lastSuccessAt,data?.generatedAt ?? 0)}</td></tr>)}</tbody></table></div>
    </section>
    <section className="panel"><div className="eyebrow">RPC REQUESTS · LAST HOUR</div>
      <div className="table-scroll"><table><thead><tr><th>CHAIN</th><th>PROVIDER</th><th>REQUESTS</th>
        <th>BATCH CALLS</th><th>LOG QUERIES</th><th>HISTORICAL BLOCK READS</th><th>FALLBACKS</th></tr></thead>
        <tbody>{(data?.usage ?? []).map((r)=><tr key={String(r.provider_id)}><td>{r.chain}</td><td>{r.provider_id}</td>
          <td>{r.requests}</td><td>{r.batch_calls}</td><td>{r.logs_queried}</td>
          <td>{r.historical_blocks_queried}</td><td>{r.fallback_calls}</td></tr>)}</tbody></table></div>
    </section>
    <section className="panel"><div className="eyebrow">HISTORICAL PRICE CALLS · LAST HOUR</div>
      <p>{(data?.priceCalls ?? []).map((r)=>`${r.chain}: ${r.calls}`).join(" · ") || "No calls recorded"}</p></section>
    <section className="panel"><div className="eyebrow">CURRENT WINDOW COVERAGE</div>
      <div className="table-scroll"><table><thead><tr><th>CHAIN</th><th>POOLS</th><th>RELIABLE PAIR PRICE</th>
        <th>±5% DEPTH</th><th>COMPLETE 1H FEES</th><th>COMPLETE 4H FEES</th></tr></thead><tbody>
        {(data?.coverage ?? []).map((r)=>{const fees = data?.currentFees.find((f)=>f.chain===r.chain);
          return <tr key={String(r.chain)}><td>{r.chain}</td><td>{r.pools}</td><td>{r.price_reliable}</td>
            <td>{r.depth}</td><td>{fees?.complete_1h ?? r.fee_1h ?? 0}</td>
            <td>{fees?.complete_4h ?? r.fee_4h ?? 0}</td></tr>})}
        </tbody></table></div><p>Last complete current 1h window: {(data?.currentFees??[])
          .map((r)=>`${r.chain}: ${r.last_complete_1h?new Date(Number(r.last_complete_1h)).toLocaleString():"unavailable"}`)
          .join(" · ")}</p></section>
    <section className="panel"><div className="eyebrow">HISTORICAL STORED COMPLETE FEE WINDOWS</div>
      <div className="table-scroll"><table><thead><tr><th>CHAIN</th><th>WINDOW</th><th>STORED COMPLETE</th></tr></thead>
        <tbody>{(data?.historicalFees ?? []).map((r)=><tr key={`${r.chain}:${r.window}`}><td>{r.chain}</td>
          <td>{r.window}</td><td>{r.stored_complete}</td></tr>)}</tbody></table></div></section>
    <section className="panel"><div className="eyebrow">MISSING USD REASONS</div>
      <div className="table-scroll"><table><thead><tr><th>REASON</th><th>SWAPS</th></tr></thead><tbody>
        {(data?.missingPriceReasons ?? []).map((r)=><tr key={r.reason}><td>{r.reason}</td><td>{r.n}</td></tr>)}
      </tbody></table></div><p>Backfill uses source timestamps. Unpriced swaps never count as complete USD fee windows.</p></section>
    <section className="panel"><div className="eyebrow">BSC DEPTH BLOCKERS</div>
      <p>{(data?.bscDepthFailures??[]).map((r)=>`${r.reason}: ${r.pools} pools (${r.n} failures)`).join(" · ")||"No failures recorded"}</p></section>
    <section className="panel"><div className="eyebrow">DATABASE GROWTH FORECAST</div>
      <p>SQLite {data?`${(data.databaseGrowth.databaseBytes/1073741824).toFixed(2)} GiB`:"—"} ·
        WAL {data?`${(data.databaseGrowth.walBytes/1048576).toFixed(1)} MiB`:"—"}.
        Estimates use recent row counts and sampled row size; no automatic deletion.</p>
      <div className="table-scroll"><table><thead><tr><th>DATA</th><th>ROWS</th><th>LAST DAY</th>
        <th>EST. / DAY</th><th>EST. / WEEK</th><th>EST. / MONTH</th></tr></thead><tbody>
        {(data?.databaseGrowth.rows??[]).map((r)=><tr key={r.name}><td>{r.name}</td><td>{r.total}</td>
          <td>{r.lastDay}</td><td>{Math.round(r.estimatedBytesPerDay/1048576)} MiB</td>
          <td>{Math.round(r.estimatedBytesPerWeek/1048576)} MiB</td>
          <td>{Math.round(r.estimatedBytesPerMonth/1048576)} MiB</td></tr>)}</tbody></table></div></section>
    <section className="panel"><div className="eyebrow">WORKER</div>
      <p>Last cycle: {data?.worker?.ended_at ? `${((data.worker.ended_at-data.worker.started_at)/1000).toFixed(1)}s` : "running or unavailable"}.
      Oldest pending fee job: {age(data?.oldestJob.oldest ?? null,data?.generatedAt ?? 0)}.</p>
      <p>{data?.worker?.notes ?? ""}</p></section>
  </>;
}
