CREATE TABLE research_epochs (
  id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, ended_at INTEGER,
  status TEXT NOT NULL CHECK(status IN ('ACTIVE','COMPLETE','INVALID')),
  methodology_versions TEXT NOT NULL, chain_set TEXT NOT NULL, reason TEXT NOT NULL,
  invalidation_reason TEXT
);
CREATE UNIQUE INDEX one_active_epoch ON research_epochs(status) WHERE status='ACTIVE';
ALTER TABLE signal_episodes ADD COLUMN research_epoch_id TEXT REFERENCES research_epochs(id);
ALTER TABLE signal_outcomes ADD COLUMN research_epoch_id TEXT REFERENCES research_epochs(id);
CREATE INDEX signals_epoch ON signal_episodes(research_epoch_id,episode_start);
CREATE INDEX outcomes_epoch ON signal_outcomes(research_epoch_id,due_at);
CREATE TABLE burnin_runs (
  id TEXT PRIMARY KEY, research_epoch_id TEXT NOT NULL REFERENCES research_epochs(id),
  started_at INTEGER, ended_at INTEGER, expected_duration_ms INTEGER NOT NULL,
  actual_duration_ms REAL, status TEXT NOT NULL, validation_version TEXT NOT NULL,
  keep_awake_status TEXT NOT NULL, data TEXT NOT NULL
);
CREATE TABLE depth_refresh_queue(pool_id TEXT PRIMARY KEY REFERENCES pools(id),
  enqueued_at INTEGER NOT NULL, reason TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0);
CREATE TABLE price_source_coverage(chain TEXT NOT NULL,asset_address TEXT NOT NULL,source TEXT NOT NULL,
  last_success INTEGER,last_failure INTEGER,failure_reason TEXT,publication_timestamp INTEGER,
  coverage_resolution TEXT,publication_latency_ms INTEGER,confidence TEXT,kind TEXT,
  PRIMARY KEY(chain,asset_address,source));
CREATE TABLE live_coverage_intervals(pool_id TEXT NOT NULL,start_time INTEGER NOT NULL,end_time INTEGER NOT NULL,
  start_block INTEGER NOT NULL,end_block INTEGER NOT NULL,end_hash TEXT NOT NULL,source_id TEXT,
  valid INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(pool_id,start_block,end_block));
INSERT INTO dataset_versions VALUES ('sprint10-v4',CAST(strftime('%s','now') AS INTEGER)*1000,
  'CORE_NUMERIC_V2_FULL_SIGNAL_TIERED','LIVE_INTERVALS_V3','PRICE_TRIGGERED_5PCT_V3',
  'SAFE_PRICE_GRAPH_V3','CLEAN_EPOCH_DENSITY_V3');
