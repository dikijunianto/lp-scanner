export function scanDistribution(durations:number[]) {
  const a=[...durations].sort((x,y)=>x-y);
  const pick=(p:number)=>a.length?a[Math.ceil(a.length*p)-1]:null;
  return {count:a.length,medianMs:pick(.5),p95Ms:pick(.95),p99Ms:pick(.99),maxMs:a.at(-1)??null};
}
export function burninPass(samples:{at:number;healthy:boolean}[],durationMs:number,
  scans:{maxMs:number|null},startedAt:number,now:number) {
  return samples.length>=2 && now-startedAt>=durationMs &&
    samples.every((s)=>s.healthy) &&
    samples.every((s,i)=>i===0 || s.at-samples[i-1].at<=180000) &&
    scans.maxMs!==null && scans.maxMs<=20000;
}
