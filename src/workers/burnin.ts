import "dotenv/config";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync,openSync,statfsSync,statSync,writeFileSync } from "node:fs";
import { dirname,resolve } from "node:path";
import Database from "better-sqlite3";
import { env } from "../config/env";
import { burninPass,scanDistribution } from "../core/burnin";

const hoursArg=process.argv.find((a)=>a.startsWith("--hours="));
const hours=Number(hoursArg?.split("=")[1]??4);
if(![4,12,24].includes(hours)) throw new Error("Use --hours=4, --hours=12, or --hours=24");
const requestedAt=Date.now(),durationMs=hours*3600000;
const dbPath=resolve(env.DATABASE_PATH);
function storageProfile() {
  const db=new Database(dbPath,{readonly:true,fileMustExist:true});
  try {
    const objects=db.prepare("SELECT name,SUM(pgsize) bytes FROM dbstat GROUP BY name")
      .all() as {name:string;bytes:number}[];
    const wanted=["pool_snapshots","fee_events","price_observations","signal_episodes",
      "signal_outcomes","depth_observations","core_snapshots"];
    const tables=wanted.map((name)=>({name,
      rows:(db.prepare(`SELECT COUNT(*) n FROM ${name}`).get() as {n:number}).n,
      bytes:objects.find((o)=>o.name===name)?.bytes??0}));
    const disk=statfsSync(dirname(dbPath));
    return {databaseBytes:statSync(dbPath).size,freeBytes:disk.bavail*disk.bsize,objects,tables};
  } finally {db.close();}
}
const reports=resolve("reports");mkdirSync(reports,{recursive:true});
const path=resolve(reports,`burnin-${new Date(requestedAt).toISOString().replace(/[:.]/g,"-")}.json`);
const logPath=path.replace(/\.json$/,".log");
let app:ChildProcess|null=null,caffeinate:ChildProcess|null=null;
let interrupted=false;
const healthUrl=`http://127.0.0.1:${env.API_PORT}/health`;
const diagnosticsUrl=`http://127.0.0.1:${env.API_PORT}/diagnostics/reliability`;
async function get(url:string) {
  const response=await fetch(url,{signal:AbortSignal.timeout(30000)});
  if(!response.ok) throw new Error(`Health HTTP ${response.status}`);
  return response.json() as Promise<Record<string,unknown>>;
}
try {await get(healthUrl);} catch {
  const log=openSync(logPath,"a");
  app=spawn("pnpm",["start"],{cwd:process.cwd(),detached:true,stdio:["ignore",log,log]});
}
if(process.platform==="darwin") {
  caffeinate=spawn("caffeinate",["-dimsu","-w",String(process.pid)],{stdio:"ignore"});
}
let ready=false;
for(let i=0;i<60;i++) {
  try {const health=await get(healthUrl);if(health.status==="ok" && health.readOnly===true) {
    ready=true;break;
  }} catch { /* Wait for production startup. */ }
  await new Promise<void>((done)=>setTimeout(done,1000));
}
if(!ready) throw new Error("Production app did not become healthy");
const storageBefore=storageProfile();
const start=Date.now(),beforeBytes=storageBefore.databaseBytes;
{
  const db=new Database(dbPath);
  db.prepare("INSERT OR REPLACE INTO storage_measurements VALUES (?,?,?,?)")
    .run(start,storageBefore.databaseBytes,storageBefore.freeBytes,JSON.stringify(storageBefore.objects));
  db.close();
}
const stop=()=>{interrupted=true;};
process.on("SIGINT",stop);process.on("SIGTERM",stop);
const samples:{at:number;healthy:boolean;error?:string;data?:unknown}[]=[];
let next=start;
while(!interrupted && Date.now()-start<durationMs) {
  const at=Date.now();
  try {
    const [health,data]=await Promise.all([get(healthUrl),get(diagnosticsUrl)]);
    samples.push({at,healthy:health.status==="ok" && health.readOnly===true,
      data:{scanLatency:data.scanLatency,hotCoverage:data.hotCoverage,
        snapshotCoverage:data.snapshotCoverage && typeof data.snapshotCoverage==="object"?
          Object.fromEntries(Object.entries(data.snapshotCoverage).filter(([k])=>k!=="pools")):null,
        selectedOutcomeCoverage:data.selectedOutcomeCoverage,newOutcomeLag:data.newOutcomeLag,
        liveRuns:data.liveRuns,liveCursors:data.liveCursors,readiness:data.readiness,
        storageGrowth:data.storageGrowth,diskSafety:data.diskSafety,providers:data.providers,
        counts:data.counts,coreWriter:data.coreWriter}});
  } catch(error) {samples.push({at,healthy:false,error:error instanceof Error?error.message:"Unknown error"});}
  writeFileSync(path,JSON.stringify({status:"RUNNING",startedAt:start,requestedHours:hours,samples},null,2));
  next+=60000;
  await new Promise<void>((done)=>setTimeout(done,Math.max(1000,next-Date.now())));
}
const finished=Date.now();
const db=new Database(dbPath,{readonly:true,fileMustExist:true});
const durations=(db.prepare(`SELECT m.duration_ms ms FROM scan_metrics m JOIN scanner_runs r ON r.id=m.run_id
  WHERE r.started_at>=? AND r.started_at<=? ORDER BY m.duration_ms`)
  .all(start,finished) as {ms:number}[]).map((r)=>r.ms);
db.close();
const scans=scanDistribution(durations),afterBytes=statSync(dbPath).size;
const pass=!interrupted && burninPass(samples,durationMs,scans,start,finished);
const storageAfter=storageProfile();
{
  const db=new Database(dbPath);
  db.prepare("INSERT OR REPLACE INTO storage_measurements VALUES (?,?,?,?)")
    .run(finished,storageAfter.databaseBytes,storageAfter.freeBytes,JSON.stringify(storageAfter.objects));
  db.close();
}
const storageDelta=storageAfter.tables.map((table)=>({name:table.name,
  rows:table.rows-(storageBefore.tables.find((r)=>r.name===table.name)?.rows??0),
  bytes:table.bytes-(storageBefore.tables.find((r)=>r.name===table.name)?.bytes??0)}));
const priorObjects=new Map(storageBefore.objects.map((row)=>[row.name,row.bytes]));
const allocatedBytes=storageAfter.objects.reduce((sum,row)=>
  sum+Math.max(0,row.bytes-(priorObjects.get(row.name)??0)),0);
const report={status:pass?"PASS":"FAIL",startedAt:start,finishedAt:finished,requestedHours:hours,
  appStartedByBurnin:!!app,scans,interrupted,dbBytesBefore:beforeBytes,dbBytesAfter:afterBytes,
  dbGrowthBytes:afterBytes-beforeBytes,observedHours:(finished-start)/3600000,
  allocatedBytes,allocatedGiBPerDay:allocatedBytes*24/(finished-start)*3600000/2**30,
  maxSampleGapMs:Math.max(0,...samples.slice(1).map((s,i)=>s.at-samples[i].at)),
  failedSamples:samples.filter((s)=>!s.healthy).length,
  storageBefore,storageAfter,storageDelta,samples};
writeFileSync(path,JSON.stringify(report,null,2));
if(app?.pid) {try {process.kill(-app.pid,"SIGINT");} catch { /* Process already exited. */ }}
if(caffeinate?.pid) caffeinate.kill();
console.log(JSON.stringify({report:path,status:report.status,scans,failedSamples:report.failedSamples,
  maxSampleGapMs:report.maxSampleGapMs,dbGrowthBytes:report.dbGrowthBytes}));
if(!pass) process.exitCode=1;
