import { afterEach,describe,expect,it,vi } from "vitest";
import { z } from "zod";
import { createStore } from "../src/db/store";
import { emptyPool,emptyToken } from "../src/core/model";
import { snapshot } from "../src/core/analytics";
import { evaluateOutcome,type SignalPolicy } from "../src/core/research";
import { assessReadiness } from "../src/core/readiness";
import { fetchIndexedSwaps } from "../src/adapters/log-sources";
import { HttpClient } from "../src/adapters/http";
import { BackgroundWorker } from "../src/workers/background";
import { readDepthContracts } from "../src/adapters/evm-depth";
import type { ReadOnlyRpc } from "../src/adapters/liquidity-rpc";
import { swapTopic } from "../src/core/fees";
import { feeContinuity,feeCoveragePct } from "../src/adapters/evm-fees";
import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";

const address=`0x${"a".repeat(40)}`;
const hash=(char:string)=>`0x${char.repeat(64)}`;
const pool=(at:number)=>{
  const p=emptyPool({chain:"base",protocol:"uniswap-v3",dex:"Uniswap V3",poolAddress:address,
    token0:emptyToken(`0x${"1".repeat(40)}`,"A"),
    token1:emptyToken(`0x${"2".repeat(40)}`,"B"),source:"fixture"},at);
  p.price=100;p.volume1h=100000;p.fees1h=10;
  return p;
};
const policy:SignalPolicy={feeEfficiency:.001,volumeDepth:1,activity:70,risk:60,
  breakoutPct:5,collapsePct:20,persistenceFraction:.5,maxObservationGapMs:240000};
afterEach(()=>vi.unstubAllGlobals());

