import Database from "better-sqlite3";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { and, asc, desc, eq, gte, lt, lte, or } from "drizzle-orm";
import * as schema from "./schema";
import { env } from "../config/env";
import type { Snapshot, Candle } from "../core/model";
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
  return {
    db,
    close: () => sqlite.close(),
    save(items: Snapshot[]) {
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
    list() {
      return db
        .select()
        .from(schema.pools)
        .all()
        .map((row) => row.data);
    },
    get(id: string) {
      return db.select().from(schema.pools).where(eq(schema.pools.id, id)).get()?.data;
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
        .map((row) => row.data);
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
        .map((row) => row.data);
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
