import { z } from "zod";
import { swapLogSchema } from "../core/fees";

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
