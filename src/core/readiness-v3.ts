import {assessReadiness,type ReadinessInputs} from "./readiness";
export interface HourlySlo {
  hour:number;healthy:boolean;freshSummary:boolean;
  cursorFreshRatio:number|null;feeRatio:number|null;priceRatio:number|null;depthRatio:number|null;
  providerHealthy:boolean;snapshotPct:number|null;
}
export function assessReadinessV3(input:ReadinessInputs,history:HourlySlo[],
  scans:{p95Ms:number|null;p99Ms:number|null;maxMs:number|null;breaches:number},hours:number) {
  const prior=assessReadiness(input);
  const ratio=(pass:(row:HourlySlo)=>boolean)=>history.length?history.filter(pass).length/history.length:0;
  const selected=input.hot.filter(r=>['solana','base'].includes(r.chain));
  const priced=selected.reduce((a,r)=>a+r.priced,0),total=selected.reduce((a,r)=>a+r.pools,0);
  const depth=selected.reduce((a,r)=>a+r.depth5Priced,0);
  const gate=(id:string,value:number|null,target:number,pass:boolean)=>({id,value,target,pass});
  const gates=prior.gates.filter(g=>!['FOREGROUND_P95','FOREGROUND_P99','HOT_PRICE','HOT_DEPTH',
    'BASE_LIVE_FEES','SNAPSHOT_CONTINUITY','SNAPSHOT_MAX_GAP','NEW_OUTCOME_LATENESS',
    'STORAGE_RUNWAY','STORAGE_GROWTH','PROVIDER_STABILITY'].includes(g.id));
  gates.push(
    gate('OBSERVATION_24H',hours,24,hours>=24 && history.length===24 && history.every((r,i)=>r.hour===i+1 && r.healthy && r.freshSummary)),
    gate('FOREGROUND_P95',scans.p95Ms,15000,scans.p95Ms!==null && scans.p95Ms<=15000),
    gate('FOREGROUND_P99',scans.p99Ms,20000,scans.p99Ms!==null && scans.p99Ms<=20000),
    gate('FOREGROUND_MAX',scans.maxMs,20000,scans.maxMs!==null && scans.maxMs<=20000),
    gate('DEADLINE_BREACHES',scans.breaches,0,scans.breaches===0),
    gate('BASE_CURSOR_HOURLY',ratio(r=>r.healthy && r.freshSummary && (r.cursorFreshRatio??0)>=.9),.9,
      ratio(r=>r.healthy && r.freshSummary && (r.cursorFreshRatio??0)>=.9)>=.9),
    gate('BASE_FEES_HOURLY',ratio(r=>r.healthy && r.freshSummary && (r.feeRatio??0)>=.8),.8,
      ratio(r=>r.healthy && r.freshSummary && (r.feeRatio??0)>=.8)>=.8),
    gate('HOT_PRICE',total?priced/total:null,.8,total>0 && priced/total>=.8 &&
      ratio(r=>r.healthy && r.freshSummary && (r.priceRatio??0)>=.8)>=.9),
    gate('HOT_DEPTH',priced?depth/priced:null,.7,priced>0 && depth/priced>=.7 &&
      ratio(r=>r.healthy && r.freshSummary && (r.depthRatio??0)>=.7)>=.9),
    gate('SNAPSHOT_CONTINUITY',input.snapshot.coveragePct,99,(input.snapshot.coveragePct??0)>=99 && history.every(r=>(r.snapshotPct??0)>=99)),
    gate('SNAPSHOT_MAX_GAP',input.snapshot.largestGapMs,120000,input.snapshot.largestGapMs!==null && input.snapshot.largestGapMs<=120000),
    gate('NEW_OUTCOME_LATENESS',input.newOutcomeP95LagMs,600000,input.newOutcomeP95LagMs!==null && input.newOutcomeP95LagMs<=600000),
    gate('STORAGE_GROWTH',input.growthBytesPerDay,.15*2**30,input.growthHours>=24 && input.growthBytesPerDay!==null && input.growthBytesPerDay<=.15*2**30),
    gate('STORAGE_RUNWAY',input.diskDaysRemaining,90,input.diskDaysRemaining!==null && input.diskDaysRemaining>=90),
    gate('PROVIDER_STABILITY',ratio(r=>r.providerHealthy && r.freshSummary),1,history.length>0 && history.every(r=>r.providerHealthy && r.freshSummary)),
  );
  const failed=gates.filter(g=>!g.pass).map(g=>g.id);
  if(!prior.bsc.gates.find(g=>g.id==='BSC_LOG_SOURCE')?.pass)prior.bsc.status='BSC_NOT_READY';
  return {...prior,version:'sprint9-v3',status:failed.length?'NOT_READY':'READY',gates,failed,
    passed:gates.filter(g=>g.pass).map(g=>g.id),borderline:gates.filter(g=>g.pass && g.value!==null && g.target>0 && Math.abs(g.value/g.target-1)<.05).map(g=>g.id)};
}
