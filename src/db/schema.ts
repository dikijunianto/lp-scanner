import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { Snapshot, Token, Candle } from "../core/model";
export const pools = sqliteTable(
  "pools",
  {
    id: text().primaryKey(),
    chain: text().notNull(),
    protocol: text().notNull(),
    address: text().notNull(),
    updatedAt: integer("updated_at").notNull(),
    data: text({ mode: "json" }).$type<Snapshot>().notNull(),
  },
  (t) => [index("pools_chain_protocol").on(t.chain, t.protocol)],
);
export const snapshots = sqliteTable(
  "pool_snapshots",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    poolId: text("pool_id")
      .notNull()
      .references(() => pools.id),
    timestamp: integer().notNull(),
    data: text({ mode: "json" }).$type<Snapshot>().notNull(),
  },
  (t) => [
    uniqueIndex("snapshots_pool_time_unique").on(t.poolId, t.timestamp),
    index("snapshots_time").on(t.timestamp),
  ],
);
export const tokens = sqliteTable("tokens", {
  id: text().primaryKey(),
  chain: text().notNull(),
  address: text().notNull(),
  updatedAt: integer("updated_at").notNull(),
  data: text({ mode: "json" }).$type<Token>().notNull(),
});
export const alerts = sqliteTable("alerts", {
  id: integer().primaryKey({ autoIncrement: true }),
  poolId: text("pool_id")
    .notNull()
    .references(() => pools.id),
  timestamp: integer().notNull(),
  kind: text().notNull(),
  data: text({ mode: "json" }).$type<Snapshot>().notNull(),
  delivery: text().notNull().default("local"),
});
export const runs = sqliteTable("scanner_runs", {
  id: integer().primaryKey({ autoIncrement: true }),
  startedAt: integer("started_at").notNull(),
  endedAt: integer("ended_at"),
  status: text().notNull(),
  data: text({ mode: "json" }).$type<SourceStatus[]>().notNull(),
});
export const settings = sqliteTable("app_settings", {
  key: text().primaryKey(),
  value: text().notNull(),
});
export const candles = sqliteTable("candles", {
  poolId: text("pool_id")
    .notNull()
    .references(() => pools.id),
  timestamp: integer().notNull(),
  data: text({ mode: "json" }).$type<Candle>().notNull(),
});
export interface SourceStatus {
  name: string;
  status: "ok" | "degraded" | "error";
  pools: number;
  notes: string[];
}
