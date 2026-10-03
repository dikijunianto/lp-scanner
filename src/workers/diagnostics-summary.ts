import {env} from "../config/env";
import {assessReadinessV3,type HourlySlo} from "../core/readiness-v3";
import type {Store} from "../db/store";
export function aggregateDiagnostics(store:Store) {
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
  const context=store.burninContext();
  const observationEnd=context?.finishedAt??generatedAt;
  const snapshotCoverage=store.coreSnapshotCoverage(observationEnd,context?Math.max(60000,observationEnd-context.startedAt):4*3600000,true);
  const scanLatency=store.scanLatency();
  const outcomeFieldCoverage=store.outcomeFieldCoverage(generatedAt);
  const selectedOutcomeCoverage=store.outcomeFieldCoverage(generatedAt,true);
  const recentOutcomeLag=store.recentOutcomeLag(generatedAt);
  const newOutcomeLag=store.newOutcomeLag(generatedAt);
  const databaseGrowth=store.databaseGrowth(generatedAt);
  const storageGrowth=store.storageGrowthSinceVersion(generatedAt);
  const measuredStorageGrowth=store.measuredStorageGrowth(generatedAt);
  const diskSafety=store.diskSafety(measuredStorageGrowth.bytesPerDay);
  const hourly=store.hourlyCheckpoints();
  const windowStart=context?.startedAt??hourly[0]?.burninStartedAt??generatedAt;
  const scanWindow=store.scanWindow(windowStart,observationEnd);
  const readiness=assessReadinessV3({foregroundP95Ms:scanLatency.p95Ms,
    foregroundP99Ms:scanLatency.p99Ms,hot:hotCoverage,
    snapshot:snapshotCoverage,outcomes:selectedOutcomeCoverage,
    newOutcomeP95LagMs:newOutcomeLag.p95Ms,providers:[...providers,
      ...eventSources.map((s)=>({...s,supportsGetLogs:true}))],diskDaysRemaining:diskSafety?.estimatedDaysRemaining??null,
    growthBytesPerDay:measuredStorageGrowth.bytesPerDay,
    growthHours:measuredStorageGrowth.hours},hourly as HourlySlo[],scanWindow,hourly.length?(hourly.at(-1).at-windowStart)/3600000:0);
  return {
  generatedAt,hotPoolDetails:store.hotPoolDetails(generatedAt),hourlySlo:hourly,scanWindow,
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
}
