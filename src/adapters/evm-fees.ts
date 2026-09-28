import { z } from "zod";
import { createHash } from "node:crypto";
import { env } from "../config/env";
import type { Pool, Window, FeeWindow } from "../core/model";
import { windows, windowMs } from "../core/model";
import { fresh } from "../core/liquidity";
import { decodeSwap, swapLogSchema, swapTopic, pancakeSwapTopic, swapUsd } from "../core/fees";
import type { Store, FeeEventRow } from "../db/store";
import type { BackfillJob } from "../db/research";
import { blockSchema, ReadOnlyRpc } from "./liquidity-rpc";
import { RpcRouter, isRangeError } from "./rpc-router";
import { fetchIndexedSwaps, reconcileSwapLogs } from "./log-sources";
type Block = { hash: string; timestamp: number };
export const liveCursorNeedsRestart = (cursorEndTime:number,updatedAt:number,
  confirmedTime:number,now=Date.now()) => confirmedTime-cursorEndTime>600000 && now-updatedAt>600000;
export function feeCoveragePct(start:number,end:number,from:number,to:number,
  gaps:{fromTime:number;toTime:number}[]) {
  const lower=Math.max(start,from),upper=Math.min(end,to);
  if(upper<=lower) return 0;
  let missing=0,coveredUntil=lower;
  for(const gap of [...gaps].sort((a,b)=>a.fromTime-b.fromTime)) {
    const a=Math.max(lower,gap.fromTime),b=Math.min(upper,gap.toTime);
    if(b>Math.max(a,coveredUntil)) missing+=b-Math.max(a,coveredUntil);
    coveredUntil=Math.max(coveredUntil,b);
  }
  return Math.max(0,Math.min(100,(upper-lower-missing)/(end-start)*100));
}
export function feeContinuity(coveragePct:number,gapped:boolean,stale:boolean,eventDerived:boolean) {
  return stale?"STALE":gapped?"GAPPED":eventDerived?"COMPLETE":
    coveragePct>0?"PARTIAL":"UNAVAILABLE";
}
const blockAt = async (rpc: ReadOnlyRpc, n: number): Promise<Block> => {
  const raw = blockSchema.parse(
    await rpc.call("eth_getBlockByNumber", [`0x${n.toString(16)}`, false]),
  );
  if (Number(BigInt(raw.number)) !== n) throw new Error("Malformed block identity");
  return { hash: raw.hash, timestamp: Number(BigInt(raw.timestamp)) * 1000 };
};


