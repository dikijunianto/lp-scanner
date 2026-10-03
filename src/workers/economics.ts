import { env,priorityPolicy } from "../config/env";
import { priorityScore } from "../core/research";
import { snapshot } from "../core/analytics";
import type { Store } from "../db/store";
import { enrichPrices, pricePolicy } from "../adapters/pricing";
import { applyPrice, deriveCrossAssetPrices, priceLineage, type EvidencedPrice, type CrossAssetPricePolicy, type PriceProvenance } from "../core/pricing";
import type { Token } from "../core/model";
import type { PriceFailure } from "../adapters/pricing";
type PriceToken=Token & {priceProvenance?:PriceProvenance|null;priceFailures?:PriceFailure[]};
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
    const active=this.store.activeSignalIds();
    const prioritized=(id:string)=>watched.has(id)||active.has(id);
    snapshots.sort((a,b)=>priorityScore(b.pool,prioritized(b.pool.id),b.metrics,priorityPolicy())-
      priorityScore(a.pool,prioritized(a.pool.id),a.metrics,priorityPolicy()));
    const pools=snapshots.map((s)=>s.pool);
    const original=new Map(pools.map((p)=>[p.id,p.timestamp]));
    const changed=new Set(pools.slice(0,env.PRICE_POOL_LIMIT).map((p)=>p.id));
    const derivationPolicy:CrossAssetPricePolicy={
      minimumLiquidityUsd:env.CROSS_PRICE_MIN_LIQUIDITY_USD,
      maxAgeMs:env.ACTIVE_LIQUIDITY_MAX_AGE_SECONDS*1000,
      maxAlignmentMs:env.CROSS_PRICE_MAX_ALIGNMENT_SECONDS*1000,
      maxPools:env.PRICE_POOL_LIMIT,
      maxDerivations:2,
    };
    const priced=await enrichPrices(pools,this.store,{derivationPolicy});
    this.store.savePrices(priced.records);
    if(env.ACTIVE_LIQUIDITY_ENABLED)
    for(const chain of ["base","solana"]) {
      const limit=chain==="solana"?env.ACTIVE_LIQUIDITY_METEORA_LIMIT:env.ACTIVE_LIQUIDITY_EVM_LIMIT;
      const targets=pools.filter((p)=>p.chain===chain).slice(0,limit);
      if(!targets.length) continue;
      await enrichLiquidity(targets,this.store);
      for(const pool of targets) changed.add(pool.id);
    }
    // Reuse fetched references after RPC capture; no extra provider calls or recursive references.
    const priceTargets=pools.slice(0,env.PRICE_POOL_LIMIT);
    const references:EvidencedPrice[]=[];
    for(const pool of priceTargets) for(const token of [pool.token0,pool.token1]) {
      if(token.usdPrice==null || !["HIGH","MEDIUM"].includes(token.usdPriceConfidence ?? "UNAVAILABLE")) continue;
      references.push({chain:pool.chain,assetAddress:token.address,symbol:token.symbol,priceUsd:token.usdPrice,
        source:token.usdPriceSource ?? "",sourceTimestamp:token.usdPriceSourceTimestamp ?? null,
        observedAt:token.usdPriceObservedAt ?? 0,blockNumber:null,confidence:token.usdPriceConfidence!,
        provenance:(token as PriceToken).priceProvenance ?? undefined});
    }
    const derived:EvidencedPrice[]=[];
    for(const pool of priceTargets) for(const token of [pool.token0,pool.token1]) {
      if(["HIGH","MEDIUM"].includes(token.usdPriceConfidence ?? "UNAVAILABLE") ||
         (token as PriceToken).priceFailures?.some((failure)=>failure.reason==="DISAGREEMENT")) continue;
      const record=deriveCrossAssetPrices(pool,token,pools,references,Date.now(),{...derivationPolicy,maxDerivations:1})[0];
      if(!record) continue;
      applyPrice(token,record,pool,pricePolicy());
      token.priceSourceCount=priceLineage(record).length;
      token.priceMaxDeviationPct=0;
      token.priceConsensusConfidence="MEDIUM";
      derived.push(record);
    }
    if(derived.length) this.store.savePrices(derived);
    for(const pool of pools) {
      if(!changed.has(pool.id)) continue;
      pool.timestamp=original.get(pool.id)!;
      // The store's timestamp comparison rejects a newer foreground discovery snapshot.
      const updated=snapshot(pool,this.store.analyticsHistory(pool.id,pool.timestamp).map((s)=>s.pool),
        this.store.candles(pool.id));
      this.store.replaceCurrent(updated);
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
