import { env,priorityPolicy } from "../config/env";
import { priorityScore,priorityTier } from "../core/research";
import type { Store } from "../db/store";
import { indexLiveEvmFees } from "../adapters/evm-fees";
import { RpcRouter } from "../adapters/rpc-router";

// One independent loop per EVM chain: historical jobs never occupy a live slot.
export class LiveEventWorker {
  private active:Promise<void>|null=null;
  private timer:ReturnType<typeof setTimeout>|undefined;
  private stopped=false;
  private retryAt=new Map<string,number>();
  constructor(private chain:"base"|"bsc",private store:Store) {}
  get running() {return this.active!==null;}
  run() {
    if(this.active) return this.active;
    this.active=this.execute().finally(()=>{this.active=null;});
    return this.active;
  }
  private async execute() {
    const started=Date.now();
    const watched=this.store.watchedIds(),active=this.store.activeSignalIds();
    const ranked=this.store.list().filter((s)=>s.pool.chain===this.chain &&
      s.pool.activeLiquidityDetails?.method==="V3_VIRTUAL_RESERVES_V1" &&
      (watched.has(s.pool.id)||active.has(s.pool.id)||
        priorityTier(s.pool,false,s.metrics,priorityPolicy())===1) &&
      (this.retryAt.get(s.pool.id)??0)<=started).map((s)=>({s,cursor:this.store.liveFeeCursor(s.pool.id)}));
    const score=(x:(typeof ranked)[number])=>priorityScore(x.s.pool,watched.has(x.s.pool.id),
      x.s.metrics,priorityPolicy())+(active.has(x.s.pool.id)?1000:0)+
      (x.cursor && started-x.cursor.updatedAt<120000?1500:
        x.cursor?Math.min(1200,(started-x.cursor.updatedAt)/1000):500);
    ranked.sort((a,b)=>score(b)-score(a));
    let swaps=0,processed=0,error:string|null=null;
    for(const {s} of ranked.slice(0,env.LIVE_POOLS_PER_CYCLE)) {
      processed++;
      try {
        const result=await indexLiveEvmFees(s.pool,new RpcRouter(this.chain,this.store),this.store);
        swaps+=result.indexed;
        this.retryAt.delete(s.pool.id);
      } catch(e) {
        error=e instanceof Error?e.message:"Live ingestion unavailable";
        this.retryAt.set(s.pool.id,Date.now()+60000);
      }
    }
    this.store.recordLiveRun(this.chain,started,processed,swaps,error);
  }
  start() {
    this.stopped=false;
    const loop=async()=>{
      try {await this.run();} catch { /* Next cycle retries; health is persisted. */ }
      if(!this.stopped) this.timer=setTimeout(loop,env.LIVE_INTERVAL_SECONDS*1000);
    };
    this.timer=setTimeout(loop,this.chain==="base"?3000:8000);
  }
  async stop() {this.stopped=true;clearTimeout(this.timer);await this.active;}
}
