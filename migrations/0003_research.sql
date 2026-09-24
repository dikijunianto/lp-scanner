ALTER TABLE fee_events ADD COLUMN chain TEXT;
ALTER TABLE fee_events ADD COLUMN pool_address TEXT;
ALTER TABLE fee_events ADD COLUMN amount0 TEXT;
ALTER TABLE fee_events ADD COLUMN amount1 TEXT;
ALTER TABLE fee_events ADD COLUMN price_usd0 REAL;
ALTER TABLE fee_events ADD COLUMN price_usd1 REAL;
ALTER TABLE fee_events ADD COLUMN gross_fee_usd REAL;
ALTER TABLE fee_events ADD COLUMN lp_fee_usd REAL;
ALTER TABLE fee_events ADD COLUMN fee_tier REAL;
ALTER TABLE fee_events ADD COLUMN protocol_fee_raw TEXT;
ALTER TABLE fee_events ADD COLUMN price_confidence TEXT;
ALTER TABLE fee_events ADD COLUMN sender TEXT;
CREATE UNIQUE INDEX fee_events_chain_tx_log ON fee_events(chain, tx_hash, log_index);

CREATE TABLE fee_backfill_jobs (
  pool_id TEXT PRIMARY KEY REFERENCES pools(id),
  chain TEXT NOT NULL,
  pool_address TEXT NOT NULL,
  start_block INTEGER,
  end_block INTEGER,
  last_confirmed_block INTEGER,
  next_backfill_block INTEGER,
  status TEXT NOT NULL DEFAULT 'NOT_STARTED',
  retry_count INTEGER NOT NULL DEFAULT 0,
  failure_reason TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX fee_backfill_priority ON fee_backfill_jobs(status, priority DESC, updated_at);

CREATE TABLE fee_block_checkpoints (
  pool_id TEXT NOT NULL REFERENCES pools(id),
  block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  PRIMARY KEY(pool_id, block_number)
);
CREATE INDEX fee_checkpoints_desc ON fee_block_checkpoints(pool_id, block_number DESC);

CREATE TABLE fee_minute_buckets (
  pool_id TEXT NOT NULL REFERENCES pools(id),
  bucket_start INTEGER NOT NULL,
  volume_usd REAL NOT NULL DEFAULT 0,
  gross_fees_usd REAL NOT NULL DEFAULT 0,
  lp_fees_usd REAL NOT NULL DEFAULT 0,
  swap_count INTEGER NOT NULL DEFAULT 0,
  unpriced_count INTEGER NOT NULL DEFAULT 0,
  gross_unknown_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(pool_id, bucket_start)
);

CREATE TABLE watchlist (
  pool_id TEXT PRIMARY KEY REFERENCES pools(id),
  added_at INTEGER NOT NULL
);

CREATE TABLE signal_episodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pool_id TEXT NOT NULL REFERENCES pools(id),
  signal_type TEXT NOT NULL,
  episode_start INTEGER NOT NULL,
  episode_last_seen INTEGER NOT NULL,
  episode_end INTEGER,
  peak_score REAL,
  scanner_version TEXT NOT NULL,
  activity_score_version TEXT NOT NULL,
  risk_score_version TEXT NOT NULL,
  signal_rule_version TEXT NOT NULL,
  reason_json TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE UNIQUE INDEX one_active_signal_episode ON signal_episodes(pool_id, signal_type) WHERE episode_end IS NULL;
CREATE INDEX signals_type_time ON signal_episodes(signal_type, episode_start DESC);
CREATE INDEX signals_pool_time ON signal_episodes(pool_id, episode_start DESC);

CREATE TABLE signal_outcomes (
  signal_id INTEGER NOT NULL REFERENCES signal_episodes(id),
  horizon TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  completed_at INTEGER,
  data TEXT,
  PRIMARY KEY(signal_id, horizon)
);
CREATE INDEX outcomes_due ON signal_outcomes(status, due_at);

CREATE TABLE worker_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  status TEXT NOT NULL,
  api_requests INTEGER NOT NULL DEFAULT 0,
  rpc_requests INTEGER NOT NULL DEFAULT 0,
  cache_hits INTEGER NOT NULL DEFAULT 0,
  queue_length INTEGER NOT NULL DEFAULT 0,
  notes TEXT
);

CREATE TABLE scan_metrics (
  run_id INTEGER PRIMARY KEY REFERENCES scanner_runs(id),
  duration_ms INTEGER NOT NULL,
  api_requests INTEGER NOT NULL,
  rpc_requests INTEGER NOT NULL,
  cache_hits INTEGER NOT NULL
);
