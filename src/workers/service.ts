import { createStore } from "../db/store";
import { BackgroundWorker } from "./background";
import { EconomicWorker } from "./economics";
import { LiveEventWorker } from "./live-events";
import {ScanSupervisor} from "./scan-supervisor";
import {DiagnosticsWorker} from "./diagnostics";
import {clockEvent} from "../core/clock";

const name=process.argv[2];
if(!["outcomes","depth","history","economic","live-base","live-bsc","scanner","diagnostics"].includes(name))
  throw new Error("Unknown worker service");
const store=createStore();
const worker=name==="scanner"?new ScanSupervisor(store):name==="diagnostics"?new DiagnosticsWorker(store):(["outcomes","depth","history"].includes(name))?
  new BackgroundWorker(store,name as "outcomes"|"depth"|"history"):
  name==="economic"?new EconomicWorker(store):
    new LiveEventWorker(name==="live-base"?"base":"bsc",store);
const mark=()=>{try {store.markService(name);} catch { /* Retry on next pulse after SQLite contention. */ }};
mark();
const heartbeat=setInterval(mark,15000);
worker.start();
let wall=Date.now(),monotonic=performance.now();
const clock=setInterval(()=>{
  const nextWall=Date.now(),nextMono=performance.now();
  const event=clockEvent(nextWall-wall,nextMono-monotonic);
  if(event) try {store.saveClockEvent(nextWall,event,nextWall-wall,nextMono-monotonic);} catch { /* Next pulse remains safe. */ }
  wall=nextWall;monotonic=nextMono;
},1000);
let stopping=false;
const stop=async()=>{
  if(stopping) return;
  stopping=true;
  clearInterval(heartbeat);
  clearInterval(clock);
  await worker.stop();
  store.close();
};
process.on("SIGINT",()=>void stop());
process.on("SIGTERM",()=>void stop());
