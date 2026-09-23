import { expireLiquidity } from "../core/analytics";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import { env } from "../config/env";
import { settings } from "../db/schema";
import { createStore } from "../db/store";
import { Scanner, log } from "../workers/scanner";
import { analyze, enrichHistory, simulateRanges } from "../core/analytics";
import { safeError } from "../adapters/http";
const store = createStore();
const scanner = new Scanner(store);
for (const [key, value] of Object.entries({
  scanInterval: env.SCAN_INTERVAL_SECONDS,
  retentionDays: env.RETENTION_DAYS,
  meteoraMinTvl: env.METEORA_MIN_TVL,
  meteoraMaxPools: env.METEORA_MAX_POOLS,
  evmPages: env.EVM_PAGES,
}))
  store.db
    .insert(settings)
    .values({ key, value: String(value) })
    .onConflictDoUpdate({ target: settings.key, set: { value: String(value) } })
    .run();
const app = Fastify({ logger: false, bodyLimit: 16384 });
await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
app.addHook("onRequest", async (request, reply) => {
  const host = request.headers.host?.split(":")[0];
  if (host !== "127.0.0.1" && host !== "localhost")
    return reply.code(403).send({ error: "Local host only" });
});
app.setErrorHandler((error, request, reply) => {
  log.warn({ route: request.routeOptions.url }, "API request failed");
  reply
    .code(error instanceof z.ZodError ? 400 : 500)
    .send({ error: error instanceof z.ZodError ? "Invalid request" : "Request failed" });
});
app.get("/health", async () => ({
  status: "ok",
  readOnly: true,
  scannerRunning: scanner.running,
  lastRun: store.recentRuns()[0] ?? null,
}));
app.get("/pools", async () => ({
  pools: store.list(),
  runs: store.recentRuns(),
  settings: {
    scanInterval: env.SCAN_INTERVAL_SECONDS,
    retentionDays: env.RETENTION_DAYS,
    meteoraMinTvl: env.METEORA_MIN_TVL,
    meteoraMaxPools: env.METEORA_MAX_POOLS,
    evmPages: env.EVM_PAGES,
    telegramConfigured: !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
  },
}));
app.get("/alerts", async () => ({ alerts: store.recentAlerts() }));
app.get("/pools/:id", async (request, reply) => {
  const { id } = z.object({ id: z.string().min(1).max(180) }).parse(request.params);
  const item = store.get(id);
  if (!item) return reply.code(404).send({ error: "Pool not found" });
  const history = store.history(id);
  let candles = store.candles(id);
  let candleError: string | null = null;
  const adapter = scanner.adapters.find((a) => a.name === item.pool.dex);
  if (adapter) {
    try {
      candles = await adapter.candles(item.pool);
      store.saveCandles(id, candles);
    } catch (error) {
      candleError = safeError(error);
    }
  }
  const pool = enrichHistory(
    item.pool,
    history.map((s) => s.pool),
    candles,
  );
  const metrics = analyze(
    pool,
    store.analyticsHistory(id, pool.timestamp).map((s) => s.pool),
    { surgeMultiplier: env.SURGE_MULTIPLIER, minHourlyFees: env.SURGE_MIN_HOURLY_FEES },
  );
  return {
    ...expireLiquidity({ pool, metrics }, Date.now()),
    history,
    candles,
    candleError,
    ranges: simulateRanges(pool.price, candles),
  };
});
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await app.close();
  await scanner.stop();
  store.close();
};
process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());
await app.listen({ host: "127.0.0.1", port: env.API_PORT });
log.info({ port: env.API_PORT }, "Read-only API listening");
scanner.start();