export async function readRange(
  pool: Pool,
  rpc: ReadOnlyRpc,
  store: Store,
  from: number,
  to: number,
  purpose: "LIVE" | "HISTORICAL" = "HISTORICAL",
) {
  const logs: z.infer<typeof swapLogSchema>[] = [];
  const provenance=new Map<string,{type:string;id:string}>();
  const rangeSources=new Set<string>();
  const logKey=(log:z.infer<typeof swapLogSchema>)=>
    `${log.transactionHash.toLowerCase()}:${Number(BigInt(log.logIndex))}`;
  const indexerUrl=pool.chain==="base"
    ? purpose==="LIVE"?env.BASE_LIVE_INDEXER_URL:env.BASE_HISTORICAL_INDEXER_URL
    : purpose==="LIVE"?env.BSC_LIVE_INDEXER_URL:env.BSC_HISTORICAL_INDEXER_URL;
  let sourceType="RPC_GET_LOGS",sourceId="DIRECT_RPC",indexedHash:string|null=null;
  const indexerId=indexerUrl?`${pool.chain}:${createHash("sha256").update(indexerUrl).digest("hex").slice(0,16)}`:null;
  const indexerStatus=indexerId?(store.eventSources() as {sourceId:string;healthState:string;lastFailureAt:number|null}[])
    .find((s)=>s.sourceId===indexerId):null;
  if(indexerUrl && !(indexerStatus?.healthState==="DEGRADED" &&
    indexerStatus.lastFailureAt && Date.now()-indexerStatus.lastFailureAt<60000)) {
    const id=indexerId!;
    const started=Date.now();
    try {
      const result=await fetchIndexedSwaps(indexerUrl,pool.chain as "base"|"bsc",pool.poolAddress,from,to);
      const final=await blockAt(rpc,to);
      if(final.hash.toLowerCase()!==result.endBlockHash.toLowerCase()) throw new Error("INDEXER_BLOCK_MISMATCH");
      let verified=false;
      if(result.logs.length) {
        const sampleBlock=Number(BigInt(result.logs[0].blockNumber));
        try {
          const sample=await rpc.call("eth_getLogs",[{address:pool.poolAddress,
            fromBlock:`0x${sampleBlock.toString(16)}`,toBlock:`0x${sampleBlock.toString(16)}`,
            topics:[pool.chain==="bsc"?pancakeSwapTopic:swapTopic]}]);
          reconcileSwapLogs(result.logs.filter((log)=>Number(BigInt(log.blockNumber))===sampleBlock),sample);
          store.recordSourceCheck(pool.chain,id,1,0,null);verified=true;
        } catch(error) {
          if(error instanceof Error && error.message==="LOG_SOURCE_DISAGREEMENT") {
            store.recordSourceCheck(pool.chain,id,1,1,error.message);throw error;
          }
          store.recordSourceCheck(pool.chain,id,0,0,"RPC sample unavailable");
        }
      }
      logs.push(...result.logs);indexedHash=result.endBlockHash;
      sourceType="INDEXER";sourceId=result.sourceId;
      rangeSources.add(`${sourceType}:${sourceId}`);
      for(const log of result.logs) provenance.set(logKey(log),{type:sourceType,id:sourceId});
      store.recordEventSource(id,pool.chain,purpose,true,result.latestIndexedBlock,from,
        result.latencyMs,null,verified);
    } catch(error) {
      const reason=error instanceof Error?error.message:"Indexer error";
      store.recordEventSource(id,pool.chain,purpose,false,null,null,Date.now()-started,reason,false);
      if(/INDEXER_BLOCK_MISMATCH|LOG_SOURCE_DISAGREEMENT/.test(reason)) throw error;
    }
  }
  let range = rpc instanceof RpcRouter ? rpc.safeLogRange : env.FEE_LOG_BLOCK_CHUNK;
  let verified=false;
  for (let start = indexedHash?to+1:from; start <= to;) {
    const size = range;
    const end = Math.min(to, start + size - 1);
    let raw: unknown;
    try {
      const params=[{
          address: pool.poolAddress,
          fromBlock: `0x${start.toString(16)}`,
          toBlock: `0x${end.toString(16)}`,
          topics: [pool.chain === "bsc" ? pancakeSwapTopic : swapTopic],
        }];
      raw = await rpc.call("eth_getLogs",params);
      if(!verified && pool.chain==="bsc" && rpc instanceof RpcRouter) {
        const alternate=await rpc.verifyBscLogs(params);
        if(alternate!==null) {raw=reconcileSwapLogs(raw,alternate);verified=true;}
      }
      if (rpc instanceof RpcRouter) rpc.noteLogRange(true,end-start+1);
      if (rpc instanceof RpcRouter) range = Math.min(5000,Math.floor(range*1.25)+1);
    } catch (error) {
      if (rpc instanceof RpcRouter && size > 1 && isRangeError(error instanceof Error ? error.message : "")) {
        rpc.noteLogRange(false,size);
        range = Math.max(1,Math.floor(size/2));
        continue;
      }
      throw error;
    }
    const batch = z.array(swapLogSchema).parse(
      raw,
    );
    if (batch.some((log) => log.removed)) throw new Error("Removed log detected");
    if (
      batch.some(
        (log) =>
          Number(BigInt(log.blockNumber)) < start ||
          Number(BigInt(log.blockNumber)) > end ||
          log.address.toLowerCase() !== pool.poolAddress.toLowerCase(),
      )
    )
      throw new Error("Malformed log range");
    if(rpc instanceof RpcRouter) {
      sourceId=rpc.lastLogSourceId??sourceId;
      const row=store.rpcProviders().find((p)=>p.providerId===sourceId);
      sourceType=purpose==="HISTORICAL" && row?.supportsArchive?"ARCHIVE_RPC":"RPC_GET_LOGS";
    }
    rangeSources.add(`${sourceType}:${sourceId}`);
    for(const log of batch) provenance.set(logKey(log),{type:sourceType,id:sourceId});
    logs.push(...batch);
    start = end + 1;
  }
  const blocks = new Map<number, Block>();
  for (const log of logs)
    if (log.blockTimestamp) {
      const n = Number(BigInt(log.blockNumber));
      const value = { hash: log.blockHash, timestamp: Number(BigInt(log.blockTimestamp)) * 1000 };
      const old = blocks.get(n);
      if (old && (old.hash !== value.hash || old.timestamp !== value.timestamp))
        throw new Error("Inconsistent log block");
      blocks.set(n, value);
    }
  const needed = [
    ...new Set([from, to, ...logs.map((log) => Number(BigInt(log.blockNumber)))]),
  ].filter((n) => indexedHash || !blocks.has(n));
  if (needed.length) {
    const fetched = await rpc.batch(
      needed.map((n) => ({
        method: "eth_getBlockByNumber",
        params: [`0x${n.toString(16)}`, false],
      })),
    );
    for (let i = 0; i < needed.length; i++) {
      const block = blockSchema.parse(fetched[i]);
      if (Number(BigInt(block.number)) !== needed[i]) throw new Error("Malformed block identity");
      const prior=blocks.get(needed[i]);
      if(prior && (prior.hash.toLowerCase()!==block.hash.toLowerCase() ||
        prior.timestamp!==Number(BigInt(block.timestamp))*1000)) {
        if(indexedHash && indexerId)
          store.recordEventSource(indexerId,pool.chain,purpose,false,null,null,0,
            "INDEXER_BLOCK_MISMATCH",false);
        throw new Error("INDEXER_BLOCK_MISMATCH");
      }
      blocks.set(needed[i], {
        hash: block.hash,
        timestamp: Number(BigInt(block.timestamp)) * 1000,
      });
    }
  }
  const details = pool.activeLiquidityDetails!;
  const events: FeeEventRow[] = [];
  for (const log of logs) {
    const swap = decodeSwap(log),
      block = blocks.get(swap.blockNumber)!;
    if (block.hash.toLowerCase() !== log.blockHash.toLowerCase())
      throw new Error("Block changed during log read");
    const p0 = store.priceAt(
      pool.chain,
      details.token0Address.toLowerCase(),
      block.timestamp,
      600000,
    );
    const p1 = store.priceAt(
      pool.chain,
      details.token1Address.toLowerCase(),
      block.timestamp,
      600000,
    );
    const amount = swapUsd(
      swap.amount0,
      swap.amount1,
      details.decimals0,
      details.decimals1,
      p0?.priceUsd ?? null,
      p1?.priceUsd ?? null,
      pool.feeTier!,
      swap.protocolFeeRaw,
    );
    events.push({
      poolId: pool.id,
      chain: pool.chain,
      poolAddress: pool.poolAddress,
      blockNumber: swap.blockNumber,
      blockHash: log.blockHash,
      txHash: log.transactionHash,
      logIndex: swap.logIndex,
      timestamp: block.timestamp,
      amount0: swap.amount0.toString(),
      amount1: swap.amount1.toString(),
      priceUsd0: p0?.priceUsd ?? null,
      priceUsd1: p1?.priceUsd ?? null,
      volumeUsd: amount.volumeUsd,
      grossFeeUsd: amount.volumeUsd === null ? null : amount.volumeUsd * pool.feeTier!,
      lpFeeUsd: amount.feesUsd,
      feesUsd: amount.feesUsd,
      feeTier: pool.feeTier,
      protocolFeeRaw: swap.protocolFeeRaw?.toString() ?? null,
      priceConfidence: (swap.amount0 > 0n ? p0 : p1)?.confidence ?? "UNAVAILABLE",
      sender: `0x${log.topics[1].slice(-40)}`.toLowerCase(),
      confidence: amount.feesUsd === null ? "UNAVAILABLE" : "MEDIUM",
      eventSourceType:provenance.get(logKey(log))?.type??null,
      eventSourceId:provenance.get(logKey(log))?.id??null,
    });
  }
  const final = await blockAt(rpc, to);
  if (final.hash.toLowerCase() !== blocks.get(to)!.hash.toLowerCase())
    throw new Error("Block changed during fee read");
  if(indexedHash && final.hash.toLowerCase()!==indexedHash.toLowerCase())
    throw new Error("INDEXER_BLOCK_MISMATCH");
  return { events, first: blocks.get(from)!, last: blocks.get(to)!,
    sourceType:rangeSources.size>1?"MIXED":sourceType,
    sourceId:rangeSources.size>1?"MULTIPLE":sourceId };
}

