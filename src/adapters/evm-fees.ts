import { z } from "zod";
import { env } from "../config/env";
import type { Pool, PriceRecord, Window, FeeWindow } from "../core/model";
import { windows, windowMs } from "../core/model";
import { fresh } from "../core/liquidity";
import { decodeSwap, swapLogSchema, swapTopic, pancakeSwapTopic, swapUsd } from "../core/fees";
import type { Store, FeeEventRow } from "../db/store";
import type { BackfillJob } from "../db/research";
import { HttpClient } from "./http";
import { blockSchema, ReadOnlyRpc } from "./liquidity-rpc";

const historical = new HttpClient(250);
const priceResponse = z.object({ coins: z.record(z.string(), z.unknown()) });
const priceCoin = z.object({
  price: z.number().finite().positive(),
  timestamp: z.number().int().positive(),
});
type Block = { hash: string; timestamp: number };
const blockAt = async (rpc: ReadOnlyRpc, n: number): Promise<Block> => {
  const raw = blockSchema.parse(
    await rpc.call("eth_getBlockByNumber", [`0x${n.toString(16)}`, false]),
  );
  if (Number(BigInt(raw.number)) !== n) throw new Error("Malformed block identity");
  return { hash: raw.hash, timestamp: Number(BigInt(raw.timestamp)) * 1000 };
};

async function historicalPrices(pool: Pool, timestamp: number, store: Store) {
  const details = pool.activeLiquidityDetails!;
  const bucket = Math.floor(timestamp / 300000) * 300000;
  const keys = [details.token0Address, details.token1Address].map(
    (a) => `${pool.chain}:${a.toLowerCase()}`,
  );
  if (keys.every((key) => store.priceAt(pool.chain, key.split(":")[1], timestamp, 600000))) return;
  const data = await historical.json(
    `${env.PRICE_API_URL}/prices/historical/${Math.floor(bucket / 1000)}/${keys.join(",")}?searchWidth=10m`,
    priceResponse,
    { ttl: 3600000 },
  );
  const observedAt = Date.now();
  const records: PriceRecord[] = [];
  for (let i = 0; i < keys.length; i++) {
    const coin = priceCoin.safeParse(data.coins[keys[i]]);
    if (!coin.success) continue;
    const sourceTimestamp = coin.data.timestamp * 1000;
    if (sourceTimestamp > bucket + 30000 || bucket - sourceTimestamp > 600000) continue;
    records.push({
      chain: pool.chain,
      assetAddress: keys[i].split(":")[1],
      symbol: i === 0 ? pool.token0.symbol : pool.token1.symbol,
      priceUsd: coin.data.price,
      source: "DefiLlama Coins API historical",
      sourceTimestamp,
      observedAt,
      blockNumber: null,
      confidence: "MEDIUM",
    });
  }
  if (records.length) store.savePrices(records);
}

export async function readRange(
  pool: Pool,
  rpc: ReadOnlyRpc,
  store: Store,
  from: number,
  to: number,
) {
  const logs: z.infer<typeof swapLogSchema>[] = [];
  for (let start = from; start <= to; start += env.FEE_LOG_BLOCK_CHUNK) {
    const end = Math.min(to, start + env.FEE_LOG_BLOCK_CHUNK - 1);
    const batch = z.array(swapLogSchema).parse(
      await rpc.call("eth_getLogs", [
        {
          address: pool.poolAddress,
          fromBlock: `0x${start.toString(16)}`,
          toBlock: `0x${end.toString(16)}`,
          topics: [pool.chain === "bsc" ? pancakeSwapTopic : swapTopic],
        },
      ]),
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
  const buckets = [
    ...new Set(
      logs.map((log) =>
        Math.floor(blocks.get(Number(BigInt(log.blockNumber)))!.timestamp / 300000),
      ),
    ),
  ];
  for (const bucket of buckets)
    try {
      await historicalPrices(pool, bucket * 300000, store);
    } catch {
      /* Unpriced events remain explicit gaps. */
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
  // Preserve old swaps, but restart the contiguous cursor when catching up would delay recent 1h windows.
  const previous = store.feeCursor(pool.id);
  if (previous && previous.endTime < confirmed.timestamp - windowMs["1h"])
    store.restartFeeCursorFromHead(pool.id);
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
