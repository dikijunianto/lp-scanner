import { enrichLiquidity } from "../adapters/enrich-liquidity";
import { eq } from "drizzle-orm";
import pino from "pino";
import { env } from "../config/env";
import { snapshot } from "../core/analytics";
import type { Adapter } from "../core/model";
import { MeteoraAdapter } from "../adapters/meteora";
import { UniswapV3Adapter, PancakeV3Adapter } from "../adapters/evm";
import { safeError } from "../adapters/http";
import type { Store } from "../db/store";
import { runs, type SourceStatus } from "../db/schema";
import { recordAlert } from "./alerts";
export const log = pino({ level: env.LOG_LEVEL });
export const makeAdapters = (): Adapter[] => [
  new MeteoraAdapter(),
  new UniswapV3Adapter(),
  new PancakeV3Adapter(),
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
    this.active = this.execute().finally(() => {
      this.active = null;
    });
    return this.active;
  }
  private async execute() {
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
          if (env.ACTIVE_LIQUIDITY_ENABLED && pools.length) {
            const { enrichPrices } = await import("../adapters/pricing");
            const priced = await enrichPrices(pools);
            this.store.savePrices(priced.records);
            notes.push(priced.note);
          }
          notes.push(await enrichLiquidity(pools));
          if (env.ACTIVE_LIQUIDITY_ENABLED && pools.length) {
            try {
              const { ReadOnlyRpc } = await import("../adapters/liquidity-rpc");
              if (pools[0].chain === "solana") {
                const { enrichMeteoraDepth } = await import("../adapters/meteora-depth");
                const { SOLANA_PUBLIC_RPC } = await import("../adapters/meteora-liquidity");
                notes.push(
                  await enrichMeteoraDepth(
                    pools,
                    new ReadOnlyRpc(env.SOLANA_RPC_URL ?? SOLANA_PUBLIC_RPC),
                    this.store,
                  ),
                );
              } else if (pools[0].chain === "base" || pools[0].chain === "bsc") {
                const chain = pools[0].chain;
                const { evmNetworks } = await import("../adapters/evm-liquidity");
                const rpc = new ReadOnlyRpc(
                  (chain === "base" ? env.BASE_RPC_URL : env.BSC_RPC_URL) ?? evmNetworks[chain].url,
                );
                const { enrichEvmFees } = await import("../adapters/evm-fees");
                const { enrichEvmDepth } = await import("../adapters/evm-depth");
                const feeRpc =
                  chain === "bsc"
                    ? new ReadOnlyRpc(env.BSC_FEE_RPC_URL ?? "https://bsc-rpc.publicnode.com")
                    : rpc;
                const depthRpc =
                  chain === "base"
                    ? new ReadOnlyRpc(env.BASE_DEPTH_RPC_URL ?? "https://base-rpc.publicnode.com")
                    : rpc;
                notes.push(await enrichEvmFees(pools, feeRpc, this.store));
                notes.push(await enrichEvmDepth(pools, depthRpc, this.store));
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
          this.store.save(items);
          for (const item of items) await recordAlert(this.store, item);
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
    log.info(
      {
        run: id,
        durationMs: Date.now() - startedAt,
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