export async function validateCursor(
  poolId: string,
  cursor: ReturnType<Store["feeCursor"]>,
  rpc: ReadOnlyRpc,
  store: Store,
) {
  if (!cursor) return null;
  const at = await blockAt(rpc, cursor.blockNumber);
  if (at.hash === cursor.blockHash) return cursor;
  const checkpoints = store
    .checkpoints(poolId, 30)
    .filter((b) => b.blockNumber < cursor.blockNumber);
  let ancestor: { blockNumber: number; blockHash: string; timestamp: number } | undefined;
  for (const old of checkpoints) {
    const current = await blockAt(rpc, old.blockNumber);
    if (current.hash === old.blockHash) {
      ancestor = old;
      break;
    }
  }
  store.rollbackIndexedFees(poolId, ancestor ? ancestor.blockNumber + 1 : 0, ancestor);
  return store.feeCursor(poolId);
}

export async function indexEvmFeeJob(
  pool: Pool,
  job: BackfillJob,
  rpc: ReadOnlyRpc,
  store: Store,
  watched = false,
) {
  if (pool.activeLiquidityDetails?.method !== "V3_VIRTUAL_RESERVES_V1" || pool.feeTier === null)
    throw new Error("Pool lacks current V3 metadata");
  if (!store.hasFeeBuckets(pool.id) && store.feeCursor(pool.id)) store.rebuildFeeBuckets(pool.id);
  const head = blockSchema.parse(await rpc.call("eth_getBlockByNumber", ["latest", false]));
  if (!fresh(Number(BigInt(head.timestamp)) * 1000, Date.now(), 120000))
    throw new Error("Stale fee RPC head");
  const confirmedNumber = Number(BigInt(head.number)) - env.FEE_CONFIRMATIONS;
  if (confirmedNumber < 0) throw new Error("No confirmed block");
  const confirmed = await blockAt(rpc, confirmedNumber);
  if (!fresh(confirmed.timestamp, Date.now(), 120000)) throw new Error("Stale confirmed block");
  let cursor = await validateCursor(pool.id, store.feeCursor(pool.id), rpc, store);
  if (cursor && cursor.blockNumber > confirmedNumber) throw new Error("Fee RPC fell behind cursor");
  let indexed = 0,
    backfilled = 0;
  const forwardLimit =
    pool.chain === "bsc" ? env.BSC_FEE_MAX_BLOCKS_PER_SCAN : env.FEE_MAX_BLOCKS_PER_SCAN;
  const from = cursor ? cursor.blockNumber + 1 : Math.max(0, confirmedNumber - forwardLimit + 1);
  const to = Math.min(confirmedNumber, from + forwardLimit - 1);
  if (from <= to) {
    const batch = await readRange(pool, rpc, store, from, to);
    store.saveFeeBatch(
      pool.id,
      batch.events,
      cursor?.startBlock ?? from,
      cursor?.startTime ?? batch.first.timestamp,
      to,
      batch.last.hash,
      batch.last.timestamp,
    );
    store.checkpoint(pool.id, from, batch.first.hash, batch.first.timestamp);
    store.checkpoint(pool.id, to, batch.last.hash, batch.last.timestamp);
    indexed = batch.events.length;
    cursor = store.feeCursor(pool.id);
  }
  if (
    cursor &&
    cursor.blockNumber >= confirmedNumber &&
    cursor.startTime > confirmed.timestamp - windowMs["24h"] &&
    cursor.startBlock > 0
  ) {
    const backTo = cursor.startBlock - 1;
    const backFrom = Math.max(
      0,
      backTo - env.BACKFILL_MAX_BLOCKS_PER_CYCLE * (watched ? 2 : 1) + 1,
    );
    const batch = await readRange(pool, rpc, store, backFrom, backTo);
    store.saveFeeBatch(
      pool.id,
      batch.events,
      backFrom,
      batch.first.timestamp,
      cursor.blockNumber,
      cursor.blockHash,
      cursor.endTime,
    );
    store.checkpoint(pool.id, backFrom, batch.first.hash, batch.first.timestamp);
    store.checkpoint(pool.id, backTo, batch.last.hash, batch.last.timestamp);
    backfilled = batch.events.length;
    cursor = store.feeCursor(pool.id);
  }
  if (!cursor) throw new Error("Fee cursor unavailable");
  const end = Math.floor(Math.min(cursor.endTime, confirmed.timestamp) / 60000) * 60000;
  const feeWindows: Partial<Record<Window, FeeWindow>> = {};
  for (const window of windows) {
    const start = end - windowMs[window];
    const data = store.materializedFeeWindow(
      pool.id,
      window,
      end,
      cursor.startTime <= start && cursor.endTime >= end,
      cursor.startBlock,
      cursor.blockNumber,
    );
    store.saveFeeWindow(pool.id, window, data);
    feeWindows[window] = data;
  }
  const status =
    cursor.startTime <= end - windowMs["24h"]
      ? "COMPLETE"
      : cursor.startTime <= end - windowMs["1h"]
        ? "PARTIAL"
        : "BACKFILLING";
  store.setBackfillJob(pool.id, {
    startBlock: cursor.startBlock,
    endBlock: cursor.blockNumber,
    lastConfirmedBlock: confirmedNumber,
    nextBackfillBlock: status === "COMPLETE" ? null : Math.max(0, cursor.startBlock - 1),
    status,
    retryCount: 0,
    failureReason: null,
    nextAttemptAt: 0,
  });
  return { indexed, backfilled, status, windows: feeWindows, rpcRequests: rpc.requests };
}

