"use client";
import Link from "next/link";
import { useData } from "./use-data";
import type { ResearchEpoch, ServiceHealth } from "../core/epoch";

type OutcomeCoverage = {horizon:string;eligible:number;priceRangeComplete:number;partial:number;missing:number};
type Lag = {total:number;known:number;unknown:number;median:number|null;p90:number|null;p95:number|null;max:number|null};
type PriceSourceCoverage = {chain:string;asset_address:string;source:string;kind:string|null;
  last_success:number|null;last_failure:number|null;failure_reason:string|null;coverage_resolution:string|null;
  publication_latency_ms:number|null;confidence:string|null};

type Provider = {providerId:string;chain:string;providerType:string;supportsArchive:boolean|null;
  supportsGetLogs:boolean|null;supportsBatching:boolean|null;supportsMulticall:boolean|null;
  supportsHistoricalState:boolean|null;healthState:string;safeLogRange:number;latencyMs:number|null;
  errorRate:number;lastSuccessAt:number|null;lastFailureAt:number|null};
type Row = Record<string, string | number | null>;
type Health = {summaryAgeMs:number;summaryStale:boolean;
  researchEpoch?:ResearchEpoch|null;burninRunId?:string|null;providerServices?:ServiceHealth[];
  currentEpochOutcomes?:OutcomeCoverage[];allHistoryOutcomes?:OutcomeCoverage[];
  baseLag?:{allHot:Lag;hotActive:Lag;noActivity:Lag};
  baseFeeWaterfall?:{allHot:number;active:number;eventComplete:number;swapPricesComplete:number;feeComplete:number;
    failures:{poolId:string;reason:string|null;unpricedSwaps:number}[]};priceSourceCoverage?:PriceSourceCoverage[];
  hotPoolDetails:{poolId:string;chain:string;priced:boolean;depth:boolean;feeComplete:boolean;activity:string;signalActive?:boolean;fresh:boolean;lagSeconds:number|null;reason:string;cursorState?:string;feeFailure?:string|null;depthFailure?:string|null;priceTokens:{address:string;symbol:string;reliable:boolean;failures:string[];provenance:{kind:string}|null}[]}[];
  generatedAt:number;providers:Provider[];usage:Row[];priceCalls:Row[];coverage:Row[];currentFees:Row[];
  bscSource:{liveLogs:boolean;historicalLogs:boolean;archiveState:boolean;websocket:string};
  readiness:{status:string;selectedChains:string[];failed:string[];gates:{id:string;value:number|null;target:number;pass:boolean;hourlyCompliance?:number}[];
    bsc:{status:string;failed:string[]}};
  hotCoverage:{chain:string;pools:number;priced:number;depth5:number;depth5Priced?:number;fee1h:number;activePools:number;activePriced?:number;signalPools?:number;signalPriced?:number;activeFee1h:number;activeFresh:number}[];
  snapshotCoverage:{tracked:number;maturePools:number;expected:number;actual:number;priced:number;
    fees:number;depth:number;coveragePct:number|null;priceCoveragePct:number|null;
    feeCoveragePct:number|null;depthCoveragePct:number|null;largestGapMs:number|null};
  scanLatency:{n:number;medianMs:number|null;p90Ms:number|null;p95Ms:number|null;p99Ms:number|null};
  outcomeFieldCoverage:{horizon:string;eligible:number;priceRangeComplete:number}[];
  recentOutcomeLag:{n:number;p95Ms:number|null};
  newOutcomeLag:{n:number;p95Ms:number|null;legacyCount:number};
  scanSkippedBecausePreviousRunning:number;
  scanSpans:{runId:number;phase:string;operation:string;provider:string|null;durationMs:number;
    timeoutMs:number|null;success:number}[];
  coreWriter:{attempts:number;successful:number;busyRetries:number;maxDurationMs:number|null};
  diskSafety:{freeBytes:number;estimatedDaysRemaining:number|null;warning:string}|null;
  datasetVersion:{version:string}|null;
  liveRuns:{chain:string;status:string;swaps:number;pools:number;error:string|null}[];
  slowCalls:{runId:number;source:string;durationMs:number;reason:string}[];
  eventSources:{sourceId:string;chain:string;sourceType:string;purpose:string;latestIndexedBlock:number|null;
    latencyMs:number|null;historicalFromBlock:number|null;confidence:string;healthState:string;
    lastSuccessAt:number|null;lastFailureAt:number|null;error:string|null}[];
  sourceDisagreements:{chain:string;sourceId:string;compared:number;disagreements:number}[];
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
    estimatedBytesPerDay:number;estimatedBytesPerWeek:number;estimatedBytesPerMonth:number}[]};
  storageGrowth:{hours:number;estimatedBytesPerDay:number|null;rows:{name:string;count:number;estimatedBytes:number}[]};
  measuredStorageGrowth:{hours:number;bytesPerDay:number|null;allocatedBytes:number|null;
    databaseBytesDelta:number|null};};
