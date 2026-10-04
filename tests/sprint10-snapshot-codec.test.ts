import {describe,expect,it} from "vitest";
import {deflateRawSync} from "node:zlib";
import Database from "better-sqlite3";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {encodeSnapshot,decodeSnapshot} from "../src/core/snapshot-codec";
import {emptyPool,emptyToken,type Snapshot} from "../src/core/model";
import {snapshot} from "../src/core/analytics";
import {createStore} from "../src/db/store";

const fixture=(at:number)=>{
  const pool=emptyPool({chain:"base",protocol:"uniswap-v3",dex:"Uniswap V3",poolAddress:`0x${"a".repeat(40)}`,
    token0:emptyToken(`0x${"1".repeat(40)}`,"A"),token1:emptyToken(`0x${"2".repeat(40)}`,"B"),source:"test"},at);
  pool.feeTier=3000;pool.price=2;pool.activeLiquidityDetails={method:"V3_VIRTUAL_RESERVES_V1",block:"99",blockTime:at,
    rpcSource:"test",token0Address:pool.token0Address,token1Address:pool.token1Address,decimals0:6,decimals1:18,
    amount0:"1",amount1:"2",price0Usd:1,price1Usd:2,priceSource:"test",priceObservedAt:at,pairPrice:"2"};
  return snapshot(pool,[]);
};
describe("lossless future snapshot encoding",()=>{
  it("round-trips every snapshot field and preserves legacy identity",()=>{
    const plain=fixture(100000),encoded=encodeSnapshot(plain);
    expect(JSON.stringify(encoded).length).toBeLessThan(JSON.stringify(plain).length);
    expect(decodeSnapshot(encoded)).toEqual(plain);expect(decodeSnapshot(plain)).toBe(plain);
    expect(JSON.stringify(encoded)).toContain('"feeTier":3000');
    expect(JSON.stringify(encoded)).toContain('"method":"V3_VIRTUAL_RESERVES_V1"');
  });
  it("rejects malformed/versioned/bomb payloads instead of fabricating snapshots",()=>{
    const envelope=(codec:string,payload:unknown)=>({codec,payload}) as unknown as Snapshot;
    for(const value of [envelope("future-codec","x"),envelope("snapshot-deflate-v1",7),
      envelope("snapshot-deflate-v1","invalid!"),envelope("snapshot-deflate-v1","AAAA"),
      envelope("snapshot-deflate-v1",deflateRawSync("{}").toString("base64")),
      envelope("snapshot-deflate-v1",deflateRawSync("x".repeat(2**20+1)).toString("base64"))])
      expect(()=>decodeSnapshot(value)).toThrow();
  });
  it("keeps oversized legitimate snapshots plain so the bounded decoder can read every future write",()=>{
    const value=fixture(100000);value.pool.warnings=["x".repeat(2**20)];
    expect(encodeSnapshot(value)).toBe(value);expect(decodeSnapshot(encodeSnapshot(value))).toEqual(value);
  });
  it("reads mixed legacy/new history, outcomes, analytics and SQL fee metadata without rewriting legacy rows",()=>{
    const directory=mkdtempSync(join(tmpdir(),"lp-codec-")),path=join(directory,"scanner.sqlite");
    const store=createStore(path),db=new Database(path);
    try {
      const start=Date.now()-600000,legacy=fixture(start),modern=fixture(start+300000);
      store.save([legacy]);
      const legacyText=JSON.stringify(legacy);
      db.prepare("UPDATE pool_snapshots SET data=? WHERE pool_id=? AND timestamp=?")
        .run(legacyText,legacy.pool.id,start);
      store.save([modern]);
      expect(store.history(legacy.pool.id,start)).toEqual([legacy,modern]);
      expect(store.outcomeHistory(legacy.pool.id,start-1,start+300000)).toEqual([legacy,modern]);
      expect(store.analyticsHistory(legacy.pool.id,start+600000)).toContainEqual(modern);
      expect(store.latestFeeMetadata(legacy.pool.id)).toEqual(modern.pool);
      expect(db.prepare("SELECT data FROM pool_snapshots WHERE timestamp=?").get(start)).toEqual({data:legacyText});
      expect(db.prepare("SELECT json_extract(data,'$.pool.feeTier') tier FROM pool_snapshots WHERE timestamp=?")
        .get(start+300000)).toEqual({tier:3000});
    } finally {db.close();store.close();rmSync(directory,{recursive:true,force:true});}
  });
});
