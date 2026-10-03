import {fork,type ChildProcess} from "node:child_process";
import {resolve} from "node:path";
import {eq} from "drizzle-orm";
import {env} from "../config/env";
import {runs} from "../db/schema";
import type {Store} from "../db/store";
import type {ScanSpan} from "../core/traffic";
// A separate parent can kill an adapter even when its JavaScript or SQLite call never yields.
export class ScanSupervisor {
  private active:Promise<void>|null=null;
  private child:ChildProcess|null=null;
  private timer:ReturnType<typeof setTimeout>|undefined;
  private stopped=false;
  constructor(private store:Store,private entry=resolve("src/workers/scan-process.ts"),
    private deadlineMs=env.SCAN_DEADLINE_MS) {}
  get running(){return this.active!==null;}
  scan() {
    if(this.store.diskState()==="EMERGENCY"){this.store.recordScanSkipped();return Promise.resolve();}
    if(this.active){this.store.recordScanSkipped();return this.active;}
    this.active=this.execute().finally(()=>{this.active=null;});
    return this.active;
  }
  private async execute() {
    const startedAt=Date.now(),monotonic=performance.now();
    const id=this.store.db.insert(runs).values({startedAt,status:"running",data:[]})
      .returning({id:runs.id}).get().id;
    let aborted=false;
    const child=this.child=fork(this.entry,[String(id)],{execArgv:["--import","tsx"],
      stdio:["ignore","ignore","inherit","ipc"]});
    const spans:ScanSpan[]=[],pending=new Map<string,Partial<ScanSpan>>();
    child.on("message",(message)=>{
      const m=message as {type?:string;span?:ScanSpan};
      if(!m.span || !["span","spanStart"].includes(m.type??""))return;
      const key=`${m.span.operation}:${m.span.startedAt}`;
      if(m.type==="spanStart")pending.set(key,m.span);
      else {pending.delete(key);if(spans.length<500)spans.push(m.span);}
    });
    const deadline=setTimeout(()=>{aborted=true;child.kill("SIGKILL");},this.deadlineMs);
    let failure:string|null=null;
    try {await new Promise<void>((done)=>{
      child.once("error",()=>{failure="SCAN_PROCESS_FAILURE";done();});
      child.once("exit",(code)=>{if(code!==0)failure=aborted?"SCAN_DEADLINE":"SCAN_PROCESS_FAILURE";done();});
    });} finally {clearTimeout(deadline);this.child=null;}
    const finishedAt=Date.now(),durationMs=finishedAt-startedAt;
    if(failure) {
      this.store.db.update(runs).set({endedAt:finishedAt,status:"error",data:[{
        name:"Foreground scan",status:"error",pools:0,notes:[failure,"Optional fields unavailable; committed partial pool state retained"],
      }]}).where(eq(runs.id,id)).run();
      this.store.saveScanMetrics(id,durationMs,0,0,0);
    }
    if(failure){
      for(const s of pending.values())spans.push({...s,endedAt:finishedAt,
        durationMs:finishedAt-s.startedAt!,success:false,aborted:true,errorClass:failure} as ScanSpan);
      this.store.recordScanSpans(id,spans);
    }
    this.store.saveScanTrace(id,startedAt,finishedAt,durationMs,performance.now()-monotonic,
      this.deadlineMs,aborted||durationMs>this.deadlineMs,failure);
  }
  start(){this.stopped=false;const loop=async()=>{
    try {await this.scan();}catch(error){console.error("Scanner supervisor failed",error);}
    if(!this.stopped)this.timer=setTimeout(loop,env.SCAN_INTERVAL_SECONDS*1000);
  };void loop();}
  async stop(){this.stopped=true;clearTimeout(this.timer);this.child?.kill("SIGKILL");await this.active;}
}
