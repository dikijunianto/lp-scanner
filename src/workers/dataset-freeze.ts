import "dotenv/config";
import { createHash } from "node:crypto";
import { createReadStream,createWriteStream,existsSync,mkdirSync,statfsSync,statSync,unlinkSync,writeFileSync } from "node:fs";
import { dirname,resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Writable } from "node:stream";
import { createGzip,createGunzip } from "node:zlib";
import Database from "better-sqlite3";
import { env } from "../config/env";

const source=resolve(env.DATABASE_PATH),size=statSync(source).size;
const gateDb=new Database(source,{readonly:true,fileMustExist:true});
try {
  const version=gateDb.prepare("SELECT version FROM dataset_versions ORDER BY valid_from DESC LIMIT 1").get() as {version:string}|undefined;
  if(version?.version==='sprint9-v3') {
    const row=gateDb.prepare("SELECT data FROM diagnostic_summaries WHERE id='current'").get() as {data:string}|undefined;
    const summary=row?JSON.parse(row.data):null;
    if(summary?.readiness?.status!=='READY' || Date.now()-summary.generatedAt>env.DIAGNOSTICS_MAX_AGE_SECONDS*1000)
      throw new Error('Sprint9 dataset freeze requires fresh READY evidence for the complete 24-hour window');
  }
}finally{gateDb.close();}
const disk=statfsSync(dirname(source));
if(disk.bavail*disk.bsize<size+5*2**30)
  throw new Error("Insufficient free disk for a consistent dataset backup");
const dir=resolve(env.ARCHIVE_PATH,"datasets");mkdirSync(dir,{recursive:true});
const base=resolve(dir,`dataset-${new Date().toISOString().replace(/[:.]/g,"-")}`);
const temporary=`${base}.sqlite`,archive=`${base}.sqlite.gz`,manifestPath=`${base}.manifest.json`;
const db=new Database(source,{readonly:true,fileMustExist:true});
try {await db.backup(temporary);}
catch(error) {if(existsSync(temporary)) unlinkSync(temporary);throw error;}
finally {db.close();}
try {
  const frozen=new Database(temporary,{readonly:true,fileMustExist:true});
  let manifest:Record<string,unknown>;
  try {
    const version=frozen.prepare("SELECT * FROM dataset_versions ORDER BY valid_from DESC LIMIT 1").get();
    const count=(table:string)=>(frozen.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as {n:number}).n;
    manifest={format:"lp-scanner-dataset-v1",createdAt:Date.now(),version,
      chainSet:(frozen.prepare("SELECT DISTINCT chain FROM pools ORDER BY chain")
        .all() as {chain:string}[]).map((r)=>r.chain),
      coverageStats:{pools:count("pools"),signals:count("signal_episodes"),
        outcomes:count("signal_outcomes"),coreSnapshots:count("core_snapshots")},
      sourceBytes:statSync(temporary).size};
  } finally {frozen.close();}
  await pipeline(createReadStream(temporary),createGzip({level:1}),
    createWriteStream(archive,{flags:"wx"}));
  let verifiedBytes=0;
  await pipeline(createReadStream(archive),createGunzip(),new Writable({
    write(chunk:Buffer,_encoding,done) {verifiedBytes+=chunk.length;done();},
  }));
  if(verifiedBytes!==manifest.sourceBytes) throw new Error("Frozen archive failed decompression verification");
  const hash=createHash("sha256");
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  manifest={...manifest,archive,archiveBytes:statSync(archive).size,sha256:hash.digest("hex"),
    verifiedUncompressedBytes:verifiedBytes};
  writeFileSync(manifestPath,JSON.stringify(manifest,null,2),{flag:"wx"});
  console.log(JSON.stringify({archive,manifestPath,version:manifest.version,
    archiveBytes:manifest.archiveBytes,sha256:manifest.sha256}));
} finally {unlinkSync(temporary);}
