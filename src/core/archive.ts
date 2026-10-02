import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

export function verifyArchive(saved:Buffer,plain:Buffer,snapshotIds:number[],eventIds:number[]) {
  const restored=gunzipSync(saved);
  if(!restored.equals(plain)) throw new Error("Archive contents changed");
  const payload=JSON.parse(restored.toString()) as {
    format?:string;snapshots?:{id:number}[];events?:{id:number}[]};
  const same=(actual:{id:number}[]|undefined,expected:number[])=>
    actual?.length===expected.length && actual.every((row,i)=>row.id===expected[i]);
  if(payload.format!=="lp-scanner-archive-v1" ||
    !same(payload.snapshots,snapshotIds) || !same(payload.events,eventIds))
    throw new Error("Archive integrity check failed");
  return {sha256:createHash("sha256").update(saved).digest("hex"),
    compressedBytes:saved.length,snapshotRows:snapshotIds.length,eventRows:eventIds.length};
}
