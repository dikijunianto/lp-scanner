CREATE TABLE rpc_providers (
  provider_id TEXT PRIMARY KEY,
  chain TEXT NOT NULL,
  url_hash TEXT NOT NULL,
  provider_type TEXT NOT NULL,
  supports_archive INTEGER,
  supports_get_logs INTEGER,
  supports_batching INTEGER,
  supports_multicall INTEGER,
  supports_historical_state INTEGER,
  safe_log_range INTEGER NOT NULL DEFAULT 100,
  last_probe_at INTEGER,
  last_success_at INTEGER,
  last_failure_at INTEGER,
  latency_ms REAL,
  error_rate REAL NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  cooldown_until INTEGER NOT NULL DEFAULT 0,
  health_state TEXT NOT NULL DEFAULT 'UNAVAILABLE',
  router_version TEXT NOT NULL DEFAULT 'sprint5-v1'
);
CREATE TABLE rpc_request_minutes (
  provider_id TEXT NOT NULL REFERENCES rpc_providers(provider_id),
  minute_start INTEGER NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  batch_calls INTEGER NOT NULL DEFAULT 0,
  logs_queried INTEGER NOT NULL DEFAULT 0,
  historical_blocks_queried INTEGER NOT NULL DEFAULT 0,
  fallback_calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(provider_id, minute_start)
);
CREATE TABLE historical_price_cache (
  chain TEXT NOT NULL,
  asset_address TEXT NOT NULL,
  bucket_start INTEGER NOT NULL,
  source TEXT NOT NULL,
  price_usd REAL,
  source_timestamp INTEGER,
  observed_at INTEGER NOT NULL,
  confidence TEXT NOT NULL,
  resolution TEXT NOT NULL,
  status TEXT NOT NULL,
  PRIMARY KEY(chain,asset_address,bucket_start,source)
);
CREATE TABLE price_request_minutes (
  chain TEXT NOT NULL,
  minute_start INTEGER NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(chain,minute_start)
);
ALTER TABLE price_observations ADD COLUMN resolution TEXT;
ALTER TABLE price_observations ADD COLUMN algorithm_version TEXT;
CREATE INDEX price_asset_source_time ON price_observations(chain,asset_address,source_timestamp);
ALTER TABLE fee_events ADD COLUMN price_reason TEXT;
ALTER TABLE fee_events ADD COLUMN price_source TEXT;
ALTER TABLE fee_events ADD COLUMN price_resolution TEXT;
ALTER TABLE fee_events ADD COLUMN price_algorithm_version TEXT;
CREATE INDEX fee_events_unpriced ON fee_events(timestamp DESC) WHERE volume_usd IS NULL;
CREATE TABLE price_backfill_attempts (
  pool_id TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  reason TEXT NOT NULL,
  retry_at INTEGER NOT NULL,
  PRIMARY KEY(pool_id,tx_hash,log_index)
);
CREATE TABLE cohort_aggregates (
  cohort_key TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  calculated_at INTEGER NOT NULL,
  data TEXT NOT NULL
);
