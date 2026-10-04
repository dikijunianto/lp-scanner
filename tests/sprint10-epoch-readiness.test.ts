import {describe,it,expect} from 'vitest';
import {createStore} from '../src/db/store';
import {activeCursorState,coveredIntervals,epochInvalidation,epochMethodologies,lagDistribution,pairedClockInterval,type ResearchEpoch} from '../src/core/epoch';
import {providerServices} from '../src/core/provider-services';
import {assessReadinessV4,type HourlySloV4} from '../src/core/readiness-v4';
import {cleanEpochFreezeAllowed} from '../src/core/freeze-gate';
import {emptyPool,emptyToken} from '../src/core/model';
import {snapshot} from '../src/core/analytics';
import {evaluateOutcome,type SignalPolicy} from '../src/core/research';
const now=1791100000000;
const epoch:ResearchEpoch={id:'epoch',startedAt:now-90000000,endedAt:now,status:'COMPLETE',methodologyVersions:epochMethodologies,chainSet:['solana','base'],reason:'fixture',invalidationReason:null};
const evidence=['solana','base'].flatMap(chain=>['POOL_DISCOVERY','PRICE','CURRENT_STATE','LIVE_EVENTS','DEPTH_STATE'].map(service=>({chain,service,source:'working',lastSuccessAt:now,healthy:true})));
const services=providerServices(evidence,now);
const goodHour=(hour:number):HourlySloV4=>({hour,healthy:true,freshSummary:true,cursorFreshRatio:1,cursorMedianLagSeconds:10,feeRatio:1,priceRatio:1,depthRatio:1,snapshotPct:100,largestGapMs:60000,providerHealthy:true,newOutcomeP95Ms:1000});
const good={epoch,outcomes:[{horizon:'4h',eligible:100,priceRangeComplete:100,partial:0,missing:0},{horizon:'24h',eligible:20,priceRangeComplete:20,partial:0,missing:0}],services,history:Array.from({length:24},(_,i)=>goodHour(i+1)),hours:24,clockValid:true,scans:{p95Ms:5000,p99Ms:6000,maxMs:8000,breaches:0},storage:{hours:24,bytesPerDay:.1*2**30,runwayDays:180},bscLiveLogs:false};
describe('clean epoch lifecycle and retained history',()=>{
 it('guards start, permits one ACTIVE epoch, and records immutable invalidation',()=>{
  const store=createStore(':memory:');try{
   expect(()=>store.startResearchEpoch({snapshotHealthy:false,deadlineHealthy:true,servicesAcceptable:true},'bad',now)).toThrow();
   const e=store.startResearchEpoch({snapshotHealthy:true,deadlineHealthy:true,servicesAcceptable:true},'healthy',now);
   expect(()=>store.startResearchEpoch({snapshotHealthy:true,deadlineHealthy:true,servicesAcceptable:true},'second',now)).toThrow();
   expect(store.finishResearchEpoch(e.id,'INVALID','DB_INTEGRITY_FAILURE',now+1)).toBe(true);
   expect(store.finishResearchEpoch(e.id,'COMPLETE',null,now+2)).toBe(false);
   expect(store.researchEpoch(e.id)?.invalidationReason).toBe('DB_INTEGRITY_FAILURE');
   const next=store.startResearchEpoch({snapshotHealthy:true,deadlineHealthy:true,servicesAcceptable:true},'next',now+3);
   expect(next.id).not.toBe(e.id);expect(store.researchEpoch(e.id)?.status).toBe('INVALID');
  }finally{store.close();}
 });
 it('persists run identity and paired durations rather than unrelated profiling endpoints',()=>{
  const store=createStore(':memory:');try{const e=store.startResearchEpoch({snapshotHealthy:true,deadlineHealthy:true,servicesAcceptable:true},'test',now);
   store.beginBurninRun('run',e.id,86400000,'ENABLED',{});store.updateBurninRun('run',now,now+86400000,'PASS',{clock:{valid:true}});
   expect(store.latestBurninRun()).toMatchObject({id:'run',research_epoch_id:e.id,started_at:now,ended_at:now+86400000,status:'PASS'});
  }finally{store.close();}
 });
 it('invalidates only critical failures, with explicit service tolerance',()=>{
  const healthy={snapshotPct:100,largestGapMs:60000,breaches:0,integrityOk:true,unavailableForMs:0,ageMs:600000};
  expect(epochInvalidation(healthy)).toBeNull();expect(epochInvalidation({...healthy,breaches:1})).toBe('FOREGROUND_DEADLINE_FAILURE');
  expect(epochInvalidation({...healthy,snapshotPct:98})).toBe('CORE_SNAPSHOT_CONTINUITY_FAILURE');
  expect(epochInvalidation({...healthy,integrityOk:false})).toBe('DB_INTEGRITY_FAILURE');
  expect(epochInvalidation({...healthy,unavailableForMs:300000})).toBeNull();
  expect(epochInvalidation({...healthy,unavailableForMs:300001})).toBe('REQUIRED_SERVICE_UNAVAILABLE');
 });
 it('persists source coverage despite duplicate publication and deduplicates depth queue',()=>{
  const store=createStore(':memory:');try{
   const p=emptyPool({chain:'base',protocol:'uniswap-v3',dex:'fixture',poolAddress:'0x'+'1'.repeat(40),token0:emptyToken('0x'+'2'.repeat(40),'A'),token1:emptyToken('0x'+'3'.repeat(40),'B'),source:'fixture'},now);
   store.save([snapshot(p,[])]);expect(store.enqueueDepth(p.id,'PRICE_AVAILABLE',now)).toBe(1);expect(store.enqueueDepth(p.id,'PRICE_AVAILABLE',now+1)).toBe(0);
   expect(store.pendingDepthIds()).toEqual([p.id]);store.finishDepthRefresh(p.id);expect(store.pendingDepthIds()).toEqual([]);
   store.recordPriceSource('base',p.token0Address,'source',true,now,{sourceTimestamp:now-1000,confidence:'HIGH',kind:'DIRECT'});
   store.recordPriceSource('base',p.token0Address,'source',false,now+1,{reason:'SOURCE_TIMEOUT'});
   expect(store.priceSourceCoverage()).toEqual([expect.objectContaining({last_success:now,last_failure:now+1,failure_reason:'SOURCE_TIMEOUT',publication_latency_ms:1000})]);
  }finally{store.close();}
 });
});
describe('denominators, intervals and service evidence',()=>{
 it('never infers no activity from missing or failed ingestion',()=>{
  const zero={fresh:false,lagSeconds:1000,provenZero:true,ingestionCovered:false,recentSwaps:0,error:'provider'};
  expect(activeCursorState(zero)).toBe('INFRA_FAILURE');expect(activeCursorState({...zero,ingestionCovered:true})).toBe('NO_RECENT_SWAPS');
  expect(activeCursorState({...zero,provenZero:false,error:null,lagSeconds:null})).toBe('UNKNOWN');
  expect(lagDistribution([{lagSeconds:10},{lagSeconds:100000},{lagSeconds:null}])).toMatchObject({total:3,known:2,unknown:1,median:10,p95:100000});
 });
 it('requires gapless coverage, not just bounding endpoints',()=>{
  expect(coveredIntervals([{start:0,end:50},{start:50,end:100}],0,100)).toBe(true);
  expect(coveredIntervals([{start:0,end:49},{start:50,end:100}],0,100)).toBe(false);
  expect(coveredIntervals([],0,100)).toBe(false);
 });
 it('ignores unused broken fallbacks, but fails absent required source',()=>{
  const result=providerServices([...evidence,{chain:'base',service:'PRICE',source:'broken',lastSuccessAt:null,healthy:false}],now);
  expect(result.find(s=>s.chain==='base'&&s.service==='PRICE')?.state).toBe('HEALTHY');
  expect(providerServices(evidence.filter(e=>!(e.chain==='base'&&e.service==='LIVE_EVENTS')),now).find(s=>s.chain==='base'&&s.service==='LIVE_EVENTS')?.state).toBe('UNAVAILABLE');
  expect(providerServices(evidence,now+180001).filter(s=>s.required).every(s=>s.state==='UNAVAILABLE')).toBe(true);
 });
 it('uses the same paired clock endpoints',()=>{
  expect(pairedClockInterval({wall:100,mono:5},{wall:86400100,mono:86400005})).toMatchObject({valid:true,actualDurationMs:86400000});
  expect(pairedClockInterval({wall:100,mono:5},{wall:86400100,mono:86410005}).valid).toBe(false);
 });
});
describe('hourly V4 readiness and freeze safety',()=>{
 it('passes genuine24h evidence, excluding incapable BSC',()=>{expect(assessReadinessV4(good)).toMatchObject({status:'READY',bsc:{status:'BSC_NOT_READY_NO_LOG_SOURCE'}});});
 it('rejects short windows, zero mature denominator, invalid epochs and nonpaired clocks',()=>{
  for(const patch of [{hours:23},{outcomes:[]},{epoch:{...epoch,status:'INVALID' as const}},{clockValid:false}])expect(assessReadinessV4({...good,...patch}).status).toBe('NOT_READY');
 });
 it('does not let a perfect final sample hide failed hourly evidence',()=>{
  const history=good.history.map(h=>h.hour<=3?{...h,priceRatio:.1}:h);
  expect(assessReadinessV4({...good,history}).failed).toContain('HOT_PRICE');
  const cursor=good.history.map(h=>h.hour<=2?{...h,cursorFreshRatio:.5}:h);
  expect(assessReadinessV4({...good,history:cursor}).failed).toContain('BASE_CURSOR_HOURLY');
 });
 it('requires matching complete epoch and authoritative PASS run for freeze',()=>{
  const input={version:'sprint10-v4',summaryStatus:'READY',summaryAgeMs:10,maxSummaryAgeMs:1000,epoch,runId:'run',summaryRunId:'run',runStatus:'PASS',epochId:epoch.id,actualDurationMs:86400000,clockValid:true};
  expect(cleanEpochFreezeAllowed(input)).toBe(true);
  for(const patch of [{summaryStatus:'NOT_READY'},{summaryRunId:'other'},{clockValid:false},{epoch:{...epoch,status:'ACTIVE' as const}},{actualDurationMs:86399999}])expect(cleanEpochFreezeAllowed({...input,...patch})).toBe(false);
 });
});
describe('clean reliable-price density',()=>{
 const policy:SignalPolicy={feeEfficiency:.001,volumeDepth:1,activity:70,risk:60,breakoutPct:5,collapsePct:20,persistenceFraction:.5,maxObservationGapMs:240000};
 const make=(at:number)=>{const p=emptyPool({chain:'base',protocol:'uniswap-v3',dex:'fixture',poolAddress:'0x'+'1'.repeat(40),token0:emptyToken('0x'+'2'.repeat(40),'A'),token1:emptyToken('0x'+'3'.repeat(40),'B'),source:'fixture'},at);p.price=100;const s=snapshot(p,[]);s.metrics.priceConfidence='MEDIUM';return s;};
 it('accepts dense price-only evidence without fee/depth and rejects low-confidence samples',()=>{
  const start=make(now),path=Array.from({length:30},(_,i)=>make(now+(i+1)*60000)),density={minimumDensityPct:95,maxGapMs:120000};
  expect(evaluateOutcome(start,path,'30m',policy,undefined,density).completenessClasses).toContain('PRICE_RANGE_COMPLETE');
  const sparse=path.map((s,i)=>i<10?{...s,metrics:{...s.metrics,priceConfidence:'LOW' as const}}:s);
  expect(evaluateOutcome(start,sparse,'30m',policy,undefined,density).completenessClasses).not.toContain('PRICE_RANGE_COMPLETE');
  expect(evaluateOutcome(start,path.filter((_,i)=>i<3||i>8),'30m',policy,undefined,density).completenessClasses).not.toContain('PRICE_RANGE_COMPLETE');
 });
});
