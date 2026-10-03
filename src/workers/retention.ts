import "dotenv/config";
import Database from "better-sqlite3";
import { gzipSync } from "node:zlib";
import { existsSync,mkdirSync,readFileSync,statSync,writeFileSync } from "node:fs";
import { dirname,resolve } from "node:path";
import { env } from "../config/env";
import { verifyArchive } from "../core/archive";

const args=new Set(process.argv.slice(2));
const archive=args.has("--archive"),archiveApply=archive && (args.has("--apply")||args.has("--execute"));
if(args.has("--apply-events")||args.has("--apply-snapshots")) throw new Error("Use storage:compact --execute with verified archive; unarchived deletion disabled");
const daysArg=process.argv.find((arg)=>arg.startsWith("--event-days="));
const eventDays=daysArg?Number(daysArg.split("=")[1]):30;
if(!Number.isInteger(eventDays)||eventDays<30) throw new Error("--event-days must be at least 30");
const db=new Database(env.DATABASE_PATH);
db.pragma("busy_timeout = 5000");
const now=Date.now(),limit=500;
if(args.has("--profile")) {
  const objects=db.prepare(`SELECT name,ROUND(SUM(pgsize)) bytes FROM dbstat GROUP BY name ORDER BY bytes DESC`)
    .all() as {name:string;bytes:number}[];
  const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as {name:string}[];
  const growthColumns:Record<string,string>={pool_snapshots:"timestamp",core_snapshots:"timestamp",
    fee_events:"timestamp",price_observations:"observed_at",signal_episodes:"episode_start",
    signal_outcomes:"completed_at",fee_windows:"window_end"};
  const rows=tables.map(({name})=>{
    const total=(db.prepare(`SELECT COUNT(*) n FROM "${name}"`).get() as {n:number}).n;
    const column=growthColumns[name];
    const lastDay=column?(db.prepare(`SELECT COUNT(*) n FROM "${name}" WHERE ${column}>=?`)
      .get(now-86400000) as {n:number}).n:null;
    const tableBytes=objects.find((o)=>o.name===name)?.bytes??0;
    return {table:name,rows:total,tableBytes,lastDay,
      estimatedBytesPerDay:lastDay===null||!total?null:Math.round(lastDay*tableBytes/total)};
  });
  console.log(JSON.stringify({databaseBytes:statSync(env.DATABASE_PATH).size,objects,rows},null,2));
  db.close();
  process.exit(0);
}
const version=db.prepare("SELECT valid_from validFrom FROM dataset_versions WHERE version='sprint7-v1'")
  .get() as {validFrom:number}|undefined;
if(!version) throw new Error("Sprint 7 dataset version missing");

// Every horizon must already contain this exact priced event. Any nearby signal keeps the raw event.
const events=db.prepare(`SELECT e.rowid id,LENGTH(e.tx_hash)+LENGTH(e.amount0)+LENGTH(e.amount1)+180 bytes
  FROM fee_events e JOIN fee_backfill_jobs j ON j.pool_id=e.pool_id AND j.status='COMPLETE'
  WHERE e.timestamp<? AND e.timestamp>=? AND e.volume_usd IS NOT NULL AND e.fees_usd IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM signal_episodes s WHERE s.pool_id=e.pool_id
      AND s.episode_start BETWEEN e.timestamp-86400000 AND e.timestamp+86400000)
    AND NOT EXISTS(SELECT 1 FROM signal_outcomes o JOIN signal_episodes s ON s.id=o.signal_id
      WHERE s.pool_id=e.pool_id AND o.status NOT IN ('COMPLETE','PARTIAL','PRICE_RANGE_COMPLETE','UNAVAILABLE'))
    AND NOT EXISTS(SELECT 1 FROM (SELECT '5m' name,300000 ms UNION ALL SELECT '30m',1800000
      UNION ALL SELECT '1h',3600000 UNION ALL SELECT '4h',14400000 UNION ALL SELECT '24h',86400000) w
      WHERE NOT EXISTS(SELECT 1 FROM fee_windows f WHERE f.pool_id=e.pool_id AND f.window_name=w.name
        AND f.window_end>=e.timestamp AND f.window_end-w.ms<=e.timestamp
        AND json_extract(f.data,'$.methodology')='EVENT_DERIVED'))
  LIMIT ?`).all(now-eventDays*86400000,version.validFrom,limit) as {id:number;bytes:number}[];

