CREATE TABLE core_snapshots (
  pool_id TEXT NOT NULL REFERENCES pools(id),
  timestamp INTEGER NOT NULL,
  source_updated_at INTEGER NOT NULL,
  price REAL,
  price_confidence TEXT NOT NULL,
  activity REAL,
  risk REAL,
  volume_1h REAL,
  fees_1h REAL,
  active_liquidity_usd REAL,
  depth5_usd REAL,
  volatility_1h REAL,
  methodology_version TEXT NOT NULL DEFAULT 'sprint7-core-v1',
  PRIMARY KEY(pool_id,timestamp)
);
CREATE INDEX core_snapshots_time ON core_snapshots(timestamp);
CREATE TABLE dataset_versions (
  version TEXT PRIMARY KEY,
  valid_from INTEGER NOT NULL,
  snapshot_method TEXT NOT NULL,
  fee_method TEXT NOT NULL,
  depth_method TEXT NOT NULL,
  price_method TEXT NOT NULL,
  outcome_method TEXT NOT NULL
);
INSERT INTO dataset_versions VALUES ('sprint7-v1',CAST(strftime('%s','now') AS INTEGER)*1000,
  'CORE_1M_FULL_TIERED_V1','LIVE_BUCKETS_V1','BOUNDED_5PCT_V1','CONSENSUS_V1','FIELD_GROUPS_V1');
CREATE TABLE fee_gaps (
  pool_id TEXT NOT NULL REFERENCES pools(id),
  from_block INTEGER NOT NULL,
  to_block INTEGER NOT NULL,
  from_time INTEGER NOT NULL,
  to_time INTEGER NOT NULL,
  reason TEXT NOT NULL,
  detected_at INTEGER NOT NULL,
  resolved_at INTEGER,
  PRIMARY KEY(pool_id,from_block,to_block)
);
CREATE INDEX fee_gaps_open ON fee_gaps(pool_id,resolved_at,from_time,to_time);
CREATE TABLE scan_slow_calls (
  run_id INTEGER NOT NULL REFERENCES scanner_runs(id),
  source TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  reason TEXT NOT NULL
);
CREATE TABLE depth_reconstruction_cache (
  pool_id TEXT PRIMARY KEY REFERENCES pools(id),
  state_key TEXT NOT NULL,
  block_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE live_ingestion_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chain TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  pools INTEGER NOT NULL,
  swaps INTEGER NOT NULL,
  error TEXT
);
CREATE INDEX live_ingestion_chain_time ON live_ingestion_runs(chain,started_at DESC);
CREATE TABLE watchlist_history (
  pool_id TEXT NOT NULL REFERENCES pools(id),
  added_at INTEGER NOT NULL,
  removed_at INTEGER,
  PRIMARY KEY(pool_id,added_at)
);
INSERT INTO watchlist_history(pool_id,added_at) SELECT pool_id,added_at FROM watchlist;
ALTER TABLE fee_events ADD COLUMN event_source_type TEXT;
ALTER TABLE fee_events ADD COLUMN event_source_id TEXT;
CREATE TABLE event_source_checks (
  chain TEXT NOT NULL,
  source_id TEXT NOT NULL,
  checked_at INTEGER NOT NULL,
  compared_events INTEGER NOT NULL,
  disagreements INTEGER NOT NULL,
  error TEXT
);
CREATE INDEX event_source_checks_chain_time ON event_source_checks(chain,checked_at);
CREATE TABLE event_sources (
  source_id TEXT PRIMARY KEY,
  chain TEXT NOT NULL,
  source_type TEXT NOT NULL,
  purpose TEXT NOT NULL,
  latest_indexed_block INTEGER,
  latency_ms INTEGER,
  historical_from_block INTEGER,
  confidence TEXT NOT NULL DEFAULT 'UNAVAILABLE',
  health_state TEXT NOT NULL DEFAULT 'UNAVAILABLE',
  last_success_at INTEGER,
  last_failure_at INTEGER,
  error TEXT
);