const yes = (v:boolean|null) => v === null ? "Unknown" : v ? "Yes" : "No";
const age = (v:number|null, now:number) => v == null ? "Unknown" : `${Math.round((now-v)/60000)} min ago`;
const ratio = (n:number,total:number) => `${n}/${total}${total?` (${(n/total*100).toFixed(1)}%)`:" — no eligible data"}`;
const seconds = (n:number|null) => n===null?"Unavailable":`${n.toFixed(1)}s`;
export function DataHealthPage() {
  const {data,error} = useData<Health>("/api/diagnostics/data-health",30000);
  const selectedHot=(data?.hotPoolDetails??[]).filter(r=>['base','solana'].includes(r.chain));
  const hotTokenKeys=new Set(selectedHot.flatMap(r=>r.priceTokens.map(t=>`${r.chain}:${r.chain==='solana'?t.address:t.address.toLowerCase()}`)));
  const sourceRows=(data?.priceSourceCoverage??[]).filter(r=>hotTokenKeys.has(`${r.chain}:${r.chain==='solana'?r.asset_address:r.asset_address.toLowerCase()}`));
  const priceCategories=new Map<string,number>();
  const depthFailures=new Map<string,number>();
  for(const pool of selectedHot.filter(p=>p.priced&&!p.depth)){
    const key=`${pool.chain}:${pool.depthFailure??'OTHER'}`;
    depthFailures.set(key,(depthFailures.get(key)??0)+1);
  }
  for(const pool of selectedHot)for(const token of pool.priceTokens){
    const reasons=token.reliable?[token.provenance?.kind==='CROSS_POOL'?'DERIVED_PRICE_OK':'DIRECT_PRICE_OK']:
      [...new Set(token.failures.length?token.failures.map(f=>f==='NO_SUPPORTED_PRICE_SOURCE'?'NO_SOURCE':f==='UNKNOWN'?'OTHER':f):['NO_SOURCE'])];
    for(const reason of reasons){const key=`${pool.chain}:${reason}`;priceCategories.set(key,(priceCategories.get(key)??0)+1);}
  }
  const alerts:string[] = [];
  for (const chain of ["base","bsc"])
    if (data && !data.providers.some((p)=>p.chain===chain && p.supportsGetLogs && p.healthState==="HEALTHY") &&
      !data.eventSources.some((s)=>s.chain===chain && s.healthState==="HEALTHY"))
      alerts.push(`${chain.toUpperCase()} historical log RPC unavailable`);
  if (data?.scan && data.scan.duration_ms > 15000) alerts.push("Foreground scan exceeded 15 seconds");
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
      <Link href="/research/coverage">Coverage</Link><Link href="/diagnostics/reliability">Reliability</Link></nav>
    {data && <p>Summary age: {Math.round(data.summaryAgeMs/1000)} seconds · {data.summaryStale?'STALE — coverage is not current':'CURRENT'}.</p>}
    {error && <div className="warning" role="alert">{error}</div>}
    {alerts.length>0 && <section className="panel"><div className="eyebrow">INFRASTRUCTURE ALERTS</div>
      <ul>{alerts.map((a)=><li key={a}>{a}</li>)}</ul></section>}
    <section className="stats">
      <div className="panel"><div className="eyebrow">UNPRICED SWAPS</div><strong>{data?.priceBackfill.pending ?? "—"}</strong></div>
      <div className="panel"><div className="eyebrow">BACKFILLED USD SWAPS</div><strong>{data?.priceBackfill.backfilled ?? "—"}</strong></div>
      <div className="panel"><div className="eyebrow">FEE JOBS WAITING</div><strong>{data?.counts.queueLength ?? "—"}</strong></div>
      <div className="panel"><div className="eyebrow">OUTCOME LAG</div><strong>{data ? `${Math.round(data.counts.workerLagMs/60000)} min` : "—"}</strong></div>
    </section>
    <section className="panel"><div className="eyebrow">STRATEGY LAB READINESS · EVALUATION ONLY</div>
      <h2>{data?.readiness.status??"UNAVAILABLE"}</h2>
      <p>Selected chains: {data?.readiness.selectedChains.join(", ")??"—"}.
        BSC: {data?.readiness.bsc.status??"UNAVAILABLE"}. No strategy recommendations are generated.</p>
      <div className="table-scroll"><table><thead><tr><th>GATE</th><th>STATUS</th><th>ACTUAL</th><th>REQUIRED</th></tr></thead><tbody>
        {(data?.readiness.gates??[]).map((g)=>{
          const percent=g.hourlyCompliance!==undefined || g.id.startsWith("EPOCH_OUTCOME_") || ["BASE_LIVE_FEES","HOT_PRICE","HOT_DEPTH","OUTCOME_4H","OUTCOME_24H"].includes(g.id);
          const duration=["FOREGROUND_P95","FOREGROUND_P99","FOREGROUND_MAX"].includes(g.id);
          const show=(v:number|null)=>v==null?"—":percent?`${Math.round(v*100)}%`:
            duration?`${(v/1000).toFixed(1)}s`:g.id==="STORAGE_GROWTH"?`${(v/2**30).toFixed(2)} GiB/day`:
              g.id==="SNAPSHOT_CONTINUITY"?`${v.toFixed(1)}%`:
              g.id==="SNAPSHOT_MAX_GAP"?`${(v/60000).toFixed(1)} min`:
              g.id==="STORAGE_RUNWAY"?`${v.toFixed(0)} days`:String(v);
          return <tr key={g.id}><td>{g.id.replaceAll("_"," ")}</td><td>{g.pass?"PASS":"FAIL"}</td>
            <td>{show(g.value)}</td><td>{show(g.target)}</td></tr>;
        })}</tbody></table></div></section>
    <section className="panel"><div className="eyebrow">CLEAN RESEARCH EPOCH</div>
      <p>Epoch: {data?.researchEpoch?.id??"No epoch started"} · {data?.researchEpoch?.status??"UNAVAILABLE"} ·
        run: {data?.burninRunId??"No validation run"}.</p>
      {data?.researchEpoch&&<p>Started {new Date(data.researchEpoch.startedAt).toLocaleString()} ·
        ended {data.researchEpoch.endedAt?new Date(data.researchEpoch.endedAt).toLocaleString():"Open"} ·
        {data.researchEpoch.chainSet.join(", ")} · {data.researchEpoch.reason}
        {data.researchEpoch.invalidationReason?` · Invalidated: ${data.researchEpoch.invalidationReason}`:""}.</p>}
      {data?.researchEpoch&&<details><summary>Epoch methodology versions</summary><p>{Object.entries(data.researchEpoch.methodologyVersions).map(([name,version])=>`${name}: ${version}`).join(" · ")}</p></details>}
      <p>Mature STANDARD-confidence outcomes. Complete means PRICE_RANGE_COMPLETE; partial observations do not count. Historical evidence remains available.</p>
      <div className="table-scroll"><table><thead><tr><th>COHORT</th><th>HORIZON</th><th>MATURE ELIGIBLE</th><th>PRICE / RANGE COMPLETE</th><th>PARTIAL</th><th>MISSING</th></tr></thead><tbody>
        {([['CURRENT_RESEARCH_EPOCH',data?.currentEpochOutcomes??[]],['ALL_HISTORY',data?.allHistoryOutcomes??[]]] as const).flatMap(([cohort,rows])=>rows.map(r=><tr key={`${cohort}:${r.horizon}`}>
          <td>{cohort}</td><td>{r.horizon}</td><td>{r.eligible}</td><td>{ratio(r.priceRangeComplete,r.eligible)}</td><td>{r.partial}</td><td>{r.missing}</td></tr>))}
      </tbody></table></div></section>
    <section className="panel"><div className="eyebrow">REQUIRED PROVIDER SERVICES · SOLANA + BASE</div>
      <div className="table-scroll"><table><thead><tr><th>CHAIN</th><th>SERVICE</th><th>STATUS</th><th>REQUIRED</th><th>FRESH SOURCES</th><th>REASON</th></tr></thead><tbody>
        {(data?.providerServices??[]).map(s=><tr key={`${s.chain}:${s.service}`}><td>{s.chain}</td><td>{s.service}</td><td>{s.state}</td><td>{yes(s.required)}</td><td>{s.sources.join(", ")||"None"}</td><td>{s.reason??"—"}</td></tr>)}
      </tbody></table></div></section>
    <section className="panel"><div className="eyebrow">CONTINUOUS CORE SNAPSHOTS</div>
      <p>{data?.snapshotCoverage.actual??"—"}/{data?.snapshotCoverage.expected??"—"} expected ·
        {data?.snapshotCoverage.coveragePct==null?" —":` ${data.snapshotCoverage.coveragePct.toFixed(1)}%`} cadence coverage ·
        {data?.snapshotCoverage.priceCoveragePct==null?" —":` ${data.snapshotCoverage.priceCoveragePct.toFixed(1)}%`} reliable price coverage ·
        {data?.snapshotCoverage.feeCoveragePct==null?" —":` ${data.snapshotCoverage.feeCoveragePct.toFixed(1)}%`} fee field ·
        {data?.snapshotCoverage.depthCoveragePct==null?" —":` ${data.snapshotCoverage.depthCoveragePct.toFixed(1)}%`} depth field ·
        {data?.snapshotCoverage.maturePools??"—"}/{data?.snapshotCoverage.tracked??"—"} mature pools ·
        largest gap {data?.snapshotCoverage.largestGapMs==null?"—":`${Math.round(data.snapshotCoverage.largestGapMs/60000)} min`}.</p>
      <p>Foreground scan latency ({data?.scanLatency.n??0} runs): median {data?.scanLatency.medianMs==null?"—":`${(data.scanLatency.medianMs/1000).toFixed(1)}s`} ·
        p90 {data?.scanLatency.p90Ms==null?"—":`${(data.scanLatency.p90Ms/1000).toFixed(1)}s`} ·
        p95 {data?.scanLatency.p95Ms==null?"—":`${(data.scanLatency.p95Ms/1000).toFixed(1)}s`} ·
        p99 {data?.scanLatency.p99Ms==null?"—":`${(data.scanLatency.p99Ms/1000).toFixed(1)}s`}.</p>
      <p>Slow foreground calls: {(data?.slowCalls??[]).slice(0,5).map((x)=>
        `${x.source} ${Math.round(x.durationMs)}ms`).join(" · ")||"None recorded"}.
        Skipped overlapping scans: {data?.scanSkippedBecausePreviousRunning??"—"}.</p>
      <p>Recent phase spans: {(data?.scanSpans??[]).slice(0,8).map((s)=>
        `${s.phase}/${s.operation} ${s.durationMs}ms ${s.success?"OK":"FAILED"}`).join(" · ")||"None"}.</p>
      <p>Core writer, last 4h: {data?.coreWriter.successful??"—"}/{data?.coreWriter.attempts??"—"} successful ·
        busy retries {data?.coreWriter.busyRetries??"—"} · maximum write {data?.coreWriter.maxDurationMs??"—"}ms.</p></section>
    <section className="panel"><div className="eyebrow">NEW STORAGE GROWTH</div>
      <p>Measured allocation: {data?.measuredStorageGrowth.bytesPerDay==null?"Unavailable":
        `${(data.measuredStorageGrowth.bytesPerDay/2**30).toFixed(2)} GiB/day`}
        {data?` over ${data.measuredStorageGrowth.hours.toFixed(1)} hours`:""} ·
        timestamp-based row estimate: {data?.storageGrowth.estimatedBytesPerDay==null?"Unavailable":
          `${(data.storageGrowth.estimatedBytesPerDay/2**30).toFixed(2)} GiB/day`}.
        Readiness requires 24 hours of measured total allocation, including indexes and WAL.</p></section>
    <section className="panel"><div className="eyebrow">HOT-POOL CURRENT COVERAGE</div>
      <div className="table-scroll"><table><thead><tr><th>CHAIN</th><th>HOT POOLS</th><th>RELIABLY PRICED</th>
        <th>±5% DEPTH / PRICED</th><th>±5% DEPTH / ALL HOT</th><th>CURRENT 1H FEES</th></tr></thead><tbody>
        {(data?.hotCoverage??[]).map((r)=><tr key={r.chain}><td>{r.chain}</td><td>{r.pools}</td>
          <td>{ratio(r.priced,r.pools)}</td><td>{r.depth5Priced==null?"Unavailable":ratio(r.depth5Priced,r.priced)}</td>
          <td>{ratio(r.depth5,r.pools)}</td><td>{ratio(r.fee1h,r.pools)}</td></tr>)}</tbody></table></div>
      <p>Independent live workers: {(data?.liveRuns??[]).map((r)=>
        `${r.chain} ${r.status}, ${r.swaps} swaps/${r.pools} pools${r.error?` (${r.error})`:""}`).join(" · ")||"Starting"}</p></section>
    <section className="panel"><div className="eyebrow">HOT ACTIVE COVERAGE</div>
      <p>{(data?.hotCoverage??[]).map(r=>`${r.chain}: all HOT ${r.pools}; active or missing ${r.activePools}; fresh cursors ${r.activeFresh}/${r.activePools}; complete 1h fees ${r.activeFee1h}/${r.activePools}`).join(' · ')}. Only proven NO_ACTIVITY pools leave the active denominator.</p>
      <div className="table-scroll"><table><thead><tr><th>POOL</th><th>ACTIVITY</th><th>CURSOR</th><th>LAG</th><th>PRICE</th><th>DEPTH</th><th>TOKEN PRICE EVIDENCE</th></tr></thead><tbody>
        {(data?.hotPoolDetails??[]).filter(r=>['base','solana'].includes(r.chain)).map(r=><tr key={r.poolId}>
          <td><Link href={`/pool/${encodeURIComponent(r.poolId)}`}>{r.chain} {r.poolId.slice(-12)}</Link></td><td>{r.activity}</td><td>{r.cursorState??r.reason}</td><td>{r.lagSeconds==null?'Unavailable':`${Math.round(r.lagSeconds)}s`}</td>
          <td>{r.priced?'Reliable':'Unavailable'}</td><td>{r.depth?'Current':r.depthFailure??'Unavailable'}</td>
          <td>{r.priceTokens.map(t=>`${t.symbol||t.address.slice(-8)}: ${t.reliable?(t.provenance?.kind==='CROSS_POOL'?'DERIVED_PRICE_OK':'DIRECT_PRICE_OK'):t.failures.join(', ')||'NO_SOURCE'}`).join(' · ')}</td>
        </tr>)}</tbody></table></div></section>
    <section className="panel"><div className="eyebrow">RELIABLE PAIR PRICING · EXPLICIT HOT DENOMINATORS</div>
      <div className="table-scroll"><table><thead><tr><th>CHAIN</th><th>COHORT</th><th>RELIABLY PRICED / ELIGIBLE</th></tr></thead><tbody>
        {(data?.hotCoverage??[]).filter(r=>['solana','base'].includes(r.chain)).flatMap(r=>[
          <tr key={`${r.chain}:all`}><td>{r.chain}</td><td>ALL HOT</td><td>{ratio(r.priced,r.pools)}</td></tr>,
          <tr key={`${r.chain}:active`}><td>{r.chain}</td><td>HOT ACTIVE</td><td>{r.activePriced==null?"Unavailable":ratio(r.activePriced,r.activePools)}</td></tr>,
          <tr key={`${r.chain}:signal`}><td>{r.chain}</td><td>HOT SIGNAL</td><td>{r.signalPriced==null||r.signalPools==null?"Unavailable":ratio(r.signalPriced,r.signalPools)}</td></tr>,
        ])}
      </tbody></table></div><p>Signal and active cohorts are shown alongside all HOT pools; no failed pool disappears from the all-HOT denominator.</p></section>
    <section className="panel"><div className="eyebrow">BASE CURSOR LAG · LABELED DENOMINATORS</div>
      <div className="table-scroll"><table><thead><tr><th>COHORT</th><th>POOLS</th><th>KNOWN / UNKNOWN</th><th>MEDIAN</th><th>P90</th><th>P95</th><th>MAX</th></tr></thead><tbody>
        {data?.baseLag&&([['HOT ACTIVE',data.baseLag.hotActive],['ALL HOT',data.baseLag.allHot],['PROVEN NO ACTIVITY',data.baseLag.noActivity]] as const).map(([name,lag])=><tr key={name}>
          <td>{name}</td><td>{lag.total}</td><td>{lag.known} / {lag.unknown}</td><td>{seconds(lag.median)}</td><td>{seconds(lag.p90)}</td><td>{seconds(lag.p95)}</td><td>{seconds(lag.max)}</td></tr>)}
      </tbody></table></div>
      <p>Infrastructure failures remain in the active denominator unless zero activity is proven by complete ingestion.</p></section>
    <section className="panel"><div className="eyebrow">BASE CURRENT 1H FEE WATERFALL</div>
      {data?.baseFeeWaterfall?<p>All HOT {data.baseFeeWaterfall.allHot} · HOT ACTIVE {data.baseFeeWaterfall.active}
        {" → "}live events complete {data.baseFeeWaterfall.eventComplete}{" → "}swap prices complete {data.baseFeeWaterfall.swapPricesComplete}
        {" → "}fee window complete {ratio(data.baseFeeWaterfall.feeComplete,data.baseFeeWaterfall.active)}.</p>:<p>Unavailable</p>}
      <div className="table-scroll"><table><thead><tr><th>INCOMPLETE ACTIVE POOL</th><th>FAILURE</th><th>UNPRICED SWAPS</th></tr></thead><tbody>
        {(data?.baseFeeWaterfall?.failures??[]).map(r=><tr key={r.poolId}><td><Link href={`/pool/${encodeURIComponent(r.poolId)}`}>{r.poolId}</Link></td><td>{r.reason??"OTHER"}</td><td>{r.unpricedSwaps}</td></tr>)}
      </tbody></table></div></section>
    <section className="panel"><div className="eyebrow">HOT TOKEN PRICE WATERFALL · SOLANA + BASE</div>
      <p>Counts are pool-token legs; a shared token can occur in several pools. Failed legs can have multiple recorded causes. Direct and derived successes are separated.</p>
      <div className="table-scroll"><table><thead><tr><th>CHAIN</th><th>RESULT / FAILURE</th><th>POOL-TOKEN LEGS</th></tr></thead><tbody>
        {[...priceCategories].sort(([a],[b])=>a.localeCompare(b)).map(([key,count])=>{const [chain,reason]=key.split(":");return <tr key={key}><td>{chain}</td><td>{reason}</td><td>{count}</td></tr>;})}
      </tbody></table></div>
      <details><summary>HOT price source coverage map · {sourceRows.length} source records</summary>
        <p>Publication latency measures lookup time minus the source publication timestamp. Missing metadata remains unavailable.</p>
        <div className="table-scroll"><table><thead><tr><th>CHAIN + TOKEN ADDRESS</th><th>SOURCE</th><th>DIRECT / DERIVED</th><th>LAST SUCCESS</th><th>LAST FAILURE</th><th>FAILURE</th><th>RESOLUTION</th><th>PUBLICATION LATENCY</th><th>CONFIDENCE</th></tr></thead><tbody>
          {sourceRows.map(r=><tr key={`${r.chain}:${r.asset_address}:${r.source}`}><td>{r.chain} {r.asset_address}</td><td>{r.source}</td><td>{r.kind??"Unavailable"}</td>
            <td>{age(r.last_success,data?.generatedAt??0)}</td><td>{age(r.last_failure,data?.generatedAt??0)}</td><td>{r.failure_reason??"—"}</td><td>{r.coverage_resolution??"Unavailable"}</td>
            <td>{r.publication_latency_ms==null?"Unavailable":`${(r.publication_latency_ms/1000).toFixed(1)}s`}</td><td>{r.confidence??"Unavailable"}</td></tr>)}
        </tbody></table></div></details></section>
    <section className="panel"><div className="eyebrow">PRICED HOT POOLS · ±5% DEPTH FAILURES</div>
      <div className="table-scroll"><table><thead><tr><th>CHAIN</th><th>FAILURE</th><th>POOLS</th></tr></thead><tbody>
        {[...depthFailures].sort(([a],[b])=>a.localeCompare(b)).map(([key,count])=>{const [chain,reason]=key.split(":");return <tr key={key}><td>{chain}</td><td>{reason}</td><td>{count}</td></tr>;})}
      </tbody></table></div><p>Only reliably-priced pools without current depth appear here; unpriced pools remain in the absolute HOT denominator.</p></section>
    <section className="panel"><div className="eyebrow">BSC SOURCE CAPABILITIES</div>
      <p>Live logs: {data?.bscSource.liveLogs?"YES":"NO"} · Historical logs: {data?.bscSource.historicalLogs?"YES":"NO"} ·
        Archive state: {data?.bscSource.archiveState?"YES":"NO"} · WebSocket: {data?.bscSource.websocket??"DISABLED"}.</p>
      <p>A WebSocket alert requires a confirmed HTTP or indexer range before fee coverage is marked complete.</p></section>
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
    <section className="panel"><div className="eyebrow">PRICE / RANGE OUTCOME FIELDS</div>
      <p>STANDARD-confidence signals with full price and ±2.5%/±5%/±10% range evidence:
        {(data?.outcomeFieldCoverage??[]).map((r)=>
          `${r.horizon} ${r.priceRangeComplete}/${r.eligible}`).join(" · ")||" unavailable"}.
        Legacy-inclusive p95 lateness: {data?.recentOutcomeLag.p95Ms==null?"—":
          `${Math.round(data.recentOutcomeLag.p95Ms/60000)} min`}.
        New jobs: {data?.newOutcomeLag.n??0} completed, p95 {data?.newOutcomeLag.p95Ms==null?"—":
          `${Math.round(data.newOutcomeLag.p95Ms/60000)} min`}.</p></section>
    <section className="panel"><div className="eyebrow">LOG SOURCES</div>
      <p>Historical coverage is unknown until a source proves a requested range. Confidence stays low without recorded independent verification.</p>
      <p>Configured indexers: {(data?.eventSources??[]).map((s)=>
        `${s.chain} ${s.purpose} ${s.healthState}, through block ${s.latestIndexedBlock??"unknown"}, ${s.confidence} confidence`).join(" · ")||"None configured"}.
        Cross-check disagreements: {(data?.sourceDisagreements??[]).map((s)=>
          `${s.chain} ${s.disagreements}/${s.compared}`).join(" · ")||"No samples"}.</p>
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
      <p>Disk free {data?.diskSafety?`${(data.diskSafety.freeBytes/1073741824).toFixed(1)} GiB`:"—"} ·
        projected runway {data?.diskSafety?.estimatedDaysRemaining==null?"—":
          `${data.diskSafety.estimatedDaysRemaining.toFixed(0)} days`} ·
        {data?.diskSafety?.warning??"UNAVAILABLE"} · dataset {data?.datasetVersion?.version??"—"}.</p>
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
