CREATE TABLE diagnostic_summaries (id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE scan_traces (run_id INTEGER PRIMARY KEY REFERENCES scanner_runs(id), started_at INTEGER NOT NULL,
  finished_at INTEGER NOT NULL, duration_ms INTEGER NOT NULL, monotonic_ms REAL NOT NULL,
  deadline_ms INTEGER NOT NULL, deadline_breached INTEGER NOT NULL, error_class TEXT);
CREATE TABLE system_clock_events (detected_at INTEGER PRIMARY KEY, event TEXT NOT NULL,
  wall_elapsed_ms REAL NOT NULL, monotonic_elapsed_ms REAL NOT NULL);
CREATE TABLE live_pool_health (pool_id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL,
  reason TEXT NOT NULL, last_error TEXT, swaps INTEGER);
CREATE INDEX outcome_due_created ON signal_outcomes(due_at,completed_at);
ALTER TABLE price_observations ADD COLUMN provenance_json TEXT;
ALTER TABLE scan_phase_spans ADD COLUMN aborted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scan_phase_spans ADD COLUMN error_class TEXT;
ALTER TABLE scan_phase_spans ADD COLUMN monotonic_ms REAL;
CREATE TABLE outcome_retry_state(signal_id INTEGER NOT NULL,horizon TEXT NOT NULL,
  input_hash TEXT NOT NULL,last_attempt_at INTEGER NOT NULL,last_checked_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(signal_id,horizon));
INSERT INTO dataset_versions VALUES ('sprint9-v3',CAST(strftime('%s','now') AS INTEGER)*1000,
  'CORE_NUMERIC_V2_FULL_SIGNAL_TIERED','LIVE_BUCKETS_V2','BOUNDED_5PCT_V2','CROSS_POOL_CONSENSUS_V2','PRICE_RANGE_STATUS_V2');
CREATE TABLE hourly_slo_checkpoints (burnin_id TEXT NOT NULL, hour INTEGER NOT NULL,
  observed_at INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(burnin_id,hour));
