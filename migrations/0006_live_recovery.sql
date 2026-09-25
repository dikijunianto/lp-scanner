CREATE TABLE live_fee_cursors (
  pool_id TEXT PRIMARY KEY REFERENCES pools(id),
  chain TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  start_block INTEGER NOT NULL,
  start_time INTEGER NOT NULL,
  end_time INTEGER NOT NULL,
  head_block INTEGER NOT NULL,
  head_time INTEGER NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX live_fee_chain_lag ON live_fee_cursors(chain,updated_at);
ALTER TABLE signal_outcomes ADD COLUMN started_at INTEGER;
ALTER TABLE signal_outcomes ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE signal_outcomes ADD COLUMN last_error TEXT;
ALTER TABLE signal_outcomes ADD COLUMN completeness_pct REAL;
ALTER TABLE signal_outcomes ADD COLUMN missing_reasons TEXT;
CREATE INDEX outcomes_ready ON signal_outcomes(status,due_at);
CREATE INDEX outcomes_completed_time ON signal_outcomes(completed_at);
ALTER TABLE signal_episodes ADD COLUMN sample_meta TEXT;
CREATE INDEX fee_events_time ON fee_events(timestamp);
CREATE INDEX prices_observed_time ON price_observations(observed_at);
CREATE INDEX signals_start_time ON signal_episodes(episode_start);
CREATE TABLE depth_failures (
  pool_id TEXT NOT NULL REFERENCES pools(id),
  reason TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  last_at INTEGER NOT NULL,
  PRIMARY KEY(pool_id,reason)
);
ALTER TABLE rpc_providers ADD COLUMN circuit_state TEXT NOT NULL DEFAULT 'CLOSED';
ALTER TABLE rpc_providers ADD COLUMN failure_reason TEXT;
