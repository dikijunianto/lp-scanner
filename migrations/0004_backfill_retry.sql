ALTER TABLE fee_backfill_jobs ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0;
CREATE INDEX fee_backfill_due ON fee_backfill_jobs(next_attempt_at, status, priority DESC);
