import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore } from "../src/db/store";
import { RpcRouter, nextLogRange, providerHealth } from "../src/adapters/rpc-router";
import { priceBucket, backfillEventPrices, historicalPriceReason, historicalQuoteReason, llamaHistoricalSource } from "../src/adapters/historical-price";
import { depthDriftPct, v3DepthKey, dlmmDepthKey } from "../src/core/depth";
import { applyDepth, depthRefreshMs } from "../src/adapters/evm-depth";
import { buildCohorts, observedRate, quantiles, signalEvidenceConfidence, type CohortFact } from "../src/core/cohorts";
import { emptyPool, emptyToken, type Pool } from "../src/core/model";
import { snapshot } from "../src/core/analytics";
import type { Outcome } from "../src/core/research";

const address = (n:string) => `0x${n.repeat(40)}`;
const hash = (n:string) => `0x${n.repeat(64)}`;
afterEach(() => vi.unstubAllGlobals());
const mockRpc = (handler:(url:string,request:{method:string;params:unknown[]})=>unknown|Response) =>
  vi.stubGlobal("fetch", vi.fn(async (input:string,init:{body:string}) => {
    const body = JSON.parse(init.body) as {id:number;method:string;params:unknown[]} | {id:number;method:string;params:unknown[]}[];
    const special = handler(input,Array.isArray(body) ? body[0] : body);
    if (special instanceof Response) return special;
    const respond = (request:{id:number;method:string;params:unknown[]}) => {
      const result = handler(input,request);
      return result instanceof Response ? result : {jsonrpc:"2.0",id:request.id,result};
    };
    const result = Array.isArray(body) ? body.map(respond) : respond(body);
    return result instanceof Response ? result : Response.json(result);
  }));

describe("RPC provider reliability", () => {
  it("probes capabilities and stores only URL hashes", async () => {
    mockRpc((_url,request) => {
      if (request.method === "eth_chainId") return "0x2105";
      if (request.method === "eth_getBlockByNumber") return {number:request.params[0] === "latest" ? "0x186a0" : request.params[0],
        timestamp:"0x65000000",hash:hash("a")};
      if (request.method === "eth_getLogs") return [];
      if (request.method === "eth_call") return "0x1234";
      throw new Error("unexpected method");
    });
    const store = createStore(":memory:");
    try {
      const router = new RpcRouter("base",store,["https://secret.example/rpc?token=hidden"]);
      await router.probeAll();
      const row = store.rpcProviders()[0];
      expect(row).toMatchObject({supportsGetLogs:true,supportsArchive:true,
        supportsBatching:true,supportsHistoricalState:true,supportsMulticall:true,healthState:"HEALTHY"});
      expect(JSON.stringify(row)).not.toContain("hidden");
      expect(row.urlHash).toMatch(/^[0-9a-f]{64}$/);
    } finally { store.close(); }
  });
  it("fails over, cools down rate-limited providers, and enforces budgets", async () => {
    mockRpc((url,request) => {
      if (url.includes("slow")) return new Response(null,{status:429});
      return request.method === "eth_chainId" ? "0x2105" : [];
    });
    const store = createStore(":memory:");
    try {
      const router = new RpcRouter("base",store,["https://slow.example","https://good.example"]);
      expect(await router.call("eth_chainId",[])).toBe("0x2105");
      const rows = store.rpcProviders();
      expect(rows.find((r)=>r.healthState === "COOLDOWN")?.consecutiveFailures).toBe(1);
      expect(rows.find((r)=>r.healthState === "HEALTHY")?.lastSuccessAt).not.toBeNull();
      expect(store.recentRpcUsage().some((r) => Number((r as Record<string,unknown>).fallback_calls) > 0)).toBe(true);
      const one = new RpcRouter("base",store,["https://budget.example"]);
      const id = store.rpcProviders().find((r)=>r.providerId !== rows[0].providerId && r.providerId !== rows[1].providerId)!.providerId;
      const minute = Math.floor(Date.now()/60000)*60000;
      for (let i=0;i<120;i++) store.recordRpcRequest(id,minute,1,0,0,0);
      await expect(one.call("eth_chainId",[])).rejects.toThrow("RPC_REQUEST_BUDGET_EXHAUSTED");
    } finally { store.close(); }
  });
  it("adapts ranges and preserves health semantics", () => {
    expect(nextLogRange(100,false,2000)).toBe(50);
    expect(nextLogRange(100,true,2000)).toBe(125);
    expect(nextLogRange(1,false,2000)).toBe(1);
    const row = {cooldownUntil:Date.now()+1000,lastSuccessAt:Date.now(),consecutiveFailures:1,errorRate:0.1} as Parameters<typeof providerHealth>[0];
    expect(providerHealth(row)).toBe("COOLDOWN");
    row.cooldownUntil = 0;
    expect(providerHealth(row)).toBe("DEGRADED");
    row.consecutiveFailures = 0;
    expect(providerHealth(row)).toBe("HEALTHY");
  });
  it("fails over a stale latest head instead of treating it as current chain state", async () => {
    mockRpc((url,request) => request.method === "eth_getBlockByNumber"
      ? {number:"0x10",hash:hash("a"),timestamp:`0x${Math.floor((Date.now()-(url.includes("stale") ? 600000 : 1000))/1000).toString(16)}`}
      : "0x2105");
    const store = createStore(":memory:");
    try {
      const router = new RpcRouter("base",store,["https://stale.example","https://fresh.example"]);
      const head = await router.call("eth_getBlockByNumber",["latest",false]) as {timestamp:string};
      expect(Date.now()-Number(BigInt(head.timestamp))*1000).toBeLessThan(120000);
      expect(store.rpcProviders().find((r)=>r.consecutiveFailures>0)).toBeTruthy();
    } finally { store.close(); }
  });
  it("keeps log provenance when later block reads use another provider", async () => {
    mockRpc((url,request) => {
      if (request.method==="eth_getLogs") return [];
      if (url.includes("logs.example")) return new Response(null,{status:429});
      return {number:"0x10",hash:hash("a"),timestamp:`0x${Math.floor(Date.now()/1000).toString(16)}`};
    });
    const store=createStore(":memory:");
    try {
      const router=new RpcRouter("base",store,["https://logs.example","https://blocks.example"]);
      await router.call("eth_getLogs",[{fromBlock:"0x1",toBlock:"0x1"}]);
      const source=router.lastLogSourceId;
      await router.call("eth_getBlockByNumber",["latest",false]);
      expect(router.lastProviderId).not.toBe(source);
      expect(router.lastLogSourceId).toBe(source);
    } finally {store.close();}
  });
});

