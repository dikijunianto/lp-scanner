export function clockEvent(wallElapsedMs:number,monotonicElapsedMs:number) {
  if(Math.abs(wallElapsedMs-monotonicElapsedMs)>2000) return "SYSTEM_CLOCK_JUMP";
  // A late pulse with no clock divergence can also be CPU/SQLite blocking. Never label it sleep.
  return monotonicElapsedMs>10000?"SYSTEM_SCHEDULER_DELAY":null;
}
export function keepAwakeArgs(platform:string,pid:number,enabled=true) {
  return platform==="darwin" && enabled?["-dimsu","-w",String(pid)]:null;
}
export function sampleTrace(id:number,rate:number,elapsed:number,failed:boolean,slowMs:number) {
  return failed || elapsed>=slowMs || (id*2654435761>>>0)/2**32<rate;
}
