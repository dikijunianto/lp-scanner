import { expireLiquidity } from "../core/analytics";
import { liquidityDefaults } from "../core/liquidity";
import { emptyToken } from "../core/model";
import Database from "better-sqlite3";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { and, asc, desc, eq, gte, lt, lte, or } from "drizzle-orm";
import * as schema from "./schema";
import { env } from "../config/env";
import { createResearchStore } from "./research";
import { createReliabilityStore } from "./reliability";
import { createLiveRecoveryStore } from "./live-recovery";
import { createContinuityStore } from "./continuity";
import type { Snapshot, Candle, PriceRecord, FeeWindow, Window, Confidence } from "../core/model";
export interface FeeEventRow {
  poolId: string;
  blockNumber: number;
  blockHash: string;
  txHash: string;
  logIndex: number;
  timestamp: number;
  volumeUsd: number | null;
  feesUsd: number | null;
  confidence: Confidence;
  chain?: string | null;
  poolAddress?: string | null;
  amount0?: string | null;
  amount1?: string | null;
  priceUsd0?: number | null;
  priceUsd1?: number | null;
  grossFeeUsd?: number | null;
  lpFeeUsd?: number | null;
  feeTier?: number | null;
  protocolFeeRaw?: string | null;
  priceConfidence?: Confidence | null;
  sender?: string | null;
  eventSourceType?: string | null;
  eventSourceId?: string | null;
}
export interface DepthRow {
  depth1PctUsd: number | null;
  depth2_5PctUsd: number | null;
  depth5PctUsd: number | null;
  depth10PctUsd: number | null;
  confidence: Confidence;
  source: string;
  updatedAt: number;
  blockId: string;
  stateKey: string;
  priceAtCalculation?: number | null;
  methodologyVersion?: string;
}
export function hydrateSnapshot(data: Snapshot): Snapshot {
  return {
    ...data,
    pool: {
      ...liquidityDefaults,
      ...data.pool,
      token0: {
        ...emptyToken(data.pool.token0Address, data.pool.token0.symbol),
        ...data.pool.token0,
      },
      token1: {
        ...emptyToken(data.pool.token1Address, data.pool.token1.symbol),
        ...data.pool.token1,
      },
    },
  };
}
// Expire only the current read view. Persisted history and its historical ratios remain unchanged.
export function currentSnapshot(data: Snapshot, now = Date.now()): Snapshot {
  const s = hydrateSnapshot(data);
  return expireLiquidity(s, now);
}

