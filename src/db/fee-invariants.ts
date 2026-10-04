import type Database from "better-sqlite3";
import type {FeeEventRow} from "./store";

// Pool address and ingestion source are immutable per referenced tuple, not mutable current metadata.
export function createFeeEventWriter(sqlite:Database.Database) {
  const invariant=sqlite.prepare(`INSERT OR IGNORE INTO fee_event_invariants
    (invariant_key,pool_address,source_type,source_id) VALUES (?,?,?,?)`);
  const find=sqlite.prepare("SELECT id FROM fee_event_invariants WHERE invariant_key=?");
  const insert=sqlite.prepare(`INSERT OR IGNORE INTO fee_events
    (pool_id,block_number,block_hash,tx_hash,log_index,timestamp,volume_usd,fees_usd,confidence,
     chain,pool_address,amount0,amount1,price_usd0,price_usd1,gross_fee_usd,lp_fee_usd,fee_tier,
     protocol_fee_raw,price_confidence,sender,event_source_type,event_source_id,invariant_id)
    VALUES (@poolId,@blockNumber,@blockHash,@txHash,@logIndex,@timestamp,@volumeUsd,@feesUsd,@confidence,
     @chain,NULL,@amount0,@amount1,@priceUsd0,@priceUsd1,@grossFeeUsd,@lpFeeUsd,@feeTier,
     @protocolFeeRaw,@priceConfidence,@sender,NULL,NULL,@invariantId)`);
  return (event:FeeEventRow)=>{
    const address=event.poolAddress??null,type=event.eventSourceType??null,source=event.eventSourceId??null;
    let invariantId:number|null=null;
    if(address!==null || type!==null || source!==null) {
      const key=JSON.stringify([event.poolId,address,type,source]);
      invariant.run(key,address,type,source);
      invariantId=(find.get(key) as {id:number}).id;
    }
    return insert.run({chain:null,amount0:null,amount1:null,priceUsd0:null,priceUsd1:null,grossFeeUsd:null,
      lpFeeUsd:null,feeTier:null,protocolFeeRaw:null,priceConfidence:null,sender:null,...event,invariantId});
  };
}

// Standalone archives must contain resolved values rather than dangling numeric references.
export function feeEventAuditRow(sqlite:Database.Database,rowid:number):Record<string,unknown>|undefined {
  const row=sqlite.prepare("SELECT * FROM fee_events WHERE rowid=?").get(rowid) as Record<string,unknown>|undefined;
  if(!row || row.invariant_id==null)return row;
  const invariant=sqlite.prepare("SELECT pool_address,source_type,source_id FROM fee_event_invariants WHERE id=?")
    .get(row.invariant_id) as {pool_address:string|null;source_type:string|null;source_id:string|null}|undefined;
  if(!invariant)throw new Error("Fee event invariant missing");
  return {...row,pool_address:row.pool_address??invariant.pool_address,
    event_source_type:row.event_source_type??invariant.source_type,event_source_id:row.event_source_id??invariant.source_id};
}
