import { describe,expect,it } from "vitest";
import { createStore } from "../src/db/store";
import { emptyPool,emptyToken } from "../src/core/model";
import { snapshot } from "../src/core/analytics";
import { horizons, outcomeMissingReasons, type SignalPolicy } from "../src/core/research";
import { cursorLag,depthFailureReason,freshness } from "../src/core/freshness";
import { reconcileSwapLogs } from "../src/adapters/log-sources";
import { providerFailureReason } from "../src/adapters/rpc-router";
import { depthTargets } from "../src/adapters/evm-depth";
import { v3DepthKey } from "../src/core/depth";
import { liveCursorNeedsRestart } from "../src/adapters/evm-fees";
import { strictSample, type CohortFact } from "../src/core/cohorts";
import { swapTopic } from "../src/core/fees";

const address=(n:string)=>`0x${n.repeat(40)}`;
const hash=(n:string)=>`0x${n.repeat(64)}`;
const policy:SignalPolicy={feeEfficiency:0.001,volumeDepth:1,activity:70,risk:60,
  breakoutPct:5,collapsePct:20,persistenceFraction:0.5,maxObservationGapMs:240000};
const pool=(at:number)=>{
  const p=emptyPool({chain:"solana",protocol:"meteora-dlmm",dex:"Meteora DLMM",
    poolAddress:"fixture",token0:emptyToken("a","A"),token1:emptyToken("b","B"),source:"fixture"},at);
  p.price=100;p.volume1h=100;p.fees1h=10;
  return p;
};

