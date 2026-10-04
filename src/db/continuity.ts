import {createEpochStore} from "./epochs";
import { existsSync, statfsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type Database from "better-sqlite3";
import { env } from "../config/env";
import type { Pool,Snapshot } from "../core/model";
import type { ScanSpan } from "../core/traffic";
import {sampleTrace} from "../core/clock";
import {activeCursorState,lagDistribution} from "../core/epoch";
import {staleCursorReason} from "../core/live-health";

const minute = 60_000;
export function liveFeeFailure(input:{complete:boolean;covered:boolean;currentWindow:boolean;
  fresh:boolean;error:string|null;continuityState?:string;unpriced:number;swaps:number}) {
  if(input.complete && input.covered && input.currentWindow)return null;
  if(/reorg|block changed|block mismatch|removed log/i.test(input.error??"") || input.continuityState==='REORG_PENDING')return 'REORG_PENDING';
  if(input.error && !input.fresh)return 'PROVIDER_FAILURE';
  if(/source|indexer/i.test(input.error??""))return 'SOURCE_GAP';
  if(!input.currentWindow)return 'WINDOW_NOT_MATURE';
  if(!input.covered)return 'CURSOR_GAP';
  if(input.unpriced>0)return 'UNPRICED_SWAPS';
  return input.swaps===0?'NO_EVENTS':'OTHER';
}
export function diskMode(freeBytes:number) {
  const gib=2**30;
  return freeBytes<env.DISK_EMERGENCY_GIB*gib?"EMERGENCY":
    freeBytes<env.DISK_CRITICAL_GIB*gib?"CRITICAL":
      freeBytes<env.DISK_HIGH_GIB*gib?"HIGH":
        freeBytes<env.DISK_WARNING_GIB*gib?"WARNING":"OK";
}
const hotWhere = `(
  COALESCE(json_extract(p.data,'$.pool.volume1h'),0)>=?
  OR json_extract(p.data,'$.metrics.surge')=1
  OR EXISTS(SELECT 1 FROM watchlist w WHERE w.pool_id=p.id)
  OR EXISTS(SELECT 1 FROM signal_episodes s WHERE s.pool_id=p.id AND s.episode_end IS NULL)
)`;
export interface CoreSnapshotRow {
  poolId:string;timestamp:number;sourceUpdatedAt:number;price:number|null;priceConfidence:string;
  activity:number|null;risk:number|null;volume1h:number|null;fees1h:number|null;
  activeLiquidityUsd:number|null;depth5Usd:number|null;volatility1h:number|null;
}
export interface WalStatus {
  attemptedAt:number;durationMs:number;walBeforeBytes:number;walAfterBytes:number;
  result:{busy:number;logFrames:number;checkpointedFrames:number}|null;
  remainingFrames:number|null;blockedOrPending:boolean;error:string|null;
  ownedReaderAgeMs:number|null;ownedReaderCount:number;
  readerCoverage:"EXPLICIT_OWNED_SCOPES_ONLY";globalReaderAgeMs:null;globalReaderStatus:"UNKNOWN";
}
export function createContinuityStore(sqlite:Database.Database,databasePath:string) {
  const readers=new Map<symbol,{operation:string;startedAt:number}>();
  const walBytes=()=>databasePath!==":memory:" && existsSync(`${resolve(databasePath)}-wal`)?
    statSync(`${resolve(databasePath)}-wal`).size:0;
  const walStatus=():WalStatus|null=>{
    const row=sqlite.prepare("SELECT value FROM app_settings WHERE key='walMaintenanceStatus'").get() as {value:string}|undefined;
    return row?JSON.parse(row.value) as WalStatus:null;
  };
  return {
    // Only explicitly instrumented scopes are observable; SQLite does not expose global reader ages.
    beginOwnedRead(operation:string,startedAt=Date.now()) {
      const id=Symbol(operation);readers.set(id,{operation,startedAt});
      return ()=>{readers.delete(id);};
    },
    ownedReaderStatus(now=Date.now()) {
      return {count:readers.size,oldestAgeMs:readers.size?
        Math.max(0,...Array.from(readers.values(),r=>now-r.startedAt)):null,
      coverage:"EXPLICIT_OWNED_SCOPES_ONLY" as const,globalReaderAgeMs:null};
    },
    walStatus,
    walMaintenance(now=Date.now()):WalStatus|null {
      if(databasePath===":memory:") return null;
      // Persist the throttle across worker restarts and claim it before checkpointing.
      const claimed=sqlite.transaction(()=>{
        const last=sqlite.prepare("SELECT value FROM app_settings WHERE key='walMaintenanceAttempt'").get() as {value:string}|undefined;
        if(last && now-Number(last.value)>=0 && now-Number(last.value)<60000) return false;
        sqlite.prepare("INSERT OR REPLACE INTO app_settings VALUES ('walMaintenanceAttempt',?)").run(String(now));
        return true;
      })();
      if(!claimed) return walStatus();
      const status:WalStatus={attemptedAt:now,durationMs:0,walBeforeBytes:walBytes(),walAfterBytes:0,
        result:null,remainingFrames:null,blockedOrPending:false,error:null,
        ownedReaderAgeMs:readers.size?Math.max(0,...Array.from(readers.values(),r=>now-r.startedAt)):null,
        ownedReaderCount:readers.size,readerCoverage:"EXPLICIT_OWNED_SCOPES_ONLY",
        globalReaderAgeMs:null,globalReaderStatus:"UNKNOWN"};
      const start=performance.now();
      try {
        const result=(sqlite.pragma("wal_checkpoint(PASSIVE)") as {busy:number;log:number;checkpointed:number}[])[0];
        status.result={busy:result.busy,logFrames:result.log,checkpointedFrames:result.checkpointed};
        status.remainingFrames=result.log<0 || result.checkpointed<0?null:Math.max(0,result.log-result.checkpointed);
        // Pending frames can have several causes; this is not proof of a blocking reader.
        status.blockedOrPending=result.busy!==0 || (status.remainingFrames??0)>0;
      } catch(error) {status.error=error instanceof Error?error.message:String(error);}
      status.durationMs=Math.max(0,performance.now()-start);status.walAfterBytes=walBytes();
      sqlite.prepare("INSERT OR REPLACE INTO app_settings VALUES ('walMaintenanceStatus',?)").run(JSON.stringify(status));
      return status;
    },
    burninContext() {
      const row=sqlite.prepare("SELECT value FROM app_settings WHERE key='burninContext'").get() as {value:string}|undefined;
      return row?JSON.parse(row.value) as {startedAt:number;finishedAt?:number;id:string}:null;
    },
    hourlyCheckpoints() {
      const context=this.burninContext();
      const id=context?{id:context.id}:sqlite.prepare("SELECT burnin_id id FROM hourly_slo_checkpoints ORDER BY observed_at DESC LIMIT 1").get() as {id:string}|undefined;
      return id?sqlite.prepare("SELECT data FROM hourly_slo_checkpoints WHERE burnin_id=? ORDER BY hour").all(id.id).map(r=>{const slo=JSON.parse((r as {data:string}).data);delete slo.data;delete slo.storage;delete slo.scans;return slo;}):[];
    },
    scanWindow(from:number,to=Date.now()) {
      const rows=sqlite.prepare("SELECT duration_ms ms,deadline_breached breached FROM scan_traces WHERE started_at BETWEEN ? AND ? ORDER BY duration_ms").all(from,to) as {ms:number;breached:number}[];
      const q=(p:number)=>rows.length?rows[Math.ceil(rows.length*p)-1].ms:null;
      return {count:rows.length,medianMs:q(.5),p95Ms:q(.95),p99Ms:q(.99),maxMs:q(1),breaches:rows.reduce((n,r)=>n+r.breached,0)};
    },
    diagnosticSummary() {
      const row=sqlite.prepare("SELECT updated_at at,data FROM diagnostic_summaries WHERE id='current'").get() as {at:number;data:string}|undefined;
      return row?{updatedAt:row.at,data:JSON.parse(row.data) as Record<string,unknown>}:null;
    },
    saveDiagnosticSummary(data:unknown,at:number) {
      sqlite.prepare("INSERT OR REPLACE INTO diagnostic_summaries VALUES ('current',?,?)").run(at,JSON.stringify(data));
    },
    saveScanTrace(id:number,start:number,end:number,duration:number,monotonic:number,deadline:number,breached:boolean,error:string|null) {
      sqlite.prepare("INSERT OR REPLACE INTO scan_traces VALUES (?,?,?,?,?,?,?,?)").run(id,start,end,duration,monotonic,deadline,Number(breached),error);
      sqlite.prepare("UPDATE scan_metrics SET duration_ms=? WHERE run_id=?").run(duration,id);
      sqlite.prepare("UPDATE scanner_runs SET ended_at=? WHERE id=?").run(end,id);
    },
    scanTrace(id:number) {
      return {root:sqlite.prepare("SELECT * FROM scan_traces WHERE run_id=?").get(id)??null,
        children:sqlite.prepare("SELECT * FROM scan_phase_spans WHERE run_id=? ORDER BY started_at").all(id)};
    },
    keepScanTrace(id:number,elapsed:number,failed:boolean) {
      return !['CRITICAL','EMERGENCY'].includes(this.diskState()) && sampleTrace(id,env.TRACE_NORMAL_SAMPLE_RATE,elapsed,failed,env.TRACE_SLOW_MS);
    },
    saveClockEvent(at:number,event:string,wall:number,monotonic:number) {
      sqlite.prepare("INSERT OR IGNORE INTO system_clock_events VALUES (?,?,?,?)").run(at,event,wall,monotonic);
    },
    clockEvents(from:number,to:number) {
      return sqlite.prepare("SELECT * FROM system_clock_events WHERE detected_at BETWEEN ? AND ? ORDER BY detected_at").all(from,to);
    },
    recordLivePoolHealth(poolId:string,reason:string,error:string|null,swaps:number|null) {
      sqlite.prepare("INSERT OR REPLACE INTO live_pool_health VALUES (?,?,?,?,?)").run(poolId,Date.now(),reason,error?.slice(0,200)??null,swaps);
    },
    livePoolHealth() {return sqlite.prepare("SELECT * FROM live_pool_health").all();},
    pruneTraces(now=Date.now()) {
      // Bounded raw trace removal only; historical pool/signal data and scan aggregates remain.
      const removed=sqlite.prepare("DELETE FROM scan_phase_spans WHERE rowid IN (SELECT rowid FROM scan_phase_spans WHERE ended_at<? LIMIT 1000)")
        .run(now-env.TRACE_RETENTION_HOURS*3600000).changes;
      const slow=sqlite.prepare("DELETE FROM scan_slow_calls WHERE rowid IN (SELECT c.rowid FROM scan_slow_calls c JOIN scanner_runs r ON r.id=c.run_id WHERE r.started_at<? LIMIT 1000)").run(now-env.TRACE_RETENTION_HOURS*3600000).changes;
      sqlite.prepare("UPDATE worker_runs SET notes='RAW_DEBUG_EXPIRED' WHERE id IN (SELECT id FROM worker_runs WHERE ended_at<? AND notes<>'RAW_DEBUG_EXPIRED' LIMIT 1000)").run(now-env.TRACE_RETENTION_HOURS*3600000);
      return removed+slow;
    },
    recordScanSkipped() {
      sqlite.prepare(`INSERT INTO app_settings(key,value) VALUES ('scanSkippedBecausePreviousRunning','1')
        ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1`).run();
    },
    scanSkipped() {
      return Number((sqlite.prepare("SELECT value FROM app_settings WHERE key='scanSkippedBecausePreviousRunning'")
        .get() as {value:string}|undefined)?.value??0);
    },
    recordBscWsStatus(status:string) {
      sqlite.prepare(`INSERT INTO app_settings(key,value) VALUES ('bscWebSocketStatus',?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(JSON.stringify({status,at:Date.now()}));
    },
    bscWsStatus() {
      const row=sqlite.prepare("SELECT value FROM app_settings WHERE key='bscWebSocketStatus'")
        .get() as {value:string}|undefined;
      return row?JSON.parse(row.value) as {status:string;at:number}:null;
    },
    recordCoreWriterRun(at:number,startedAt:number,rows:number,busyRetries:number,state:string) {
      sqlite.prepare(`INSERT INTO core_writer_runs VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(minute) DO UPDATE SET ended_at=excluded.ended_at,
        duration_ms=excluded.duration_ms,rows_written=excluded.rows_written,
        busy_retries=excluded.busy_retries,state=excluded.state`)
        .run(at,startedAt,Date.now(),Date.now()-startedAt,rows,busyRetries,state);
    },
    coreWriterHealth(now=Date.now()) {
      return sqlite.prepare(`SELECT COUNT(*) attempts,SUM(state='OK') successful,
        SUM(busy_retries) busyRetries,MAX(duration_ms) maxDurationMs,
        AVG(duration_ms) avgDurationMs FROM core_writer_runs WHERE minute>=?`)
        .get(now-4*3600000);
    },
    recordScanSpans(runId:number,spans:ScanSpan[]) {
      const insert=sqlite.prepare(`INSERT OR IGNORE INTO scan_phase_spans
        (run_id,phase,operation,provider,started_at,ended_at,duration_ms,timeout_ms,success,aborted,error_class,monotonic_ms)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
      sqlite.transaction(()=>{for(const s of spans) insert.run(runId,s.phase,s.operation,s.provider,
        s.startedAt,s.endedAt,s.durationMs,s.timeoutMs,s.success?1:0,Number(s.aborted??false),s.errorClass??null,s.monotonicMs??null);})();
    },
    recentScanSpans(limit=80) {
      return sqlite.prepare(`SELECT run_id runId,phase,operation,provider,started_at startedAt,
        ended_at endedAt,duration_ms durationMs,timeout_ms timeoutMs,success FROM scan_phase_spans
        ORDER BY run_id DESC,started_at DESC LIMIT ?`).all(limit);
    },
    markService(name:string) {
      sqlite.prepare(`INSERT INTO app_settings(key,value) VALUES (?,?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(`service:${name}`,String(Date.now()));
    },
    publishDepth(pool:Pool) {
      const row=sqlite.prepare("SELECT data FROM pools WHERE id=? AND updated_at=?")
        .get(pool.id,pool.timestamp) as {data:string}|undefined;
      if(!row) return false;
      const data=JSON.parse(row.data) as Snapshot;
      for(const key of ["depth1PctUsd","depth2_5PctUsd","depth5PctUsd","depth10PctUsd",
        "depthConfidence","depthSource","depthUpdatedAt","depthExpiresAt","depthBlock",
        "depthPriceAtCalculation","depthCurrentPrice","depthPriceDriftPct","depthState"] as const)
        (data.pool as unknown as Record<string,unknown>)[key]=pool[key];
      return sqlite.prepare("UPDATE pools SET data=? WHERE id=? AND updated_at=?")
        .run(JSON.stringify(data),pool.id,pool.timestamp).changes>0;
    },
    serviceAlive(name:string,now=Date.now()) {
      const row=sqlite.prepare("SELECT value FROM app_settings WHERE key=?")
        .get(`service:${name}`) as {value:string}|undefined;
      return row!==undefined && now-Number(row.value)<60000;
    },
    recordEventSource(sourceId:string,chain:string,purpose:string,ok:boolean,latestIndexedBlock:number|null,
      historicalFromBlock:number|null,latencyMs:number,error:string|null,verified:boolean) {
      sqlite.prepare(`INSERT INTO event_sources
        (source_id,chain,source_type,purpose,latest_indexed_block,latency_ms,historical_from_block,
         confidence,health_state,last_success_at,last_failure_at,error)
        VALUES (?,?,'INDEXER',?,?,?,?,?,?,?,?,?)
        ON CONFLICT(source_id) DO UPDATE SET
          purpose=excluded.purpose,
          latest_indexed_block=COALESCE(excluded.latest_indexed_block,event_sources.latest_indexed_block),
          latency_ms=excluded.latency_ms,
          historical_from_block=COALESCE(excluded.historical_from_block,event_sources.historical_from_block),
          confidence=excluded.confidence,health_state=excluded.health_state,
          last_success_at=COALESCE(excluded.last_success_at,event_sources.last_success_at),
          last_failure_at=COALESCE(excluded.last_failure_at,event_sources.last_failure_at),error=excluded.error`)
        .run(sourceId,chain,purpose,latestIndexedBlock,latencyMs,historicalFromBlock,
          ok?(verified?"HIGH":"MEDIUM"):"UNAVAILABLE",ok?"HEALTHY":"DEGRADED",
          ok?Date.now():null,ok?null:Date.now(),error?.slice(0,200)??null);
    },
    eventSources() {
      return sqlite.prepare(`SELECT source_id sourceId,chain,source_type sourceType,purpose,
        latest_indexed_block latestIndexedBlock,latency_ms latencyMs,
        historical_from_block historicalFromBlock,confidence,health_state healthState,
        last_success_at lastSuccessAt,last_failure_at lastFailureAt,error FROM event_sources`).all();
    },
    recordSourceCheck(chain:string,sourceId:string,compared:number,disagreements:number,error:string|null) {
      sqlite.prepare("INSERT INTO event_source_checks VALUES (?,?,?,?,?,?)")
        .run(chain,sourceId,Date.now(),compared,disagreements,error?.slice(0,200)??null);
    },
    sourceDisagreementRates() {
      return sqlite.prepare(`SELECT chain,source_id sourceId,SUM(compared_events) compared,
        SUM(disagreements) disagreements FROM event_source_checks
        WHERE checked_at>=? GROUP BY chain,source_id`).all(Date.now()-86400000);
    },
    recordLiveRun(chain:string,startedAt:number,pools:number,swaps:number,error:string|null) {
      sqlite.prepare(`INSERT INTO live_ingestion_runs
        (chain,started_at,ended_at,status,pools,swaps,error) VALUES (?,?,?,?,?,?,?)`)
        .run(chain,startedAt,Date.now(),error?"DEGRADED":"OK",pools,swaps,error?.slice(0,200)??null);
    },
    recentLiveRuns() {
      return sqlite.prepare(`SELECT chain,started_at startedAt,ended_at endedAt,status,pools,swaps,error
        FROM live_ingestion_runs WHERE id IN
        (SELECT MAX(id) FROM live_ingestion_runs GROUP BY chain) ORDER BY chain`).all();
    },
    writeCoreSnapshots(now=Date.now()) {
      const at=Math.floor(now/minute)*minute;
      const freshAfter=at-5*minute;
      const trackedWhere=`(${hotWhere} OR EXISTS (SELECT 1 FROM signal_outcomes o JOIN signal_episodes s ON s.id=o.signal_id JOIN research_epochs e ON e.id=s.research_epoch_id WHERE s.pool_id=p.id AND e.status='ACTIVE' AND o.due_at>=${at}))`;
      return sqlite.transaction(()=>{
        const ids=(sqlite.prepare(`SELECT p.id FROM pools p WHERE ${trackedWhere}`)
          .all(env.PRIORITY_TIER1_VOLUME_1H) as {id:string}[]).map((r)=>r.id);
        const target=new Set(ids);
        const open=sqlite.prepare("SELECT pool_id poolId FROM core_tracking_intervals WHERE ended_at IS NULL")
          .all() as {poolId:string}[];
        const active=new Set(open.map((r)=>r.poolId));
        const add=sqlite.prepare("INSERT OR IGNORE INTO core_tracking_intervals VALUES (?,?,NULL)");
        const close=sqlite.prepare("UPDATE core_tracking_intervals SET ended_at=? WHERE pool_id=? AND ended_at IS NULL");
        for(const id of ids) if(!active.has(id)) add.run(id,at);
        for(const {poolId} of open) if(!target.has(poolId)) close.run(at-minute,poolId);
        return sqlite.prepare(`INSERT OR IGNORE INTO core_snapshots
        (pool_id,timestamp,source_updated_at,price,price_confidence,activity,risk,
         volume_1h,fees_1h,active_liquidity_usd,depth5_usd,volatility_1h,methodology_version)
        SELECT p.id,?,p.updated_at,
          CASE WHEN p.updated_at>=? THEN json_extract(p.data,'$.pool.price') END,
          CASE WHEN p.updated_at>=? THEN COALESCE(json_extract(p.data,'$.metrics.priceConfidence'),'UNAVAILABLE')
            ELSE 'UNAVAILABLE' END,
          CASE WHEN p.updated_at>=? THEN json_extract(p.data,'$.metrics.activity') END,
          CASE WHEN p.updated_at>=? THEN json_extract(p.data,'$.metrics.risk') END,
          CASE WHEN p.updated_at>=? THEN json_extract(p.data,'$.pool.volume1h') END,
          CASE WHEN p.updated_at>=? THEN json_extract(p.data,'$.pool.fees1h') END,
          CASE WHEN p.updated_at>=? THEN json_extract(p.data,'$.pool.activeLiquidityUsd') END,
          CASE WHEN p.updated_at>=? AND json_extract(p.data,'$.pool.depthState')='CURRENT'
            AND json_extract(p.data,'$.pool.depthExpiresAt')>=${at}
            AND json_extract(p.data,'$.pool.depthConfidence') IN ('HIGH','MEDIUM')
            THEN json_extract(p.data,'$.pool.depth5PctUsd') END,
          CASE WHEN p.updated_at>=? THEN json_extract(p.data,'$.pool.realizedVolatility1h') END,
          'sprint8-core-v2'
        FROM pools p WHERE ${trackedWhere}`).run(at,...Array(9).fill(freshAfter),env.PRIORITY_TIER1_VOLUME_1H).changes;
      }).immediate();
    },
    coreHistory(poolId:string,from:number,to:number):CoreSnapshotRow[] {
      return sqlite.prepare(`SELECT pool_id poolId,timestamp,source_updated_at sourceUpdatedAt,
        price,price_confidence priceConfidence,activity,risk,volume_1h volume1h,fees_1h fees1h,
        active_liquidity_usd activeLiquidityUsd,depth5_usd depth5Usd,volatility_1h volatility1h
        FROM core_snapshots WHERE pool_id=? AND timestamp>? AND timestamp<=? AND price IS NOT NULL
        ORDER BY timestamp`).all(poolId,from,to) as CoreSnapshotRow[];
    },
    coreSnapshotCoverage(now=Date.now(),windowMs=4*3600000,selected=false) {
      const at=Math.floor(now/minute)*minute;
      const ids=(selected?sqlite.prepare(`SELECT DISTINCT p.id FROM pools p JOIN core_tracking_intervals t ON t.pool_id=p.id WHERE p.chain IN ('solana','base') AND t.started_at<=? AND (t.ended_at IS NULL OR t.ended_at>=?)`).all(at,at-windowMs):sqlite.prepare(`SELECT p.id FROM pools p WHERE ${hotWhere}`).all(env.PRIORITY_TIER1_VOLUME_1H) as {id:string}[]).map(r=>(r as {id:string}).id);
      const intervals=sqlite.prepare(`SELECT started_at startedAt,ended_at endedAt
        FROM core_tracking_intervals WHERE pool_id=? AND started_at<=?
          AND (ended_at IS NULL OR ended_at>=?) ORDER BY started_at`);
      const query=sqlite.prepare(`SELECT timestamp,price,price_confidence priceConfidence,
        fees_1h fees1h,depth5_usd depth5Usd
        FROM core_snapshots WHERE pool_id=? AND timestamp BETWEEN ? AND ? ORDER BY timestamp`);
      const pools=ids.map((poolId)=>{
        const spans=intervals.all(poolId,at,at-windowMs) as {startedAt:number;endedAt:number|null}[];
        if(!spans.length) return {poolId,expected:1,actual:0,priced:0,fees:0,depth:0,
          coveragePct:0,priceCoveragePct:0,feeCoveragePct:0,depthCoveragePct:0,
          largestGapMs:minute,mature:false};
        let expected=0,actual=0,priced=0,fees=0,depth=0,largestGapMs=0;
        for(const span of spans) {
          const start=Math.max(span.startedAt,at-windowMs),end=Math.min(span.endedAt??at,at);
          if(end<start) continue;
          const rows=query.all(poolId,start,end) as {timestamp:number;price:number|null;
            priceConfidence:string;fees1h:number|null;depth5Usd:number|null}[];
          expected+=Math.floor((end-start)/minute)+1;
          actual+=rows.length;
          priced+=rows.filter((r)=>r.price!==null && ["HIGH","MEDIUM"].includes(r.priceConfidence)).length;
          fees+=rows.filter((r)=>r.fees1h!==null).length;
          depth+=rows.filter((r)=>r.depth5Usd!==null).length;
          let previous=start-minute;
          for(const row of rows) {largestGapMs=Math.max(largestGapMs,row.timestamp-previous);previous=row.timestamp;}
          largestGapMs=Math.max(largestGapMs,end-previous);
        }
        return {poolId,expected,actual,priced,fees,depth,
          coveragePct:expected?Math.min(100,actual/expected*100):null,
          priceCoveragePct:expected?Math.min(100,priced/expected*100):null,
          feeCoveragePct:expected?Math.min(100,fees/expected*100):null,
          depthCoveragePct:expected?Math.min(100,depth/expected*100):null,largestGapMs,
          mature:spans.some((span)=>span.endedAt===null && span.startedAt<=at-windowMs)};
      });
      const expected=pools.reduce((n,p)=>n+p.expected,0);
      const actual=pools.reduce((n,p)=>n+p.actual,0);
      const priced=pools.reduce((n,p)=>n+p.priced,0);
      const fees=pools.reduce((n,p)=>n+p.fees,0),depth=pools.reduce((n,p)=>n+p.depth,0);
      return {tracked:pools.length,maturePools:pools.filter((p)=>p.mature).length,
        expected,actual,priced,fees,depth,
        coveragePct:expected?actual/expected*100:null,priceCoveragePct:expected?priced/expected*100:null,
        feeCoveragePct:expected?fees/expected*100:null,depthCoveragePct:expected?depth/expected*100:null,
        largestGapMs:pools.length?Math.max(...pools.map((p)=>p.largestGapMs??0)):null,pools};
    },
    liveCoverageComplete(poolId:string,start:number,end:number) {
      const intervals=sqlite.prepare('SELECT start_time start,end_time end FROM live_coverage_intervals WHERE pool_id=? AND valid=1 AND end_time>=? AND start_time<=? ORDER BY start_time')
        .all(poolId,start,end) as {start:number;end:number}[];
      let cursor=start;
      for(const i of intervals){if(i.end<cursor)continue;if(i.start>cursor)break;cursor=Math.max(cursor,i.end);}
      const gap=sqlite.prepare('SELECT 1 FROM fee_gaps WHERE pool_id=? AND resolved_at IS NULL AND from_time<? AND to_time>? LIMIT 1').get(poolId,end,start);
      return end>start && cursor>=end && !gap;
    },
    hotLagDistributions(now=Date.now()) {
      const all=this.hotPoolDetails(now).filter(r=>r.chain==='base');
      return {allHot:lagDistribution(all),hotActive:lagDistribution(all.filter(r=>r.activity!=='NO_ACTIVITY')),
        noActivity:lagDistribution(all.filter(r=>r.activity==='NO_ACTIVITY'))};
    },
    feeWaterfall(now=Date.now()) {
      const all=this.hotPoolDetails(now).filter(r=>r.chain==='base'),active=all.filter(r=>r.activity!=='NO_ACTIVITY');
      return {allHot:all.length,active:active.length,eventComplete:active.filter(r=>r.eventCovered && r.currentWindow).length,
        swapPricesComplete:active.filter(r=>r.eventCovered && r.currentWindow && r.unpricedSwaps===0).length,
        feeComplete:active.filter(r=>r.feeComplete).length,failures:active.filter(r=>!r.feeComplete).map(r=>({poolId:r.poolId,reason:r.feeFailure,unpricedSwaps:r.unpricedSwaps}))};
    },
    hotPoolDetails(now=Date.now()) {
      const rows=sqlite.prepare(`SELECT p.id,p.chain,p.data,EXISTS(SELECT 1 FROM signal_episodes s WHERE s.pool_id=p.id AND s.episode_end IS NULL) signalActive,l.end_time cursorTime,l.head_time headTime,
        l.updated_at cursorUpdatedAt,h.reason,h.last_error error,
        (SELECT MAX(timestamp) FROM fee_events e WHERE e.pool_id=p.id) lastSwapTimestamp,
        (SELECT MAX(block_number) FROM fee_events e WHERE e.pool_id=p.id) lastSwapBlock,
        (SELECT reason FROM depth_failures d WHERE d.pool_id=p.id AND d.last_at>=? ORDER BY last_at DESC LIMIT 1) depthReason,
        (SELECT f.data FROM fee_windows f WHERE f.pool_id=p.id AND f.window_name='1h' ORDER BY window_end DESC LIMIT 1) fee
        FROM pools p LEFT JOIN live_fee_cursors l ON l.pool_id=p.id LEFT JOIN live_pool_health h ON h.pool_id=p.id
        WHERE ${hotWhere}`).all(now-300000,env.PRIORITY_TIER1_VOLUME_1H) as Record<string,unknown>[];
      return rows.map(row=>{
        const data=JSON.parse(String(row.data)) as Snapshot,p=data.pool;
        const fee=row.fee?JSON.parse(String(row.fee)):null;
        const complete=fee?.windowEnd>=now-300000 && fee?.windowEnd<=now+30000 && fee?.continuityState==='COMPLETE' &&
          fee?.coveragePct>=99.9 && fee?.methodology==='EVENT_DERIVED';
        const reliable=(token:typeof p.token0)=>['HIGH','MEDIUM'].includes(token.usdPriceConfidence??'') &&
          token.usdPriceSourceTimestamp!=null && token.usdPriceSourceTimestamp>=now-env.PRICE_MEDIUM_AGE_SECONDS*1000 &&
          token.usdPriceSourceTimestamp<=now+30000 && token.usdPrice!==null;
        const priced=p.timestamp>=now-300000 && reliable(p.token0) && reliable(p.token1) &&
          ['HIGH','MEDIUM'].includes(data.metrics.priceConfidence??'');
        const depth=p.depth5PctUsd!==null && p.depthState==='CURRENT' && (p.depthExpiresAt??0)>=now &&
          ['HIGH','MEDIUM'].includes(p.depthConfidence??'') && (p.depthPriceDriftPct??Infinity)<=env.DEPTH_PRICE_DRIFT_PCT;
        const lag=row.cursorTime==null?null:Math.max(0,(now-Number(row.cursorTime))/1000);
        const fresh=lag!==null && lag<=120 && row.headTime!=null && now-Number(row.headTime)<=180000 && Number(row.headTime)<=now+30000;
        const covered=!!fee && this.liveCoverageComplete(p.id,fee.windowStart,fee.windowEnd);
        const activity=complete && covered && fee.activityState==='NO_ACTIVITY'?'NO_ACTIVITY':'ACTIVE_OR_MISSING';
        const cursorState=activeCursorState({fresh,lagSeconds:lag,provenZero:activity==='NO_ACTIVITY',ingestionCovered:covered,
          recentSwaps:fee?.swapCount??null,error:row.error==null?null:String(row.error)});
        const currentWindow=fee?.windowEnd>=now-300000 && fee?.windowEnd<=now+30000;
        const recent=sqlite.prepare(`SELECT COUNT(*) swaps,SUM(volume_usd IS NULL OR COALESCE(lp_fee_usd,fees_usd) IS NULL) unpriced
          FROM fee_events WHERE pool_id=? AND timestamp>=? AND timestamp<?`).get(p.id,
            currentWindow?fee.windowStart:Math.floor(now/60000)*60000-3600000,
            currentWindow?fee.windowEnd:Math.floor(now/60000)*60000) as {swaps:number;unpriced:number|null};
        const feeFailure=liveFeeFailure({complete,covered,currentWindow,fresh,
          error:row.error==null?null:String(row.error),continuityState:fee?.continuityState,
          unpriced:recent.unpriced??0,swaps:recent.swaps});
        const reason=staleCursorReason({fresh,lagSeconds:lag,headAgeSeconds:row.headTime==null?null:(now-Number(row.headTime))/1000,
          updatedAgeSeconds:row.cursorUpdatedAt==null?null:(now-Number(row.cursorUpdatedAt))/1000,
          error:row.error==null?null:String(row.error),covered:complete,swaps:fee?.swapCount??null});
        const failures=[p.token0,p.token1].map(token=>({address:token.address,symbol:token.symbol,
          reliable:reliable(token),provenance:token.priceProvenance??null,failures:(token.priceFailures??[]).map(f=>({MISSING:"NO_SOURCE",NO_RELIABLE_SOURCE:"NO_SOURCE",INVALID_RESPONSE:"MAPPING_ERROR",FUTURE_TIMESTAMP:"TIMESTAMP_MISMATCH",HTTP_ERROR:"OTHER",RATE_LIMITED:"SOURCE_RATE_LIMIT",TIMEOUT:"SOURCE_TIMEOUT",STALE:"STALE",DISAGREEMENT:"PRICE_DISAGREEMENT"} as Record<string,string>)[f.reason]??"OTHER")}));
        return {poolId:p.id,chain:p.chain,signalActive:!!row.signalActive,priced,depth,feeComplete:complete && covered,activity,fresh,lagSeconds:lag,reason,
          cursorState,eventCovered:covered,currentWindow,unpricedSwaps:recent.unpriced??0,feeFailure,
          zeroActivityState:activity==='NO_ACTIVITY'?'COMPLETE_ZERO_ACTIVITY':null,
          depthFailure:depth?null:!priced?'UNPRICED':row.depthReason?({TICK_READ_LIMIT:'TICK_DATA_MISSING',NO_TICKS:'TICK_DATA_MISSING',STALE_PRICE:'PRICE_DRIFT',RPC_UNSUPPORTED:'PROVIDER_FAILURE',POOL_STATE_FAILURE:'STATE_READ_FAILURE',INDEXER_STALE:'CACHE_STALE',PROVIDER_FAILURE:'PROVIDER_FAILURE'} as Record<string,string>)[String(row.depthReason)]??'RECONSTRUCTION_ERROR':(p.depthState==='STALE'?'CACHE_STALE':'QUEUE_DELAY'),
          lastSwapTimestamp:row.lastSwapTimestamp,lastSwapBlock:row.lastSwapBlock,priceTokens:failures};
      });
    },
    hotCoverage(now=Date.now()) {
      const rows=this.hotPoolDetails(now);
      return [...new Set(rows.map(r=>r.chain))].sort().map(chain=>{
        const pools=rows.filter(r=>r.chain===chain),active=pools.filter(r=>r.activity!=='NO_ACTIVITY');
        return {chain,pools:pools.length,priced:pools.filter(r=>r.priced).length,
          depth5:pools.filter(r=>r.depth).length,depth5Priced:pools.filter(r=>r.depth && r.priced).length,
          fee1h:pools.filter(r=>r.feeComplete).length,activePools:active.length,
          activeFee1h:active.filter(r=>r.feeComplete).length,activeFresh:active.filter(r=>r.fresh).length,
          signalPools:pools.filter(r=>r.signalActive).length,signalPriced:pools.filter(r=>r.signalActive&&r.priced).length,activePriced:active.filter(r=>r.priced).length,
          noActivity:pools.length-active.length};
      });
    },
    scanLatency(limit=20) {
      const a=(sqlite.prepare("SELECT duration_ms ms FROM scan_metrics ORDER BY run_id DESC LIMIT ?")
        .all(limit) as {ms:number}[]).map((r)=>r.ms).sort((x,y)=>x-y);
      const q=(p:number)=>a.length?a[Math.ceil(a.length*p)-1]:null;
      return {n:a.length,medianMs:q(.5),p90Ms:q(.9),p95Ms:q(.95),p99Ms:q(.99)};
    },
    recordScanSlowCalls(runId:number,calls:{source:string;durationMs:number;reason:string}[]) {
      const insert=sqlite.prepare("INSERT INTO scan_slow_calls VALUES (?,?,?,?)");
      sqlite.transaction(()=>{for(const call of calls) insert.run(runId,call.source,call.durationMs,call.reason);})();
    },
    recentSlowCalls(limit=20) {
      return sqlite.prepare(`SELECT run_id runId,source,duration_ms durationMs,reason
        FROM scan_slow_calls ORDER BY run_id DESC LIMIT ?`).all(limit);
    },
    recentOutcomeLag(now=Date.now()) {
      const a=(sqlite.prepare(`SELECT completed_at-due_at lag FROM signal_outcomes
        WHERE completed_at>=? ORDER BY lag`).all(now-86400000) as {lag:number}[]).map((r)=>r.lag);
      return {n:a.length,medianMs:a.length?a[Math.floor((a.length-1)*.5)]:null,
        p95Ms:a.length?a[Math.floor((a.length-1)*.95)]:null};
    },
    newOutcomeLag(now=Date.now()) {
      const epochs=createEpochStore(sqlite);if(epochs.researchEpoch())return {...epochs.epochOutcomeLag(now),legacyCount:0};
      const row=sqlite.prepare("SELECT valid_from at FROM dataset_versions WHERE version='sprint9-v3'")
        .get() as {at:number}|undefined;
      if(!row) return {n:0,p95Ms:null,legacyCount:0};
      const newLags=(sqlite.prepare(`SELECT o.completed_at-o.due_at lag FROM signal_outcomes o
        JOIN signal_episodes s ON s.id=o.signal_id
        WHERE s.episode_start>=? AND o.due_at>=? AND o.due_at<=?
          AND o.completed_at IS NOT NULL ORDER BY lag`)
        .all(row.at,row.at,now) as {lag:number}[]).map((r)=>r.lag);
      const legacyCount=(sqlite.prepare(`SELECT COUNT(*) n FROM signal_outcomes o
        JOIN signal_episodes s ON s.id=o.signal_id
        WHERE s.episode_start<? AND o.completed_at>=?`).get(row.at,row.at) as {n:number}).n;
      return {n:newLags.length,p95Ms:newLags.length?
        newLags[Math.ceil(newLags.length*.95)-1]:null,legacyCount};
    },
    outcomeFieldCoverage(now=Date.now(),selected=false) {
      return sqlite.prepare(`SELECT o.horizon,COUNT(*) eligible,
        SUM(o.status IN ('COMPLETE','PRICE_RANGE_COMPLETE')
          AND json_extract(o.data,'$.endpointAt') IS NOT NULL
          AND json_extract(o.data,'$.priceReturn') IS NOT NULL
          AND json_extract(o.data,'$.observationCoveragePct')>=80
          AND json_extract(o.data,'$.priceAtSignal') IS NOT NULL
          AND json_extract(o.data,'$.priceAtHorizon') IS NOT NULL
          AND json_extract(o.data,'$.maxPriceMoveUp') IS NOT NULL
          AND json_extract(o.data,'$.maxPriceMoveDown') IS NOT NULL
          AND json_extract(o.data,'$.ranges."2.5".timeSpentInRangePct') IS NOT NULL
          AND json_extract(o.data,'$.ranges."5".timeSpentInRangePct') IS NOT NULL
          AND json_extract(o.data,'$.ranges."10".timeSpentInRangePct') IS NOT NULL
          AND json_extract(o.data,'$.ranges."2.5".remainedInRange') IS NOT NULL
          AND json_extract(o.data,'$.ranges."5".remainedInRange') IS NOT NULL
          AND json_extract(o.data,'$.ranges."10".remainedInRange') IS NOT NULL) priceRangeComplete
        FROM signal_outcomes o JOIN signal_episodes s ON s.id=o.signal_id
        JOIN pools p ON p.id=s.pool_id
        WHERE o.due_at<=? AND json_extract(s.data,'$.metrics.dataQuality') IN ('HIGH','MEDIUM')
          AND (?=0 OR p.chain IN ('solana','base'))
        GROUP BY o.horizon`).all(now,selected?1:0) as {horizon:string;eligible:number;priceRangeComplete:number}[];
    },
    datasetVersion() {
      return sqlite.prepare("SELECT * FROM dataset_versions ORDER BY valid_from DESC LIMIT 1").get();
    },
    measuredStorageGrowth(now=Date.now()) {
      const latest=sqlite.prepare(`SELECT measured_at at,database_bytes databaseBytes,
        free_bytes freeBytes,objects_json objects FROM storage_measurements
        WHERE measured_at<=? ORDER BY measured_at DESC LIMIT 1`)
        .get(now) as {at:number;databaseBytes:number;freeBytes:number;objects:string}|undefined;
      if(!latest) return {hours:0,bytesPerDay:null,allocatedBytes:null,databaseBytesDelta:null};
      const prior=sqlite.prepare(`SELECT measured_at at,database_bytes databaseBytes,
        free_bytes freeBytes,objects_json objects FROM storage_measurements
        WHERE measured_at<=? ORDER BY measured_at DESC LIMIT 1`)
        .get(latest.at-24*3600000) as typeof latest ?? sqlite.prepare(`SELECT measured_at at,database_bytes databaseBytes,free_bytes freeBytes,objects_json objects FROM storage_measurements WHERE measured_at<=? ORDER BY measured_at ASC LIMIT 1`).get(latest.at-4*3600000) as typeof latest;
      if(!prior) return {hours:0,bytesPerDay:null,allocatedBytes:null,databaseBytesDelta:null};
      const beforeRows=JSON.parse(prior.objects) as {name:string;bytes:number}[];
      const afterRows=JSON.parse(latest.objects) as {name:string;bytes:number}[];
      const before=new Map(beforeRows.map(r=>[r.name,r.bytes]));
      const occupiedDelta=afterRows.filter(r=>!r.name.startsWith('__')).reduce((sum,r)=>sum+r.bytes-(before.get(r.name)??0),0);
      const walDelta=(afterRows.find(r=>r.name==='__wal')?.bytes??0)-(before.get('__wal')??0);
      const allocatedBytes=Math.max(0,occupiedDelta,latest.databaseBytes-prior.databaseBytes+walDelta);
      const hours=(latest.at-prior.at)/3600000;
      return {hours,allocatedBytes,databaseBytesDelta:latest.databaseBytes-prior.databaseBytes,
        bytesPerDay:hours>0?allocatedBytes*24/hours:null};
    },
    storageGrowthSinceVersion(now=Date.now()) {
      const row=sqlite.prepare("SELECT MAX(valid_from) at FROM dataset_versions")
        .get() as {at:number}|undefined;
      if(!row) return {hours:0,estimatedBytesPerDay:null,rows:[]};
      const tables=[
        ["pool_snapshots","timestamp",null],["core_snapshots","timestamp",180],
        ["price_observations","observed_at",190],["fee_events","timestamp",450],
        ["fee_windows","window_end",null],["depth_observations","timestamp",null],
        ["signal_episodes","episode_start",5500],["signal_outcomes","completed_at",null],
        ["fee_minute_buckets","bucket_start",120],["candles","timestamp",null],
        ["alerts","timestamp",null],["scan_phase_spans","started_at",140],
        ["live_ingestion_runs","started_at",180],["core_writer_runs","minute",100],
        ["rpc_request_minutes","minute_start",100],
      ] as const;
      const rows=tables.map(([name,column,fixed])=>{
        const count=(sqlite.prepare(`SELECT COUNT(*) n FROM ${name} WHERE ${column}>=?`)
          .get(row.at) as {n:number}).n;
        const sample=fixed??((sqlite.prepare(`SELECT AVG(LENGTH(data)) n FROM
          (SELECT data FROM ${name} WHERE data IS NOT NULL ORDER BY rowid DESC LIMIT 100)`)
          .get() as {n:number|null}).n??0)+96;
        return {name,count,estimatedBytes:Math.round(count*sample*1.5)};
      });
      const hours=Math.max(0,(now-row.at)/3600000);
      return {hours,estimatedBytesPerDay:hours>0?
        Math.round(rows.reduce((n,r)=>n+r.estimatedBytes,0)*24/hours):null,rows};
    },
    openFeeGaps(poolId:string,from:number,to:number) {
      return sqlite.prepare(`SELECT from_block fromBlock,to_block toBlock,from_time fromTime,to_time toTime,reason
        FROM fee_gaps WHERE pool_id=? AND resolved_at IS NULL AND from_time<? AND to_time>?`)
        .all(poolId,to,from);
    },
    recordFeeGap(poolId:string,fromBlock:number,toBlock:number,fromTime:number,toTime:number,reason:string) {
      if(fromBlock>toBlock || fromTime>=toTime) return;
      sqlite.prepare(`INSERT OR IGNORE INTO fee_gaps
        (pool_id,from_block,to_block,from_time,to_time,reason,detected_at) VALUES (?,?,?,?,?,?,?)`)
        .run(poolId,fromBlock,toBlock,fromTime,toTime,reason,Date.now());
    },
    resolveFeeGaps(poolId:string,fromBlock:number,toBlock:number) {
      sqlite.prepare(`UPDATE fee_gaps SET resolved_at=? WHERE pool_id=? AND resolved_at IS NULL
        AND from_block>=? AND to_block<=?`).run(Date.now(),poolId,fromBlock,toBlock);
    },
    cacheDepthReconstruction(poolId:string,stateKey:string,blockId:string,data:unknown) {
      sqlite.prepare(`INSERT INTO depth_reconstruction_cache VALUES (?,?,?,?,?)
        ON CONFLICT(pool_id) DO UPDATE SET state_key=excluded.state_key,block_id=excluded.block_id,
          updated_at=excluded.updated_at,data=excluded.data`).run(poolId,stateKey,blockId,Date.now(),JSON.stringify(data));
    },
    depthReconstruction(poolId:string,stateKey:string,blockId:string) {
      const row=sqlite.prepare(`SELECT data FROM depth_reconstruction_cache WHERE pool_id=?
        AND state_key=? AND block_id=? AND updated_at>=?`).get(poolId,stateKey,blockId,Date.now()-120000) as {data:string}|undefined;
      return row?JSON.parse(row.data) as unknown:null;
    },
    diskSafety(estimatedBytesPerDay:number|null) {
      if(databasePath===':memory:') return null;
      const fs=statfsSync(dirname(resolve(databasePath)));
      const freeBytes=fs.bavail*fs.bsize;
      return {freeBytes,estimatedDaysRemaining:estimatedBytesPerDay!==null && estimatedBytesPerDay>0?
        freeBytes/estimatedBytesPerDay:null,
        warning:diskMode(freeBytes)};
    },
    diskState() {
      if(databasePath===':memory:') return "OK";
      const fs=statfsSync(dirname(resolve(databasePath)));
      return diskMode(fs.bavail*fs.bsize);
    },
  };
}
