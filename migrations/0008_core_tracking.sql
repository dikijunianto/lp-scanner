CREATE TABLE core_tracking_intervals (
  pool_id TEXT NOT NULL REFERENCES pools(id),
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  PRIMARY KEY(pool_id,started_at)
);
CREATE INDEX core_tracking_open ON core_tracking_intervals(ended_at,pool_id);
