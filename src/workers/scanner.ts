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
