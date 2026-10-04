export interface StorageSample {
  at:number;databaseBytes:number;walBytes:number;freelistBytes:number;
  objects:{name:string;bytes:number}[];
}
export function storageDelta(before:StorageSample,after:StorageSample) {
  const hours=(after.at-before.at)/3600000;
  const old=new Map(before.objects.map(r=>[r.name,r.bytes]));
  const names=new Set([...old.keys(),...after.objects.map(r=>r.name)]);
  const current=new Map(after.objects.map(r=>[r.name,r.bytes]));
  const objects=[...names].map(name=>({name,startBytes:old.get(name)??0,endBytes:current.get(name)??0,
    deltaBytes:(current.get(name)??0)-(old.get(name)??0)})).sort((a,b)=>b.deltaBytes-a.deltaBytes);
  const allocatedDelta=objects.reduce((n,r)=>n+r.deltaBytes,0);
  const fileDelta=after.databaseBytes-before.databaseBytes;
  const walDelta=after.walBytes-before.walBytes;
  // Conservative growth includes expanding occupied pages even when the file reuses its freelist.
  const totalGrowthBytes=Math.max(0,allocatedDelta,fileDelta+walDelta);
  return {hours,objects,allocatedDelta,fileDelta,walDelta,
    freelistDelta:after.freelistBytes-before.freelistBytes,totalGrowthBytes,
    bytesPerDay:hours>0?totalGrowthBytes*24/hours:null};
}
