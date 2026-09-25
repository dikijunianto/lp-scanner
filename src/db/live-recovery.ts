import { statSync } from "node:fs";
import type Database from "better-sqlite3";
import type { FeeEventRow } from "./store";
import { cursorLag, depthFailureReason, freshness } from "../core/freshness";
import type { Snapshot } from "../core/model";

export interface LiveCursor {
  poolId:string;chain:string;blockNumber:number;blockHash:string;startBlock:number;
  startTime:number;endTime:number;headBlock:number;headTime:number;sourceType:string;sourceId:string;updatedAt:number;
}
export function createLiveRecoveryStore(sqlite: Database.Database, databasePath: string) {
  return {
    liveFeeCursor(poolId:string):LiveCursor|null {
      return (sqlite.prepare(`SELECT pool_id poolId,chain,block_number blockNumber,block_hash blockHash,
        start_block startBlock,start_time startTime,end_time endTime,head_block headBlock,
        head_time headTime,source_type sourceType,source_id sourceId,updated_at updatedAt
        FROM live_fee_cursors WHERE pool_id=?`).get(poolId) as LiveCursor|undefined) ?? null;
    },
    resetLiveFeeCursor(poolId:string) { sqlite.prepare("DELETE FROM live_fee_cursors WHERE pool_id=?").run(poolId); },
    saveLiveFeeBatch(poolId:string, chain:string, events:FeeEventRow[], from:number, firstTime:number,
      to:number, hash:string, endTime:number, headBlock:number, headTime:number, sourceType:string, sourceId:string) {
      sqlite.transaction(() => {
        const insert = sqlite.prepare(`INSERT OR IGNORE INTO fee_events
          (pool_id,block_number,block_hash,tx_hash,log_index,timestamp,volume_usd,fees_usd,confidence,
          chain,pool_address,amount0,amount1,price_usd0,price_usd1,gross_fee_usd,lp_fee_usd,fee_tier,protocol_fee_raw,price_confidence,sender)
          VALUES (@poolId,@blockNumber,@blockHash,@txHash,@logIndex,@timestamp,@volumeUsd,@feesUsd,@confidence,
          @chain,@poolAddress,@amount0,@amount1,@priceUsd0,@priceUsd1,@grossFeeUsd,@lpFeeUsd,@feeTier,@protocolFeeRaw,@priceConfidence,@sender)`);
        for (const event of events) insert.run({poolAddress:null,amount0:null,amount1:null,
          priceUsd0:null,priceUsd1:null,grossFeeUsd:null,lpFeeUsd:null,feeTier:null,
          protocolFeeRaw:null,priceConfidence:null,sender:null,...event});
        sqlite.prepare(`INSERT INTO live_fee_cursors VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(pool_id) DO UPDATE SET block_number=excluded.block_number,
          block_hash=excluded.block_hash,end_time=excluded.end_time,head_block=excluded.head_block,
          head_time=excluded.head_time,source_type=excluded.source_type,source_id=excluded.source_id,
          updated_at=excluded.updated_at`).run(poolId,chain,to,hash,from,firstTime,endTime,
            headBlock,headTime,sourceType,sourceId,Date.now());
      })();
      if (events.length) {
        const start = Math.floor(Math.min(...events.map((e)=>e.timestamp))/60000)*60000;
        const end = Math.floor(Math.max(...events.map((e)=>e.timestamp))/60000)*60000;
        sqlite.transaction(() => {
          sqlite.prepare("DELETE FROM fee_minute_buckets WHERE pool_id=? AND bucket_start BETWEEN ? AND ?")
            .run(poolId,start,end);
          sqlite.prepare(`INSERT INTO fee_minute_buckets
            SELECT pool_id,CAST(timestamp/60000 AS INTEGER)*60000,
            SUM(COALESCE(volume_usd,0)),SUM(COALESCE(gross_fee_usd,0)),SUM(COALESCE(lp_fee_usd,fees_usd,0)),
            COUNT(*),SUM(volume_usd IS NULL OR COALESCE(lp_fee_usd,fees_usd) IS NULL),SUM(gross_fee_usd IS NULL)
            FROM fee_events WHERE pool_id=? AND timestamp>=? AND timestamp<?
            GROUP BY pool_id,CAST(timestamp/60000 AS INTEGER)`).run(poolId,start,end+60000);
        })();
      }
    },
    liveCursorHealth(now=Date.now()) {
      const rows = sqlite.prepare(`SELECT l.pool_id poolId,l.chain,l.block_number blockNumber,
        l.end_time endTime,l.head_block headBlock,l.head_time headTime,l.source_type sourceType,
        l.source_id sourceId,l.updated_at updatedAt FROM live_fee_cursors l ORDER BY l.chain,l.pool_id`)
        .all() as (Pick<LiveCursor,"poolId"|"chain"|"blockNumber"|"endTime"|"headBlock"|"headTime"|"sourceType"|"sourceId"|"updatedAt">)[];
      return rows.map((r)=>({...r,...cursorLag(r.headBlock,r.headTime,r.blockNumber,r.endTime,now)}));
    },
    poolFreshness(poolId:string,now=Date.now()) {
      const row=sqlite.prepare("SELECT data FROM pools WHERE id=?").get(poolId) as {data:string}|undefined;
      if(!row) return null;
      const p=(JSON.parse(row.data) as Snapshot).pool;
      const priceTimes=[p.token0.usdPriceSourceTimestamp,p.token1.usdPriceSourceTimestamp];
      const priceFreshness=priceTimes.every((t)=>freshness(t,now,300000)==="FRESH")?"FRESH":
        priceTimes.some((t)=>freshness(t,now,300000)==="UNAVAILABLE")?"UNAVAILABLE":
          priceTimes.some((t)=>freshness(t,now,300000)==="STALE")?"STALE":"DELAYED";
      const fee=sqlite.prepare("SELECT data FROM fee_windows WHERE pool_id=? AND window_name='1h' ORDER BY window_end DESC LIMIT 1")
        .get(poolId) as {data:string}|undefined;
      const feeWindow=fee?JSON.parse(fee.data) as {methodology:string;windowEnd:number}:null;
      const signal=sqlite.prepare("SELECT MAX(episode_last_seen) at FROM signal_episodes WHERE pool_id=?")
        .get(poolId) as {at:number|null};
      const outcome=sqlite.prepare(`SELECT MAX(o.completed_at) at FROM signal_outcomes o
        JOIN signal_episodes s ON s.id=o.signal_id WHERE s.pool_id=? AND o.status IN ('COMPLETE','PARTIAL')`)
        .get(poolId) as {at:number|null};
      return {poolId,priceFreshness,
        feeFreshness:feeWindow?.methodology==="EVENT_DERIVED"?freshness(feeWindow.windowEnd,now,180000,600000):"UNAVAILABLE",
        depthFreshness:p.depth5PctUsd==null?"UNAVAILABLE":freshness(p.depthUpdatedAt,now,
          Math.max(0,(p.depthExpiresAt??0)-(p.depthUpdatedAt??0)),
          Math.max(0,(p.depthExpiresAt??0)-(p.depthUpdatedAt??0))*2),
        signalFreshness:freshness(signal.at,now,300000,900000),
        outcomeFreshness:freshness(outcome.at,now,3600000,14400000)};
    },
    recordDepthFailure(poolId:string,message:string) {
      const reason=depthFailureReason(message);
      sqlite.prepare(`INSERT INTO depth_failures VALUES (?,?,1,?) ON CONFLICT(pool_id,reason)
        DO UPDATE SET count=count+1,last_at=excluded.last_at`).run(poolId,reason,Date.now());
    },
    depthFailureCounts(chain?:string) {
      return sqlite.prepare(`SELECT d.reason,SUM(d.count) n,COUNT(DISTINCT d.pool_id) pools
        FROM depth_failures d JOIN pools p ON p.id=d.pool_id
        WHERE (? IS NULL OR p.chain=?) GROUP BY d.reason ORDER BY n DESC`).all(chain??null,chain??null);
    },
    outcomePipeline(now=Date.now()) {
      const rows=sqlite.prepare(`SELECT horizon,
        SUM(due_at<=?) eligible,SUM(status='COMPLETE') complete,
        SUM(status IN ('PENDING','READY','RUNNING') AND due_at<=?) overdue,
        MIN(CASE WHEN status IN ('PENDING','READY','RUNNING') AND due_at<=? THEN due_at END) oldest_ready,
        SUM(status='PARTIAL') partial,SUM(status='UNAVAILABLE') unavailable
        FROM signal_outcomes GROUP BY horizon`).all(now,now,now) as {horizon:string;eligible:number;
          complete:number;overdue:number;oldest_ready:number|null;partial:number;unavailable:number}[];
      return rows.map((r)=>({ ...r, oldestReadyAgeMs:r.oldest_ready==null ? null : now-Number(r.oldest_ready),
        completionRate:Number(r.eligible) ? Number(r.complete)/Number(r.eligible) : null }));
    },
    outcomeMissingness(now=Date.now()) {
      return sqlite.prepare(`SELECT horizon,
        CASE WHEN status IN ('PENDING','READY','RUNNING') AND due_at>? THEN 'SIGNAL_TOO_RECENT'
          WHEN status IN ('PENDING','READY','RUNNING') THEN 'WORKER_BACKLOG'
          WHEN status='UNAVAILABLE' THEN COALESCE(json_extract(missing_reasons,'$[0]'),'OTHER')
          WHEN status='PARTIAL' THEN COALESCE(json_extract(missing_reasons,'$[0]'),'OTHER')
          WHEN status='FAILED' THEN 'INFRA_FAILURE'
          ELSE 'COMPLETE' END reason,COUNT(*) n
        FROM signal_outcomes GROUP BY horizon,reason ORDER BY horizon,n DESC`).all(now);
    },
    outcomeCompletionLag() {
      const rows=sqlite.prepare(`SELECT horizon,completed_at-due_at lag FROM signal_outcomes
        WHERE completed_at IS NOT NULL ORDER BY horizon,lag`).all() as {horizon:string;lag:number}[];
      const groups=new Map<string,number[]>();
      for(const r of rows) {const a=groups.get(r.horizon)??[];a.push(r.lag);groups.set(r.horizon,a);}
      return [...groups].map(([horizon,a])=>({horizon,n:a.length,medianMs:a[Math.floor((a.length-1)*0.5)],p95Ms:a[Math.floor((a.length-1)*0.95)]}));
    },
    outcomeThroughput(now=Date.now()) {
      return (sqlite.prepare("SELECT COUNT(*) n FROM signal_outcomes WHERE completed_at>=?")
        .get(now-60000) as {n:number}).n;
    },
    databaseGrowth(now=Date.now()) {
      const tables=[
        ["swaps","fee_events","timestamp"],["snapshots","pool_snapshots","timestamp"],
        ["prices","price_observations","observed_at"],["signals","signal_episodes","episode_start"],
        ["outcomes","signal_outcomes","completed_at"],
      ] as const;
      const rows=tables.map(([name,table,col])=>{
        const count=(where:string,args:number[]=[])=>(sqlite.prepare(`SELECT COUNT(*) n FROM ${table} ${where}`).get(...args) as {n:number}).n;
        const counts={total:count(""),day:count(`WHERE ${col}>=?`,[now-86400000]),
          week:count(`WHERE ${col}>=?`,[now-604800000])};
        const sample=sqlite.prepare(`SELECT AVG(LENGTH(${table==='signal_outcomes'?'data':table==='signal_episodes'?'data':table==='fee_events'?'tx_hash':table==='price_observations'?'source':'data'})) bytes
          FROM (SELECT * FROM ${table} ORDER BY rowid DESC LIMIT 100)`).get() as {bytes:number|null};
        const bytesPerRow=Math.max(64,(sample.bytes??0)+96);
        return {name,total:counts.total,lastDay:counts.day,lastWeek:counts.week,
          estimatedBytesPerDay:Math.round(counts.day*bytesPerRow),estimatedBytesPerWeek:Math.round(counts.day*bytesPerRow*7),
          estimatedBytesPerMonth:Math.round(counts.day*bytesPerRow*30)};
      });
      const pages=sqlite.pragma("page_count",{simple:true}) as number;
      const size=sqlite.pragma("page_size",{simple:true}) as number;
      return {databaseBytes:databasePath===':memory:'?pages*size:statSync(databasePath).size,
        walBytes:databasePath===':memory:'?0:(()=>{try{return statSync(`${databasePath}-wal`).size}catch{return 0}})(),rows};
    },
  };
}
