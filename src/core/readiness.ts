export interface ReadinessInputs {
  foregroundP95Ms:number|null;
  foregroundP99Ms:number|null;
  hot:{chain:string;pools:number;priced:number;depth5Priced:number;fee1h:number}[];
  snapshot:{maturePools:number;tracked:number;coveragePct:number|null;largestGapMs:number|null};
  outcomes:{horizon:string;eligible:number;priceRangeComplete:number}[];
  newOutcomeP95LagMs:number|null;
  providers:{chain:string;supportsGetLogs:boolean|null;healthState:string}[];
  diskDaysRemaining:number|null;
  growthBytesPerDay:number|null;
  growthHours:number;
}
export function assessReadiness(input:ReadinessInputs) {
  const selected=["solana","base"];
  const byChain=(chain:string)=>input.hot.find((r)=>r.chain===chain);
  const ratio=(n:number,d:number)=>d>0?n/d:null;
  const base=byChain("base"),bsc=byChain("bsc");
  const hot=input.hot.filter((r)=>selected.includes(r.chain));
  const price=ratio(hot.reduce((n,r)=>n+r.priced,0),hot.reduce((n,r)=>n+r.pools,0));
  const depth=ratio(hot.reduce((n,r)=>n+r.depth5Priced,0),hot.reduce((n,r)=>n+r.priced,0));
  const outcome=(h:string)=>{const r=input.outcomes.find((x)=>x.horizon===h);
    return r?ratio(r.priceRangeComplete,r.eligible):null;};
  const provider=(chain:string)=>input.providers.some((p)=>p.chain===chain &&
    p.supportsGetLogs===true && p.healthState==="HEALTHY");
  const gate=(id:string,value:number|null,target:number,pass:boolean)=>({id,value,target,pass});
  const gates=[
    gate("FOREGROUND_P95",input.foregroundP95Ms,15000,
      input.foregroundP95Ms!==null && input.foregroundP95Ms<15000),
    gate("FOREGROUND_P99",input.foregroundP99Ms,20000,
      input.foregroundP99Ms!==null && input.foregroundP99Ms<20000),
    gate("HOT_PRICE",price,.9,price!==null && price>=.9),
    gate("HOT_DEPTH",depth,.7,depth!==null && depth>=.7),
    gate("BASE_LIVE_FEES",ratio(base?.fee1h??0,base?.pools??0),.8,
      (base?.pools??0)>0 && base!.fee1h/base!.pools>=.8),
    gate("SNAPSHOT_CONTINUITY",input.snapshot.coveragePct,98,
      input.snapshot.tracked>0 && input.snapshot.maturePools===input.snapshot.tracked &&
      (input.snapshot.coveragePct??0)>=98),
    gate("SNAPSHOT_MAX_GAP",input.snapshot.largestGapMs,180000,
      input.snapshot.largestGapMs!==null && input.snapshot.largestGapMs<=180000),
    gate("OUTCOME_4H",outcome("4h"),.7,outcome("4h")!==null && outcome("4h")!>=.7),
    gate("OUTCOME_24H",outcome("24h"),.6,outcome("24h")!==null && outcome("24h")!>=.6),
    gate("NEW_OUTCOME_LATENESS",input.newOutcomeP95LagMs,900000,
      input.newOutcomeP95LagMs!==null && input.newOutcomeP95LagMs<900000),
    gate("PROVIDER_STABILITY",provider("base")?1:0,1,provider("base")),
    gate("STORAGE_RUNWAY",input.diskDaysRemaining,180,
      input.diskDaysRemaining!==null && input.diskDaysRemaining>=180),
    gate("STORAGE_GROWTH",input.growthBytesPerDay,.15*2**30,
      input.growthHours>=4 && input.growthBytesPerDay!==null &&
        input.growthBytesPerDay<=.15*2**30),
  ];
  const bscPrice=ratio(bsc?.priced??0,bsc?.pools??0);
  const bscDepth=ratio(bsc?.depth5Priced??0,bsc?.priced??0);
  const bscGates=[
    gate("BSC_LOG_SOURCE",provider("bsc")?1:0,1,provider("bsc")),
    gate("BSC_LIVE_FEES",ratio(bsc?.fee1h??0,bsc?.pools??0),.7,
      (bsc?.pools??0)>0 && bsc!.fee1h/bsc!.pools>=.7),
    gate("BSC_PRICE",bscPrice,.9,bscPrice!==null && bscPrice>=.9),
    gate("BSC_DEPTH",bscDepth,.7,bscDepth!==null && bscDepth>=.7),
  ];
  return {status:gates.every((g)=>g.pass)?"READY" as const:"NOT_READY" as const,
    selectedChains:selected,gates,failed:gates.filter((g)=>!g.pass).map((g)=>g.id),
    bsc:{status:bscGates.every((g)=>g.pass)?"BSC_READY" as const:"BSC_NOT_READY" as const,
      gates:bscGates,failed:bscGates.filter((g)=>!g.pass).map((g)=>g.id)}};
}
