import type Database from "better-sqlite3";
import type { PriceRecord } from "../core/model";

export interface RpcProviderRow {
  providerId: string;
  chain: string;
  urlHash: string;
  providerType: string;
  supportsArchive: boolean | null;
  supportsGetLogs: boolean | null;
  supportsBatching: boolean | null;
  supportsMulticall: boolean | null;
  supportsHistoricalState: boolean | null;
  safeLogRange: number;
  lastProbeAt: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  latencyMs: number | null;
  errorRate: number;
  consecutiveFailures: number;
  cooldownUntil: number;
  healthState: "HEALTHY" | "DEGRADED" | "COOLDOWN" | "UNAVAILABLE";
  circuitState: "CLOSED" | "OPEN" | "HALF_OPEN";
  failureReason: string | null;
}
export interface UnpricedEvent {
  poolId: string;
  chain: string;
  txHash: string;
  logIndex: number;
  timestamp: number;
  amount0: string;
  amount1: string;
  protocolFeeRaw: string | null;
  feeTier: number;
  token0Address: string;
  token1Address: string;
  decimals0: number;
  decimals1: number;
  symbol0: string;
  symbol1: string;
}
const bool = (n: unknown): boolean | null => n == null ? null : Boolean(n);
export function createReliabilityStore(sqlite: Database.Database) {
  return {
    rpcProviders(): RpcProviderRow[] {
      return (sqlite.prepare("SELECT * FROM rpc_providers").all() as Record<string, unknown>[]).map((r) => ({
        providerId: String(r.provider_id), chain: String(r.chain), urlHash: String(r.url_hash),
        providerType: String(r.provider_type), supportsArchive: bool(r.supports_archive),
        supportsGetLogs: bool(r.supports_get_logs), supportsBatching: bool(r.supports_batching),
        supportsMulticall: bool(r.supports_multicall), supportsHistoricalState: bool(r.supports_historical_state),
        safeLogRange: Number(r.safe_log_range), lastProbeAt: r.last_probe_at == null ? null : Number(r.last_probe_at),
        lastSuccessAt: r.last_success_at == null ? null : Number(r.last_success_at),
        lastFailureAt: r.last_failure_at == null ? null : Number(r.last_failure_at),
        latencyMs: r.latency_ms == null ? null : Number(r.latency_ms), errorRate: Number(r.error_rate),
        consecutiveFailures: Number(r.consecutive_failures), cooldownUntil: Number(r.cooldown_until),
        healthState: r.health_state as RpcProviderRow["healthState"],
        circuitState: r.circuit_state as RpcProviderRow["circuitState"],
        failureReason: r.failure_reason == null ? null : String(r.failure_reason),
      }));
    },
    saveRpcProvider(r: RpcProviderRow) {
      sqlite.prepare(`INSERT INTO rpc_providers
        (provider_id,chain,url_hash,provider_type,supports_archive,supports_get_logs,supports_batching,
        supports_multicall,supports_historical_state,safe_log_range,last_probe_at,last_success_at,last_failure_at,
        latency_ms,error_rate,consecutive_failures,cooldown_until,health_state,router_version,circuit_state,failure_reason) VALUES
        (@providerId,@chain,@urlHash,@providerType,@supportsArchive,@supportsGetLogs,@supportsBatching,
        @supportsMulticall,@supportsHistoricalState,@safeLogRange,@lastProbeAt,@lastSuccessAt,@lastFailureAt,
        @latencyMs,@errorRate,@consecutiveFailures,@cooldownUntil,@healthState,'sprint6-v1',@circuitState,@failureReason)
        ON CONFLICT(provider_id) DO UPDATE SET
        supports_archive=excluded.supports_archive,supports_get_logs=excluded.supports_get_logs,
        supports_batching=excluded.supports_batching,supports_multicall=excluded.supports_multicall,
        supports_historical_state=excluded.supports_historical_state,safe_log_range=excluded.safe_log_range,
        last_probe_at=excluded.last_probe_at,last_success_at=excluded.last_success_at,
        last_failure_at=excluded.last_failure_at,latency_ms=excluded.latency_ms,
        error_rate=excluded.error_rate,consecutive_failures=excluded.consecutive_failures,
        cooldown_until=excluded.cooldown_until,health_state=excluded.health_state,
        circuit_state=excluded.circuit_state,failure_reason=excluded.failure_reason,
        router_version=excluded.router_version`).run({
        ...r, supportsArchive: r.supportsArchive == null ? null : Number(r.supportsArchive),
        supportsGetLogs: r.supportsGetLogs == null ? null : Number(r.supportsGetLogs),
        supportsBatching: r.supportsBatching == null ? null : Number(r.supportsBatching),
        supportsMulticall: r.supportsMulticall == null ? null : Number(r.supportsMulticall),
        supportsHistoricalState: r.supportsHistoricalState == null ? null : Number(r.supportsHistoricalState),
      });
    },
    rpcUsage(providerId: string, chain: string, minute: number) {
      const provider = sqlite.prepare("SELECT COALESCE(SUM(requests),0) n FROM rpc_request_minutes WHERE provider_id=? AND minute_start=?")
        .get(providerId, minute) as { n: number };
      const total = sqlite.prepare(`SELECT COALESCE(SUM(m.requests),0) n FROM rpc_request_minutes m
        JOIN rpc_providers p ON p.provider_id=m.provider_id WHERE p.chain=? AND m.minute_start=?`)
        .get(chain, minute) as { n: number };
      return { provider: provider.n, chain: total.n };
    },
    recordRpcRequest(providerId: string, minute: number, calls: number, logs: number, blocks: number, fallback: number, requests = 1) {
      sqlite.prepare(`INSERT INTO rpc_request_minutes
        (provider_id,minute_start,requests,batch_calls,logs_queried,historical_blocks_queried,fallback_calls)
        VALUES (?,?,?,?,?,?,?) ON CONFLICT(provider_id,minute_start) DO UPDATE SET
        requests=requests+excluded.requests,batch_calls=batch_calls+excluded.batch_calls,
        logs_queried=logs_queried+excluded.logs_queried,
        historical_blocks_queried=historical_blocks_queried+excluded.historical_blocks_queried,
        fallback_calls=fallback_calls+excluded.fallback_calls`)
        .run(providerId, minute, requests, calls, logs, blocks, fallback);
    },
    recentRpcUsage() {
      return sqlite.prepare(`SELECT p.chain,m.provider_id,SUM(m.requests) requests,SUM(m.batch_calls) batch_calls,
        SUM(m.logs_queried) logs_queried,SUM(m.historical_blocks_queried) historical_blocks_queried,
        SUM(m.fallback_calls) fallback_calls FROM rpc_request_minutes m JOIN rpc_providers p USING(provider_id)
        WHERE m.minute_start>=? GROUP BY m.provider_id ORDER BY p.chain,m.provider_id`)
        .all(Date.now() - 3600000);
    },
    reservePriceCall(chain: string, limit: number) {
      const minute = Math.floor(Date.now()/60000)*60000;
      const row = sqlite.prepare("SELECT calls FROM price_request_minutes WHERE chain=? AND minute_start=?")
        .get(chain,minute) as {calls:number}|undefined;
      if ((row?.calls ?? 0) >= limit) return false;
      sqlite.prepare(`INSERT INTO price_request_minutes VALUES (?,?,1)
        ON CONFLICT(chain,minute_start) DO UPDATE SET calls=calls+1`).run(chain,minute);
      return true;
    },
    recentPriceCalls() {
      return sqlite.prepare("SELECT chain,SUM(calls) calls FROM price_request_minutes WHERE minute_start>=? GROUP BY chain")
        .all(Date.now()-3600000);
    },
    unpricedEvents(limit: number): UnpricedEvent[] {
      return sqlite.prepare(`SELECT e.pool_id poolId,e.chain,e.tx_hash txHash,e.log_index logIndex,
        ROW_NUMBER() OVER (PARTITION BY e.pool_id ORDER BY e.timestamp DESC) pool_rank,
        e.timestamp,e.amount0,e.amount1,e.protocol_fee_raw protocolFeeRaw,e.fee_tier feeTier,
        json_extract(p.data,'$.pool.activeLiquidityDetails.token0Address') token0Address,
        json_extract(p.data,'$.pool.activeLiquidityDetails.token1Address') token1Address,
        json_extract(p.data,'$.pool.activeLiquidityDetails.decimals0') decimals0,
        json_extract(p.data,'$.pool.activeLiquidityDetails.decimals1') decimals1,
        json_extract(p.data,'$.pool.token0.symbol') symbol0,
        json_extract(p.data,'$.pool.token1.symbol') symbol1
        FROM fee_events e JOIN pools p ON p.id=e.pool_id
        LEFT JOIN price_backfill_attempts a ON a.pool_id=e.pool_id AND a.tx_hash=e.tx_hash AND a.log_index=e.log_index
        WHERE e.volume_usd IS NULL AND e.amount0 IS NOT NULL AND e.amount1 IS NOT NULL
        AND (a.retry_at IS NULL OR a.retry_at<=?)
        ORDER BY pool_rank,e.timestamp DESC LIMIT ?`).all(Date.now(), limit) as UnpricedEvent[];
    },
    cachedHistoricalPrice(chain: string, address: string, bucket: number, source: string) {
      return sqlite.prepare(`SELECT * FROM historical_price_cache WHERE chain=? AND asset_address=? AND bucket_start=? AND source=?`)
        .get(chain, address.toLowerCase(), bucket, source) as Record<string, unknown> | undefined;
    },
    saveHistoricalPrice(record: PriceRecord | null, chain: string, address: string, bucket: number, source: string, status: string) {
      sqlite.prepare(`INSERT OR REPLACE INTO historical_price_cache VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(chain, address.toLowerCase(), bucket, source, record?.priceUsd ?? null,
          record?.sourceTimestamp ?? null, Date.now(), record?.confidence ?? "UNAVAILABLE",
          record?.resolution ?? "5M", status);
    },
    markPriceAttempt(e: UnpricedEvent, reason: string, retryAt: number) {
      sqlite.prepare(`INSERT INTO price_backfill_attempts VALUES (?,?,?,?,?)
        ON CONFLICT(pool_id,tx_hash,log_index) DO UPDATE SET reason=excluded.reason,retry_at=excluded.retry_at`)
        .run(e.poolId,e.txHash,e.logIndex,reason,retryAt);
      sqlite.prepare("UPDATE fee_events SET price_reason=? WHERE pool_id=? AND tx_hash=? AND log_index=? AND volume_usd IS NULL")
        .run(reason,e.poolId,e.txHash,e.logIndex);
    },
    priceBackfillProgress() {
      return sqlite.prepare(`SELECT count(*) total, SUM(volume_usd IS NOT NULL) priced,
        SUM(volume_usd IS NULL) pending,
        SUM(price_algorithm_version='sprint5-v1') backfilled FROM fee_events`).get();
    },
    priceReasonCounts() {
      return sqlite.prepare(`SELECT COALESCE(price_reason,'HISTORICAL_PRICE_UNAVAILABLE') reason,count(*) n
        FROM fee_events WHERE volume_usd IS NULL GROUP BY reason ORDER BY n DESC`).all();
    },
    saveBackfilledEvent(e: UnpricedEvent, price: PriceRecord, volume: number, fees: number | null,
      gross: number, price0: number | null, price1: number | null) {
      sqlite.transaction(() => {
        sqlite.prepare(`UPDATE fee_events SET volume_usd=?,fees_usd=?,gross_fee_usd=?,lp_fee_usd=?,
          price_usd0=?,price_usd1=?,confidence=?,price_confidence=?,price_reason=NULL,
          price_source=?,price_resolution=?,price_algorithm_version='sprint5-v1'
          WHERE pool_id=? AND tx_hash=? AND log_index=? AND volume_usd IS NULL`)
          .run(volume,fees,gross,fees,price0,price1,fees == null ? "UNAVAILABLE" : price.confidence,
            price.confidence,price.source,price.resolution ?? "5M",e.poolId,e.txHash,e.logIndex);
        sqlite.prepare("DELETE FROM price_backfill_attempts WHERE pool_id=? AND tx_hash=? AND log_index=?")
          .run(e.poolId,e.txHash,e.logIndex);
        const minute = Math.floor(e.timestamp / 60000) * 60000;
        sqlite.prepare("DELETE FROM fee_minute_buckets WHERE pool_id=? AND bucket_start=?").run(e.poolId,minute);
        sqlite.prepare(`INSERT INTO fee_minute_buckets
          SELECT pool_id,?,SUM(COALESCE(volume_usd,0)),SUM(COALESCE(gross_fee_usd,0)),
          SUM(COALESCE(lp_fee_usd,fees_usd,0)),COUNT(*),
          SUM(CASE WHEN volume_usd IS NULL OR COALESCE(lp_fee_usd,fees_usd) IS NULL THEN 1 ELSE 0 END),
          SUM(CASE WHEN gross_fee_usd IS NULL THEN 1 ELSE 0 END)
          FROM fee_events WHERE pool_id=? AND timestamp>=? AND timestamp<? HAVING COUNT(*)>0`)
          .run(minute,e.poolId,minute,minute+60000);
      })();
    },
    historicalFeeCoverage() {
      return sqlite.prepare(`SELECT p.chain,f.window_name window,count(*) stored_complete
        FROM fee_windows f JOIN pools p ON p.id=f.pool_id
        WHERE json_extract(f.data,'$.methodology')='EVENT_DERIVED'
        GROUP BY p.chain,f.window_name ORDER BY p.chain,f.window_name`).all();
    },
    currentFeeCoverage() {
      return sqlite.prepare(`SELECT p.chain,COUNT(*) pools,
        SUM(EXISTS(SELECT 1 FROM fee_windows f WHERE f.pool_id=p.id AND f.window_name='1h'
          AND f.window_end>=? AND json_extract(f.data,'$.methodology')='EVENT_DERIVED')) complete_1h,
        SUM(EXISTS(SELECT 1 FROM fee_windows f WHERE f.pool_id=p.id AND f.window_name='4h'
          AND f.window_end>=? AND json_extract(f.data,'$.methodology')='EVENT_DERIVED')) complete_4h,
        MAX((SELECT MAX(f.window_end) FROM fee_windows f WHERE f.pool_id=p.id AND f.window_name='1h'
          AND json_extract(f.data,'$.methodology')='EVENT_DERIVED')) last_complete_1h
        FROM pools p WHERE p.chain IN ('base','bsc') AND p.updated_at>=?
        GROUP BY p.chain`).all(Date.now()-300000,Date.now()-300000,Date.now()-300000);
    },
    outcomeCoverage() {
      return sqlite.prepare(`SELECT horizon,status,count(*) n FROM signal_outcomes GROUP BY horizon,status ORDER BY horizon,status`).all();
    },
    oldestBackfillJob() {
      return sqlite.prepare("SELECT MIN(updated_at) oldest FROM fee_backfill_jobs WHERE status!='COMPLETE'").get();
    },
    saveCohort(key: string, data: unknown) {
      sqlite.prepare("INSERT OR REPLACE INTO cohort_aggregates VALUES (?,'sprint5-v1',?,?)")
        .run(key,Date.now(),JSON.stringify(data));
    },
    replaceCohorts(rows: {key:string}[]) {
      sqlite.transaction(() => {
        sqlite.prepare("DELETE FROM cohort_aggregates").run();
        const insert = sqlite.prepare("INSERT INTO cohort_aggregates VALUES (?,'sprint5-v1',?,?)");
        const now = Date.now();
        for (const row of rows) insert.run(row.key,now,JSON.stringify(row));
      })();
    },
    cohorts() {
      return sqlite.prepare("SELECT * FROM cohort_aggregates ORDER BY cohort_key").all() as {cohort_key:string;version:string;calculated_at:number;data:string}[];
    },
  };
}
