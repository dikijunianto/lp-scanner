import { env, researchPolicy, priorityPolicy } from "../config/env";
import { priorityScore,priorityTier } from "../core/research";
import { withTraffic, type Traffic } from "../core/traffic";
import type { Store } from "../db/store";
import { RpcRouter } from "../adapters/rpc-router";
import { backfillEventPrices } from "../adapters/historical-price";
import { indexEvmFeeJob } from "../adapters/evm-fees";
import { enrichEvmDepth } from "../adapters/evm-depth";
import { enrichMeteoraDepth } from "../adapters/meteora-depth";
import { buildCohorts } from "../core/cohorts";

export class BackgroundWorker {
  private active: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private lastProbeAt=0;
  constructor(private store: Store,private mode:"all"|"outcomes"|"depth"|"history"="all") {}
  get running() {
    return this.active !== null;
  }
  run() {
    if (this.active) return this.active;
    const traffic: Traffic = { apiRequests: 0, rpcRequests: 0, cacheHits: 0 };
    this.active = withTraffic(traffic, () => this.execute(traffic)).finally(() => {
      this.active = null;
    });
    return this.active;
  }
  private async execute(traffic: Traffic) {
    const started=Date.now();
    const disk=this.store.diskState();
    if((this.mode==="history" && ["CRITICAL","EMERGENCY"].includes(disk)) ||
      (this.mode==="depth" && disk==="EMERGENCY")) return;
    const runId = this.store.startWorkerRun(this.store.backfillQueueLength());
    const notes: string[] = [this.mode];
    let status = "ok";
    try {
      const watched = this.store.watchedIds();
      if(this.mode==="all"||this.mode==="outcomes") {
      const outcomes = await this.store.evaluateDueOutcomes(researchPolicy(),Date.now(),
        env.OUTCOME_JOBS_PER_CYCLE,env.OUTCOME_WORKER_CONCURRENCY);
      if (outcomes) notes.push(`${outcomes} outcomes evaluated`);
      if(disk!=="EMERGENCY" && outcomes<env.OUTCOME_JOBS_PER_CYCLE)
        notes.push(`${this.store.requeueOutcomeFieldBackfill(20)} old outcome fields queued`);
      }
      if(this.mode==="all"||this.mode==="depth") {
      const protectedSignals=this.store.activeSignalIds();
      const snapshots = this.store.list().filter(s=>disk!=="CRITICAL" || watched.has(s.pool.id) || protectedSignals.has(s.pool.id) || priorityTier(s.pool,false,s.metrics,priorityPolicy())===1);
      const ranked=snapshots.sort((a,b)=>priorityScore(b.pool,watched.has(b.pool.id),b.metrics,priorityPolicy())-
        priorityScore(a.pool,watched.has(a.pool.id),a.metrics,priorityPolicy()));
      const sol=ranked.filter((s)=>s.pool.chain==="solana").map((s)=>s.pool);
      const base=ranked.filter((s)=>s.pool.chain==="base").map((s)=>s.pool);
      const depth=await Promise.allSettled([
        sol.length?enrichMeteoraDepth(sol,new RpcRouter("solana",this.store),this.store,false,watched):Promise.resolve(""),
        base.length?enrichEvmDepth(base,new RpcRouter("base",this.store),this.store,false,watched):Promise.resolve(""),
      ]);
      for(const result of depth) if(result.status==="fulfilled" && result.value) notes.push(result.value);
      if(Date.now()-this.lastProbeAt>=env.RPC_PROBE_INTERVAL_SECONDS*1000) {
        this.lastProbeAt=Date.now();
        const probes=await Promise.allSettled((["solana","base","bsc"] as const)
          .map((chain)=>new RpcRouter(chain,this.store).probeAll()));
        if(probes.some((p)=>p.status==="rejected")) notes.push("RPC probe degraded");
      }
      }
      if(this.mode==="all"||this.mode==="history") {
      const jobs = this.store.backfillJobs(env.BACKFILL_POOLS_PER_CYCLE);
      const signals=this.store.activeSignalIds();
      const hotBase=this.store.list().filter((s)=>s.pool.chain==="base" &&
        (watched.has(s.pool.id)||signals.has(s.pool.id)||
          priorityTier(s.pool,false,s.metrics,priorityPolicy())===1));
      const live=new Map(this.store.liveCursorHealth().map((c)=>[c.poolId,c]));
      const baseLiveBehind=hotBase.some((s)=>{
        const cursor=live.get(s.pool.id);
        return !cursor || Date.now()-cursor.endTime>180000;
      });
      for (const { job, pool } of jobs) {
        if(job.chain==="base" && baseLiveBehind) {
          notes.push("Base historical repair yielded to stale HOT live cursors");
          continue;
        }
        if(job.chain==="bsc" && ![env.BSC_HISTORICAL_INDEXER_URL,env.BSC_ARCHIVE_RPC_URL,
          env.BSC_LOG_RPC_URL,env.BSC_LOG_RPC_URLS,env.BSC_FEE_RPC_URL].some(Boolean)) {
          notes.push("BSC historical logs disabled: no configured capable source");
          continue;
        }
        if(Date.now()-started>env.BACKGROUND_COLD_BUDGET_MS) {notes.push("Historical fees paused by background budget");break;}
        const rpc = new RpcRouter(job.chain as "base" | "bsc",this.store);
        try {
          const metadata =
            pool.activeLiquidityDetails?.method === "V3_VIRTUAL_RESERVES_V1"
              ? pool
              : (this.store.latestFeeMetadata(pool.id) ?? pool);
          const result = await indexEvmFeeJob(metadata, job, rpc, this.store, watched.has(pool.id));
          notes.push(
            `${job.chain} ${pool.pair}: ${result.indexed} new, ${result.backfilled} older swaps, ${result.status}`,
          );
        } catch (error) {
          status = "degraded";
          const retry = job.retryCount + 1;
          const reason = error instanceof Error ? error.message : "Fee indexing failed";
          const failed = retry >= env.BACKFILL_MAX_RETRIES;
          this.store.setBackfillJob(job.poolId, {
            status: failed ? "FAILED" : "PARTIAL",
            retryCount: retry,
            nextAttemptAt: Date.now() + Math.min(900000, 15000 * 2 ** Math.min(retry - 1, 6)),
            failureReason: reason.slice(0, 200),
          });
          notes.push(`${job.chain} fee indexing unavailable: ${reason}`);
        }
      }
      const priceEvents=Date.now()-started<env.BACKGROUND_COLD_BUDGET_MS
        ? this.store.unpricedEvents(env.PRICE_BACKFILL_EVENTS_PER_CYCLE) : [];
      if(!priceEvents.length && Date.now()-started>=env.BACKGROUND_COLD_BUDGET_MS)
        notes.push("Historical price backfill paused by background budget");
      if(priceEvents.length) {
        const prices=await backfillEventPrices(priceEvents,this.store);
        notes.push(`Historical price backfill: ${prices.priced} priced, ${prices.missing} unavailable, ${prices.requests} calls`);
      }
      const cohorts=buildCohorts(this.store.researchFacts(),env.COHORT_MIN_SAMPLE);
      this.store.replaceCohorts(cohorts);
      notes.push(`${cohorts.filter((c)=>c.status==="VALID").length} valid cohorts`);
      }
    } catch (error) {
      status = "error";
      notes.push(error instanceof Error ? error.message : "Worker failed");
    }
    this.store.finishWorkerRun(
      runId,
      status,
      traffic.apiRequests,
      traffic.rpcRequests,
      traffic.cacheHits,
      this.store.backfillQueueLength(),
      notes.join("; "),
    );
  }
  start() {
    this.stopped = false;
    const loop = async () => {
      try {
        await this.run();
      } catch {
        /* A failed cycle is recorded and retried later. */
      } finally {
        if (!this.stopped) this.timer = setTimeout(loop,
          Math.max(this.mode==="history"?60000:0,env.BACKGROUND_INTERVAL_SECONDS*1000));
      }
    };
    this.timer=setTimeout(loop,this.mode==="depth"?5000:this.mode==="history"?15000:0);
  }
  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.active;
  }
}
