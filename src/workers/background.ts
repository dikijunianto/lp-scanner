import { env, researchPolicy, priorityPolicy } from "../config/env";
import { priorityScore } from "../core/research";
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
    const runId = this.store.startWorkerRun(this.store.backfillQueueLength());
    const notes: string[] = [];
    let status = "ok";
    try {
      const outcomes = this.store.evaluateDueOutcomes(researchPolicy(), Date.now(), 20);
      if (outcomes) notes.push(`${outcomes} outcomes evaluated`);
      if (outcomes || !this.store.cohorts().length) {
        const cohorts = buildCohorts(this.store.researchFacts(),env.COHORT_MIN_SAMPLE);
        this.store.replaceCohorts(cohorts);
        notes.push(`${cohorts.filter((c) => c.status === "VALID").length} valid cohorts`);
      }
      await Promise.all((["solana","base","bsc"] as const)
        .map((chain) => new RpcRouter(chain,this.store).probeAll()));
      const priceEvents = this.store.unpricedEvents(env.PRICE_BACKFILL_EVENTS_PER_CYCLE);
      if (priceEvents.length) {
        const prices = await backfillEventPrices(priceEvents,this.store);
        notes.push(`Historical price backfill: ${prices.priced} priced, ${prices.missing} unavailable, ${prices.requests} calls`);
      }
      const watched = this.store.watchedIds();
      const jobs = this.store.backfillJobs(env.BACKFILL_POOLS_PER_CYCLE);
      for (const { job, pool } of jobs) {
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
      const snapshots = this.store
        .list()
        .sort(
          (a, b) =>
            priorityScore(b.pool, watched.has(b.pool.id), b.metrics, priorityPolicy()) -
            priorityScore(a.pool, watched.has(a.pool.id), a.metrics, priorityPolicy()),
        );
      const sol = snapshots
        .filter((s) => s.pool.chain === "solana")
        .map((s) => s.pool);
      const base = snapshots
        .filter((s) => s.pool.chain === "base")
        .map((s) => s.pool);
      const bsc = snapshots
        .filter((s) => s.pool.chain === "bsc")
        .map((s) => s.pool);
      if (sol.length)
        notes.push(
          await enrichMeteoraDepth(
            sol,
            new RpcRouter("solana",this.store),
            this.store,
            false,
            watched,
          ),
        );
      if (base.length)
        notes.push(
          await enrichEvmDepth(
            base,
            new RpcRouter("base",this.store),
            this.store,
            false,
            watched,
          ),
        );
      if (bsc.length)
        notes.push(
          await enrichEvmDepth(
            bsc,
            new RpcRouter("bsc",this.store),
            this.store,
            false,
            watched,
          ),
        );
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
