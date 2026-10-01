import { createStore } from "../db/store";

// Separate process keeps cadence when API scans or outcome queries block their event loop.
const store=createStore();
let stopped=false;
let timer:ReturnType<typeof setTimeout>|undefined;
let lastErrorMinute=-1;
let retries=0;
const write=()=>{
  if(stopped) return;
  let retry=false;
  const started=Date.now(),minute=Math.floor(started/60000);
  try {
    const rows=store.writeCoreSnapshots(started);
    store.recordCoreWriterRun(minute*60000,started,rows,retries,"OK");
    retries=0;
  }
  catch(error) {
    retry=true;
    retries++;
    if(minute!==lastErrorMinute) console.error("Core snapshot write failed",error);
    lastErrorMinute=minute;
  }
  timer=setTimeout(write,retry?1000:Math.max(1000,60000-Date.now()%60000+500));
};
const stop=()=>{stopped=true;clearTimeout(timer);store.close();};
process.on("SIGINT",stop);
process.on("SIGTERM",stop);
write();
