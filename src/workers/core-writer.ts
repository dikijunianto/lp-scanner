import { createStore } from "../db/store";

// Separate process keeps cadence when API scans or outcome queries block their event loop.
const store=createStore();
let stopped=false;
let timer:ReturnType<typeof setTimeout>|undefined;
const write=()=>{
  if(stopped) return;
  try {store.writeCoreSnapshots();}
  catch(error) {console.error("Core snapshot write failed",error);}
  timer=setTimeout(write,Math.max(1000,60000-Date.now()%60000+500));
};
const stop=()=>{stopped=true;clearTimeout(timer);store.close();};
process.on("SIGINT",stop);
process.on("SIGTERM",stop);
write();
