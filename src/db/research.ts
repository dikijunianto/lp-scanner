import Database from "better-sqlite3";
import type { Pool, Snapshot, FeeWindow, Window, PriceRecord } from "../core/model";
import { windows, windowMs } from "../core/model";
import {
  detectSignals,
  evaluateOutcome,
  horizons,
  activityScoreVersion,
  riskScoreVersion,
  scannerVersion,
  signalRuleVersion,
  type Horizon,
  type Outcome,
  type SignalPolicy,
  type SignalType,
} from "../core/research";

export interface BackfillJob {
  poolId: string;
  chain: string;
  poolAddress: string;
  startBlock: number | null;
  endBlock: number | null;
  lastConfirmedBlock: number | null;
  nextBackfillBlock: number | null;
  status: "NOT_STARTED" | "BACKFILLING" | "PARTIAL" | "COMPLETE" | "FAILED";
  retryCount: number;
  failureReason: string | null;
  priority: number;
  updatedAt: number;
  nextAttemptAt: number;
}
export interface SignalRow {
  id: number;
  poolId: string;
  signalType: SignalType;
  episodeStart: number;
  episodeLastSeen: number;
  episodeEnd: number | null;
  peakScore: number | null;
  scannerVersion: string;
  activityScoreVersion: string;
  riskScoreVersion: string;
  signalRuleVersion: string;
  reasonJson: string;
  data: Snapshot;
}
export interface OutcomeRow {
  signalId: number;
  horizon: Horizon;
  dueAt: number;
  status: "PENDING" | "COMPLETE" | "PARTIAL" | "UNAVAILABLE";
  completedAt: number | null;
  data: Outcome | null;
}
const json = (s: string) => JSON.parse(s) as Snapshot;
const signal = (row: Record<string, unknown>): SignalRow => ({
  id: Number(row.id),
  poolId: String(row.pool_id),
  signalType: row.signal_type as SignalType,
  episodeStart: Number(row.episode_start),
  episodeLastSeen: Number(row.episode_last_seen),
  episodeEnd: row.episode_end == null ? null : Number(row.episode_end),
  peakScore: row.peak_score == null ? null : Number(row.peak_score),
  scannerVersion: String(row.scanner_version),
  activityScoreVersion: String(row.activity_score_version),
  riskScoreVersion: String(row.risk_score_version),
  signalRuleVersion: String(row.signal_rule_version),
  reasonJson: String(row.reason_json),
  data: json(String(row.data)),
});