export function createStore(path = env.DATABASE_PATH) {
  if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
  );
  const migrationDir = resolve(process.cwd(), "migrations");
  for (const name of readdirSync(migrationDir)
    .filter((n) => n.endsWith(".sql"))
    .sort()) {
    if (sqlite.prepare("SELECT name FROM schema_migrations WHERE name=?").get(name)) continue;
    sqlite.transaction(() => {
      sqlite.exec(readFileSync(resolve(migrationDir, name), "utf8"));
      sqlite.prepare("INSERT INTO schema_migrations VALUES (?,?)").run(name, Date.now());
    })();
  }
  const db = drizzle(sqlite, { schema });
  const research = createResearchStore(sqlite);
  const reliability = createReliabilityStore(sqlite);
  const liveRecovery = createLiveRecoveryStore(sqlite,path);
  const continuity = createContinuityStore(sqlite,path);
  return {
    ...research,
    ...reliability,
    ...liveRecovery,
    ...continuity,
    db,
    close: () => sqlite.close(),
    savePrices(records: PriceRecord[]) {
      const insert = sqlite.prepare(`INSERT INTO price_observations
        (chain, asset_address, symbol, price_usd, source, source_timestamp, observed_at, block_number, confidence,resolution,algorithm_version,provenance_json)
        VALUES (@chain, @assetAddress, @symbol, @priceUsd, @source, @sourceTimestamp, @observedAt, @blockNumber, @confidence,@resolution,@algorithmVersion,@provenanceJson)`);
      const duplicate=sqlite.prepare(`SELECT 1 FROM price_observations WHERE chain=? AND asset_address=?
        AND source_timestamp=? AND source=? AND price_usd=? LIMIT 1`);
      sqlite.transaction(() => {
        for (const record of records) {
          if(record.sourceTimestamp===null || duplicate.get(record.chain,record.assetAddress,
            record.sourceTimestamp,record.source,record.priceUsd)) continue;
          insert.run({ resolution: record.resolution ?? "REALTIME",
            algorithmVersion: record.algorithmVersion ?? "sprint4-v1", provenanceJson:record.provenance?JSON.stringify(record.provenance):null, ...record });
        }
      })();
    },
    priceAt(chain: string, address: string, at: number, maxAgeMs: number): PriceRecord | null {
      const row = sqlite
        .prepare(
          `SELECT * FROM price_observations WHERE chain=? AND asset_address=?
        AND source_timestamp BETWEEN ? AND ? AND confidence IN ('HIGH','MEDIUM')
        ORDER BY ABS(source_timestamp - ?) LIMIT 1`,
        )
        .get(chain, address, at - maxAgeMs, at, at) as Record<string, unknown> | undefined;
      return row
        ? {
            chain: String(row.chain),
            assetAddress: String(row.asset_address),
            symbol: String(row.symbol),
            priceUsd: Number(row.price_usd),
            source: String(row.source),
            sourceTimestamp: Number(row.source_timestamp),
            observedAt: Number(row.observed_at),
            blockNumber: row.block_number == null ? null : String(row.block_number),
            confidence: row.confidence as Confidence,
            resolution: (row.resolution ?? "REALTIME") as PriceRecord["resolution"],
            algorithmVersion: row.algorithm_version == null ? undefined : String(row.algorithm_version),
            provenance: row.provenance_json?JSON.parse(String(row.provenance_json)):undefined,
          }
        : null;
    },
    feeCursor(
      poolId: string,
    ): {
      blockNumber: number;
      blockHash: string;
      startBlock: number;
      startTime: number;
      endTime: number;
    } | null {
      return (
        (sqlite
          .prepare(
            `SELECT block_number AS blockNumber, block_hash AS blockHash,
        start_block AS startBlock, start_time AS startTime, end_time AS endTime
        FROM fee_cursors WHERE pool_id=?`,
          )
          .get(poolId) as
          | {
              blockNumber: number;
              blockHash: string;
              startBlock: number;
              startTime: number;
              endTime: number;
            }
          | undefined) ?? null
      );
    },
    rollbackFees(poolId: string, fromBlock: number) {
      sqlite.transaction(() => {
        sqlite
          .prepare("DELETE FROM fee_events WHERE pool_id=? AND block_number>=?")
          .run(poolId, fromBlock);
        sqlite.prepare("DELETE FROM fee_windows WHERE pool_id=?").run(poolId);
        sqlite.prepare("DELETE FROM live_fee_cursors WHERE pool_id=?").run(poolId);
        sqlite.prepare("DELETE FROM fee_cursors WHERE pool_id=?").run(poolId);
      })();
    },
    rewindFeeCursor(
      poolId: string,
      blockNumber: number,
      blockHash: string,
      startBlock: number,
      startTime: number,
    ) {
      sqlite
        .prepare(
          `UPDATE fee_cursors SET block_number=?, block_hash=?, start_block=?,
        start_time=?, end_time=?, updated_at=? WHERE pool_id=?`,
        )
        .run(blockNumber, blockHash, startBlock, startTime, startTime, Date.now(), poolId);
    },
    saveFeeBatch(
      poolId: string,
      events: FeeEventRow[],
      startBlock: number,
      startTime: number,
      blockNumber: number,
      blockHash: string,
      endTime: number,
    ) {
      sqlite.transaction(() => {
        const insert = sqlite.prepare(`INSERT OR IGNORE INTO fee_events
          (pool_id,block_number,block_hash,tx_hash,log_index,timestamp,volume_usd,fees_usd,confidence,
          chain,pool_address,amount0,amount1,price_usd0,price_usd1,gross_fee_usd,lp_fee_usd,fee_tier,protocol_fee_raw,price_confidence,sender,event_source_type,event_source_id)
          VALUES (@poolId,@blockNumber,@blockHash,@txHash,@logIndex,@timestamp,@volumeUsd,@feesUsd,@confidence,
          @chain,@poolAddress,@amount0,@amount1,@priceUsd0,@priceUsd1,@grossFeeUsd,@lpFeeUsd,@feeTier,@protocolFeeRaw,@priceConfidence,@sender,@eventSourceType,@eventSourceId)`);
        for (const event of events) insert.run({ chain: null, poolAddress: null, amount0: null, amount1: null,
          priceUsd0: null, priceUsd1: null, grossFeeUsd: null, lpFeeUsd: null, feeTier: null,
          protocolFeeRaw: null, priceConfidence: null, sender: null,eventSourceType:null,eventSourceId:null,...event });
        sqlite
          .prepare(
            `INSERT INTO fee_cursors VALUES (?,?,?,?,?,?,?) ON CONFLICT(pool_id)
          DO UPDATE SET block_number=excluded.block_number, block_hash=excluded.block_hash,
          start_block=MIN(fee_cursors.start_block,excluded.start_block),
          start_time=MIN(fee_cursors.start_time,excluded.start_time),
          end_time=excluded.end_time, updated_at=excluded.updated_at`,
          )
          .run(poolId, blockNumber, blockHash, startBlock, startTime, endTime, Date.now());
      })();
      if (events.length) research.rebuildFeeBucketsRange(poolId,
        Math.min(...events.map((e) => e.timestamp)),Math.max(...events.map((e) => e.timestamp)));
    },
    feeEvents(poolId: string, from: number, to: number): FeeEventRow[] {
      const rows = sqlite
        .prepare(
          `SELECT pool_id AS poolId, block_number AS blockNumber,
        block_hash AS blockHash, tx_hash AS txHash, log_index AS logIndex, timestamp,
        volume_usd AS volumeUsd, fees_usd AS feesUsd, confidence FROM fee_events
        WHERE pool_id=? AND timestamp>=? AND timestamp<=? ORDER BY block_number,log_index`,
        )
        .all(poolId, from, to);
      return rows as FeeEventRow[];
    },
    saveFeeWindow(poolId: string, window: Window, data: FeeWindow) {
      sqlite
        .prepare(`INSERT INTO fee_windows VALUES (?,?,?,?) ON CONFLICT(pool_id,window_name,window_end)
          DO UPDATE SET data=excluded.data WHERE json_extract(fee_windows.data,'$.methodology')!='EVENT_DERIVED'
            OR json_extract(excluded.data,'$.methodology')='EVENT_DERIVED'`)
        .run(poolId, window, data.windowEnd, JSON.stringify(data));
    },
    latestDepth(poolId: string): DepthRow | null {
      const row = sqlite
        .prepare(
          "SELECT data FROM depth_observations WHERE pool_id=? ORDER BY timestamp DESC LIMIT 1",
        )
        .get(poolId) as { data: string } | undefined;
      return row ? (JSON.parse(row.data) as DepthRow) : null;
    },
    saveDepth(poolId: string, data: DepthRow) {
      sqlite
        .prepare("INSERT OR REPLACE INTO depth_observations VALUES (?,?,?,?)")
        .run(poolId, data.blockId, data.updatedAt, JSON.stringify(data));
    },
    save(items: Snapshot[],tieredHistory=false) {
      const preserveDisk=continuity.diskState()==="EMERGENCY";
      const watched=tieredHistory?research.watchedIds():new Set<string>();
      const active=tieredHistory?research.activeSignalIds():new Set<string>();
      const latest=sqlite.prepare("SELECT timestamp FROM pool_snapshots WHERE pool_id=? ORDER BY timestamp DESC LIMIT 1");
      db.transaction((tx) => {
        for (const data of items) {
          const p = data.pool;
          const row = {
            id: p.id,
            chain: p.chain,
            protocol: p.protocol,
            address: p.poolAddress,
            updatedAt: p.timestamp,
            data,
          };
          tx.insert(schema.pools)
            .values(row)
            .onConflictDoUpdate({ target: schema.pools.id, set: row })
            .run();
          const last=tieredHistory?(latest.get(p.id) as {timestamp:number}|undefined)?.timestamp:null;
          if(!preserveDisk && (!tieredHistory || last==null || p.timestamp-last>=
            (watched.has(p.id)||active.has(p.id)?300000:3600000)))
            tx.insert(schema.snapshots)
              .values({ poolId: p.id, timestamp: p.timestamp, data })
              .onConflictDoNothing()
              .run();
          for (const token of [p.token0, p.token1]) {
            const row = {
              id: `${p.chain}:${token.address}`,
              chain: p.chain,
              address: token.address,
              updatedAt: p.timestamp,
              data: token,
            };
            tx.insert(schema.tokens)
              .values(row)
              .onConflictDoUpdate({ target: schema.tokens.id, set: row })
              .run();
          }
        }
      });
    },
    replaceCurrent(item: Snapshot) {
      sqlite.prepare("UPDATE pools SET data=? WHERE id=? AND updated_at=?")
        .run(JSON.stringify(item), item.pool.id, item.pool.timestamp);
    },
    list() {
      return db
        .select()
        .from(schema.pools)
        .all()
        .map((row) => currentSnapshot(row.data));
    },
    get(id: string) {
      const row = db.select().from(schema.pools).where(eq(schema.pools.id, id)).get();
      return row ? currentSnapshot(row.data) : undefined;
    },
    analyticsHistory(id: string, now: number) {
      return db
        .select()
        .from(schema.snapshots)
        .where(
          and(
            eq(schema.snapshots.poolId, id),
            or(
              ...[300000, 1800000, 3600000, 14400000, 86400000].map((w) =>
                and(
                  gte(schema.snapshots.timestamp, now - w - 120000),
                  lte(schema.snapshots.timestamp, now - w),
                ),
              ),
            ),
          ),
        )
        .orderBy(asc(schema.snapshots.timestamp))
        .all()
        .map((row) => hydrateSnapshot(row.data));
    },
    history(id: string, since = Date.now() - 86400000, limit = 2000) {
      return db
        .select()
        .from(schema.snapshots)
        .where(and(eq(schema.snapshots.poolId, id), gte(schema.snapshots.timestamp, since)))
        .orderBy(desc(schema.snapshots.timestamp))
        .limit(limit)
        .all()
        .reverse()
        .map((row) => hydrateSnapshot(row.data));
    },
    candles(id: string) {
      return db
        .select()
        .from(schema.candles)
        .where(
          and(
            eq(schema.candles.poolId, id),
            gte(schema.candles.timestamp, Date.now() - 86400000 - 300000),
          ),
        )
        .orderBy(asc(schema.candles.timestamp))
        .all()
        .map((row) => row.data);
    },
    saveCandles(id: string, items: Candle[]) {
      db.transaction((tx) => {
        for (const data of items)
          tx.insert(schema.candles)
            .values({ poolId: id, timestamp: data.timestamp, data })
            .onConflictDoNothing()
            .run();
      });
    },
    prune(days: number) {
      if (days <= 0) return;
      const cutoff = Date.now() - days * 86400000;
      db.transaction((tx) => {
        tx.delete(schema.snapshots).where(lt(schema.snapshots.timestamp, cutoff)).run();
        tx.delete(schema.candles).where(lt(schema.candles.timestamp, cutoff)).run();
        tx.delete(schema.runs).where(lt(schema.runs.startedAt, cutoff)).run();
        tx.delete(schema.alerts).where(lt(schema.alerts.timestamp, cutoff)).run();
      });
    },
    recentRuns() {
      return db.select().from(schema.runs).orderBy(desc(schema.runs.id)).limit(10).all();
    },
    recentAlerts() {
      return db.select().from(schema.alerts).orderBy(desc(schema.alerts.id)).limit(50).all();
    },
    alertDue(poolId: string, kind: string, cooldown: number, now = Date.now()) {
      return !db
        .select({ id: schema.alerts.id })
        .from(schema.alerts)
        .where(
          and(
            eq(schema.alerts.poolId, poolId),
            eq(schema.alerts.kind, kind),
            gte(schema.alerts.timestamp, now - cooldown),
          ),
        )
        .get();
    },
  };
}
export type Store = ReturnType<typeof createStore>;
