import {describe,expect,it} from "vitest";
import {gzipSync,gunzipSync} from "node:zlib";
import Database from "better-sqlite3";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createStore,type FeeEventRow} from "../src/db/store";
import {feeEventAuditRow} from "../src/db/fee-invariants";
import {emptyPool,emptyToken} from "../src/core/model";
import {snapshot} from "../src/core/analytics";
import {verifyArchive} from "../src/core/archive";

describe("future fee invariant normalization",()=>{
  it("shares immutable numeric references, reads legacy/new metadata and archives complete audit values",()=>{
    const directory=mkdtempSync(join(tmpdir(),"lp-fee-invariant-")),path=join(directory,"scanner.sqlite");
    const store=createStore(path),db=new Database(path);
    try {
      const pool=emptyPool({chain:"base",protocol:"uniswap-v3",dex:"Uniswap V3",poolAddress:`0x${"a".repeat(40)}`,
        token0:emptyToken("a","A"),token1:emptyToken("b","B"),source:"test"},100000);
      store.save([snapshot(pool,[])]);
      const event:FeeEventRow={poolId:pool.id,chain:"base",poolAddress:pool.poolAddress,
        blockNumber:1,blockHash:"hash",txHash:"one",logIndex:0,timestamp:100000,
        volumeUsd:2,feesUsd:.006,confidence:"HIGH",amount0:"-2000000",amount1:"1",feeTier:3000,
        eventSourceType:"RPC_GET_LOGS",eventSourceId:"source-one"};
      db.prepare(`INSERT INTO fee_events (pool_id,chain,pool_address,block_number,block_hash,tx_hash,log_index,
        timestamp,volume_usd,fees_usd,confidence,event_source_type,event_source_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(pool.id,"base",pool.poolAddress,0,"legacy-hash","legacy",0,
          99000,1,.003,"HIGH","RPC_GET_LOGS","legacy-source");
      const legacyBefore=db.prepare("SELECT * FROM fee_events WHERE tx_hash='legacy'").get();
      store.saveFeeBatch(pool.id,[event,{...event,txHash:"two"}],1,100000,1,"hash",100000);
      store.saveFeeBatch(pool.id,[event],1,100000,1,"hash",100000);
      expect(db.prepare("SELECT COUNT(*) n FROM fee_event_invariants").get()).toEqual({n:1});
      expect(db.prepare("SELECT COUNT(*) n FROM fee_events").get()).toEqual({n:3});
      expect(db.prepare("SELECT pool_address,event_source_id,invariant_id FROM fee_events WHERE tx_hash='one'").get())
        .toMatchObject({pool_address:null,event_source_id:null,invariant_id:1});
      expect(store.feeEvents(pool.id,0,100001)).toEqual(expect.arrayContaining([
        expect.objectContaining({txHash:"one",poolAddress:pool.poolAddress,eventSourceId:"source-one"}),
        expect.objectContaining({txHash:"legacy",poolAddress:pool.poolAddress,eventSourceId:"legacy-source"})]));
      expect(store.feeEventAudit(pool.id,"one",0)).toMatchObject({pool_address:pool.poolAddress,
        event_source_type:"RPC_GET_LOGS",event_source_id:"source-one",amount0:"-2000000",fee_tier:3000});
      // Another source gets an immutable new reference; prior audit identity never follows mutable current metadata.
      store.saveLiveFeeBatch(pool.id,"base",[{...event,txHash:"three",eventSourceId:"source-two"}],2,
        100001,2,"hash2",100002,2,100002,"RPC_GET_LOGS","source-two");
      expect(store.feeEventAudit(pool.id,"one",0)?.event_source_id).toBe("source-one");
      expect(store.feeEventAudit(pool.id,"three",0)?.event_source_id).toBe("source-two");
      expect(db.prepare("SELECT * FROM fee_events WHERE tx_hash='legacy'").get()).toEqual(legacyBefore);
      const id=(db.prepare("SELECT rowid id FROM fee_events WHERE tx_hash='one'").get() as {id:number}).id;
      const plain=Buffer.from(JSON.stringify({format:"lp-scanner-archive-v1",snapshots:[],
        events:[{id,row:feeEventAuditRow(db,id)}]})),archive=gzipSync(plain);
      expect(verifyArchive(archive,plain,[],[id]).eventRows).toBe(1);
      expect(JSON.parse(gunzipSync(archive).toString()).events[0].row.event_source_id).toBe("source-one");
      expect(db.pragma("integrity_check",{simple:true})).toBe("ok");
    } finally {db.close();store.close();rmSync(directory,{recursive:true,force:true});}
  });
});
