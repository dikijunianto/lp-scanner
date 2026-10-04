import type Database from 'better-sqlite3';
import {randomUUID} from 'node:crypto';
import {epochMethodologies,epochInvalidation,coveredIntervals,type ResearchEpoch,type ServiceHealth} from '../core/epoch';
import {env} from '../config/env';
const epoch=(r:Record<string,unknown>):ResearchEpoch=>({id:String(r.id),startedAt:Number(r.started_at),
  endedAt:r.ended_at==null?null:Number(r.ended_at),status:r.status as ResearchEpoch['status'],
  methodologyVersions:JSON.parse(String(r.methodology_versions)),chainSet:JSON.parse(String(r.chain_set)),
  reason:String(r.reason),invalidationReason:r.invalidation_reason==null?null:String(r.invalidation_reason)});
export function createEpochStore(sqlite:Database.Database) {return {
  researchEpoch(id?:string):ResearchEpoch|null {
    const row=(id?sqlite.prepare('SELECT * FROM research_epochs WHERE id=?').get(id):
      sqlite.prepare('SELECT * FROM research_epochs ORDER BY started_at DESC LIMIT 1').get()) as Record<string,unknown>|undefined;
    return row?epoch(row):null;
  },
  startResearchEpoch(health:{snapshotHealthy:boolean;deadlineHealthy:boolean;servicesAcceptable:boolean},reason:string,now=Date.now()) {
    if(!health.snapshotHealthy || !health.deadlineHealthy || !health.servicesAcceptable)
      throw new Error('Clean epoch requires healthy snapshots, foreground deadlines and required services');
    const id=randomUUID();
    sqlite.prepare("INSERT INTO research_epochs(id,started_at,status,methodology_versions,chain_set,reason) VALUES (?,?,'ACTIVE',?,?,?)")
      .run(id,now,JSON.stringify(epochMethodologies),JSON.stringify(['solana','base']),reason);
    return this.researchEpoch(id)!;
  },
  finishResearchEpoch(id:string,status:'COMPLETE'|'INVALID',reason:string|null=null,now=Date.now()) {
    return sqlite.prepare("UPDATE research_epochs SET status=?,ended_at=?,invalidation_reason=? WHERE id=? AND status='ACTIVE'")
      .run(status,now,reason,id).changes>0;
  },
  validateResearchEpoch(input:{snapshotPct:number|null;largestGapMs:number|null;breaches:number;services:ServiceHealth[];integrityOk:boolean},now=Date.now()) {
    const current=this.researchEpoch();if(current?.status!=='ACTIVE')return current;
    const key=`epoch-outage:${current.id}`;
    const old=sqlite.prepare('SELECT value FROM app_settings WHERE key=?').get(key) as {value:string}|undefined;
    const unavailable=input.services.some(s=>s.required && s.state==='UNAVAILABLE');
    const since=unavailable?Number(old?.value??now):now;
    if(unavailable)sqlite.prepare('INSERT OR IGNORE INTO app_settings VALUES (?,?)').run(key,String(since));
    else sqlite.prepare('DELETE FROM app_settings WHERE key=?').run(key);
    const reason=epochInvalidation({...input,unavailableForMs:unavailable?now-since:0,ageMs:now-current.startedAt},env.EPOCH_SERVICE_TOLERANCE_SECONDS*1000);
    if(reason)this.finishResearchEpoch(current.id,'INVALID',reason,now);
    return this.researchEpoch(current.id);
  },
  epochOutcomeCoverage(now=Date.now(),epochId:string|null=null) {
    const rows=sqlite.prepare(`SELECT o.horizon,COUNT(*) eligible,
      SUM(o.status IN ('PRICE_RANGE_COMPLETE','COMPLETE') AND json_extract(o.data,'$.completenessClasses') LIKE '%PRICE_RANGE_COMPLETE%') priceRangeComplete,
      SUM(o.status='PARTIAL') partial,SUM(o.status NOT IN ('COMPLETE','PRICE_RANGE_COMPLETE','PARTIAL') OR (o.status IN ('COMPLETE','PRICE_RANGE_COMPLETE') AND COALESCE(json_extract(o.data,'$.completenessClasses'),'') NOT LIKE '%PRICE_RANGE_COMPLETE%')) missing
      FROM signal_outcomes o JOIN signal_episodes s ON s.id=o.signal_id JOIN pools p ON p.id=s.pool_id
      WHERE p.chain IN ('solana','base') AND o.due_at<=?
      AND json_extract(s.data,'$.metrics.dataQuality') IN ('HIGH','MEDIUM')
      AND (? IS NULL OR s.research_epoch_id=?) GROUP BY o.horizon`).all(now,epochId,epochId) as {
        horizon:string;eligible:number;priceRangeComplete:number;partial:number;missing:number}[];
    return ['30m','1h','4h','24h'].map(horizon=>rows.find(r=>r.horizon===horizon)??{horizon,eligible:0,priceRangeComplete:0,partial:0,missing:0});
  },
  epochOutcomeLag(now=Date.now(),windowMs=3600000) {
    const current=this.researchEpoch();
    if(!current)return {n:0,p95Ms:null,pending:0,oldestPendingLagMs:null};
    const rows=sqlite.prepare(`SELECT MAX(0,COALESCE(completed_at,?)-due_at) lag,completed_at completedAt
      FROM signal_outcomes WHERE research_epoch_id=? AND due_at<=?
      AND (due_at>=? OR completed_at>=? OR completed_at IS NULL) ORDER BY lag`)
      .all(now,current.id,now,now-windowMs,now-windowMs) as {lag:number;completedAt:number|null}[];
    const pending=rows.filter(r=>r.completedAt===null);
    return {n:rows.length,p95Ms:rows.length?rows[Math.ceil(rows.length*.95)-1].lag:null,
      pending:pending.length,oldestPendingLagMs:pending.length?Math.max(...pending.map(r=>r.lag)):null};
  },
  integrityStatus() {const row=sqlite.prepare("SELECT value FROM app_settings WHERE key='dbIntegrity'").get() as {value:string}|undefined;
    return row?JSON.parse(row.value) as {state:'OK'|'FAIL';at:number;result:string}:null;},
  epochLaunchHealth(now=Date.now()) {
    const writer=sqlite.prepare("SELECT ended_at,state FROM core_writer_runs ORDER BY minute DESC LIMIT 1").get() as {ended_at:number;state:string}|undefined;
    const scans=sqlite.prepare('SELECT started_at,finished_at ended_at,deadline_breached,duration_ms FROM scan_traces ORDER BY run_id DESC LIMIT 3').all() as {started_at:number;ended_at:number;deadline_breached:number;duration_ms:number}[];
    return {snapshotHealthy:!!writer && writer.state==='OK' && now-writer.ended_at<=120000 && writer.ended_at<=now,
      deadlineHealthy:scans.length>0 && scans[0].ended_at<=now && now-scans[0].ended_at<=120000 && scans.every(s=>!s.deadline_breached && s.duration_ms<=20000)};
  },
  beginBurninRun(id:string,researchEpochId:string,expectedDurationMs:number,keepAwakeStatus:string,data:unknown) {
    sqlite.prepare("INSERT INTO burnin_runs VALUES (?,?,NULL,NULL,?,NULL,'WARMUP','sprint10-v4',?,?)")
      .run(id,researchEpochId,expectedDurationMs,keepAwakeStatus,JSON.stringify(data));
  },
  updateBurninRun(id:string,start:number|null,end:number|null,status:string,data:unknown) {
    sqlite.prepare("UPDATE burnin_runs SET started_at=?,ended_at=?,actual_duration_ms=?,status=?,data=?,keep_awake_status=COALESCE(json_extract(?,'$.keepAwakeStatus'),keep_awake_status) WHERE id=?")
      .run(start,end,start!==null&&end!==null?end-start:null,status,JSON.stringify(data),JSON.stringify(data),id);
  },
  latestBurninRun() {return sqlite.prepare('SELECT * FROM burnin_runs ORDER BY rowid DESC LIMIT 1').get() as {
    id:string;research_epoch_id:string;started_at:number|null;ended_at:number|null;status:string;data:string}|undefined;},
  liveIntervalCoverage(poolId:string,start:number,end:number) {
    const rows=sqlite.prepare('SELECT start_time start,end_time end FROM live_coverage_intervals WHERE pool_id=? AND valid=1 AND end_time>=? AND start_time<=?')
      .all(poolId,start,end) as {start:number;end:number}[];
    const gap=sqlite.prepare('SELECT 1 FROM fee_gaps WHERE pool_id=? AND resolved_at IS NULL AND from_time<? AND to_time>? LIMIT 1').get(poolId,end,start);
    return !gap && coveredIntervals(rows,start,end);
  },
  enqueueDepth(poolId:string,reason:string,now=Date.now()) {
    return sqlite.prepare('INSERT OR IGNORE INTO depth_refresh_queue(pool_id,enqueued_at,reason) VALUES (?,?,?)').run(poolId,now,reason).changes;
  },
  pendingDepthIds(limit=200) {return (sqlite.prepare('SELECT pool_id FROM depth_refresh_queue ORDER BY enqueued_at LIMIT ?').all(limit) as {pool_id:string}[]).map(r=>r.pool_id);},
  finishDepthRefresh(poolId:string) {sqlite.prepare('DELETE FROM depth_refresh_queue WHERE pool_id=?').run(poolId);},
  recordPriceSource(chain:string,address:string,source:string,success:boolean,at:number,detail:{reason?:string;sourceTimestamp?:number|null;resolution?:string;confidence?:string;kind?:string}) {
    sqlite.prepare(`INSERT INTO price_source_coverage VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(chain,asset_address,source) DO UPDATE SET last_success=COALESCE(excluded.last_success,last_success),
      last_failure=COALESCE(excluded.last_failure,last_failure),failure_reason=excluded.failure_reason,
      publication_timestamp=COALESCE(excluded.publication_timestamp,publication_timestamp),
      coverage_resolution=COALESCE(excluded.coverage_resolution,coverage_resolution),
      publication_latency_ms=COALESCE(excluded.publication_latency_ms,publication_latency_ms),
      confidence=COALESCE(excluded.confidence,confidence),kind=COALESCE(excluded.kind,kind)`)
      .run(chain,address,source,success?at:null,success?null:at,detail.reason??null,detail.sourceTimestamp??null,
        detail.resolution??null,detail.sourceTimestamp==null?null:at-detail.sourceTimestamp,detail.confidence??null,detail.kind??null);
  },
  priceSourceCoverage() {return sqlite.prepare('SELECT * FROM price_source_coverage').all();},
  serviceEvidence(now=Date.now()) {
    const evidence:{chain:string;service:string;source:string;lastSuccessAt:number|null;healthy:boolean}[]=[];
    const run=sqlite.prepare("SELECT ended_at,data FROM scanner_runs WHERE ended_at IS NOT NULL ORDER BY id DESC LIMIT 1").get() as {ended_at:number;data:string}|undefined;
    if(run)for(const source of JSON.parse(run.data) as {name:string;status:string;pools:number}[])
      if(source.pools>0 && source.status!=='error')evidence.push({chain:source.name.includes('Meteora')?'solana':source.name.includes('Uniswap')?'base':'bsc',
        service:'POOL_DISCOVERY',source:source.name,lastSuccessAt:run.ended_at,healthy:source.status==='ok'});
    const prices=sqlite.prepare('SELECT chain,source,MAX(last_success) at FROM price_source_coverage WHERE confidence IN (\'HIGH\',\'MEDIUM\') GROUP BY chain,source')
      .all() as {chain:string;source:string;at:number}[];
    for(const p of prices)evidence.push({chain:p.chain,service:'PRICE',source:p.source,lastSuccessAt:p.at,healthy:true});
    const states=sqlite.prepare("SELECT chain,MAX(json_extract(data,'$.pool.pairState.sourceTimestamp')) at FROM pools GROUP BY chain").all() as {chain:string;at:number|null}[];
    for(const p of states)for(const service of ['CURRENT_STATE','DEPTH_STATE'])evidence.push({chain:p.chain,service,
      source:'VALIDATED_PINNED_POOL_STATE',lastSuccessAt:p.at,healthy:true});
    const logs=sqlite.prepare("SELECT chain,source_id sourceId,MAX(updated_at) at FROM live_fee_cursors GROUP BY chain,source_id").all() as {chain:string;sourceId:string;at:number}[];
    for(const p of logs)evidence.push({chain:p.chain,service:'LIVE_EVENTS',source:p.sourceId,lastSuccessAt:p.at,healthy:now-p.at<=180000});
    return evidence;
  },
};}
