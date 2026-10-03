export function staleCursorReason(input:{fresh:boolean;headAgeSeconds:number|null;
  lagSeconds:number|null;updatedAgeSeconds:number|null;error?:string|null;covered:boolean;swaps:number|null}) {
  const error=input.error??"";
  if(/budget|429|rate.limit/i.test(error))return "RATE_LIMIT";
  if(/timeout|timed out/i.test(error))return "GETLOGS_TIMEOUT";
  if(/rpc|provider|network|fetch/i.test(error))return "RPC_FAILURE";
  if((input.headAgeSeconds??Infinity)>180)return "BLOCK_HEAD_STALE";
  if(input.fresh && input.covered && input.swaps===0)return "NO_RECENT_ACTIVITY";
  if(input.fresh)return "HEALTHY";
  if(input.updatedAgeSeconds===null || input.updatedAgeSeconds>180)return "WORKER_STARVED";
  return input.lagSeconds!==null && input.lagSeconds>180?"CURSOR_STUCK":"UNKNOWN";
}
