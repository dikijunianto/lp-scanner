import type {ResearchEpoch,ServiceHealth} from './epoch';
export interface EpochOutcomeCoverage {horizon:string;eligible:number;priceRangeComplete:number;partial:number;missing:number}
export interface HourlySloV4 {hour:number;healthy:boolean;freshSummary:boolean;
  cursorFreshRatio:number|null;cursorMedianLagSeconds:number|null;feeRatio:number|null;
  priceRatio:number|null;depthRatio:number|null;snapshotPct:number|null;largestGapMs:number|null;
  providerHealthy:boolean;newOutcomeP95Ms:number|null}
export function assessReadinessV4(input:{epoch:ResearchEpoch|null;outcomes:EpochOutcomeCoverage[];
  services:ServiceHealth[];history:HourlySloV4[];hours:number;clockValid:boolean;
  scans:{p95Ms:number|null;p99Ms:number|null;maxMs:number|null;breaches:number};
  storage:{hours:number;bytesPerDay:number|null;runwayDays:number|null};bscLiveLogs:boolean}) {
  const {history,scans,storage}=input;
  const compliance=(test:(h:HourlySloV4)=>boolean)=>history.length?history.filter(h=>h.healthy && h.freshSummary && test(h)).length/history.length:0;
  const gates:{id:string;value:number|null;target:number;pass:boolean;hourlyCompliance?:number}[]=[];
  const gate=(id:string,value:number|null,target:number,pass:boolean,hourlyCompliance?:number)=>gates.push({id,value,target,pass,hourlyCompliance});
  const hourly=(id:string,test:(h:HourlySloV4)=>boolean,target=.9)=>{const ratio=compliance(test);gate(id,ratio,target,history.length===24 && ratio>=target,ratio);};
  gate('OBSERVATION_24H',input.hours,24,input.hours>=24 && history.length===24 && history.every((h,i)=>h.hour===i+1 && h.healthy && h.freshSummary));
  gate('CLOCK_ENDPOINTS',input.clockValid?1:0,1,input.clockValid);
  gate('CLEAN_EPOCH_VALID',input.epoch && input.epoch.status!=='INVALID'?1:0,1,!!input.epoch && input.epoch.status!=='INVALID');
  for(const [id,value,target] of [['FOREGROUND_P95',scans.p95Ms,10000],['FOREGROUND_P99',scans.p99Ms,15000],['FOREGROUND_MAX',scans.maxMs,20000]] as const)
    gate(id,value,target,value!==null && value<=target);
  gate('DEADLINE_BREACHES',scans.breaches,0,scans.breaches===0);
  hourly('BASE_CURSOR_HOURLY',h=>(h.cursorFreshRatio??0)>=.9,.95);
  hourly('BASE_CURSOR_MEDIAN',h=>h.cursorMedianLagSeconds!==null && h.cursorMedianLagSeconds<=90);
  hourly('BASE_FEES_HOURLY',h=>(h.feeRatio??0)>=.8);
  hourly('HOT_PRICE',h=>(h.priceRatio??0)>=.8);
  hourly('HOT_DEPTH',h=>(h.depthRatio??0)>=.8);
  hourly('SNAPSHOT_CONTINUITY',h=>(h.snapshotPct??0)>=99,1);
  hourly('SNAPSHOT_MAX_GAP',h=>h.largestGapMs!==null && h.largestGapMs<=120000,1);
  hourly('PROVIDER_SERVICES',h=>h.providerHealthy,1);
  hourly('NEW_OUTCOME_LATENESS',h=>h.newOutcomeP95Ms!==null && h.newOutcomeP95Ms<=600000);
  for(const [horizon,target] of [['4h',.9],['24h',.8]] as const) {
    const row=input.outcomes.find(r=>r.horizon===horizon),value=row && row.eligible>0?row.priceRangeComplete/row.eligible:null;
    gate(`EPOCH_OUTCOME_${horizon.toUpperCase()}`,value,target,value!==null && value>=target);
  }
  gate('REQUIRED_SERVICES_CURRENT',input.services.filter(s=>s.required && s.state==='UNAVAILABLE').length,0,
    input.services.filter(s=>s.required).length>0 && input.services.filter(s=>s.required).every(s=>s.state!=='UNAVAILABLE'));
  gate('STORAGE_GROWTH',storage.bytesPerDay,.15*2**30,storage.hours>=24 && storage.bytesPerDay!==null && storage.bytesPerDay<=.15*2**30);
  gate('STORAGE_RUNWAY',storage.runwayDays,120,storage.runwayDays!==null && storage.runwayDays>=120);
  const failed=gates.filter(g=>!g.pass).map(g=>g.id);
  return {version:'sprint10-v4',status:failed.length?'NOT_READY' as const:'READY' as const,selectedChains:['solana','base'],gates,failed,
    passed:gates.filter(g=>g.pass).map(g=>g.id),borderline:gates.filter(g=>g.pass && g.value!==null && g.target>0 && Math.abs(g.value/g.target-1)<.05).map(g=>g.id),
    bsc:{status:input.bscLiveLogs?'BSC_NOT_READY':'BSC_NOT_READY_NO_LOG_SOURCE',gates:[],failed:input.bscLiveLogs?['BSC_NOT_VALIDATED']:['BSC_LOG_SOURCE']}};
}
