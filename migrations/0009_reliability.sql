CREATE TABLE scan_phase_spans (
  run_id INTEGER NOT NULL REFERENCES scanner_runs(id),
  phase TEXT NOT NULL,
  operation TEXT NOT NULL,
  provider TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  timeout_ms INTEGER,
  success INTEGER NOT NULL,
  PRIMARY KEY(run_id,phase,operation,provider,started_at)
);
CREATE INDEX scan_phase_run ON scan_phase_spans(run_id);
CREATE TABLE core_writer_runs (
  minute INTEGER PRIMARY KEY,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  rows_written INTEGER NOT NULL,
  busy_retries INTEGER NOT NULL,
  state TEXT NOT NULL
);
