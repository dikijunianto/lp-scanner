import { z } from "zod";
import { decodeSwap,pancakeSwapTopic,swapLogSchema,swapTopic } from "../core/fees";
import { createHash } from "node:crypto";

const indexedRange = z.object({
  chain: z.enum(["base", "bsc"]),
  pool: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  fromBlock: z.number().int().nonnegative(),
  throughBlock: z.number().int().nonnegative(),
  complete: z.literal(true),
  endBlockHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  logs: z.array(swapLogSchema),
});

// A complete range and anchored end-block hash are required, including for empty ranges.
export async function fetchIndexedSwaps(url:string,chain:"base"|"bsc",pool:string,
  from:number,to:number,timeoutMs=7000) {
  const target=new URL(url);
  for(const [key,value] of Object.entries({chain,pool,fromBlock:String(from),toBlock:String(to)}))
    target.searchParams.set(key,value);
  const started=Date.now();
  const response=await fetch(target,{signal:AbortSignal.timeout(timeoutMs)});
  if(!response.ok) throw new Error(`Indexer HTTP ${response.status}`);
  const body=indexedRange.parse(await response.json());
  if(body.chain!==chain || body.pool.toLowerCase()!==pool.toLowerCase() ||
    body.fromBlock!==from || body.throughBlock<to) throw new Error("INDEXER_INCOMPLETE_RANGE");
  const seen=new Map<string,(typeof body.logs)[number]>();
  for(const log of body.logs) {
    const block=Number(BigInt(log.blockNumber));
    if(log.removed || !log.blockTimestamp || block<from || block>to ||
      log.topics[0].toLowerCase()!==(chain==="bsc"?pancakeSwapTopic:swapTopic) ||
      log.address.toLowerCase()!==pool.toLowerCase()) throw new Error("INDEXER_INVALID_LOG");
    decodeSwap(log);
    const key=`${chain}:${log.transactionHash.toLowerCase()}:${Number(BigInt(log.logIndex))}`;
    const old=seen.get(key);
    if(old && JSON.stringify(old)!==JSON.stringify(log)) throw new Error("INDEXER_CONFLICT");
    seen.set(key,log);
  }
  return {logs:[...seen.values()],endBlockHash:body.endBlockHash,
    latestIndexedBlock:body.throughBlock,latencyMs:Date.now()-started,
    sourceId:`${chain}:${createHash("sha256").update(url).digest("hex").slice(0,16)}`};
}

export function reconcileSwapLogs(primary:unknown,secondary:unknown) {
  const parse=(value:unknown)=>{
    const logs=z.array(swapLogSchema).parse(value);
    const map=new Map<string,(typeof logs)[number]>();
    for(const log of logs) {
      const key=`${log.transactionHash.toLowerCase()}:${Number(BigInt(log.logIndex))}`;
      const old=map.get(key);
      if(old && JSON.stringify(old)!==JSON.stringify(log)) throw new Error("LOG_SOURCE_DISAGREEMENT");
      map.set(key,log);
    }
    return map;
  };
  const first=parse(primary),second=parse(secondary);
  if(first.size!==second.size) throw new Error("LOG_SOURCE_DISAGREEMENT");
  for(const [key,log] of first) {
    const other=second.get(key);
    if(!other || log.blockNumber!==other.blockNumber || log.blockHash.toLowerCase()!==other.blockHash.toLowerCase() ||
      log.address.toLowerCase()!==other.address.toLowerCase() || log.data.toLowerCase()!==other.data.toLowerCase() ||
      log.topics.join(":").toLowerCase()!==other.topics.join(":").toLowerCase())
      throw new Error("LOG_SOURCE_DISAGREEMENT");
  }
  return [...first.values()];
}
