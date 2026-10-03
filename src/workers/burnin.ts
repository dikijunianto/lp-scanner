import "dotenv/config";
import {spawn,type ChildProcess} from "node:child_process";
import {existsSync,mkdirSync,openSync,statfsSync,statSync,writeFileSync} from "node:fs";
import {dirname,resolve} from "node:path";
import Database from "better-sqlite3";
import {env} from "../config/env";
import {burninPass,scanDistribution} from "../core/burnin";
import {keepAwakeArgs} from "../core/clock";
import {storageDelta} from "../core/storage-accounting";
import {assessReadinessV3,type HourlySlo} from "../core/readiness-v3";
import type {aggregateDiagnostics} from "./diagnostics-summary";

type Summary=ReturnType<typeof aggregateDiagnostics>&{summaryStale:boolean;summaryAgeMs:number};
const hours=Number(process.argv.find(a=>a.startsWith('--hours='))?.split('=')[1]??4);
if(![4,12,24].includes(hours))throw new Error('Use --hours=4, --hours=12, or --hours=24');
const requestedAt=Date.now(),durationMs=hours*3600000,dbPath=resolve(env.DATABASE_PATH);
function storageProfile(){
  const db=new Database(dbPath,{readonly:true,fileMustExist:true});
  try{
    const at=Date.now(),objects=db.prepare('SELECT name,SUM(pgsize) bytes FROM dbstat GROUP BY name').all() as {name:string;bytes:number}[];
    const tables=(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {name:string}[])
      .map(({name})=>({name,rows:(db.prepare(`SELECT COUNT(*) n FROM "${name.replaceAll('"','""')}"`).get() as {n:number}).n,
        bytes:objects.find(o=>o.name===name)?.bytes??0}));
    const disk=statfsSync(dirname(dbPath));
    return {at,databaseBytes:statSync(dbPath).size,walBytes:existsSync(`${dbPath}-wal`)?statSync(`${dbPath}-wal`).size:0,
      freelistBytes:Number(db.pragma('freelist_count',{simple:true}))*Number(db.pragma('page_size',{simple:true})),
      freeBytes:disk.bavail*disk.bsize,objects,tables};
  }finally{db.close();}
}
function persistStorage(s:ReturnType<typeof storageProfile>){const db=new Database(dbPath);
  try{db.prepare('INSERT OR REPLACE INTO storage_measurements VALUES (?,?,?,?)').run(s.at,s.databaseBytes,s.freeBytes,JSON.stringify([...s.objects,{name:"__wal",bytes:s.walBytes},{name:"__freelist",bytes:s.freelistBytes}]));}finally{db.close();}}
async function get<T>(route:string){const r=await fetch(`http://127.0.0.1:${env.API_PORT}${route}`,{signal:AbortSignal.timeout(10000)});
  if(!r.ok)throw new Error(`HTTP ${r.status} ${route}`);return r.json() as Promise<T>;}
