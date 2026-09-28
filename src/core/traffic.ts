import { AsyncLocalStorage } from "node:async_hooks";
export interface Traffic {
  apiRequests: number;
  rpcRequests: number;
  cacheHits: number;
  slowCalls?:{source:string;durationMs:number;reason:string}[];
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