// Keep first sample in each bucket; protect watchlist periods and every signal's research window.
const snapshots=db.prepare(`SELECT p.rowid id,LENGTH(p.data)+64 bytes FROM pool_snapshots p
  WHERE p.timestamp>=? AND p.timestamp<?
    AND EXISTS(SELECT 1 FROM pool_snapshots earlier WHERE earlier.pool_id=p.pool_id
      AND earlier.timestamp<p.timestamp
    AND CAST(earlier.timestamp/(CASE WHEN p.timestamp<? THEN 1800000 ELSE 300000 END) AS INTEGER)
        =CAST(p.timestamp/(CASE WHEN p.timestamp<? THEN 1800000 ELSE 300000 END) AS INTEGER))
    AND NOT EXISTS(SELECT 1 FROM watchlist_history w WHERE w.pool_id=p.pool_id
      AND w.added_at<=p.timestamp AND (w.removed_at IS NULL OR w.removed_at>=p.timestamp))
    AND NOT EXISTS(SELECT 1 FROM signal_episodes s WHERE s.pool_id=p.pool_id
      AND s.episode_start BETWEEN p.timestamp-86400000 AND p.timestamp+86400000)
    AND NOT EXISTS(SELECT 1 FROM signal_outcomes o JOIN signal_episodes s ON s.id=o.signal_id
      WHERE s.pool_id=p.pool_id AND o.status NOT IN ('COMPLETE','PARTIAL','PRICE_RANGE_COMPLETE','UNAVAILABLE'))
  LIMIT ?`).all(version.validFrom,now-7*86400000,now-30*86400000,now-30*86400000,limit) as {id:number;bytes:number}[];

const size=statSync(env.DATABASE_PATH).size;
let archiveParent=resolve(env.ARCHIVE_PATH);
while(!existsSync(archiveParent) && dirname(archiveParent)!==archiveParent)archiveParent=dirname(archiveParent);
const sameFilesystem=statSync(archiveParent).dev===statSync(env.DATABASE_PATH).dev;
const report={archivePath:resolve(env.ARCHIVE_PATH),sameFilesystem,
  archiveWarning:sameFilesystem?'Archives share the active database filesystem; archival does not create disk runway.':null,
  mode:archiveApply||args.has("--apply-events")||args.has("--apply-snapshots")?"APPLY":"DRY_RUN",
  databaseBytes:size,events:{eligibleInBatch:events.length,estimatedBytes:events.reduce((n,e)=>n+e.bytes,0)},
  snapshots:{eligibleInBatch:snapshots.length,estimatedBytes:snapshots.reduce((n,e)=>n+e.bytes,0)},
  affectedSignals:0,affectedOutcomes:0,cappedAt:limit,
  notes:"Batch is capped at 500; estimates are not a full-table count. Deleted bytes remain allocated for SQLite reuse; pre-Sprint-7 history is protected."};
if(archiveApply) {
  const payload={format:"lp-scanner-archive-v1",createdAt:now,datasetVersion:"sprint7-v1",
    snapshots:snapshots.map(({id})=>({id,row:db.prepare("SELECT * FROM pool_snapshots WHERE rowid=?").get(id)})),
    events:events.map(({id})=>({id,row:db.prepare("SELECT * FROM fee_events WHERE rowid=?").get(id)}))};
  if(payload.snapshots.length||payload.events.length) {
    const plain=Buffer.from(JSON.stringify(payload));
    const compressed=gzipSync(plain,{level:9});
    const dir=resolve(env.ARCHIVE_PATH);mkdirSync(dir,{recursive:true});
    const archivePath=resolve(dir,`archive-${now}.json.gz`);
    const manifestPath=`${archivePath}.manifest.json`;
    writeFileSync(archivePath,compressed,{flag:"wx"});
    const saved=readFileSync(archivePath);
    const verified=verifyArchive(saved,plain,snapshots.map((r)=>r.id),events.map((r)=>r.id));
    const manifest={format:payload.format,createdAt:now,archivePath,
      ...verified};
    writeFileSync(manifestPath,JSON.stringify(manifest,null,2),{flag:"wx"});
    db.transaction(()=>{
      const delSnapshot=db.prepare("DELETE FROM pool_snapshots WHERE rowid=?");
      const delEvent=db.prepare("DELETE FROM fee_events WHERE rowid=?");
      for(const item of payload.snapshots) {
        if(JSON.stringify(db.prepare("SELECT * FROM pool_snapshots WHERE rowid=?").get(item.id))!==JSON.stringify(item.row))
          throw new Error("Snapshot changed during archival; no rows deleted");
        delSnapshot.run(item.id);
      }
      for(const item of payload.events) {
        if(JSON.stringify(db.prepare("SELECT * FROM fee_events WHERE rowid=?").get(item.id))!==JSON.stringify(item.row))
          throw new Error("Event changed during archival; no rows deleted");
        delEvent.run(item.id);
      }
    }).immediate();
    console.log(JSON.stringify({...report,archive:manifest,manifestPath},null,2));
    db.close();process.exit(0);
  }
}
if(!archive && (args.has("--apply-events")||args.has("--apply-snapshots"))) {
  db.transaction(()=>{
    if(args.has("--apply-events")) {
      const del=db.prepare("DELETE FROM fee_events WHERE rowid=?");
      for(const row of events) del.run(row.id);
    }
    if(args.has("--apply-snapshots")) {
      const del=db.prepare("DELETE FROM pool_snapshots WHERE rowid=?");
      for(const row of snapshots) del.run(row.id);
    }
  })();
}
console.log(JSON.stringify(report,null,2));
db.close();