const reports=resolve('reports');mkdirSync(reports,{recursive:true});
const path=resolve(reports,`burnin-${new Date(requestedAt).toISOString().replace(/[:.]/g,'-')}.json`);
let app:ChildProcess|null=null,caffeinate:ChildProcess|null=null,interrupted=false;
const awake=keepAwakeArgs(process.platform,process.pid);
if(awake && (hours===24 || process.argv.includes('--keep-awake')))caffeinate=spawn('caffeinate',awake,{stdio:'ignore'});
try {
try{await get('/health');}catch{const log=openSync(path.replace(/\.json$/,'.log'),'a');app=spawn('pnpm',['start'],{cwd:process.cwd(),detached:true,stdio:['ignore',log,log]});}
let ready=false;
for(let i=0;i<180;i++){try{const h=await get<{status:string;readOnly:boolean}>('/health');const d=await get<Summary>('/diagnostics/reliability');
  if(h.status==='ok' && h.readOnly===true && !d.summaryStale){ready=true;break;}}catch{/* Startup warmup is outside the observation window. */}
  await new Promise<void>(r=>setTimeout(r,1000));}
if(!ready){if(app?.pid)try{process.kill(-app.pid,'SIGINT');}catch{}caffeinate?.kill();throw new Error('Production app did not produce a fresh healthy summary');}
const storageBefore=storageProfile(),start=Date.now(),monotonicStart=performance.now();persistStorage(storageBefore);
{const db=new Database(dbPath);try{db.prepare("INSERT OR REPLACE INTO app_settings VALUES ('burninContext',?)").run(JSON.stringify({startedAt:start,id:path}));}finally{db.close();}}
const stop=()=>{interrupted=true;};process.on('SIGINT',stop);process.on('SIGTERM',stop);
const samples:{at:number;healthy:boolean;error?:string;data?:Summary}[]=[],hourly:(HourlySlo&{at:number;burninStartedAt:number;data:Summary|null;storage:ReturnType<typeof storageProfile>;scans:ReturnType<typeof scanStats>})[]=[];
function scanStats(to:number){const db=new Database(dbPath,{readonly:true});try{
  const rows=db.prepare('SELECT * FROM scan_traces WHERE started_at BETWEEN ? AND ? ORDER BY started_at').all(start,to) as {duration_ms:number;deadline_breached:number;error_class:string|null}[];
  return {...scanDistribution(rows.map(r=>r.duration_ms)),breaches:rows.filter(r=>r.deadline_breached).length,
    failedScans:rows.filter(r=>r.error_class!==null || r.deadline_breached)};
}finally{db.close();}}
let latest:Summary|null=null,next=start;
function checkpoint(hour:number,at:number){
  const data=latest,selected=data?.hotCoverage.filter(r=>['solana','base'].includes(r.chain))??[];
  const base=selected.find(r=>r.chain==='base');const total=selected.reduce((n,r)=>n+r.pools,0),priced=selected.reduce((n,r)=>n+r.priced,0);
  const storage=storageProfile();persistStorage(storage);
  const windowSamples=samples.filter(s=>s.at>=start+(hour-1)*3600000 && s.at<=at);
  const continuous=windowSamples.length>=58 && windowSamples.every((s,i)=>s.healthy && (i===0 || s.at-windowSamples[i-1].at<=120000));
  const row={hour,at,burninStartedAt:start,healthy:continuous && Math.abs(at-(start+hour*3600000))<=120000,
    freshSummary:!!data && !data.summaryStale && at-data.generatedAt<=env.DIAGNOSTICS_MAX_AGE_SECONDS*1000,
    cursorFreshRatio:base?.activePools?base.activeFresh/base.activePools:null,
    feeRatio:base?.activePools?base.activeFee1h/base.activePools:null,
    priceRatio:total?priced/total:null,depthRatio:priced?selected.reduce((n,r)=>n+r.depth5Priced,0)/priced:null,
    providerHealthy:!!data && !data.providers.some(r=>['base','solana'].includes(r.chain)&&r.healthState==='UNAVAILABLE') &&
      (data.providers.some(r=>r.chain==='base'&&r.supportsGetLogs&&r.healthState==='HEALTHY') || data.eventSources.some(r=>r.chain==='base'&&r.purpose==='LIVE'&&r.healthState==='HEALTHY')),
    snapshotPct:data?.snapshotCoverage.coveragePct??null,data,storage,scans:scanStats(at)};
  hourly.push(row);const db=new Database(dbPath);try{db.prepare('INSERT OR REPLACE INTO hourly_slo_checkpoints VALUES (?,?,?,?)').run(path,hour,at,JSON.stringify(row));}finally{db.close();}
}
function writeRunning(){writeFileSync(path,JSON.stringify({status:'RUNNING',startedAt:start,requestedHours:hours,keepAwakePid:caffeinate?.pid??null,hourly,samples},null,2));}
while(!interrupted && Date.now()-start<durationMs){const at=Date.now();try{
  const [health,data]=await Promise.all([get<{status:string;readOnly:boolean}>('/health'),get<Summary>('/diagnostics/reliability')]);latest=data;
  // Keep cached evidence compact; scan trees can be inspected separately by run ID.
  samples.push({at,healthy:health.status==='ok'&&health.readOnly===true&&!data.summaryStale,data:{...data,hotPoolDetails:[],hourlySlo:[],scanSpans:[],slowCalls:[],usage:[],priceCalls:[]}});
}catch(error){samples.push({at,healthy:false,error:error instanceof Error?error.message:String(error)});}
  const elapsed=Math.floor((Date.now()-start)/3600000);
  while(hourly.length<Math.min(hours,elapsed))checkpoint(hourly.length+1,Date.now());
  writeRunning();next+=60000;await new Promise<void>(r=>setTimeout(r,Math.max(1000,next-Date.now())));
}
const finished=Date.now();
{const db=new Database(dbPath);try{db.prepare("INSERT OR REPLACE INTO app_settings VALUES ('burninContext',?)").run(JSON.stringify({startedAt:start,finishedAt:finished,id:path}));}finally{db.close();}}
try{latest=await get<Summary>('/diagnostics/reliability');samples.push({at:finished,healthy:!latest.summaryStale,data:latest});}catch(error){samples.push({at:finished,healthy:false,error:String(error)});}
if(!interrupted)while(hourly.length<hours)checkpoint(hourly.length+1,Date.now());
const scans=scanStats(finished),storageAfter=storageProfile();persistStorage(storageAfter);
const storage=storageDelta(storageBefore,storageAfter);
const readiness=latest?assessReadinessV3({foregroundP95Ms:scans.p95Ms,foregroundP99Ms:scans.p99Ms,hot:latest.hotCoverage,
  snapshot:latest.snapshotCoverage,outcomes:latest.selectedOutcomeCoverage,newOutcomeP95LagMs:latest.newOutcomeLag.p95Ms,
  providers:latest.providers,diskDaysRemaining:storage.bytesPerDay&&storage.bytesPerDay>0?storageAfter.freeBytes/storage.bytesPerDay:null,
  growthBytesPerDay:storage.bytesPerDay,growthHours:(finished-start)/3600000},hourly,scans,(finished-start)/3600000):null;
const db=new Database(dbPath,{readonly:true});const clockEvents=db.prepare('SELECT * FROM system_clock_events WHERE detected_at BETWEEN ? AND ?').all(start,finished);db.close();
const clockDiscrepancyMs=Math.abs((finished-start)-(performance.now()-monotonicStart));
const pass=!interrupted && clockDiscrepancyMs<=2000 && scans.breaches===0 && burninPass(samples,durationMs,scans,start,finished) && hourly.length===hours;
const report={status:pass?'PASS':'FAIL',startedAt:start,finishedAt:finished,requestedHours:hours,observedHours:(finished-start)/3600000,
  clockDiscrepancyMs,appStartedByBurnin:!!app,keepAwakeEnabled:!!caffeinate,scans,interrupted,clockEvents,storageBefore,storageAfter,storage,readiness,
  maxSampleGapMs:Math.max(0,...samples.slice(1).map((s,i)=>s.at-samples[i].at)),failedSamples:samples.filter(s=>!s.healthy).length,hourly,samples};
writeFileSync(path,JSON.stringify(report,null,2));
console.log(JSON.stringify({report:path,status:report.status,scans,readiness:readiness?.status}));if(!pass)process.exitCode=1;
} finally {
  if(app?.pid){try{process.kill(-app.pid,'SIGINT');}catch{/* Already stopped. */}}
  caffeinate?.kill();
}