// A separate contiguous cursor keeps recent windows moving even while older history is missing.
export async function indexLiveEvmFees(pool:Pool,rpc:ReadOnlyRpc,store:Store) {
  if (pool.activeLiquidityDetails?.method !== "V3_VIRTUAL_RESERVES_V1" || pool.feeTier === null)
    throw new Error("Pool lacks current V3 metadata");
  const head=blockSchema.parse(await rpc.call("eth_getBlockByNumber",["latest",false]));
  const headBlock=Number(BigInt(head.number));
  const headTime=Number(BigInt(head.timestamp))*1000;
  if (!fresh(headTime,Date.now(),120000)) throw new Error("Stale live RPC head");
  const confirmedBlock=headBlock-env.FEE_CONFIRMATIONS;
  const confirmed=await blockAt(rpc,confirmedBlock);
  let cursor=store.liveFeeCursor(pool.id);
  const prior=cursor;
  if (cursor) {
    const current=await blockAt(rpc,cursor.blockNumber);
    if (current.hash.toLowerCase()!==cursor.blockHash.toLowerCase()) {
      store.rollbackIndexedFees(pool.id,cursor.startBlock);
      cursor=null;
    } else if (liveCursorNeedsRestart(cursor.endTime,cursor.updatedAt,confirmed.timestamp)) {
      store.resetLiveFeeCursor(pool.id);
      cursor=null;
    }
  }
  if(cursor && cursor.blockNumber>confirmedBlock) throw new Error("LIVE_RPC_BEHIND_CURSOR");
  const bootstrap=pool.chain==="bsc" ? env.BSC_LIVE_BOOTSTRAP_BLOCKS : env.BASE_LIVE_BOOTSTRAP_BLOCKS;
  const from=cursor ? cursor.blockNumber+1 : Math.max(0,confirmedBlock-bootstrap);
  const to=Math.min(confirmedBlock,from+env.LIVE_MAX_BLOCKS_PER_JOB-1);
  if (from>to) return {indexed:0,cursor,headBlock,headTime,status:"CURRENT"};
  const batch=await readRange(pool,rpc,store,from,to,"LIVE");
  if(!cursor && prior && from>prior.blockNumber+1)
    store.recordFeeGap(pool.id,prior.blockNumber+1,from-1,prior.endTime,batch.first.timestamp,
      "LIVE_CURSOR_RESTART");
  store.saveLiveFeeBatch(pool.id,pool.chain,batch.events,from,batch.first.timestamp,to,batch.last.hash,
    batch.last.timestamp,headBlock,headTime,batch.sourceType,batch.sourceId);
  cursor=store.liveFeeCursor(pool.id);
  if (!cursor) throw new Error("Live fee cursor not saved");
  store.resolveFeeGaps(pool.id,cursor.startBlock,cursor.blockNumber);
  const end=Math.floor(cursor.endTime/60000)*60000;
  for (const window of windows) {
    const start=end-windowMs[window];
    const gaps=store.openFeeGaps(pool.id,start,end) as {fromTime:number;toTime:number}[];
    const coverageStart=Math.max(start,cursor.startTime),coverageEnd=Math.min(end,cursor.endTime);
    const coveragePct=feeCoveragePct(start,end,coverageStart,coverageEnd,gaps);
    const stale=confirmed.timestamp-cursor.endTime>180000;
    const covered=coveragePct>=99.9 && !gaps.length && !stale;
    const data=store.materializedFeeWindow(pool.id,window,end,covered,
      cursor.startBlock,cursor.blockNumber);
    data.coverageStart=coverageStart;data.coverageEnd=coverageEnd;data.coveragePct=coveragePct;
    data.eventSource=`${cursor.sourceType}:${cursor.sourceId}`;
    data.continuityState=feeContinuity(coveragePct,gaps.length>0,stale,
      data.methodology==="EVENT_DERIVED");
    store.saveFeeWindow(pool.id,window,data);
  }
  return {indexed:batch.events.length,cursor,headBlock,headTime,
    status:confirmedBlock-cursor.blockNumber<=bootstrap/20 ? "CURRENT" : "CATCHING_UP"};
}
