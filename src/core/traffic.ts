import { AsyncLocalStorage } from "node:async_hooks";
export interface Traffic {
  apiRequests: number;
  rpcRequests: number;
  cacheHits: number;
  slowCalls?:{source:string;durationMs:number;reason:string}[];
  spans?:ScanSpan[];
}
export interface ScanSpan {
  phase:string;operation:string;provider:string|null;startedAt:number;endedAt:number;
  durationMs:number;timeoutMs:number|null;success:boolean;
}
const scope = new AsyncLocalStorage<Traffic>();
export const withTraffic = <T>(traffic: Traffic, work: () => T): T => scope.run(traffic, work);
export const countApi = () => {
  const s = scope.getStore();
  if (s) s.apiRequests++;
};
export const countRpc = () => {
  const s = scope.getStore();
  if (s) s.rpcRequests++;
};
export const countCache = () => {
  const s = scope.getStore();
  if (s) s.cacheHits++;
};
export const traceSlow=(source:string,durationMs:number,reason:string)=>{
  const calls=scope.getStore()?.slowCalls;
  if(calls && durationMs>=1000 && calls.length<50) calls.push({source,durationMs,reason});
};
export const traceSpan=(phase:string,operation:string,provider:string|null,startedAt:number,
  timeoutMs:number|null,success:boolean)=>{
  const spans=scope.getStore()?.spans;
  if(spans && spans.length<500) {
    const endedAt=Date.now();
    spans.push({phase,operation,provider,startedAt,endedAt,
      durationMs:endedAt-startedAt,timeoutMs,success});
  }
};
