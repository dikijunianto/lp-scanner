import { createHash } from "node:crypto";
import { Interface } from "@ethersproject/abi";
import { env } from "../config/env";
import type { Store } from "../db/store";
import type { RpcProviderRow } from "../db/reliability";
import { HttpClient } from "./http";
import { ReadOnlyRpc, blockSchema } from "./liquidity-rpc";
import { evmNetworks } from "./evm-liquidity";
import { SOLANA_PUBLIC_RPC } from "./meteora-liquidity";

export const routerVersion = "sprint5-v1";
const minute = () => Math.floor(Date.now() / 60000) * 60000;
const multicall = new Interface(["function aggregate3(tuple(address target,bool allowFailure,bytes callData)[] calls) returns (tuple(bool success,bytes returnData)[])"]);
export function rpcUrls(chain: string) {
  const list = chain === "base" ? env.BASE_RPC_URLS : chain === "bsc" ? env.BNB_RPC_URLS : env.SOLANA_RPC_URLS;
  const prior = chain === "base" ? [env.BASE_RPC_URL,env.BASE_DEPTH_RPC_URL] : chain === "bsc"
    ? [env.BSC_FEE_RPC_URL,env.BSC_RPC_URL] : [env.SOLANA_RPC_URL];
  const defaults = chain === "base" ? [evmNetworks.base.url,"https://base-rpc.publicnode.com"]
    : chain === "bsc" ? ["https://bsc.publicnode.com",evmNetworks.bsc.url] : [SOLANA_PUBLIC_RPC];
  return [...new Set([...list.split(","),...prior,...defaults].filter((x): x is string => !!x).map((x) => x.trim()))]
    .filter((x) => { try { const u = new URL(x); return u.protocol === "https:" || (u.protocol === "http:" && ["localhost","127.0.0.1"].includes(u.hostname)); } catch { return false; } });
}
export function providerHealth(row: RpcProviderRow, now = Date.now()): RpcProviderRow["healthState"] {
  if (row.cooldownUntil > now) return "COOLDOWN";
  if (row.lastSuccessAt === null) return "UNAVAILABLE";
  return row.consecutiveFailures || row.errorRate >= 0.2 ? "DEGRADED" : "HEALTHY";
}
export function nextLogRange(current: number, success: boolean, maximum: number) {
  return success ? Math.min(maximum, Math.max(current + 1, Math.floor(current * 1.25)))
    : Math.max(1, Math.floor(current / 2));
}
export function isRangeError(message: string) {
  return /range|too many|response size|limit exceeded|timeout|timed out|query returned/i.test(message);
}
export class RpcRouter extends ReadOnlyRpc {
  private providers: { url: string; row: RpcProviderRow }[];
  private lastLogProvider: RpcProviderRow | null = null;
  constructor(public chain: "solana" | "base" | "bsc", private store: Store, urls = rpcUrls(chain)) {
    super("https://unused.invalid");
    const saved = new Map(store.rpcProviders().map((r) => [r.providerId,r]));
    this.providers = urls.map((url, index) => {
      const urlHash = createHash("sha256").update(url).digest("hex");
      const providerId = `${chain}:${urlHash.slice(0,16)}`;
      const row = saved.get(providerId) ?? {
        providerId,chain,urlHash,providerType:index < urls.length - (chain === "solana" ? 1 : 2) ? "CONFIGURED" : "PUBLIC",
        supportsArchive:null,supportsGetLogs:null,supportsBatching:null,supportsMulticall:null,
        supportsHistoricalState:null,safeLogRange:env.FEE_LOG_BLOCK_CHUNK,lastProbeAt:null,
        lastSuccessAt:null,lastFailureAt:null,latencyMs:null,errorRate:0,consecutiveFailures:0,
        cooldownUntil:0,healthState:"UNAVAILABLE" as const,
      };
      store.saveRpcProvider(row);
      return { url,row };
    });
  }
  get providerCount() { return this.providers.length; }
  get safeLogRange() {
    const capable = this.ordered("eth_getLogs",[]);
    return capable.length ? capable[0].row.safeLogRange : 1;
  }
  noteLogRange(success: boolean, attempted: number) {
    const row = this.lastLogProvider;
    if (!row) return;
    row.safeLogRange = nextLogRange(success ? Math.max(row.safeLogRange,attempted) : Math.min(row.safeLogRange,attempted),
      success,Math.min(5000,env.FEE_LOG_BLOCK_CHUNK*16));
    this.store.saveRpcProvider(row);
  }
  private ordered(method: string, params: unknown[]) {
    const now = Date.now();
    const capability = method === "eth_getLogs" ? "supportsGetLogs" :
      method === "eth_call" && typeof params[1] === "string" && params[1] !== "latest" ? "supportsHistoricalState" : null;
    return this.providers.filter((p) => p.row.cooldownUntil <= now && (capability !== "supportsGetLogs" || p.row.supportsGetLogs !== false))
      .sort((a,b) => {
        const score = (p: typeof a) => (capability && p.row[capability] === true ? 1000 : 0)
          + (method === "eth_getLogs" && p.row.supportsArchive === true ? 500 : 0)
          + (p.row.healthState === "HEALTHY" ? 100 : p.row.healthState === "DEGRADED" ? 20 : 0)
          - (p.row.latencyMs ?? 2000)/100 - p.row.errorRate*100;
        return score(b)-score(a);
      });
  }
  private record(row: RpcProviderRow, success: boolean, latency: number, error?: string) {
    row.errorRate = row.errorRate * 0.8 + (success ? 0 : 0.2);
    row.latencyMs = row.latencyMs === null ? latency : row.latencyMs * 0.7 + latency * 0.3;
    if (success) { row.lastSuccessAt = Date.now(); row.consecutiveFailures = 0; row.cooldownUntil = 0; }
    else {
      row.lastFailureAt = Date.now(); row.consecutiveFailures++;
      if (/429|rate.limit/i.test(error ?? "")) row.cooldownUntil = Date.now()+60000;
      else if (row.consecutiveFailures >= 3) row.cooldownUntil = Date.now()+Math.min(300000,10000*row.consecutiveFailures);
    }
    row.healthState = providerHealth(row);
    this.store.saveRpcProvider(row);
  }
  async batch(calls: { method: string; params: unknown[] }[]): Promise<unknown[]> {
    if (!calls.length) return [];
    const method = calls[0].method;
    const ordered = this.ordered(method,calls[0].params);
    if (!ordered.length) throw new Error(`RPC_CAPABILITY_UNAVAILABLE ${this.chain} ${method}`);
    let last: unknown;
    for (let i=0; i<Math.min(ordered.length,3); i++) {
      const p = ordered[i], usage = this.store.rpcUsage(p.row.providerId,this.chain,minute());
      const requestCount = p.row.supportsBatching === false ? calls.length : Math.ceil(calls.length/10);
      if (usage.provider+requestCount > env.RPC_PROVIDER_REQUESTS_PER_MINUTE ||
        usage.chain+requestCount > env.RPC_CHAIN_REQUESTS_PER_MINUTE) {
        last = new Error("RPC_REQUEST_BUDGET_EXHAUSTED"); continue;
      }
      const rpc = new ReadOnlyRpc(p.url,new HttpClient(0,fetch,0,env.RPC_CALL_TIMEOUT_MS),10,p.row.supportsBatching !== false);
      if (method === "eth_getLogs") this.lastLogProvider = p.row;
      const started = Date.now();
      const logs = calls.filter((c) => c.method === "eth_getLogs").length;
      const blocks = calls.filter((c) => c.method === "eth_getBlockByNumber" && c.params[0] !== "latest").length;
      this.store.recordRpcRequest(p.row.providerId,minute(),calls.length,logs,blocks,i ? 1 : 0,requestCount);
      try {
        const result = await rpc.batch(calls);
        for (let j=0;j<calls.length;j++)
          if (calls[j].method === "eth_getBlockByNumber" && calls[j].params[0] === "latest") {
            const head = blockSchema.parse(result[j]);
            if (Date.now()-Number(BigInt(head.timestamp))*1000 > 120000) throw new Error("RPC_STALE_HEAD");
          }
        this.requests += rpc.requests;
        this.record(p.row,true,Date.now()-started);
        return result;
      } catch (error) {
        this.requests += rpc.requests;
        const message = error instanceof Error ? error.message : "RPC error";
        last = new Error(method === "eth_getLogs" && isRangeError(message) ? "RPC_RANGE_LIMIT" :
          /timed out|timeout/i.test(message) ? "RPC_PROVIDER_TIMEOUT" : message === "RPC_STALE_HEAD" ? "RPC_STALE_HEAD" : /429|rate.limit/i.test(message)
          ? "RPC_RATE_LIMIT" : /403|disabled|not supported|method not found/i.test(message)
            ? "RPC_CAPABILITY_UNAVAILABLE" : "RPC_PROVIDER_FAILURE");
        if (method === "eth_getLogs" && /disabled|not supported|method not found|403/i.test(message))
          p.row.supportsGetLogs = false;
        if (method === "eth_getLogs" && /archive/i.test(message)) p.row.supportsArchive = false;
        this.record(p.row,false,Date.now()-started,message);
      }
    }
    throw last instanceof Error ? last : new Error("RPC_UNAVAILABLE");
  }
  async call(method: string, params: unknown[]) { return (await this.batch([{method,params}]))[0]; }
  async probeAll() {
    await Promise.all(this.providers.map(async (p) => {
      if (p.row.lastProbeAt && Date.now()-p.row.lastProbeAt < env.RPC_PROBE_INTERVAL_SECONDS*1000) return;
      const usage = this.store.rpcUsage(p.row.providerId,this.chain,minute());
      if (usage.provider+8 > env.RPC_PROVIDER_REQUESTS_PER_MINUTE ||
        usage.chain+8 > env.RPC_CHAIN_REQUESTS_PER_MINUTE) return;
      let rpc = new ReadOnlyRpc(p.url,new HttpClient(0,fetch,0,5000),10,true);
      try {
        let identity: unknown;
        try { identity = this.chain === "solana" ? await rpc.call("getGenesisHash",[]) : await rpc.call("eth_chainId",[]); }
        catch { rpc = new ReadOnlyRpc(p.url,new HttpClient(0,fetch,0,5000),1,false);
          identity = this.chain === "solana" ? await rpc.call("getGenesisHash",[]) : await rpc.call("eth_chainId",[]);
          p.row.supportsBatching = false; }
        if (identity !== (this.chain === "solana" ? "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d" : this.chain === "base" ? "0x2105" : "0x38"))
          throw new Error("Wrong RPC chain");
        try {
          await new ReadOnlyRpc(p.url,new HttpClient(0,fetch,0,5000),10,true).batch(this.chain === "solana" ? [{method:"getGenesisHash",params:[]},{method:"getGenesisHash",params:[]}]
            : [{method:"eth_chainId",params:[]},{method:"eth_chainId",params:[]}]);
          p.row.supportsBatching = true;
        } catch { p.row.supportsBatching = false; rpc = new ReadOnlyRpc(p.url,new HttpClient(0,fetch,0,5000),1,false); }
        if (this.chain !== "solana") {
          const head = blockSchema.parse(await rpc.call("eth_getBlockByNumber",["latest",false]));
          const n = Number(BigInt(head.number));
          const old = `0x${Math.max(1,n-50000).toString(16)}`;
          try { p.row.supportsArchive = !!blockSchema.safeParse(await rpc.call("eth_getBlockByNumber",[old,false])).success; }
          catch { p.row.supportsArchive = false; }
          try { p.row.supportsGetLogs = Array.isArray(await rpc.call("eth_getLogs",[{fromBlock:`0x${Math.max(1,n-100).toString(16)}`,toBlock:`0x${Math.max(1,n-99).toString(16)}`,address:"0x0000000000000000000000000000000000000001"}])); }
          catch { p.row.supportsGetLogs = false; }
          const token = this.chain === "base" ? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" : "0x55d398326f99059fF775485246999027B3197955";
          try { p.row.supportsHistoricalState = typeof await rpc.call("eth_call",[{to:token,data:"0x313ce567"},old]) === "string"; }
          catch { p.row.supportsHistoricalState = false; }
          try { p.row.supportsMulticall = typeof await rpc.call("eth_call",[{to:"0xca11bde05977b3631167028862be2a173976ca11",data:multicall.encodeFunctionData("aggregate3",[[]])},"latest"]) === "string"; }
          catch { p.row.supportsMulticall = false; }
        }
        this.record(p.row,true,0);
      } catch (error) { this.record(p.row,false,0,error instanceof Error ? error.message : "probe failed"); }
      p.row.lastProbeAt = Date.now();
      if (rpc.requests) this.store.recordRpcRequest(p.row.providerId,minute(),rpc.requests,0,0,0,rpc.requests);
      this.store.saveRpcProvider(p.row);
    }));
  }
}
