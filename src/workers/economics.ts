import { env,priorityPolicy } from "../config/env";
import { priorityScore } from "../core/research";
import { snapshot } from "../core/analytics";
import type { Store } from "../db/store";
import { enrichPrices } from "../adapters/pricing";
import { enrichLiquidity } from "../adapters/enrich-liquidity";

// External price and pool-state reads never hold up the foreground discovery pass.
export class EconomicWorker {
  private active:Promise<void>|null=null;
  private timer:ReturnType<typeof setTimeout>|undefined;
  private stopped=false;
  constructor(private store:Store) {}
  get running() {return this.active!==null;}
  run() {
    if(this.active) return this.active;
    this.active=this.execute().finally(()=>{this.active=null;});
    return this.active;
  }
  private async execute() {
    if(this.store.diskState()==="EMERGENCY") return;
    const snapshots=this.store.list();
    if(!snapshots.length) return;
    const watched=this.store.watchedIds();
    snapshots.sort((a,b)=>priorityScore(b.pool,watched.has(b.pool.id),b.metrics,priorityPolicy())-
      priorityScore(a.pool,watched.has(a.pool.id),a.metrics,priorityPolicy()));
    const pools=snapshots.map((s)=>s.pool);
    const priced=await enrichPrices(pools,this.store);
    this.store.savePrices(priced.records);
    if(!env.ACTIVE_LIQUIDITY_ENABLED) return;
    for(const chain of ["base","bsc","solana"]) {
      const limit=chain==="solana"?env.ACTIVE_LIQUIDITY_METEORA_LIMIT:env.ACTIVE_LIQUIDITY_EVM_LIMIT;
      const targets=pools.filter((p)=>p.chain===chain).slice(0,limit);
      if(!targets.length) continue;
      const original=new Map(targets.map((p)=>[p.id,p.timestamp]));
      await enrichLiquidity(targets,this.store);
      for(const pool of targets) {
        pool.timestamp=original.get(pool.id)!;
        const updated=snapshot(pool,this.store.analyticsHistory(pool.id,pool.timestamp).map((s)=>s.pool),
          this.store.candles(pool.id));
        this.store.replaceCurrent(updated);
      }
    }
  }
  start() {
    this.stopped=false;
    const loop=async()=>{
      try {await this.run();} catch { /* Cache remains available; retry next interval. */ }
      if(!this.stopped) this.timer=setTimeout(loop,env.ECONOMIC_INTERVAL_SECONDS*1000);
    };
    this.timer=setTimeout(loop,10000);
  }
  async stop() {this.stopped=true;clearTimeout(this.timer);await this.active;}
}
