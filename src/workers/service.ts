import { createStore } from "../db/store";
import { BackgroundWorker } from "./background";
import { EconomicWorker } from "./economics";
import { LiveEventWorker } from "./live-events";

const name=process.argv[2];
if(!["outcomes","depth","history","economic","live-base","live-bsc"].includes(name))
  throw new Error("Unknown worker service");
const store=createStore();
const worker=(["outcomes","depth","history"].includes(name))?
  new BackgroundWorker(store,name as "outcomes"|"depth"|"history"):
  name==="economic"?new EconomicWorker(store):
    new LiveEventWorker(name==="live-base"?"base":"bsc",store);
const mark=()=>{try {store.markService(name);} catch { /* Retry on next pulse after SQLite contention. */ }};
mark();
const heartbeat=setInterval(mark,15000);
worker.start();
let stopping=false;
const stop=async()=>{
  if(stopping) return;
  stopping=true;
  clearInterval(heartbeat);
  await worker.stop();
  store.close();
};
process.on("SIGINT",()=>void stop());
process.on("SIGTERM",()=>void stop());
