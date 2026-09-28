export interface ReadinessInputs {
  foregroundP95Ms:number|null;
  hot:{chain:string;pools:number;priced:number;depth5Priced:number;fee1h:number}[];
  snapshot:{maturePools:number;tracked:number;coveragePct:number|null;priceCoveragePct:number|null};
  outcomes:{horizon:string;eligible:number;priceRangeComplete:number}[];
  outcomeP95LagMs:number|null;
  providers:{chain:string;supportsGetLogs:boolean|null;healthState:string}[];
  diskDaysRemaining:number|null;
  growthBytesPerDay:number|null;
  growthHours:number;
  excludeBsc:boolean;
}
export function assessReadiness(input:ReadinessInputs) {
  const selected=input.excludeBsc?["solana","base"]:["solana","base","bsc"];
  const byChain=(chain:string)=>input.hot.find((r)=>r.chain===chain);
  const ratio=(n:number,d:number)=>d>0?n/d:null;
  const base=byChain("base"),bsc=byChain("bsc");
  const depth=input.hot.filter((r)=>selected.includes(r.chain));
  const depthRatio=ratio(depth.reduce((n,r)=>n+r.depth5Priced,0),
    depth.reduce((n,r)=>n+r.priced,0));
  const outcome=(h:string)=>{const r=input.outcomes.find((x)=>x.horizon===h);
    return r?ratio(r.priceRangeComplete,r.eligible):null;};
  const providerChains=input.excludeBsc?["base"]:["base","bsc"];
  const providersStable=providerChains.every((chain)=>input.providers.some((p)=>p.chain===chain &&
    p.supportsGetLogs===true && p.healthState==="HEALTHY"));
  const gates=[
    {id:"FOREGROUND_LATENCY",value:input.foregroundP95Ms,target:20000,pass:input.foregroundP95Ms!==null && input.foregroundP95Ms<20000},
    {id:"BASE_LIVE_FEES",value:ratio(base?.fee1h??0,base?.pools??0),target:.8,
      pass:(base?.pools??0)>0 && (base!.fee1h/base!.pools)>=.8},
    {id:"BSC_LIVE_FEES",value:input.excludeBsc?null:ratio(bsc?.fee1h??0,bsc?.pools??0),target:.7,
      pass:input.excludeBsc || ((bsc?.pools??0)>0 && (bsc!.fee1h/bsc!.pools)>=.7),
      excluded:input.excludeBsc},
    {id:"HOT_DEPTH",value:depthRatio,target:.7,pass:depthRatio!==null && depthRatio>=.7},
    {id:"SNAPSHOT_CONTINUITY",value:input.snapshot.coveragePct,target:95,
      pass:input.snapshot.tracked>0 && input.snapshot.maturePools===input.snapshot.tracked &&
        (input.snapshot.coveragePct??0)>=95 && (input.snapshot.priceCoveragePct??0)>=95},
    {id:"OUTCOME_4H",value:outcome("4h"),target:.7,
      pass:outcome("4h")!==null && outcome("4h")!>=.7},
    {id:"OUTCOME_24H",value:outcome("24h"),target:.6,
      pass:outcome("24h")!==null && outcome("24h")!>=.6},
    {id:"OUTCOME_LATENESS",value:input.outcomeP95LagMs,target:1800000,
      pass:input.outcomeP95LagMs!==null && input.outcomeP95LagMs<1800000},
    {id:"PROVIDER_STABILITY",value:providersStable?1:0,target:1,pass:providersStable},
    {id:"STORAGE_RUNWAY",value:input.diskDaysRemaining,target:180,
      pass:input.diskDaysRemaining!==null && input.diskDaysRemaining>=180},
    {id:"STORAGE_GROWTH",value:input.growthBytesPerDay,target:.2*2**30,
      pass:input.growthHours>=1 && input.growthBytesPerDay!==null &&
        input.growthBytesPerDay<.2*2**30},
  ];
  return {status:gates.every((g)=>g.pass)?"READY" as const:"NOT_READY" as const,
    selectedChains:selected,gates,failed:gates.filter((g)=>!g.pass).map((g)=>g.id)};
}
