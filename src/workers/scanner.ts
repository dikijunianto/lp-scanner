import { eq } from "drizzle-orm";
import pino from "pino";
import { env, researchPolicy, priorityPolicy } from "../config/env";
import { priorityScore } from "../core/research";
import { withTraffic, type Traffic } from "../core/traffic";
import { snapshot } from "../core/analytics";
import { windows, type Adapter } from "../core/model";
import { MeteoraAdapter } from "../adapters/meteora";
import { UniswapV3Adapter, PancakeV3Adapter } from "../adapters/evm";
import { safeError } from "../adapters/http";
import { HttpClient } from "../adapters/http";
import { applyCachedPrices } from "../adapters/pricing";
import type { Store } from "../db/store";
import { runs, type SourceStatus } from "../db/schema";
import { recordAlert } from "./alerts";
export const log = pino({ level: env.LOG_LEVEL });
export const makeAdapters = (): Adapter[] => [
  new MeteoraAdapter(new HttpClient(1000/env.METEORA_REQUESTS_PER_SECOND,fetch,0,2500)),
  new UniswapV3Adapter(new HttpClient(60000/env.GECKO_REQUESTS_PER_MINUTE,fetch,0,2500)),
  new PancakeV3Adapter(new HttpClient(60000/env.GECKO_REQUESTS_PER_MINUTE,fetch,0,2500)),
];
export class Scanner {
  private active: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  constructor(
    private store: Store,
    public adapters = makeAdapters(),
  ) {}
  get running() {
    return this.active !== null;
  }
  scan() {
    if (this.active) return this.active;
    const traffic: Traffic = { apiRequests: 0, rpcRequests: 0, cacheHits: 0,slowCalls:[] };
    this.active = withTraffic(traffic, () => this.execute(traffic)).finally(() => {
      this.active = null;
    });
    return this.active;
  }
  private async execute(traffic: Traffic) {
    const startedAt = Date.now();
    const id = this.store.db
      .insert(runs)
      .values({ startedAt, status: "running", data: [] })
      .returning({ id: runs.id })
      .get().id;
    const result = await Promise.all(
      this.adapters.map(async (adapter): Promise<SourceStatus> => {
        try {
          const { pools, notes } = await adapter.scan();
          const watched = this.store.watchedIds();
          pools.sort((a, b) => priorityScore(b, watched.has(b.id), undefined, priorityPolicy()) - priorityScore(a, watched.has(a.id), undefined, priorityPolicy()));
          notes.push(applyCachedPrices(pools,this.store));
          for(const pool of pools) {
            const cached=this.store.get(pool.id)?.pool;
            if(!cached || cached.activeLiquidityUsd===null) continue;
            for(const key of ["activeLiquidityUsd","activeLiquiditySource","activeLiquidityConfidence",
              "activeLiquidityUpdatedAt","activeLiquidityExpiresAt","activeLiquidityReason",
              "activeLiquidityDetails"] as const) (pool as unknown as Record<string,unknown>)[key]=cached[key];
            pool.feeTier ??= cached.feeTier;
            pool.binStep ??= cached.binStep;
            pool.token0.decimals ??= cached.token0.decimals;
            pool.token1.decimals ??= cached.token1.decimals;
          }
          if (env.ACTIVE_LIQUIDITY_ENABLED && pools.length) {
            try {
              const { RpcRouter } = await import("../adapters/rpc-router");
              if (pools[0].chain === "solana") {
                const { enrichMeteoraDepth } = await import("../adapters/meteora-depth");
                notes.push(
                  await enrichMeteoraDepth(
                    pools,
                    new RpcRouter("solana",this.store),
                    this.store,
                    true,
                    watched,
                  ),
                );
              } else if (pools[0].chain === "base" || pools[0].chain === "bsc") {
                const chain = pools[0].chain;
                const { enrichEvmDepth } = await import("../adapters/evm-depth");
                const depthRpc = new RpcRouter(chain,this.store);
                notes.push(await enrichEvmDepth(pools, depthRpc, this.store, true, watched));
                for (const pool of pools) {
                  const saved = this.store.latestFeeWindows(pool.id, pool.timestamp);
                  pool.feeWindows = saved;
                  for (const window of windows) {
                    const data = saved[window];
                    if (data?.methodology === "EVENT_DERIVED") {
                      pool[`fees${window}`] = data.feesUsd;
                      pool[`volume${window}`] = data.volumeUsd;
                    }
                  }
                  pool.feeConfidence = saved["1h"]?.methodology === "EVENT_DERIVED" ? "MEDIUM"
                    : saved["5m"]?.methodology === "EVENT_DERIVED" ? "LOW" : "UNAVAILABLE";
                }
              }
            } catch {
              notes.push("Economic enrichment unavailable");
            }
          }
          const items = pools.map((pool) =>
            snapshot(
              pool,
              this.store.analyticsHistory(pool.id, pool.timestamp).map((s) => s.pool),
              this.store.candles(pool.id),
              { surgeMultiplier: env.SURGE_MULTIPLIER, minHourlyFees: env.SURGE_MIN_HOURLY_FEES },
            ),
          );
          this.store.save(items,true);
          for (const item of items) {
            const created = this.store.syncSignals(item, researchPolicy());
            if (created.length) await recordAlert(this.store, item);
          }
          if (pools[0]?.chain === "base" || pools[0]?.chain === "bsc")
            for (const item of items.slice(0, env.FEE_EVM_LIMIT))
              this.store.enqueueBackfill(item.pool, priorityScore(item.pool, watched.has(item.pool.id), item.metrics, priorityPolicy()));
          return {
            name: adapter.name,
            status: notes.some((n) => n.includes("unavailable") || n.includes("skipped"))
              ? "degraded"
              : "ok",
            pools: items.length,
            notes,
          };
        } catch (error) {
          const message = safeError(error);
          log.warn({ source: adapter.name, message }, "Scan source failed");
          return { name: adapter.name, status: "error", pools: 0, notes: [message] };
        }
      }),
    );
    this.store.db
      .update(runs)
      .set({
        endedAt: Date.now(),
        status: result.every((s) => s.status === "error")
          ? "error"
          : result.some((s) => s.status !== "ok")
            ? "degraded"
            : "ok",
        data: result,
      })
      .where(eq(runs.id, id))
      .run();
    this.store.prune(env.RETENTION_DAYS);
    const durationMs = Date.now() - startedAt;
    this.store.saveScanMetrics(id, durationMs, traffic.apiRequests, traffic.rpcRequests, traffic.cacheHits);
    this.store.recordScanSlowCalls(id,traffic.slowCalls??[]);
    if (durationMs > 25000) log.warn({run:id,durationMs},"Foreground scan exceeded 25 seconds");
    log.info(
      {
        run: id,
        durationMs,
        sources: result.map((r) => ({ source: r.name, status: r.status, pools: r.pools })),
      },
      "Scan complete",
    );
  }
  start() {
    this.stopped = false;
    const loop = async () => {
      try {
        await this.scan();
      } catch {
        log.error("Scanner run failed");
      } finally {
        if (!this.stopped) this.timer = setTimeout(loop, env.SCAN_INTERVAL_SECONDS * 1000);
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