describe("historical price backfill and depth validity", () => {
  it("deduplicates five-minute buckets and prices only known swap input", async () => {
    const store = createStore(":memory:");
    try {
      const at = Math.floor((Date.now()-3600000)/300000)*300000+60000;
      const pool = emptyPool({chain:"base",protocol:"uniswap-v3",dex:"Uniswap V3",
        poolAddress:address("3"),token0:emptyToken(address("1"),"A"),
        token1:emptyToken(address("2"),"B"),source:"fixture"},at);
      pool.feeTier = 0.003;
      pool.activeLiquidityDetails = {method:"V3_VIRTUAL_RESERVES_V1",block:"0x1",blockTime:at,
        rpcSource:"fixture",token0Address:address("1"),token1Address:address("2"),decimals0:6,decimals1:6,
        amount0:"0",amount1:"0",price0Usd:2,price1Usd:1,priceSource:"fixture",
        priceObservedAt:at,pairPrice:"1"};
      store.save([snapshot(pool,[])]);
      store.saveFeeBatch(pool.id,[{poolId:pool.id,chain:"base",blockNumber:1,blockHash:hash("a"),
        txHash:hash("b"),logIndex:0,timestamp:at,amount0:"1000000",amount1:"-2000000",
        feeTier:0.003,volumeUsd:null,feesUsd:null,confidence:"UNAVAILABLE"},
        {poolId:pool.id,chain:"base",blockNumber:2,blockHash:hash("c"),
          txHash:hash("d"),logIndex:0,timestamp:at+180000,amount0:"1000000",amount1:"-2000000",
          feeTier:0.003,volumeUsd:null,feesUsd:null,confidence:"UNAVAILABLE"}],1,at,2,hash("c"),at+180000);
      const quote = {chain:"base",assetAddress:address("1"),symbol:"A",priceUsd:2,
        source:"fixture historical",sourceTimestamp:at-300000,observedAt:Date.now(),blockNumber:null,
        confidence:"MEDIUM" as const,resolution:"5M" as const};
      store.savePrices([quote]);
      store.saveHistoricalPrice(quote,"base",address("1"),priceBucket(at),llamaHistoricalSource.name,"FOUND");
      expect(priceBucket(at)).toBe(at-60000);
      const events = store.unpricedEvents(10).sort((a,b)=>a.timestamp-b.timestamp);
      expect(events).toHaveLength(2);
      expect(await backfillEventPrices(events,store)).toMatchObject({priced:1,missing:1,requests:0});
      expect(store.feeEvents(pool.id,at-1,at+1)[0]).toMatchObject({volumeUsd:2,feesUsd:0.006});
      expect(store.priceReasonCounts()).toContainEqual({reason:"STALE_PRICE",n:1});
      expect(store.unpricedEvents(10)).toHaveLength(0);
      store.saveHistoricalPrice(null,"base",address("1"),priceBucket(at),"source","NO_TOKEN_PRICE");
      expect(store.cachedHistoricalPrice("base",address("1"),priceBucket(at),"source")?.status).toBe("NO_TOKEN_PRICE");
    } finally { store.close(); }
  });
  it("classifies stale/provider failures and invalidates moved depth", () => {
    expect(historicalPriceReason(new Error("STALE_PRICE"))).toBe("STALE_PRICE");
    expect(historicalQuoteReason(100,300101)).toBe("STALE_PRICE");
    expect(historicalPriceReason(new Error("Upstream HTTP 429"))).toBe("PROVIDER_FAILURE");
    expect(depthDriftPct(100,103)).toBeCloseTo(3);
    expect(v3DepthKey(101,60,"1000000",100,100)).toBe(v3DepthKey(101,60,"1010000",101,100));
    expect(v3DepthKey(101,60,"1000000",100,100)).not.toBe(v3DepthKey(301,60,"1000000",100,100));
    expect(dlmmDepthKey(100,25,100,100)).toBe(dlmmDepthKey(101,25,101,100));
    const p = emptyPool({chain:"base",protocol:"uniswap-v3",dex:"Uniswap V3",
      poolAddress:address("3"),token0:emptyToken(address("1"),"A"),
      token1:emptyToken(address("2"),"B"),source:"fixture"},Date.now()) as Pool;
    p.price = 103;
    applyDepth(p,{depth1PctUsd:1,depth2_5PctUsd:2,depth5PctUsd:3,depth10PctUsd:4,
      confidence:"MEDIUM",source:"fixture",updatedAt:Date.now(),blockId:"1",stateKey:"x",
      priceAtCalculation:100});
    expect(p.depthState).toBe("STALE");
    expect(p.depth5PctUsd).toBeNull();
    expect(depthRefreshMs(p,true,false)).toBe(120000);
  });
});

