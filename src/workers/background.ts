import { env, researchPolicy, priorityPolicy } from "../config/env";
import { priorityScore } from "../core/research";
import { withTraffic, type Traffic } from "../core/traffic";
import type { Store } from "../db/store";
import { ReadOnlyRpc } from "../adapters/liquidity-rpc";
import { evmNetworks } from "../adapters/evm-liquidity";
import { SOLANA_PUBLIC_RPC } from "../adapters/meteora-liquidity";
import { indexEvmFeeJob } from "../adapters/evm-fees";
import { enrichEvmDepth } from "../adapters/evm-depth";
import { enrichMeteoraDepth } from "../adapters/meteora-depth";

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
      const watched = this.store.watchedIds();
      const jobs = this.store.backfillJobs(env.BACKFILL_POOLS_PER_CYCLE);
      for (const { job, pool } of jobs) {
        const rpc = new ReadOnlyRpc(
          job.chain === "bsc"
            ? (env.BSC_FEE_RPC_URL ?? "https://bsc.publicnode.com")
            : (env.BASE_RPC_URL ?? evmNetworks.base.url),
        );
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
        .slice(0, env.DEPTH_METEORA_LIMIT)
        .map((s) => s.pool);
      const base = snapshots
        .filter((s) => s.pool.chain === "base")
        .slice(0, env.DEPTH_EVM_LIMIT)
        .map((s) => s.pool);
      const bsc = snapshots
        .filter((s) => s.pool.chain === "bsc")
        .slice(0, env.DEPTH_EVM_LIMIT)
        .map((s) => s.pool);
      if (sol.length)
        notes.push(
          await enrichMeteoraDepth(
            sol,
            new ReadOnlyRpc(env.SOLANA_RPC_URL ?? SOLANA_PUBLIC_RPC),
            this.store,
            false,
            watched,
          ),
        );
      if (base.length)
        notes.push(
          await enrichEvmDepth(
            base,
            new ReadOnlyRpc(env.BASE_DEPTH_RPC_URL ?? "https://base-rpc.publicnode.com"),
            this.store,
            false,
            watched,
          ),
        );
      if (bsc.length)
        notes.push(
          await enrichEvmDepth(
            bsc,
            new ReadOnlyRpc(env.BSC_RPC_URL ?? evmNetworks.bsc.url),
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
