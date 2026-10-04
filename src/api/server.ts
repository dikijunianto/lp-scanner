import { expireLiquidity } from "../core/analytics";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import { env } from "../config/env";
import { settings } from "../db/schema";
import { createStore } from "../db/store";
import pino from "pino";
const log=pino({level:env.LOG_LEVEL});
import { analyze, enrichHistory, simulateRanges } from "../core/analytics";
import { safeError } from "../adapters/http";
const store = createStore();
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
  scannerRunning: store.serviceAlive("scanner"),
  backgroundRunning: ["outcomes","depth","history"].every((name)=>store.serviceAlive(name)),
  economicRunning:store.serviceAlive("economic"),
  liveBaseRunning:store.serviceAlive("live-base"),liveBscRunning:store.serviceAlive("live-bsc"),
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
app.get("/watchlist", async () => ({ poolIds: [...store.watchedIds()] }));
app.post("/watchlist", async (request, reply) => {
  if (request.headers["content-type"]?.split(";")[0] !== "application/json")
    return reply.code(415).send({ error: "JSON required" });
  const { poolId, watched } = z.object({ poolId: z.string().min(1).max(180), watched: z.boolean() }).parse(request.body);
  if (!store.watch(poolId, watched)) return reply.code(404).send({ error: "Pool not found" });
  return { poolId, watched };
});
app.get("/research/signals", async () => ({ signals: store.listSignals(500).map((s) => ({
  id: s.id, poolId: s.poolId, signalType: s.signalType, episodeStart: s.episodeStart,
  episodeLastSeen: s.episodeLastSeen, episodeEnd: s.episodeEnd, peakScore: s.peakScore,
  chain: s.data.pool.chain, protocol: s.data.pool.protocol, pair: s.data.pool.pair,
  activity: s.data.metrics.activity, risk: s.data.metrics.risk,
  confidence: s.data.metrics.dataQuality,
})) }));
app.get("/research/signals/:id", async (request, reply) => {
  const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
  const signal = store.signalDetail(id);
  return signal ?? reply.code(404).send({ error: "Signal not found" });
});
app.get("/research/summary", async () => ({ facts: store.researchFacts(),
  cohorts: store.cohorts().map((r) => JSON.parse(r.data)), minSample: env.COHORT_MIN_SAMPLE,
  counts: store.researchCounts(env.OUTCOME_MAX_GAP_SECONDS*1000), outcomes: store.outcomeCoverage() }));
app.get("/research/coverage", async () => ({ coverage: store.coverage(), counts: store.researchCounts(env.OUTCOME_MAX_GAP_SECONDS*1000),
  scan: store.recentScanMetrics(), worker: store.recentWorkerRun(), jobs: store.backfillStatus(20).map((j) => ({
    poolId:j.pool_id,chain:j.chain,status:j.status,startBlock:j.start_block,endBlock:j.end_block,
    retryCount:j.retry_count,failureReason:j.failure_reason,
  })) }));
const dataHealth=async (_request:unknown,reply:{code:(n:number)=>{send:(v:unknown)=>unknown}}) => {
  const cached=store.diagnosticSummary();
  if(!cached) return reply.code(503).send({error:"Diagnostics warming up"});
  return {...cached.data,summaryAgeMs:Date.now()-Number(cached.data.generatedAt??cached.updatedAt),
    summaryStale:Date.now()-Number(cached.data.generatedAt??cached.updatedAt)>env.DIAGNOSTICS_MAX_AGE_SECONDS*1000};
};
app.get("/diagnostics/scan/:id",async(request)=>{
  const {id}=z.object({id:z.coerce.number().int().positive()}).parse(request.params);
  return store.scanTrace(id);
});
app.get("/diagnostics/data-health",dataHealth);
app.get("/diagnostics/reliability",dataHealth);
app.get("/diagnostics/pool-freshness/:id", async (request,reply) => {
  const {id}=z.object({id:z.string().min(1).max(180)}).parse(request.params);
  return store.poolFreshness(id)??reply.code(404).send({error:"Pool not found"});
});
app.get("/pools/:id", async (request, reply) => {
  const { id } = z.object({ id: z.string().min(1).max(180) }).parse(request.params);
  const item = store.get(id);
  if (!item) return reply.code(404).send({ error: "Pool not found" });
  const history = store.history(id);
  let candles = store.candles(id);
  let candleError: string | null = null;
  const {makeAdapters}=await import("../workers/scanner");
  const adapter = makeAdapters().find((a) => a.name === item.pool.dex);
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
  store.close();
};
process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());
await app.listen({ host: "127.0.0.1", port: env.API_PORT });
log.info({ port: env.API_PORT }, "Read-only API listening");