describe("descriptive cohorts", () => {
  it("uses robust quantiles, confidence filters, and minimum sample", () => {
    expect(signalEvidenceConfidence("HIGH_FEE_EFFICIENCY","UNAVAILABLE","MEDIUM","MEDIUM","MEDIUM","UNAVAILABLE")).toBe("MEDIUM");
    expect(signalEvidenceConfidence("HIGH_VOLUME_DEPTH","UNAVAILABLE","MEDIUM","MEDIUM","MEDIUM","UNAVAILABLE")).toBe("UNAVAILABLE");
    expect(quantiles([1,2,3,4])).toMatchObject({n:4,median:2.5,p25:1.75,p75:3.25});
    expect(quantiles([1,2],3).median).toBeNull();
    expect(observedRate([true,false,true],3)).toBeCloseTo(2/3);
    const outcome = {activityPersistence:0.6,activityRatioAtEndpoint:0.8,feesGenerated:10,
      volumeGenerated:100,maxPriceMoveDown:-0.02,maxPriceMoveUp:0.03,activeLiquidityChange:null,
      depth5PctChange:null,ranges:{"2.5":{remainedInRange:false,timeUntilFirstExitMs:1200000},
        "5":{remainedInRange:true,timeUntilFirstExitMs:null},
        "10":{remainedInRange:true,timeUntilFirstExitMs:null}}} as Outcome;
    const facts:CohortFact[] = Array.from({length:30},(_,i)=>({id:i+1,signalType:"ACTIVITY_SURGE",
      chain:"base",protocol:"uniswap-v3",trend:"RANGING",risk:40,activity:80,
      volatility:3,confidence:i<20 ? "HIGH":"MEDIUM",tokenAge:100,poolAge:200,
      horizon:"1h",outcomeStatus:"COMPLETE",outcomeData:JSON.stringify(outcome)}));
    const cohorts = buildCohorts(facts,30);
    const all = cohorts.find((c)=>c.confidenceFilter==="HIGH_MEDIUM" && c.dimension==="all")!;
    expect(all.status).toBe("VALID");
    expect(all.confidenceComposition).toMatchObject({HIGH:20,MEDIUM:10});
    expect(all.curves.find((x)=>x.horizon==="1h")?.ranges["5"].survivalRate).toBe(1);
    expect(cohorts.find((c)=>c.confidenceFilter==="HIGH" && c.dimension==="all")?.status).toBe("INSUFFICIENT_SAMPLE");
    expect(all.curves.find((x)=>x.horizon==="4h")?.activityRatio.median).toBeNull();
  });
});
