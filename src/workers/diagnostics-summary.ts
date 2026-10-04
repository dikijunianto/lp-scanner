import {env} from "../config/env";
import {assessReadinessV4,type HourlySloV4} from "../core/readiness-v4";
import {providerServices} from "../core/provider-services";
import {storageDelta,type StorageSample} from "../core/storage-accounting";
import type {Store} from "../db/store";
export function aggregateDiagnostics(store:Store) {
  const generatedAt=Date.now();
  const providers=store.rpcProviders();
  const bscProviders=providers.filter((p)=>p.chain==="bsc" && p.providerType==="CONFIGURED");
  const bscWebSocket=store.bscWsStatus();
  const eventSources=store.eventSources() as {chain:string;purpose:string;healthState:string;lastSuccessAt:number|null}[];
  const fresh=(at:number|null)=>at!==null&&at<=generatedAt&&generatedAt-at<=180000;
  const configuredLive=!!(env.BSC_LOG_RPC_URL || env.BSC_LOG_RPC_URLS || env.BSC_LOG_WSS_URL);
  const bscSource={
    liveLogs:configuredLive && (bscWebSocket?.status==="LIVE" && fresh(bscWebSocket.at) || bscProviders.some((p)=>p.supportsGetLogs===true && p.healthState==="HEALTHY") ||
      eventSources.some((s)=>s.chain==="bsc" && s.purpose==="LIVE" && s.healthState==="HEALTHY" && fresh(s.lastSuccessAt))),
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
  const services=providerServices(store.serviceEvidence(generatedAt),generatedAt);
  const epoch=store.validateResearchEpoch({snapshotPct:snapshotCoverage.coveragePct,largestGapMs:snapshotCoverage.largestGapMs,
    breaches:scanWindow.breaches,services,integrityOk:store.integrityStatus()?.state!=='FAIL'},generatedAt);
  const currentEpochOutcomes=epoch?store.epochOutcomeCoverage(generatedAt,epoch.id):store.epochOutcomeCoverage(generatedAt,'NO_EPOCH');
  const allHistoryOutcomes=store.epochOutcomeCoverage(generatedAt);
  const run=store.latestBurninRun();
  const runData=run?JSON.parse(run.data):null;
  const runStorage=runData?.storageBefore&&runData?.storageLast?storageDelta(runData.storageBefore as StorageSample,runData.storageLast as StorageSample):null;
  const hours=run?.started_at?((run.ended_at??generatedAt)-run.started_at)/3600000:0;
  const readiness=assessReadinessV4({epoch,outcomes:currentEpochOutcomes,services,history:hourly as HourlySloV4[],hours,
    clockValid:runData?.clock?.valid===true,scans:scanWindow,storage:{hours:runStorage?.hours??0,
      bytesPerDay:runStorage?.bytesPerDay??null,runwayDays:runStorage?.bytesPerDay&&runStorage.bytesPerDay>0?runData.storageLast.freeBytes/runStorage.bytesPerDay:null},bscLiveLogs:bscSource.liveLogs});
  return {
  generatedAt,dbIntegrity:store.integrityStatus(),runStorage,epochLaunchHealth:store.epochLaunchHealth(generatedAt),researchEpoch:epoch,burninRunId:run?.id??null,providerServices:services,currentEpochOutcomes,allHistoryOutcomes,
  baseLag:store.hotLagDistributions(generatedAt),baseFeeWaterfall:store.feeWaterfall(generatedAt),priceSourceCoverage:store.priceSourceCoverage(),wal:store.walStatus(),
  hotPoolDetails:store.hotPoolDetails(generatedAt),hourlySlo:hourly,scanWindow,
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
