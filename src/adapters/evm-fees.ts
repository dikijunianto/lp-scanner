import { z } from "zod";
import { env } from "../config/env";
import type { Pool, Window, FeeWindow } from "../core/model";
import { windows, windowMs } from "../core/model";
import { fresh } from "../core/liquidity";
import { decodeSwap, swapLogSchema, swapTopic, pancakeSwapTopic, swapUsd } from "../core/fees";
import type { Store, FeeEventRow } from "../db/store";
import type { BackfillJob } from "../db/research";
import { blockSchema, ReadOnlyRpc } from "./liquidity-rpc";
import { RpcRouter, isRangeError } from "./rpc-router";
import { reconcileSwapLogs } from "./log-sources";
type Block = { hash: string; timestamp: number };
export const liveCursorNeedsRestart = (cursorEndTime:number,updatedAt:number,
  confirmedTime:number,now=Date.now()) => confirmedTime-cursorEndTime>600000 && now-updatedAt>600000;
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
) {
  const logs: z.infer<typeof swapLogSchema>[] = [];
  let range = rpc instanceof RpcRouter ? rpc.safeLogRange : env.FEE_LOG_BLOCK_CHUNK;
  let verified=false;
  for (let start = from; start <= to;) {
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
  ].filter((n) => !blocks.has(n));
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
    });
  }
  const final = await blockAt(rpc, to);
  if (final.hash !== blocks.get(to)!.hash) throw new Error("Block changed during fee read");
  return { events, first: blocks.get(from)!, last: blocks.get(to)! };
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
  if (cursor) {
    const current=await blockAt(rpc,cursor.blockNumber);
    if (current.hash.toLowerCase()!==cursor.blockHash.toLowerCase() ||
      liveCursorNeedsRestart(cursor.endTime,cursor.updatedAt,confirmed.timestamp)) {
      store.resetLiveFeeCursor(pool.id);
      cursor=null;
    }
  }
  const bootstrap=pool.chain==="bsc" ? env.BSC_LIVE_BOOTSTRAP_BLOCKS : env.BASE_LIVE_BOOTSTRAP_BLOCKS;
  const from=cursor ? cursor.blockNumber+1 : Math.max(0,confirmedBlock-bootstrap);
  const to=Math.min(confirmedBlock,from+env.LIVE_MAX_BLOCKS_PER_JOB-1);
  if (from>to) return {indexed:0,cursor,headBlock,headTime,status:"CURRENT"};
  const batch=await readRange(pool,rpc,store,from,to);
  store.saveLiveFeeBatch(pool.id,pool.chain,batch.events,from,batch.first.timestamp,to,batch.last.hash,
    batch.last.timestamp,headBlock,headTime,"RPC_GET_LOGS",
    rpc instanceof RpcRouter ? rpc.lastLogSourceId ?? "UNKNOWN" : "DIRECT_RPC");
  cursor=store.liveFeeCursor(pool.id);
  if (!cursor) throw new Error("Live fee cursor not saved");
  const end=Math.floor(cursor.endTime/60000)*60000;
  for (const window of windows) {
    const covered=cursor.startTime<=end-windowMs[window] &&
      confirmed.timestamp-cursor.endTime<=180000;
    store.saveFeeWindow(pool.id,window,store.materializedFeeWindow(pool.id,window,end,covered,
      cursor.startBlock,cursor.blockNumber));
  }
  return {indexed:batch.events.length,cursor,headBlock,headTime,
    status:confirmedBlock-cursor.blockNumber<=bootstrap/20 ? "CURRENT" : "CATCHING_UP"};
}