export function createResearchStore(sqlite: Database.Database) {
  const rebuildBuckets = (poolId: string) => {
    sqlite.prepare("DELETE FROM fee_minute_buckets WHERE pool_id=?").run(poolId);
    sqlite
      .prepare(
        `INSERT INTO fee_minute_buckets
      (pool_id,bucket_start,volume_usd,gross_fees_usd,lp_fees_usd,swap_count,unpriced_count,gross_unknown_count)
      SELECT pool_id, CAST(timestamp/60000 AS INTEGER)*60000,
      SUM(COALESCE(volume_usd,0)),SUM(COALESCE(gross_fee_usd,0)),SUM(COALESCE(lp_fee_usd,fees_usd,0)),
      COUNT(*),SUM(CASE WHEN volume_usd IS NULL OR COALESCE(lp_fee_usd,fees_usd) IS NULL THEN 1 ELSE 0 END),
      SUM(CASE WHEN gross_fee_usd IS NULL THEN 1 ELSE 0 END)
      FROM fee_events WHERE pool_id=? GROUP BY pool_id,CAST(timestamp/60000 AS INTEGER)`,
      )
      .run(poolId);
  };
  return {
    latestIndependentPrice(chain: string, address: string): PriceRecord | null {
      const row = sqlite
        .prepare(
          `SELECT * FROM price_observations WHERE chain=? AND asset_address=?
        AND source_timestamp IS NOT NULL AND confidence IN ('HIGH','MEDIUM')
        AND (source LIKE 'DefiLlama%' OR source LIKE 'CoinGecko%' OR source LIKE 'Independent median%')
        ORDER BY source_timestamp DESC LIMIT 1`,
        )
        .get(chain, chain === "solana" ? address : address.toLowerCase()) as
        Record<string, unknown> | undefined;
      return row
        ? {
            assetAddress: String(row.asset_address),
            chain,
            symbol: String(row.symbol),
            priceUsd: Number(row.price_usd),
            source: String(row.source),
            sourceTimestamp: Number(row.source_timestamp),
            observedAt: Number(row.observed_at),
            blockNumber: row.block_number == null ? null : String(row.block_number),
            confidence: row.confidence as PriceRecord["confidence"],
          }
        : null;
    },
    watchedIds(): Set<string> {
      return new Set(
        (sqlite.prepare("SELECT pool_id FROM watchlist").all() as { pool_id: string }[]).map(
          (r) => r.pool_id,
        ),
      );
    },
    watch(poolId: string, watched: boolean) {
      if (!sqlite.prepare("SELECT id FROM pools WHERE id=?").get(poolId)) return false;
      if (watched)
        sqlite.prepare("INSERT OR IGNORE INTO watchlist VALUES (?,?)").run(poolId, Date.now());
      else sqlite.prepare("DELETE FROM watchlist WHERE pool_id=?").run(poolId);
      return true;
    },
    enqueueBackfill(pool: Pool, priority: number) {
      if (pool.chain !== "base" && pool.chain !== "bsc") return;
      sqlite
        .prepare(
          `INSERT INTO fee_backfill_jobs
        (pool_id,chain,pool_address,status,priority,updated_at) VALUES (?,?,?,'NOT_STARTED',?,?)
        ON CONFLICT(pool_id) DO UPDATE SET priority=excluded.priority`,
        )
        .run(pool.id, pool.chain, pool.poolAddress, priority, Date.now());
    },
    backfillJobs(limit: number): { job: BackfillJob; pool: Pool }[] {
      const rows = sqlite
        .prepare(
          `SELECT j.*,p.data AS pool_data FROM fee_backfill_jobs j JOIN pools p ON p.id=j.pool_id
        WHERE j.next_attempt_at<=? AND (j.status!='COMPLETE' OR j.last_confirmed_block IS NULL OR j.updated_at<?)
        ORDER BY CASE WHEN j.status='NOT_STARTED' THEN 0 ELSE 1 END,
        j.updated_at ASC,j.priority DESC
        LIMIT ?`,
        )
        .all(Date.now(), Date.now() - 30000, limit) as (Record<string, unknown> & {
        pool_data: string;
      })[];
      return rows.map((row) => ({
        job: {
          poolId: String(row.pool_id),
          chain: String(row.chain),
          poolAddress: String(row.pool_address),
          startBlock: row.start_block == null ? null : Number(row.start_block),
          endBlock: row.end_block == null ? null : Number(row.end_block),
          lastConfirmedBlock:
            row.last_confirmed_block == null ? null : Number(row.last_confirmed_block),
          nextBackfillBlock:
            row.next_backfill_block == null ? null : Number(row.next_backfill_block),
          status: row.status as BackfillJob["status"],
          retryCount: Number(row.retry_count),
          failureReason: row.failure_reason == null ? null : String(row.failure_reason),
          priority: Number(row.priority),
          updatedAt: Number(row.updated_at),
          nextAttemptAt: Number(row.next_attempt_at),
        },
        pool: (JSON.parse(row.pool_data) as Snapshot).pool,
      }));
    },
    backfillQueueLength() {
      return (
        sqlite
          .prepare("SELECT count(*) n FROM fee_backfill_jobs WHERE status!='COMPLETE'")
          .get() as { n: number }
      ).n;
    },
    backfillStatus(limit = 20) {
      return sqlite
        .prepare("SELECT * FROM fee_backfill_jobs ORDER BY updated_at DESC LIMIT ?")
        .all(limit) as Record<string, unknown>[];
    },
    setBackfillJob(
      poolId: string,
      patch: Partial<
        Pick<
          BackfillJob,
          | "startBlock"
          | "endBlock"
          | "lastConfirmedBlock"
          | "nextBackfillBlock"
          | "status"
          | "retryCount"
          | "failureReason"
          | "nextAttemptAt"
        >
      >,
    ) {
      const cols: Record<string, string> = {
        startBlock: "start_block",
        endBlock: "end_block",
        lastConfirmedBlock: "last_confirmed_block",
        nextBackfillBlock: "next_backfill_block",
        status: "status",
        retryCount: "retry_count",
        failureReason: "failure_reason",
        nextAttemptAt: "next_attempt_at",
      };
      const entries = Object.entries(patch).filter(([k]) => k in cols);
      if (!entries.length) return;
      sqlite
        .prepare(
          `UPDATE fee_backfill_jobs SET ${entries.map(([k]) => `${cols[k]}=?`).join(",")},updated_at=? WHERE pool_id=?`,
        )
        .run(...entries.map(([, v]) => v), Date.now(), poolId);
    },
    checkpoint(poolId: string, blockNumber: number, hash: string, timestamp: number) {
      sqlite
        .prepare("INSERT OR REPLACE INTO fee_block_checkpoints VALUES (?,?,?,?)")
        .run(poolId, blockNumber, hash, timestamp);
    },
    restartFeeCursorFromHead(poolId: string) {
      sqlite.transaction(() => {
        sqlite.prepare("DELETE FROM fee_cursors WHERE pool_id=?").run(poolId);
        sqlite.prepare("DELETE FROM fee_block_checkpoints WHERE pool_id=?").run(poolId);
      })();
    },
    checkpoints(poolId: string, limit = 30) {
      return sqlite
        .prepare(
          "SELECT block_number AS blockNumber,block_hash AS blockHash,timestamp FROM fee_block_checkpoints WHERE pool_id=? ORDER BY block_number DESC LIMIT ?",
        )
        .all(poolId, limit) as { blockNumber: number; blockHash: string; timestamp: number }[];
    },
    rollbackIndexedFees(
      poolId: string,
      fromBlock: number,
      ancestor?: { blockNumber: number; blockHash: string; timestamp: number },
    ) {
      sqlite.transaction(() => {
        sqlite
          .prepare("DELETE FROM fee_events WHERE pool_id=? AND block_number>=?")
          .run(poolId, fromBlock);
        sqlite
          .prepare("DELETE FROM fee_block_checkpoints WHERE pool_id=? AND block_number>=?")
          .run(poolId, fromBlock);
        sqlite.prepare("DELETE FROM fee_windows WHERE pool_id=?").run(poolId);
        if (ancestor)
          sqlite
            .prepare(
              "UPDATE fee_cursors SET block_number=?,block_hash=?,end_time=?,updated_at=? WHERE pool_id=?",
            )
            .run(ancestor.blockNumber, ancestor.blockHash, ancestor.timestamp, Date.now(), poolId);
        else sqlite.prepare("DELETE FROM fee_cursors WHERE pool_id=?").run(poolId);
        rebuildBuckets(poolId);
      })();
    },
    rebuildFeeBuckets(poolId: string) {
      sqlite.transaction(() => rebuildBuckets(poolId))();
    },
    hasFeeBuckets(poolId: string) {
      return !!sqlite
        .prepare("SELECT 1 FROM fee_minute_buckets WHERE pool_id=? LIMIT 1")
        .get(poolId);
    },
    rebuildFeeBucketsRange(poolId: string, from: number, to: number) {
      const start = Math.floor(from / 60000) * 60000;
      const end = Math.floor(to / 60000) * 60000;
      sqlite.transaction(() => {
        sqlite
          .prepare(
            "DELETE FROM fee_minute_buckets WHERE pool_id=? AND bucket_start BETWEEN ? AND ?",
          )
          .run(poolId, start, end);
        sqlite
          .prepare(
            `INSERT INTO fee_minute_buckets
          (pool_id,bucket_start,volume_usd,gross_fees_usd,lp_fees_usd,swap_count,unpriced_count,gross_unknown_count)
          SELECT pool_id,CAST(timestamp/60000 AS INTEGER)*60000,
          SUM(COALESCE(volume_usd,0)),SUM(COALESCE(gross_fee_usd,0)),SUM(COALESCE(lp_fee_usd,fees_usd,0)),
          COUNT(*),SUM(CASE WHEN volume_usd IS NULL OR COALESCE(lp_fee_usd,fees_usd) IS NULL THEN 1 ELSE 0 END),
          SUM(CASE WHEN gross_fee_usd IS NULL THEN 1 ELSE 0 END)
          FROM fee_events WHERE pool_id=? AND timestamp>=? AND timestamp<?
          GROUP BY pool_id,CAST(timestamp/60000 AS INTEGER)`,
          )
          .run(poolId, start, end + 60000);
      })();
    },
    materializedFeeWindow(
      poolId: string,
      window: Window,
      end: number,
      covered: boolean,
      startBlock: number | null,
      endBlock: number | null,
    ): FeeWindow {
      const start = end - windowMs[window];
      const row = sqlite
        .prepare(
          `SELECT COALESCE(SUM(volume_usd),0) volume,COALESCE(SUM(gross_fees_usd),0) gross,
        COALESCE(SUM(lp_fees_usd),0) lp,COALESCE(SUM(swap_count),0) swaps,
        COALESCE(SUM(unpriced_count),0) unpriced,COALESCE(SUM(gross_unknown_count),0) grossUnknown
        FROM fee_minute_buckets WHERE pool_id=? AND bucket_start>=? AND bucket_start<?`,
        )
        .get(poolId, start, end) as {
        volume: number;
        gross: number;
        lp: number;
        swaps: number;
        unpriced: number;
        grossUnknown: number;
      };
      const complete = covered && row.unpriced === 0;
      return {
        volumeUsd: complete ? row.volume : null,
        feesUsd: complete ? row.lp : null,
        grossFeesUsd: complete && row.grossUnknown === 0 ? row.gross : null,
        lpFeesUsd: complete ? row.lp : null,
        swapCount: complete ? row.swaps : null,
        uniqueTraderCount: null,
        windowStart: start,
        windowEnd: end,
        startBlock,
        endBlock,
        methodology: complete ? "EVENT_DERIVED" : "UNAVAILABLE",
        confidence: complete ? "MEDIUM" : "UNAVAILABLE",
      };
    },
    latestFeeWindows(poolId: string, now = Date.now()): Partial<Record<Window, FeeWindow>> {
      const result: Partial<Record<Window, FeeWindow>> = {};
      for (const w of windows) {
        const row = sqlite
          .prepare(
            "SELECT data FROM fee_windows WHERE pool_id=? AND window_name=? ORDER BY window_end DESC LIMIT 1",
          )
          .get(poolId, w) as { data: string } | undefined;
        if (!row) continue;
        const data = JSON.parse(row.data) as FeeWindow;
        if (now - data.windowEnd <= 300000 && data.windowEnd <= now + 30000) result[w] = data;
      }
      return result;
    },
    generatedFees(
      poolId: string,
      from: number,
      to: number,
    ): { fees: number | null; volume: number | null } {
      const cursor = sqlite
        .prepare("SELECT start_time startTime,end_time endTime FROM fee_cursors WHERE pool_id=?")
        .get(poolId) as { startTime: number; endTime: number } | undefined;
      if (!cursor || cursor.startTime > from || cursor.endTime < to)
        return { fees: null, volume: null };
      const row = sqlite
        .prepare(
          `SELECT COALESCE(SUM(volume_usd),0) volume,COALESCE(SUM(COALESCE(lp_fee_usd,fees_usd)),0) fees,
        COALESCE(SUM(CASE WHEN volume_usd IS NULL OR COALESCE(lp_fee_usd,fees_usd) IS NULL THEN 1 ELSE 0 END),0) missing
        FROM fee_events WHERE pool_id=? AND timestamp>? AND timestamp<=?`,
        )
        .get(poolId, from, to) as { volume: number; fees: number; missing: number };
      return row.missing ? { fees: null, volume: null } : { fees: row.fees, volume: row.volume };
    },
    syncSignals(s: Snapshot, policy: SignalPolicy): number[] {
      const found = detectSignals(s, policy);
      const created: number[] = [];
      sqlite.transaction(() => {
        const active = sqlite
          .prepare(
            "SELECT id,signal_type,peak_score FROM signal_episodes WHERE pool_id=? AND episode_end IS NULL",
          )
          .all(s.pool.id) as { id: number; signal_type: SignalType; peak_score: number | null }[];
        for (const old of active) {
          const match = found.find((m) => m.type === old.signal_type);
          if (match)
            sqlite
              .prepare("UPDATE signal_episodes SET episode_last_seen=?,peak_score=? WHERE id=?")
              .run(s.pool.timestamp, Math.max(old.peak_score ?? match.score, match.score), old.id);
          else
            sqlite
              .prepare("UPDATE signal_episodes SET episode_end=? WHERE id=?")
              .run(s.pool.timestamp, old.id);
        }
        for (const match of found)
          if (!active.some((old) => old.signal_type === match.type)) {
            const id = Number(
              sqlite
                .prepare(
                  `INSERT INTO signal_episodes
            (pool_id,signal_type,episode_start,episode_last_seen,peak_score,scanner_version,activity_score_version,risk_score_version,signal_rule_version,reason_json,data)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
                )
                .run(
                  s.pool.id,
                  match.type,
                  s.pool.timestamp,
                  s.pool.timestamp,
                  match.score,
                  scannerVersion,
                  activityScoreVersion,
                  riskScoreVersion,
                  signalRuleVersion,
                  JSON.stringify({ reason: match.reason }),
                  JSON.stringify(s),
                ).lastInsertRowid,
            );
            created.push(id);
            for (const [h, ms] of Object.entries(horizons))
              sqlite
                .prepare("INSERT INTO signal_outcomes(signal_id,horizon,due_at) VALUES (?,?,?)")
                .run(id, h, s.pool.timestamp + ms);
          }
      })();
      return created;
    },
    dueOutcomes(
      now: number,
      limit: number,
      graceMs = 0,
    ): { signal: SignalRow; outcome: OutcomeRow }[] {
      const rows = sqlite
        .prepare(
          `SELECT o.*,s.data signal_data,s.id signal_id_full,s.pool_id,s.signal_type,s.episode_start,s.episode_last_seen,s.episode_end,s.peak_score,
        s.scanner_version,s.activity_score_version,s.risk_score_version,s.signal_rule_version,s.reason_json
        FROM signal_outcomes o JOIN signal_episodes s ON s.id=o.signal_id
        WHERE o.status='PENDING' AND o.due_at+?<=? ORDER BY o.due_at LIMIT ?`,
        )
        .all(graceMs, now, limit) as Record<string, unknown>[];
      return rows.map((r) => ({
        signal: signal({ ...r, id: r.signal_id_full, data: r.signal_data }),
        outcome: {
          signalId: Number(r.signal_id),
          horizon: r.horizon as Horizon,
          dueAt: Number(r.due_at),
          status: "PENDING",
          completedAt: null,
          data: null,
        },
      }));
    },
    completeOutcome(
      signalId: number,
      horizon: Horizon,
      status: OutcomeRow["status"],
      data: Outcome,
    ) {
      sqlite
        .prepare(
          "UPDATE signal_outcomes SET status=?,completed_at=?,data=? WHERE signal_id=? AND horizon=? AND status='PENDING'",
        )
        .run(status, Date.now(), JSON.stringify(data), signalId, horizon);
    },
    outcomeHistory(poolId: string, from: number, to: number): Snapshot[] {
      return (
        sqlite
          .prepare(
            "SELECT data FROM pool_snapshots WHERE pool_id=? AND timestamp>? AND timestamp<=? ORDER BY timestamp",
          )
          .all(poolId, from, to) as { data: string }[]
      ).map((r) => json(r.data));
    },
    evaluateDueOutcomes(policy: SignalPolicy, now = Date.now(), limit = 10) {
      let completed = 0;
      for (const { signal: row, outcome } of this.dueOutcomes(
        now,
        limit,
        policy.maxObservationGapMs,
      )) {
        const end = outcome.dueAt + policy.maxObservationGapMs;
        const history = this.outcomeHistory(row.poolId, row.episodeStart, end);
        const generated =
          row.data.pool.chain === "solana"
            ? { fees: null, volume: null }
            : this.generatedFees(row.poolId, row.episodeStart, outcome.dueAt);
        const data = evaluateOutcome(row.data, history, outcome.horizon, policy, generated);
        const status =
          data.endpointAt === null
            ? "UNAVAILABLE"
            : data.observationCoveragePct < 80
              ? "PARTIAL"
              : "COMPLETE";
        this.completeOutcome(row.id, outcome.horizon, status, data);
        completed++;
      }
      return completed;
    },
    listSignals(limit = 300): SignalRow[] {
      return (
        sqlite
          .prepare("SELECT * FROM signal_episodes ORDER BY episode_start DESC LIMIT ?")
          .all(limit) as Record<string, unknown>[]
      ).map(signal);
    },
    researchFacts(limit = 5000) {
      return sqlite
        .prepare(
          `SELECT s.id,s.signal_type signalType,s.episode_start episodeStart,
        json_extract(s.data,'$.pool.chain') chain,json_extract(s.data,'$.pool.protocol') protocol,
        json_extract(s.data,'$.pool.pair') pair,json_extract(s.data,'$.pool.tokenAge') tokenAge,
        json_extract(s.data,'$.pool.poolAge') poolAge,json_extract(s.data,'$.metrics.activity') activity,
        json_extract(s.data,'$.metrics.risk') risk,json_extract(s.data,'$.metrics.dataQuality') confidence,
        json_extract(s.data,'$.metrics.feeEfficiency1h') feeEfficiency,
        json_extract(s.data,'$.metrics.volumeDepthRatio1h') volumeDepth,
        json_extract(s.data,'$.pool.realizedVolatility1h') volatility,
        json_extract(s.data,'$.metrics.trend') trend,
        o.horizon,o.status outcomeStatus,o.data outcomeData
        FROM signal_episodes s LEFT JOIN signal_outcomes o ON o.signal_id=s.id
        WHERE s.id IN (SELECT id FROM signal_episodes ORDER BY episode_start DESC LIMIT ?)
        ORDER BY s.episode_start DESC,o.due_at`,
        )
        .all(limit) as Record<string, unknown>[];
    },
    signalDetail(id: number): { signal: SignalRow; outcomes: OutcomeRow[] } | null {
      const row = sqlite.prepare("SELECT * FROM signal_episodes WHERE id=?").get(id) as
        Record<string, unknown> | undefined;
      if (!row) return null;
      const outcomes = (
        sqlite
          .prepare("SELECT * FROM signal_outcomes WHERE signal_id=? ORDER BY due_at")
          .all(id) as Record<string, unknown>[]
      ).map((o) => ({
        signalId: Number(o.signal_id),
        horizon: o.horizon as Horizon,
        dueAt: Number(o.due_at),
        status: o.status as OutcomeRow["status"],
        completedAt: o.completed_at == null ? null : Number(o.completed_at),
        data: o.data == null ? null : (JSON.parse(String(o.data)) as Outcome),
      }));
      return { signal: signal(row), outcomes };
    },
    researchCounts(graceMs = 0) {
      const one = (sql: string) => (sqlite.prepare(sql).get() as { n: number }).n;
      const oldest = (
        sqlite
          .prepare("SELECT MIN(due_at) n FROM signal_outcomes WHERE status='PENDING' AND due_at+?<?")
          .get(graceMs, Date.now()) as { n: number | null }
      ).n;
      return {
        events: one("SELECT count(*) n FROM fee_events"),
        signals: one("SELECT count(*) n FROM signal_episodes"),
        completeOutcomes: one("SELECT count(*) n FROM signal_outcomes WHERE status='COMPLETE'"),
        pendingOutcomes: one("SELECT count(*) n FROM signal_outcomes WHERE status='PENDING'"),
        queueLength: this.backfillQueueLength(),
        workerLagMs: oldest === null ? 0 : Math.max(0, Date.now() - oldest - graceMs),
      };
    },
    coverage() {
      return sqlite
        .prepare(
          `SELECT chain,COUNT(*) pools,
        SUM(json_extract(data,'$.pool.token0.usdPrice') IS NOT NULL AND json_extract(data,'$.pool.token1.usdPrice') IS NOT NULL
          AND json_extract(data,'$.pool.token0.usdPriceSourceTimestamp') IS NOT NULL AND json_extract(data,'$.pool.token1.usdPriceSourceTimestamp') IS NOT NULL) price_timestamped,
        SUM(json_extract(data,'$.metrics.priceConfidence') IN ('HIGH','MEDIUM')) price_reliable,
        SUM(json_extract(data,'$.pool.feeWindows.1h.methodology')='EVENT_DERIVED' OR (chain='solana' AND json_extract(data,'$.pool.fees1h') IS NOT NULL)) fee_1h,
        SUM(json_extract(data,'$.pool.depth5PctUsd') IS NOT NULL) depth,
        SUM(json_extract(data,'$.metrics.dataQuality')='HIGH') high_confidence
        FROM pools WHERE updated_at >= COALESCE((SELECT started_at FROM scanner_runs WHERE ended_at IS NOT NULL AND status!='error' ORDER BY id DESC LIMIT 1),0)
        GROUP BY chain`,
        )
        .all() as Record<string, unknown>[];
    },
    startWorkerRun(queueLength: number) {
      return Number(
        sqlite
          .prepare("INSERT INTO worker_runs(started_at,status,queue_length) VALUES (?,'running',?)")
          .run(Date.now(), queueLength).lastInsertRowid,
      );
    },
    finishWorkerRun(
      id: number,
      status: string,
      api: number,
      rpc: number,
      cache: number,
      queueLength: number,
      notes: string,
    ) {
      sqlite
        .prepare(
          "UPDATE worker_runs SET ended_at=?,status=?,api_requests=?,rpc_requests=?,cache_hits=?,queue_length=?,notes=? WHERE id=?",
        )
        .run(Date.now(), status, api, rpc, cache, queueLength, notes, id);
    },
    recentWorkerRun() {
      return sqlite.prepare("SELECT * FROM worker_runs ORDER BY id DESC LIMIT 1").get() as
        Record<string, unknown> | undefined;
    },
    saveScanMetrics(runId: number, duration: number, api: number, rpc: number, cache: number) {
      sqlite
        .prepare("INSERT OR REPLACE INTO scan_metrics VALUES (?,?,?,?,?)")
        .run(runId, duration, api, rpc, cache);
    },
    recentScanMetrics() {
      return sqlite.prepare("SELECT * FROM scan_metrics ORDER BY run_id DESC LIMIT 1").get() as
        Record<string, unknown> | undefined;
    },
    latestFeeMetadata(poolId: string): Pool | null {
      const row = sqlite
        .prepare(
          `SELECT data FROM pool_snapshots WHERE pool_id=?
        AND json_extract(data,'$.pool.activeLiquidityDetails.method')='V3_VIRTUAL_RESERVES_V1'
        AND json_extract(data,'$.pool.feeTier') IS NOT NULL ORDER BY timestamp DESC LIMIT 1`,
        )
        .get(poolId) as { data: string } | undefined;
      return row ? (JSON.parse(row.data) as Snapshot).pool : null;
    },
  };
}
