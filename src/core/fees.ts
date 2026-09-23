import { z } from "zod";
import { tokenUnits } from "./liquidity";
import type { Confidence, FeeWindow } from "./model";
import type { FeeEventRow } from "../db/store";

export const swapTopic = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
export const pancakeSwapTopic =
  "0x19b47279256b2a23a1665c810c8d55a1758940ee09377d4f8d26497a3577dc83";
export const swapLogSchema = z.object({
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  blockNumber: z.string().regex(/^0x[0-9a-fA-F]+$/),
  blockTimestamp: z
    .string()
    .regex(/^0x[0-9a-fA-F]+$/)
    .optional(),
  blockHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  transactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  logIndex: z.string().regex(/^0x[0-9a-fA-F]+$/),
  topics: z.array(z.string().regex(/^0x[0-9a-fA-F]{64}$/)).length(3),
  data: z.string().regex(/^0x(?:[0-9a-fA-F]{64})+$/),
  removed: z.boolean().optional(),
});
export type SwapLog = z.infer<typeof swapLogSchema>;

export function decodeSwap(log: SwapLog) {
  if (![swapTopic, pancakeSwapTopic].includes(log.topics[0].toLowerCase()) || log.removed)
    throw new Error("Invalid swap log");
  const chunks = log.data.slice(2).match(/.{64}/g);
  if (chunks?.length !== (log.topics[0].toLowerCase() === pancakeSwapTopic ? 7 : 5))
    throw new Error("Malformed swap event");
  const amount0 = BigInt.asIntN(256, BigInt(`0x${chunks[0]}`));
  const amount1 = BigInt.asIntN(256, BigInt(`0x${chunks[1]}`));
  if (amount0 > 0n === amount1 > 0n || (amount0 === 0n && amount1 === 0n))
    throw new Error("Invalid swap amounts");
  const protocolFeeRaw =
    chunks.length === 7 ? BigInt(`0x${amount0 > 0n ? chunks[5] : chunks[6]}`) : null;
  return {
    amount0,
    amount1,
    protocolFeeRaw,
    blockNumber: Number(BigInt(log.blockNumber)),
    logIndex: Number(BigInt(log.logIndex)),
  };
}

// Positive pool balance delta is the token paid by the trader, including the swap fee.
export function swapUsd(
  amount0: bigint,
  amount1: bigint,
  decimals0: number,
  decimals1: number,
  price0: number | null,
  price1: number | null,
  feeTier: number,
  protocolFeeRaw: bigint | null = null,
) {
  if (!Number.isFinite(feeTier) || feeTier < 0 || feeTier >= 1) throw new Error("Invalid fee tier");
  const volume =
    amount0 > 0n
      ? price0 == null
        ? null
        : tokenUnits(amount0.toString(), decimals0).mul(price0).toNumber()
      : price1 == null
        ? null
        : tokenUnits(amount1.toString(), decimals1).mul(price1).toNumber();
  if (volume === null || !Number.isFinite(volume) || volume < 0)
    return { volumeUsd: null, feesUsd: null };
  const protocolFeeUsd =
    protocolFeeRaw === null
      ? 0
      : amount0 > 0n
        ? tokenUnits(protocolFeeRaw.toString(), decimals0).mul(price0!).toNumber()
        : tokenUnits(protocolFeeRaw.toString(), decimals1).mul(price1!).toNumber();
  if (
    !Number.isFinite(protocolFeeUsd) ||
    protocolFeeUsd < 0 ||
    protocolFeeUsd > volume * feeTier * 1.05
  )
    return { volumeUsd: volume, feesUsd: null };
  return { volumeUsd: volume, feesUsd: Math.max(0, volume * feeTier - protocolFeeUsd) };
}

export function measuredWindow(
  events: FeeEventRow[],
  start: number,
  end: number,
  startBlock: number | null,
  endBlock: number | null,
  covered: boolean,
): FeeWindow {
  const complete =
    covered && events.every((event) => event.volumeUsd !== null && event.feesUsd !== null);
  return {
    volumeUsd: complete ? events.reduce((a, e) => a + e.volumeUsd!, 0) : null,
    feesUsd: complete ? events.reduce((a, e) => a + e.feesUsd!, 0) : null,
    windowStart: start,
    windowEnd: end,
    startBlock,
    endBlock,
    methodology: complete ? "EVENT_DERIVED" : "UNAVAILABLE",
    // Gross fee estimate; historical protocol-fee share is not reconstructed.
    confidence: complete ? ("MEDIUM" as Confidence) : ("UNAVAILABLE" as Confidence),
  };
}
