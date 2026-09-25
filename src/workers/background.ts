import { env, researchPolicy, priorityPolicy } from "../config/env";
import { priorityScore } from "../core/research";
import { withTraffic, type Traffic } from "../core/traffic";
import type { Store } from "../db/store";
import { RpcRouter } from "../adapters/rpc-router";
import { backfillEventPrices } from "../adapters/historical-price";
import { indexEvmFeeJob, indexLiveEvmFees } from "../adapters/evm-fees";
import { enrichEvmDepth } from "../adapters/evm-depth";
import { enrichMeteoraDepth } from "../adapters/meteora-depth";
import { buildCohorts } from "../core/cohorts";

export class BackgroundWorker {
  private active: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  constructor(private store: Store) {}
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
    const runId = this.store.startWorkerRun(this.store.backfillQueueLength());
    const notes: string[] = [];
    let status = "ok";
    try {
      const outcomes = await this.store.evaluateDueOutcomes(researchPolicy(),Date.now(),
        env.OUTCOME_JOBS_PER_CYCLE,env.OUTCOME_WORKER_CONCURRENCY);
      if (outcomes) notes.push(`${outcomes} outcomes evaluated`);
      await Promise.all((["solana","base","bsc"] as const)
        .map((chain) => new RpcRouter(chain,this.store).probeAll()));
      const watched = this.store.watchedIds();
      const snapshots = this.store.list();
      const active=this.store.activeSignalIds();
      const live=snapshots.filter((s)=>["base","bsc"].includes(s.pool.chain) &&
        s.pool.activeLiquidityDetails?.method==="V3_VIRTUAL_RESERVES_V1")
        .map((s)=>({s,cursor:this.store.liveFeeCursor(s.pool.id)}))
        .sort((a,b)=>{
          const score=(x:typeof a)=>priorityScore(x.s.pool,watched.has(x.s.pool.id),x.s.metrics,priorityPolicy())
            +(active.has(x.s.pool.id)?1000:0)
            +(x.cursor && x.cursor.headBlock-x.cursor.blockNumber>100?3000:0)
            +(x.cursor?Math.min(1000,(Date.now()-x.cursor.updatedAt)/1000):1500);
          return score(b)-score(a);
        });
      const chosen=[live.find((x)=>x.s.pool.chain==="base"),live.find((x)=>x.s.pool.chain==="bsc")]
        .filter((x):x is (typeof live)[number]=>!!x);
      chosen.push(...live.filter((x)=>!chosen.includes(x)).slice(0,Math.max(0,env.LIVE_POOLS_PER_CYCLE-chosen.length)));
      for(const {s} of chosen.slice(0,env.LIVE_POOLS_PER_CYCLE)) {
        try {
          const result=await indexLiveEvmFees(s.pool,new RpcRouter(s.pool.chain as "base"|"bsc",this.store),this.store);
          notes.push(`Live ${s.pool.chain} ${s.pool.pair}: ${result.indexed} swaps, ${result.status}`);
        } catch(error) {
          status="degraded";
          notes.push(`Live ${s.pool.chain} ${s.pool.pair}: ${error instanceof Error?error.message:"unavailable"}`);
        }
      }
      const ranked=snapshots.sort((a,b)=>priorityScore(b.pool,watched.has(b.pool.id),b.metrics,priorityPolicy())-
        priorityScore(a.pool,watched.has(a.pool.id),a.metrics,priorityPolicy()));
      const sol=ranked.filter((s)=>s.pool.chain==="solana").map((s)=>s.pool);
      const base=ranked.filter((s)=>s.pool.chain==="base").map((s)=>s.pool);
      const bsc=ranked.filter((s)=>s.pool.chain==="bsc").map((s)=>s.pool);
      if(sol.length) notes.push(await enrichMeteoraDepth(sol,new RpcRouter("solana",this.store),this.store,false,watched));
      if(base.length) notes.push(await enrichEvmDepth(base,new RpcRouter("base",this.store),this.store,false,watched));
      if(bsc.length) notes.push(await enrichEvmDepth(bsc,new RpcRouter("bsc",this.store),this.store,false,watched));
      const jobs = this.store.backfillJobs(env.BACKFILL_POOLS_PER_CYCLE);
      for (const { job, pool } of jobs) {
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
      if(outcomes || !this.store.cohorts().length) {
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
        if (!this.stopped) this.timer = setTimeout(loop, env.BACKGROUND_INTERVAL_SECONDS * 1000);
      }
    };
    void loop();
  }
  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.active;
  }
}