describe("Sprint 7 continuity",()=>{
  it("includes a single severe scan outlier in p99",()=>{
    const dir=mkdtempSync(join(tmpdir(),"lp-latency-")),path=join(dir,"scanner.sqlite");
    try {
      const store=createStore(path),db=new Database(path);
      try {
        const run=db.prepare("INSERT INTO scanner_runs(started_at,status,data) VALUES (?,'ok','{}')");
        const metric=db.prepare("INSERT INTO scan_metrics VALUES (?,?,?,?,?)");
        for(let i=0;i<20;i++) metric.run(run.run(Date.now()).lastInsertRowid,i===19?486733:1000,0,0,0);
        expect(store.scanLatency()).toMatchObject({n:20,medianMs:1000,p95Ms:1000,p99Ms:486733});
      } finally {db.close();store.close();}
    } finally {rmSync(dir,{recursive:true,force:true});}
  });
  it("keeps core cadence independent of full snapshot sampling and reports gaps",()=>{
    const store=createStore(":memory:");
    try {
      const at=Math.floor(Date.now()/60000)*60000;
      const p=pool(at);
      store.save([snapshot(p,[])],true);
      expect(store.writeCoreSnapshots(at)).toBe(1);
      p.timestamp=at+60000;store.save([snapshot(p,[])],true);
      expect(store.writeCoreSnapshots(at+60000)).toBe(1);
      expect(store.history(p.id,0)).toHaveLength(1);
      const coverage=store.coreSnapshotCoverage(at+2*60000,3*60000);
      expect(coverage.actual).toBe(2);
      expect(coverage.expected).toBe(3);
      expect(coverage.largestGapMs).toBe(60000);
      p.timestamp=at+5*60000;store.save([snapshot(p,[])],true);
      expect(store.history(p.id,0)).toHaveLength(2);
      expect(store.storageGrowthSinceVersion(Date.now()+3600000).estimatedBytesPerDay).toBeGreaterThan(0);
    } finally {store.close();}
  });
  it("does not count cold intervals as missed core snapshots",()=>{
    const store=createStore(":memory:");
    try {
      const at=Math.floor(Date.now()/60000)*60000,p=pool(at);
      for(const minute of [0,1,2,5]) {
        p.timestamp=at+minute*60000;
        p.volume1h=minute===2?0:100000;
        store.save([snapshot(p,[])]);
        store.writeCoreSnapshots(p.timestamp);
      }
      const coverage=store.coreSnapshotCoverage(at+5*60000,6*60000);
      expect(coverage.expected).toBe(3);
      expect(coverage.actual).toBe(3);
      expect(coverage.largestGapMs).toBe(60000);
    } finally {store.close();}
  });
  it("persists fee gaps and exact-block depth cache, then resolves gaps",()=>{
    const store=createStore(":memory:");
    try {
      const p=pool(Date.now());store.save([snapshot(p,[])]);
      store.recordFeeGap(p.id,10,20,1000,2000,"LIVE_CURSOR_RESTART");
      expect(store.openFeeGaps(p.id,1000,2000)).toHaveLength(1);
      store.resolveFeeGaps(p.id,11,19);
      expect(store.openFeeGaps(p.id,1000,2000)).toHaveLength(1);
      store.resolveFeeGaps(p.id,10,20);
      expect(store.openFeeGaps(p.id,1000,2000)).toHaveLength(0);
      store.cacheDepthReconstruction(p.id,"tick:1","0x10",{nets:[{tick:1,liquidityNet:"2"}]});
      expect(store.depthReconstruction(p.id,"tick:1","0x10")).toMatchObject({nets:[{tick:1}]});
      expect(store.depthReconstruction(p.id,"tick:2","0x10")).toBeNull();
      expect(store.depthReconstruction(p.id,"tick:1","0x11")).toBeNull();
      store.recordEventSource("base:fixture","base","LIVE",true,20,10,12,null,true);
      store.recordSourceCheck("base","base:fixture",2,0,null);
      expect(store.eventSources()).toMatchObject([{sourceId:"base:fixture",healthState:"HEALTHY"}]);
      expect(store.sourceDisagreementRates()).toMatchObject([{chain:"base",compared:2,disagreements:0}]);
      p.depth5PctUsd=25;p.depthUpdatedAt=Date.now();p.depthExpiresAt=Date.now()+60000;
      p.depthState="CURRENT";
      expect(store.publishDepth(p)).toBe(true);
      expect(store.get(p.id)?.pool.depth5PctUsd).toBe(25);
    } finally {store.close();}
  });
  it("counts overlapping fee gaps once and classifies window state",()=>{
    expect(feeCoveragePct(0,100,0,100,[{fromTime:20,toTime:40},{fromTime:30,toTime:50}])).toBe(70);
    expect(feeContinuity(70,true,false,false)).toBe("GAPPED");
    expect(feeContinuity(100,false,false,true)).toBe("COMPLETE");
    expect(feeContinuity(40,false,false,false)).toBe("PARTIAL");
    expect(feeContinuity(0,false,false,false)).toBe("UNAVAILABLE");
    expect(feeContinuity(100,false,true,true)).toBe("STALE");
  });
  it("falls back from multicall to bounded direct calls at the same block",async()=>{
    const seen:unknown[]=[];
    const rpc={call:async()=>{throw new Error("Multicall unsupported");},
      batch:async(calls:{params:unknown[]}[])=>{seen.push(...calls.map((c)=>c.params[1]));
        return calls.map(()=>"0x01");}} as unknown as ReadOnlyRpc;
    const calls=[{to:address,data:"0x01"},{to:address,data:"0x02"}];
    expect(await readDepthContracts(rpc,calls,"0x10")).toEqual({values:["0x01","0x01"],method:"ONCHAIN_DIRECT"});
    expect(seen).toEqual(["0x10","0x10"]);
    await expect(readDepthContracts(rpc,Array.from({length:65},()=>calls[0]),"0x10"))
      .rejects.toThrow("Multicall unsupported");
  });
  it("marks price and range complete without fabricating fee or depth",()=>{
    const at=Date.now()-3600000,first=snapshot(pool(at),[]);
    const later=Array.from({length:8},(_,i)=>snapshot(pool(at+(i+1)*4*60000),[]));
    const outcome=evaluateOutcome(first,later,"30m",policy);
    expect(outcome.fieldCompleteness).toMatchObject({price:"COMPLETE",range:"COMPLETE",
      fee:"UNAVAILABLE",depth:"UNAVAILABLE",liquidity:"UNAVAILABLE"});
    expect(outcome.overallCompletenessPct).toBe(40);
  });
  it("requires every readiness gate, with explicit BSC exclusion only",()=>{
    const good={foregroundP95Ms:10000,hot:[
      {chain:"base",pools:10,priced:10,depth5Priced:8,fee1h:9},
      {chain:"bsc",pools:10,priced:10,depth5Priced:8,fee1h:0}],
      snapshot:{maturePools:2,tracked:2,coveragePct:100,priceCoveragePct:100},
      outcomes:[{horizon:"4h",eligible:10,priceRangeComplete:8},
        {horizon:"24h",eligible:10,priceRangeComplete:7}],outcomeP95LagMs:100000,
      providers:[{chain:"base",supportsGetLogs:true,healthState:"HEALTHY"}],
      diskDaysRemaining:200,growthBytesPerDay:100000000,growthHours:24,excludeBsc:true};
    expect(assessReadiness(good).status).toBe("READY");
    expect(assessReadiness({...good,excludeBsc:false}).failed).toContain("BSC_LIVE_FEES");
    expect(assessReadiness({...good,snapshot:{...good.snapshot,priceCoveragePct:90}}).failed)
      .toContain("SNAPSHOT_CONTINUITY");
  });
  it("rejects incomplete indexer ranges and validates empty anchored ranges",async()=>{
    const body={chain:"base",pool:address,fromBlock:10,throughBlock:11,complete:true,
      endBlockHash:hash("b"),logs:[]};
    vi.stubGlobal("fetch",vi.fn(async()=>Response.json(body)));
    expect((await fetchIndexedSwaps("https://example.test/swaps","base",address,10,11)).logs).toEqual([]);
    vi.stubGlobal("fetch",vi.fn(async()=>Response.json({...body,throughBlock:10})));
    await expect(fetchIndexedSwaps("https://example.test/swaps","base",address,10,11))
      .rejects.toThrow("INDEXER_INCOMPLETE_RANGE");
    vi.stubGlobal("fetch",vi.fn(async()=>Response.json({...body,complete:false})));
    await expect(fetchIndexedSwaps("https://example.test/swaps","base",address,10,11)).rejects.toThrow();
  });
  it("deduplicates identical indexed swaps and rejects conflicting identities",async()=>{
    const log={address,blockNumber:"0xa",blockTimestamp:"0x1",blockHash:hash("b"),
      transactionHash:hash("c"),logIndex:"0x0",topics:[swapTopic,hash("1"),hash("2")],
      data:`0x${[1n,(1n<<256n)-1n,0n,0n,0n].map((n)=>n.toString(16).padStart(64,"0")).join("")}`};
    const body={chain:"base",pool:address,fromBlock:10,throughBlock:11,complete:true,
      endBlockHash:hash("b"),logs:[log,log]};
    vi.stubGlobal("fetch",vi.fn(async()=>Response.json(body)));
    expect((await fetchIndexedSwaps("https://example.test/swaps","base",address,10,11)).logs).toHaveLength(1);
    vi.stubGlobal("fetch",vi.fn(async()=>Response.json({...body,logs:[log,{...log,blockHash:hash("d") }]})));
    await expect(fetchIndexedSwaps("https://example.test/swaps","base",address,10,11))
      .rejects.toThrow("INDEXER_CONFLICT");
  });
  it("aborts a foreground HTTP call at its configured deadline",async()=>{
    const pending=((_url:string,options?:RequestInit)=>new Promise<Response>((_resolve,reject)=>{
      options?.signal?.addEventListener("abort",()=>reject(new Error("aborted")),{once:true});
    })) as typeof fetch;
    const client=new HttpClient(0,pending,0,20);
    const started=Date.now();
    await expect(client.json("https://example.test",z.object({ok:z.boolean()})))
      .rejects.toThrow("Upstream request failed or timed out");
    expect(Date.now()-started).toBeLessThan(500);
  });
  it("runs due outcomes without opening a historical RPC slot",async()=>{
    const store=createStore(":memory:");
    const network=vi.fn(()=>{throw new Error("unexpected network request");});
    vi.stubGlobal("fetch",network);
    try {
      await new BackgroundWorker(store,"outcomes").run();
      expect(network).not.toHaveBeenCalled();
      expect(store.recentWorkerRun()?.notes).toContain("outcomes");
    } finally {store.close();}
  });
  it("keeps pre-version history during a retention dry run and profiles stored bytes",()=>{
    const dir=mkdtempSync(join(tmpdir(),"lp-retention-")),path=join(dir,"scanner.sqlite");
    try {
      const store=createStore(path);
      const old=pool(Date.now()-40*86400000);
      store.save([snapshot(old,[])]);store.close();
      const run=(...args:string[])=>JSON.parse(execFileSync(process.execPath,
        ["--import","tsx","src/workers/retention.ts",...args],
        {cwd:process.cwd(),env:{...process.env,DATABASE_PATH:path},encoding:"utf8"})) as Record<string,unknown>;
      expect(run()).toMatchObject({mode:"DRY_RUN",snapshots:{eligibleInBatch:0}});
      const profile=run("--profile");
      expect(profile.databaseBytes).toBeGreaterThan(0);
      expect((profile.objects as {name:string}[]).some((o)=>o.name==="pool_snapshots")).toBe(true);
    } finally {rmSync(dir,{recursive:true,force:true});}
  });
});
