import {env} from "../config/env";
import type {Store} from "../db/store";
import {aggregateDiagnostics} from "./diagnostics-summary";
export class DiagnosticsWorker {
  private timer:ReturnType<typeof setTimeout>|undefined;
  constructor(private store:Store){}
  start(){const update=()=>{
    try {
      const spans:{operation:string;durationMs:number}[]=[];
      const profiled=new Proxy(this.store,{get(target,key){const value=Reflect.get(target,key);
        if(typeof value!=="function")return value;
        return (...args:unknown[])=>{const at=performance.now();
          try{return value.apply(target,args);}finally{spans.push({operation:String(key),durationMs:performance.now()-at});}};
      }});
      const data=aggregateDiagnostics(profiled);
      this.store.saveDiagnosticSummary({...data,diagnosticProfile:spans},Date.now());
      this.store.pruneTraces();
    }catch(error){console.error("Diagnostics refresh failed",error);}
    this.timer=setTimeout(update,env.DIAGNOSTICS_INTERVAL_SECONDS*1000);
  };update();}
  async stop(){clearTimeout(this.timer);}
}
