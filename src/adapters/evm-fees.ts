import { z } from "zod";
import { env } from "../config/env";
import type { Pool, PriceRecord, Window } from "../core/model";
import { windows, windowMs } from "../core/model";
import { fresh } from "../core/liquidity";
import {
  decodeSwap,
  measuredWindow,
  swapLogSchema,
  swapTopic,
  pancakeSwapTopic,
  swapUsd,
} from "../core/fees";
import type { Store, FeeEventRow } from "../db/store";
import { HttpClient } from "./http";
import { blockSchema, ReadOnlyRpc } from "./liquidity-rpc";

const historical = new HttpClient(250);
const priceResponse = z.object({ coins: z.record(z.string(), z.unknown()) });
const priceCoin = z.object({
  price: z.number().finite().positive(),
  timestamp: z.number().int().positive(),
});

async function historicalPrices(pool: Pool, timestamp: number, store: Store) {
  const details = pool.activeLiquidityDetails!;
  const bucket = Math.floor(timestamp / 300000) * 300000;
  const keys = [details.token0Address, details.token1Address].map(
    (address) => `${pool.chain}:${address.toLowerCase()}`,
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

export async function enrichEvmFees(pools: Pool[], rpc: ReadOnlyRpc, store: Store) {
  const targets = pools
    .filter(
      (p) => p.activeLiquidityDetails?.method === "V3_VIRTUAL_RESERVES_V1" && p.feeTier !== null,
    )
    .slice(0, env.FEE_EVM_LIMIT);
  if (!targets.length) return "Fees: no eligible pools";
  let processed = 0,
    measured = 0;
  const reasons = new Map<string, number>();
  try {
    const head = blockSchema.parse(await rpc.call("eth_getBlockByNumber", ["latest", false]));
    if (!fresh(Number(BigInt(head.timestamp)) * 1000, Date.now(), 120000))
      throw new Error("Stale fee RPC head");
    const confirmedNumber = Number(BigInt(head.number)) - env.FEE_CONFIRMATIONS;
    const confirmed = blockSchema.parse(
      await rpc.call("eth_getBlockByNumber", [`0x${confirmedNumber.toString(16)}`, false]),
    );
    if (!fresh(Number(BigInt(confirmed.timestamp)) * 1000, Date.now(), 120000))
      throw new Error("Stale confirmed block");
    const blockCache = new Map<number, { hash: string; timestamp: number }>();
    blockCache.set(confirmedNumber, {
      hash: confirmed.hash,
      timestamp: Number(BigInt(confirmed.timestamp)) * 1000,
    });
    for (const pool of targets) {
      try {
        let cursor = store.feeCursor(pool.id);
        const maxBlocks =
          pool.chain === "bsc" ? env.BSC_FEE_MAX_BLOCKS_PER_SCAN : env.FEE_MAX_BLOCKS_PER_SCAN;
        if (cursor) {
          if (cursor.blockNumber > confirmedNumber) throw new Error("Fee RPC fell behind cursor");
          const checked = blockSchema.parse(
            await rpc.call("eth_getBlockByNumber", [`0x${cursor.blockNumber.toString(16)}`, false]),
          );
          if (checked.hash !== cursor.blockHash) {
            store.rollbackFees(pool.id, 0);
            cursor = null;
          }
        }
        if (
          cursor &&
          pool.chain === "bsc" &&
          cursor.startTime > Number(BigInt(confirmed.timestamp)) * 1000 - 300000 &&
          cursor.startBlock > confirmedNumber - maxBlocks + 1
        ) {
          const rewindTo = Math.max(1, confirmedNumber - maxBlocks);
          const earlier = blockSchema.parse(
            await rpc.call("eth_getBlockByNumber", [`0x${rewindTo.toString(16)}`, false]),
          );
          store.rewindFeeCursor(
            pool.id,
            rewindTo,
            earlier.hash,
            rewindTo + 1,
            Number(BigInt(earlier.timestamp)) * 1000,
          );
          cursor = store.feeCursor(pool.id);
        }
        const from = cursor ? cursor.blockNumber + 1 : Math.max(0, confirmedNumber - maxBlocks + 1);
        const to = Math.min(confirmedNumber, from + maxBlocks - 1);
        if (from <= to) {
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
          const firstBlock = cursor?.startBlock ?? from;
          for (const log of logs)
            if (log.blockTimestamp) {
              const number = Number(BigInt(log.blockNumber));
              const timestamp = Number(BigInt(log.blockTimestamp)) * 1000;
              const known = blockCache.get(number);
              if (known && (known.hash !== log.blockHash || known.timestamp !== timestamp))
                throw new Error("Inconsistent log block");
              blockCache.set(number, { hash: log.blockHash, timestamp });
            }
          const needed = [
            ...new Set([from, to, ...logs.map((log) => Number(BigInt(log.blockNumber)))]),
          ].filter((n) => !blockCache.has(n));
          if (needed.length) {
            const fetched = await rpc.batch(
              needed.map((n) => ({
                method: "eth_getBlockByNumber",
                params: [`0x${n.toString(16)}`, false],
              })),
            );
            for (let i = 0; i < needed.length; i++) {
              const block = blockSchema.parse(fetched[i]);
              if (Number(BigInt(block.number)) !== needed[i])
                throw new Error("Malformed block identity");
              blockCache.set(needed[i], {
                hash: block.hash,
                timestamp: Number(BigInt(block.timestamp)) * 1000,
              });
            }
          }
          const details = pool.activeLiquidityDetails!;
          const events: FeeEventRow[] = [];
          const buckets = [
            ...new Set(
              logs.map((log) =>
                Math.floor(blockCache.get(Number(BigInt(log.blockNumber)))!.timestamp / 300000),
              ),
            ),
          ];
          for (const bucket of buckets) await historicalPrices(pool, bucket * 300000, store);
          for (const log of logs) {
            const swap = decodeSwap(log),
              block = blockCache.get(swap.blockNumber)!;
            if (block.hash.toLowerCase() !== log.blockHash.toLowerCase())
              throw new Error("Block changed during log read");
            const price0 = store.priceAt(
              pool.chain,
              details.token0Address.toLowerCase(),
              block.timestamp,
              600000,
            );
            const price1 = store.priceAt(
              pool.chain,
              details.token1Address.toLowerCase(),
              block.timestamp,
              600000,
            );
            const amounts = swapUsd(
              swap.amount0,
              swap.amount1,
              details.decimals0,
              details.decimals1,
              price0?.priceUsd ?? null,
              price1?.priceUsd ?? null,
              pool.feeTier!,
              swap.protocolFeeRaw,
            );
            events.push({
              poolId: pool.id,
              blockNumber: swap.blockNumber,
              blockHash: log.blockHash,
              txHash: log.transactionHash,
              logIndex: swap.logIndex,
              timestamp: block.timestamp,
              ...amounts,
              confidence: amounts.feesUsd === null ? "UNAVAILABLE" : "MEDIUM",
            });
          }
          const firstTime = cursor?.startTime ?? blockCache.get(from)!.timestamp;
          const finalBlock = blockSchema.parse(
            await rpc.call("eth_getBlockByNumber", [`0x${to.toString(16)}`, false]),
          );
          if (finalBlock.hash !== blockCache.get(to)!.hash)
            throw new Error("Block changed during fee read");
          store.saveFeeBatch(
            pool.id,
            events,
            firstBlock,
            firstTime,
            to,
            blockCache.get(to)!.hash,
            blockCache.get(to)!.timestamp,
          );
          processed += events.length;
          cursor = store.feeCursor(pool.id);
        }
        if (!cursor) continue;
        for (const window of windows) {
          const end = Number(BigInt(confirmed.timestamp)) * 1000,
            start = end - windowMs[window];
          const events = store.feeEvents(pool.id, start, end);
          const data = measuredWindow(
            events,
            start,
            end,
            events[0]?.blockNumber ?? null,
            cursor.blockNumber,
            cursor.startTime <= start && cursor.blockNumber >= confirmedNumber,
          );
          pool.feeWindows![window] = data;
          store.saveFeeWindow(pool.id, window as Window, data);
          if (data.methodology === "EVENT_DERIVED") {
            pool[`fees${window}`] = data.feesUsd;
            pool[`volume${window}`] = data.volumeUsd;
          }
        }
        pool.feeConfidence =
          pool.feeWindows?.["1h"]?.confidence === "MEDIUM"
            ? "MEDIUM"
            : pool.feeWindows?.["5m"]?.confidence === "MEDIUM"
              ? "LOW"
              : "UNAVAILABLE";
        if (pool.feeWindows?.["5m"]?.methodology === "EVENT_DERIVED") measured++;
      } catch (error) {
        pool.feeConfidence = "UNAVAILABLE";
        const reason = error instanceof Error ? error.message : "RPC error";
        reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
      }
    }
  } catch {
    /* RPC failure leaves historical source windows intact. */
  }
  return `Fees: ${measured}/${targets.length} pools with complete 5m event window; ${processed} swaps; ${rpc.requests} RPC batches; ${[...reasons].map(([k, v]) => `${k} ${v}`).join(", ")}`;
}
