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
import { assessReadiness } from "../core/readiness";
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
const dataHealth=async () => {
  const generatedAt=Date.now();
  const providers=store.rpcProviders();
  const bscProviders=providers.filter((p)=>p.chain==="bsc" && p.providerType==="CONFIGURED");
  const bscWebSocket=store.bscWsStatus();
  const eventSources=store.eventSources() as {chain:string;purpose:string;healthState:string}[];
  const bscSource={
    liveLogs:bscWebSocket?.status==="LIVE" || bscProviders.some((p)=>p.supportsGetLogs===true && p.healthState==="HEALTHY") ||
      eventSources.some((s)=>s.chain==="bsc" && s.purpose==="LIVE" && s.healthState==="HEALTHY"),
    historicalLogs:bscProviders.some((p)=>p.supportsGetLogs===true && p.healthState==="HEALTHY") ||
      eventSources.some((s)=>s.chain==="bsc" && s.purpose==="HISTORICAL" && s.healthState==="HEALTHY"),
    archiveState:bscProviders.some((p)=>p.supportsHistoricalState===true && p.healthState==="HEALTHY"),
    websocket:bscWebSocket?.status??"DISABLED",
  };
  const hotCoverage=store.hotCoverage(generatedAt);
  const snapshotCoverage=store.coreSnapshotCoverage(generatedAt);
  const scanLatency=store.scanLatency();
  const outcomeFieldCoverage=store.outcomeFieldCoverage(generatedAt);
  const selectedOutcomeCoverage=store.outcomeFieldCoverage(generatedAt,true);
  const recentOutcomeLag=store.recentOutcomeLag(generatedAt);
  const newOutcomeLag=store.newOutcomeLag(generatedAt);
  const databaseGrowth=store.databaseGrowth(generatedAt);
  const storageGrowth=store.storageGrowthSinceVersion(generatedAt);
  const measuredStorageGrowth=store.measuredStorageGrowth(generatedAt);
  const diskSafety=store.diskSafety(measuredStorageGrowth.bytesPerDay);
  const readiness=assessReadiness({foregroundP95Ms:scanLatency.p95Ms,
    foregroundP99Ms:scanLatency.p99Ms,hot:hotCoverage,
    snapshot:snapshotCoverage,outcomes:selectedOutcomeCoverage,
    newOutcomeP95LagMs:newOutcomeLag.p95Ms,providers:[...providers,
      ...eventSources.map((s)=>({...s,supportsGetLogs:true}))],diskDaysRemaining:diskSafety?.estimatedDaysRemaining??null,
    growthBytesPerDay:measuredStorageGrowth.bytesPerDay,
    growthHours:measuredStorageGrowth.hours});
  return {
  generatedAt,
  providers,bscSource, usage: store.recentRpcUsage(), priceCalls: store.recentPriceCalls(),
  coverage: store.coverage(), currentFees: store.currentFeeCoverage(),
  historicalFees: store.historicalFeeCoverage(), priceBackfill: store.priceBackfillProgress(),
  missingPriceReasons: store.priceReasonCounts(),
  counts: store.researchCounts(env.OUTCOME_MAX_GAP_SECONDS*1000),
  oldestJob: store.oldestBackfillJob(), scan: store.recentScanMetrics(),
  worker: store.recentWorkerRun(),
  liveCursors:store.liveCursorHealth(),
  logSources:store.rpcProviders().filter((p)=>["base","bsc"].includes(p.chain)).map((p)=>({
    chain:p.chain,sourceId:p.providerId,sourceType:"RPC_GET_LOGS",
    latestIndexedBlock:store.liveCursorHealth().filter((c)=>c.sourceId===p.providerId)
      .reduce<number|null>((n,c)=>Math.max(n??0,c.blockNumber),null),
    latencyMs:p.latencyMs,historicalCoverage:"UNKNOWN",
    confidence:p.supportsGetLogs===true && p.healthState==="HEALTHY"?"LOW":"UNAVAILABLE",
    status:p.healthState,failureReason:p.failureReason,
  })),outcomePipeline:store.outcomePipeline(),
  outcomeMissingness:store.outcomeMissingness(),outcomeLag:store.outcomeCompletionLag(),
  outcomeThroughput:store.outcomeThroughput(),outcomeConcurrency:env.OUTCOME_WORKER_CONCURRENCY,
  depthFailures:store.depthFailureCounts(),bscDepthFailures:store.depthFailureCounts("bsc"),
  databaseGrowth,storageGrowth,measuredStorageGrowth,hotCoverage,snapshotCoverage,scanLatency,outcomeFieldCoverage,
  recentOutcomeLag,newOutcomeLag,selectedOutcomeCoverage,diskSafety,readiness,
  datasetVersion:store.datasetVersion(),scanSkippedBecausePreviousRunning:store.scanSkipped(),
  scanSpans:store.recentScanSpans(),coreWriter:store.coreWriterHealth(),
  liveRuns:store.recentLiveRuns(),slowCalls:store.recentSlowCalls(),eventSources,
  sourceDisagreements:store.sourceDisagreementRates(),
  };
};
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
