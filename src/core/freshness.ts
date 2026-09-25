export type Freshness = "FRESH" | "DELAYED" | "STALE" | "UNAVAILABLE";
export function freshness(at: number | null | undefined, now: number, freshMs: number, staleMs = freshMs*3): Freshness {
  if (at == null || !Number.isFinite(at) || at > now+30000) return "UNAVAILABLE";
  const age = now-at;
  return age <= freshMs ? "FRESH" : age <= staleMs ? "DELAYED" : "STALE";
}
export function cursorLag(headBlock: number | null, headTime: number | null,
  cursorBlock: number | null, cursorTime: number | null, now: number) {
  const lagBlocks = headBlock == null || cursorBlock == null ? null : Math.max(0,headBlock-cursorBlock);
  const lagSeconds = headTime == null || cursorTime == null ? null : Math.max(0,(headTime-cursorTime)/1000);
  return {lagBlocks,lagSeconds,state:cursorTime == null ? "UNAVAILABLE" as const :
    freshness(cursorTime,now,120000,600000)};
}
export function depthFailureReason(message: string) {
  if (/initialized tick cap|tick word cap|array cap/i.test(message)) return "TICK_READ_LIMIT";
  if (/no ticks|incomplete range/i.test(message)) return "NO_TICKS";
  if (/stale|drift/i.test(message)) return "STALE_PRICE";
  if (/capability|unsupported|method not found/i.test(message)) return "RPC_UNSUPPORTED";
  if (/pool state|state changed|identity mismatch/i.test(message)) return "POOL_STATE_FAILURE";
  if (/indexer/i.test(message)) return "INDEXER_STALE";
  if (/rpc|timeout|network|provider/i.test(message)) return "PROVIDER_FAILURE";
  return "UNKNOWN";
}
