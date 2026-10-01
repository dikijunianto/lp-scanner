import { env,priorityPolicy } from "../config/env";
import { priorityScore,priorityTier } from "../core/research";
import type { Store } from "../db/store";
import { indexLiveEvmFees } from "../adapters/evm-fees";
import { RpcRouter } from "../adapters/rpc-router";
import { BscWsSource } from "../adapters/bsc-ws";

// One independent loop per EVM chain: historical jobs never occupy a live slot.
export class LiveEventWorker {
  private active:Promise<void>|null=null;
  private timer:ReturnType<typeof setTimeout>|undefined;
  private stopped=false;
  private retryAt=new Map<string,number>();
  private disabledNoSource=false;
  private ws:BscWsSource|null=null;
  private wsAddresses="";
  constructor(private chain:"base"|"bsc",private store:Store) {}
  get running() {return this.active!==null;}
  run() {
    if(this.active) return this.active;
    this.active=this.execute().finally(()=>{this.active=null;});
    return this.active;
  }
  private async execute() {
    const started=Date.now();
    if(this.chain==="bsc") {
      const configured=[env.BSC_LOG_RPC_URL,env.BSC_ARCHIVE_RPC_URL,env.BSC_LOG_RPC_URLS,
        env.BSC_LIVE_INDEXER_URL,env.BSC_FEE_RPC_URL];
      if(!configured.some(Boolean)) {
        if(!this.disabledNoSource) this.store.recordLiveRun("bsc",started,0,0,
          "BSC_LIVE_FEES_DISABLED_NO_CAPABLE_SOURCE");
        this.disabledNoSource=true;
        return;
      }
      const sources=this.store.rpcProviders().filter((p)=>p.chain==="bsc" &&
        p.providerType==="CONFIGURED" && p.supportsGetLogs===true && p.healthState==="HEALTHY");
      if(!sources.length && !env.BSC_LIVE_INDEXER_URL) {
        await new RpcRouter("bsc",this.store).probeAll();
        const capable=this.store.rpcProviders().some((p)=>p.chain==="bsc" &&
          p.providerType==="CONFIGURED" && p.supportsGetLogs===true && p.healthState==="HEALTHY");
        if(!capable) {
          if(!this.disabledNoSource) this.store.recordLiveRun("bsc",started,0,0,
            "BSC_LIVE_FEES_DISABLED_NO_CAPABLE_SOURCE");
          this.disabledNoSource=true;
          return;
        }
      }
      this.disabledNoSource=false;
      if(env.BSC_LOG_WSS_URL) {
        const addresses=this.store.list().filter((s)=>s.pool.chain==="bsc" &&
          s.pool.activeLiquidityDetails?.method==="V3_VIRTUAL_RESERVES_V1")
          .map((s)=>s.pool.poolAddress.toLowerCase()).sort().join(",");
        if(addresses!==this.wsAddresses) {
          this.ws?.stop();this.wsAddresses=addresses;
          this.ws=addresses?new BscWsSource(env.BSC_LOG_WSS_URL,addresses.split(","),
            env.FEE_CONFIRMATIONS,()=>{void this.run().catch(()=>{});},
            (status)=>this.store.recordBscWsStatus(status)):null;
          this.ws?.start();
        }
      }
    }
    const watched=this.store.watchedIds(),active=this.store.activeSignalIds();
    const ranked=this.store.list().filter((s)=>s.pool.chain===this.chain &&
      s.pool.activeLiquidityDetails?.method==="V3_VIRTUAL_RESERVES_V1" &&
      (watched.has(s.pool.id)||active.has(s.pool.id)||
        priorityTier(s.pool,false,s.metrics,priorityPolicy())===1) &&
      (this.retryAt.get(s.pool.id)??0)<=started).map((s)=>({s,cursor:this.store.liveFeeCursor(s.pool.id)}));
    const score=(x:(typeof ranked)[number])=>priorityScore(x.s.pool,watched.has(x.s.pool.id),
      x.s.metrics,priorityPolicy())+(active.has(x.s.pool.id)?1000:0)+
      (x.cursor?Math.min(5000,Math.max(0,started-x.cursor.updatedAt)/40):5000);
    ranked.sort((a,b)=>score(b)-score(a));
    const selected=ranked.slice(0,env.LIVE_POOLS_PER_CYCLE);
    const results=await Promise.all(selected.map(async({s})=>{
      try {
        const result=await indexLiveEvmFees(s.pool,new RpcRouter(this.chain,this.store),this.store);
        this.retryAt.delete(s.pool.id);
        return {swaps:result.indexed,error:null};
      } catch(e) {
        this.retryAt.set(s.pool.id,Date.now()+60000);
        return {swaps:0,error:e instanceof Error?e.message:"Live ingestion unavailable"};
      }
    }));
    this.store.recordLiveRun(this.chain,started,selected.length,
      results.reduce((n,r)=>n+r.swaps,0),results.find((r)=>r.error)?.error??null);
  }
  start() {
    this.stopped=false;
    const loop=async()=>{
      try {await this.run();} catch { /* Next cycle retries; health is persisted. */ }
      if(!this.stopped) this.timer=setTimeout(loop,this.disabledNoSource?300000:
        env.LIVE_INTERVAL_SECONDS*1000);
    };
    this.timer=setTimeout(loop,this.chain==="base"?3000:8000);
  }
  async stop() {this.stopped=true;clearTimeout(this.timer);this.ws?.stop();await this.active;}
}