describe("Sprint 6 live recovery",()=>{
  it("separates live and historical cursors and saves live events idempotently",()=>{
    const store=createStore(":memory:");
    try {
      const p=pool(Date.now());store.save([snapshot(p,[])]);
      store.saveFeeBatch(p.id,[],1,1000,5,hash("a"),5000);
      const event={poolId:p.id,blockNumber:6,blockHash:hash("b"),txHash:hash("c"),logIndex:0,
        timestamp:6000,volumeUsd:2,feesUsd:0.01,confidence:"MEDIUM" as const,chain:"base"};
      store.saveLiveFeeBatch(p.id,"base",[event],6,6000,6,hash("b"),6000,7,7000,"RPC_GET_LOGS","fixture");
      store.saveLiveFeeBatch(p.id,"base",[event],6,6000,6,hash("b"),6000,7,7000,"RPC_GET_LOGS","fixture");
      expect(store.feeCursor(p.id)?.blockNumber).toBe(5);
      store.saveFeeBatch(p.id,[{...event,volumeUsd:null,feesUsd:null,confidence:"UNAVAILABLE"}],1,1000,6,hash("b"),6000);
      expect(store.feeCursor(p.id)?.blockNumber).toBe(6);
      expect(store.liveFeeCursor(p.id)?.blockNumber).toBe(6);
      expect(store.feeEvents(p.id,0,10000)).toHaveLength(1);
      expect(store.feeEvents(p.id,0,10000)[0].volumeUsd).toBe(2);
    } finally {store.close();}
  });
  it("uses a contiguous live cursor for generated fees when history is behind",()=>{
    const store=createStore(":memory:");
    try {
      const p=pool(Date.now());store.save([snapshot(p,[])]);
      store.saveLiveFeeBatch(p.id,"base",[{poolId:p.id,blockNumber:2,blockHash:hash("b"),
        txHash:hash("c"),logIndex:0,timestamp:2000,volumeUsd:2,feesUsd:0.01,
        confidence:"MEDIUM",chain:"base"}],1,1000,3,hash("d"),3000,4,4000,"RPC_GET_LOGS","fixture");
      expect(store.generatedFees(p.id,1500,2500)).toEqual({fees:0.01,volume:2});
      expect(store.generatedFees(p.id,500,2500)).toEqual({fees:null,volume:null});
    } finally {store.close();}
  });
  it("recovers overdue 4h and 24h jobs from stored snapshots",async()=>{
    const store=createStore(":memory:");
    try {
      const start=Date.now()-26*3600000;
      const first=snapshot(pool(start),[]);first.metrics.surge=true;first.metrics.activity=85;
      store.save([first]);const [id]=store.syncSignals(first,policy);
      const points=[];
      for(let t=4*60000;t<=horizons["24h"];t+=4*60000)
        points.push(snapshot(pool(start+t),[]));
      points.push(snapshot(pool(start+horizons["30m"]),[]));
      store.save(points);
      const done=await store.evaluateDueOutcomes(policy,Date.now(),10,2);
      expect(done).toBe(4);
      const outcomes=store.signalDetail(id)!.outcomes;
      expect(outcomes.map((o)=>[o.horizon,o.status])).toEqual([
        ["30m","COMPLETE"],["1h","COMPLETE"],["4h","COMPLETE"],["24h","COMPLETE"]]);
      expect(outcomes.every((o)=>o.data?.outcomeCompletenessPct!==undefined)).toBe(true);
      expect(store.outcomePipeline().every((r)=>Number(r.overdue)===0)).toBe(true);
    } finally {store.close();}
  });
  it("marks partial fields and gates strict research samples",()=>{
    expect(outcomeMissingReasons({endpointAt:null,priceReturn:null,feesGenerated:null,
      depth5PctChange:null,ranges:{"2.5":{remainedInRange:null,timeUntilFirstExitMs:null,numberOfExits:null,timeSpentInRangePct:null},
        "5":{remainedInRange:null,timeUntilFirstExitMs:null,numberOfExits:null,timeSpentInRangePct:null},
        "10":{remainedInRange:null,timeUntilFirstExitMs:null,numberOfExits:null,timeSpentInRangePct:null}},
      observationCoveragePct:0})).toContain("MISSING_PRICE");
    const fact={confidence:"HIGH",sampleMeta:JSON.stringify({priceFreshness:"FRESH",providerIntegrityWarning:false})} as CohortFact;
    expect(strictSample(fact)).toBe(true);
    expect(strictSample({...fact,sampleMeta:null})).toBe(false);
  });
  it("classifies freshness, circuit failures, and depth blockers",()=>{
    expect(freshness(1000,2000,2000)).toBe("FRESH");
    expect(freshness(1000,5000,2000)).toBe("DELAYED");
    expect(cursorLag(100,100000,90,0,110000)).toMatchObject({lagBlocks:10,lagSeconds:100,state:"FRESH"});
    expect(providerFailureReason("HTTP 429")).toBe("RATE_LIMIT");
    expect(providerFailureReason("eth_getLogs disabled")).toBe("LOGS_DISABLED");
    expect(depthFailureReason("RPC_CAPABILITY_UNAVAILABLE bsc eth_call")).toBe("RPC_UNSUPPORTED");
    expect(liveCursorNeedsRestart(0,900000,1000000,1000000)).toBe(false);
    expect(liveCursorNeedsRestart(0,0,1000000,1000000)).toBe(true);
  });
  it("flags conflicting log sources by transaction and log index",()=>{
    const log={address:address("a"),blockNumber:"0x10",blockHash:hash("b"),
      transactionHash:hash("c"),logIndex:"0x0",topics:[swapTopic,hash("1"),hash("2")],
      data:`0x${"0".repeat(64*5)}`};
    expect(reconcileSwapLogs([log],[log])).toHaveLength(1);
    expect(()=>reconcileSwapLogs([log],[{...log,blockHash:hash("d")}])).toThrow("LOG_SOURCE_DISAGREEMENT");
  });
  it("schedules overdue depth before fresh cached depth",()=>{
    const store=createStore(":memory:");
    try {
      const a=pool(Date.now()),b=pool(Date.now());a.id="a";b.id="b";
      for(const p of [a,b]) {
        p.activeLiquidityDetails={method:"V3_VIRTUAL_RESERVES_V1",block:"0x1",blockTime:Date.now(),
          rpcSource:"fixture",token0Address:address("1"),token1Address:address("2"),decimals0:6,decimals1:6,
          amount0:"0",amount1:"0",price0Usd:1,price1Usd:1,priceSource:"fixture",priceObservedAt:Date.now(),
          pairPrice:"1",tick:100,tickSpacing:10,liquidityRaw:"1000",sqrtPriceX96:"1"};
        store.save([snapshot(p,[])]);
      }
      store.saveDepth(a.id,{depth1PctUsd:1,depth2_5PctUsd:1,depth5PctUsd:1,depth10PctUsd:1,
        confidence:"MEDIUM",source:"fixture",updatedAt:Date.now(),blockId:"1",
        stateKey:v3DepthKey(100,10,"1000",1,1),priceAtCalculation:100});
      expect(depthTargets([a,b],store,false,new Set(),1)[0].pool.id).toBe("b");
    } finally {store.close();}
  });
});
