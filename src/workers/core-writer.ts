import { createStore } from "../db/store";

// Separate process keeps cadence when API scans or outcome queries block their event loop.
const store=createStore();
let stopped=false;
let timer:ReturnType<typeof setTimeout>|undefined;
let lastErrorMinute=-1;
const write=()=>{
  if(stopped) return;
  let retry=false;
  try {store.writeCoreSnapshots();}
  catch(error) {
    retry=true;
    const minute=Math.floor(Date.now()/60000);
    if(minute!==lastErrorMinute) console.error("Core snapshot write failed",error);
    lastErrorMinute=minute;
  }
  timer=setTimeout(write,retry?1000:Math.max(1000,60000-Date.now()%60000+500));
};
const stop=()=>{stopped=true;clearTimeout(timer);store.close();};
process.on("SIGINT",stop);
process.on("SIGTERM",stop);
write();
