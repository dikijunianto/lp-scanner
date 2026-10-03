import {describe,it,expect} from 'vitest';
import {storageDelta} from '../src/core/storage-accounting';
import {assessReadinessV3,type HourlySlo} from '../src/core/readiness-v3';
import type {ReadinessInputs} from '../src/core/readiness';
import {staleCursorReason} from '../src/core/live-health';
const input:ReadinessInputs={foregroundP95Ms:5000,foregroundP99Ms:7000,hot:[{chain:'base',pools:10,priced:9,depth5Priced:8,fee1h:9}],
 snapshot:{tracked:10,maturePools:10,coveragePct:100,largestGapMs:60000},outcomes:[{horizon:'4h',eligible:10,priceRangeComplete:8},{horizon:'24h',eligible:10,priceRangeComplete:7}],
 newOutcomeP95LagMs:100000,providers:[{chain:'base',supportsGetLogs:true,healthState:'HEALTHY'}],diskDaysRemaining:200,growthBytesPerDay:.1*2**30,growthHours:24};
const history=():HourlySlo[]=>Array.from({length:24},(_,i)=>({hour:i+1,healthy:true,freshSummary:true,cursorFreshRatio:1,feeRatio:1,priceRatio:.9,depthRatio:.8,providerHealthy:true,snapshotPct:100}));
const scans={p95Ms:5000,p99Ms:7000,maxMs:9000,breaches:0};
describe('Sprint9 full-window proof',()=>{
 it('requires actual 24h and all numbered checkpoints',()=>{expect(assessReadinessV3(input,history(),scans,24).status).toBe('READY');
  expect(assessReadinessV3(input,history(),scans,4).failed).toContain('OBSERVATION_24H');
  expect(assessReadinessV3(input,history().map(r=>({...r,hour:r.hour+100})),scans,24).status).toBe('NOT_READY');});
 it('does not let the last good hour hide failed coverage or a breach',()=>{const rows=history();rows.slice(0,3).forEach(r=>r.priceRatio=.1);
  expect(assessReadinessV3(input,rows,scans,24).failed).toContain('HOT_PRICE');
  expect(assessReadinessV3(input,history(),{...scans,breaches:1},24).failed).toContain('DEADLINE_BREACHES');});
 it('accounts indexes, WAL and reusable allocation independently',()=>{const before={at:0,databaseBytes:1000,walBytes:100,freelistBytes:500,objects:[{name:'table',bytes:100},{name:'index',bytes:50}]};
  const after={at:86400000,databaseBytes:1000,walBytes:100,freelistBytes:250,objects:[{name:'table',bytes:300},{name:'index',bytes:100}]};
  expect(storageDelta(before,after)).toMatchObject({allocatedDelta:250,fileDelta:0,bytesPerDay:250,freelistDelta:-250});
  expect(storageDelta(before,{...after,walBytes:1100}).bytesPerDay).toBe(1000);});
 it('classifies infrastructure separately from proven inactivity',()=>{const base={fresh:false,headAgeSeconds:10,lagSeconds:400,updatedAgeSeconds:10,covered:false,swaps:null};
  expect(staleCursorReason({...base,error:'HTTP 429'})).toBe('RATE_LIMIT');
  expect(staleCursorReason({...base,error:'getLogs timeout'})).toBe('GETLOGS_TIMEOUT');
  expect(staleCursorReason(base)).toBe('CURSOR_STUCK');
  expect(staleCursorReason({...base,fresh:true,covered:true,swaps:0})).toBe('NO_RECENT_ACTIVITY');});
});
