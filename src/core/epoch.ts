export const epochMethodologies={snapshot:'CORE_NUMERIC_V2',price:'SAFE_PRICE_GRAPH_V3',
  fee:'LIVE_INTERVALS_V3',depth:'PRICE_TRIGGERED_5PCT_V3',outcome:'CLEAN_EPOCH_DENSITY_V3',readiness:'sprint10-v4'};
export interface ResearchEpoch {id:string;startedAt:number;endedAt:number|null;
  status:'ACTIVE'|'COMPLETE'|'INVALID';methodologyVersions:typeof epochMethodologies;
  chainSet:string[];reason:string;invalidationReason:string|null}
export interface ServiceHealth {chain:string;service:string;state:'HEALTHY'|'DEGRADED'|'UNAVAILABLE';
  required:boolean;sources:string[];reason:string|null}
export function servicesAcceptable(services:ServiceHealth[]) {
  return ['solana','base'].every(chain=>['POOL_DISCOVERY','PRICE','CURRENT_STATE','DEPTH_STATE']
    .every(service=>services.some(s=>s.chain===chain && s.service===service && s.state!=='UNAVAILABLE'))) &&
    services.some(s=>s.chain==='base' && s.service==='LIVE_EVENTS' && s.state!=='UNAVAILABLE');
}
export function epochInvalidation(input:{snapshotPct:number|null;largestGapMs:number|null;breaches:number;
  integrityOk:boolean;unavailableForMs:number;ageMs:number},toleranceMs=300000) {
  if(!input.integrityOk)return 'DB_INTEGRITY_FAILURE';
  if(input.breaches>0)return 'FOREGROUND_DEADLINE_FAILURE';
  if(input.ageMs>=300000 && ((input.snapshotPct??0)<99 || (input.largestGapMs??Infinity)>120000))
    return 'CORE_SNAPSHOT_CONTINUITY_FAILURE';
  if(input.unavailableForMs>toleranceMs)return 'REQUIRED_SERVICE_UNAVAILABLE';
  return null;
}
export function pairedClockInterval(start:{wall:number;mono:number},end:{wall:number;mono:number}) {
  const actualDurationMs=end.wall-start.wall,monotonicDurationMs=end.mono-start.mono;
  return {actualDurationMs,monotonicDurationMs,clockDiscrepancyMs:Math.abs(actualDurationMs-monotonicDurationMs),
    valid:actualDurationMs>=0 && monotonicDurationMs>=0 && Math.abs(actualDurationMs-monotonicDurationMs)<=2000};
}
export function coveredIntervals(intervals:{start:number;end:number}[],start:number,end:number) {
  if(end<=start)return false;
  let cursor=start;
  for(const i of [...intervals].sort((a,b)=>a.start-b.start)) {
    if(i.end<cursor)continue;
    if(i.start>cursor)return false;
    cursor=Math.max(cursor,i.end);
    if(cursor>=end)return true;
  }
  return false;
}
export function activeCursorState(input:{fresh:boolean;lagSeconds:number|null;provenZero:boolean;
  ingestionCovered:boolean;recentSwaps:number|null;error:string|null}) {
  if(input.provenZero && input.ingestionCovered && input.recentSwaps===0)return 'NO_RECENT_SWAPS';
  if(input.error && !input.fresh)return 'INFRA_FAILURE';
  if(input.fresh)return 'ACTIVE_FRESH';
  if(input.lagSeconds===null)return 'UNKNOWN';
  return input.lagSeconds<=300?'ACTIVE_DELAYED':'ACTIVE_STALE';
}
export function lagDistribution(rows:{lagSeconds:number|null}[]) {
  const sorted=rows.flatMap(r=>r.lagSeconds===null?[]:[r.lagSeconds]).sort((a,b)=>a-b);
  const q=(p:number)=>sorted.length?sorted[Math.ceil(sorted.length*p)-1]:null;
  return {total:rows.length,known:sorted.length,unknown:rows.length-sorted.length,
    median:q(.5),p90:q(.9),p95:q(.95),max:q(1)};
}
