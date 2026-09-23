CREATE TABLE price_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chain TEXT NOT NULL,
  asset_address TEXT NOT NULL,
  symbol TEXT NOT NULL,
  price_usd REAL NOT NULL,
  source TEXT NOT NULL,
  source_timestamp INTEGER,
  observed_at INTEGER NOT NULL,
  block_number TEXT,
  confidence TEXT NOT NULL
);
CREATE INDEX price_asset_time ON price_observations(chain, asset_address, observed_at);

CREATE TABLE fee_cursors (
  pool_id TEXT PRIMARY KEY,
  block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  start_block INTEGER NOT NULL,
  start_time INTEGER NOT NULL,
  end_time INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE fee_events (
  pool_id TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  volume_usd REAL,
  fees_usd REAL,
  confidence TEXT NOT NULL,
  PRIMARY KEY(pool_id, tx_hash, log_index)
);
CREATE INDEX fee_events_pool_time ON fee_events(pool_id, timestamp);
CREATE TABLE fee_windows (
  pool_id TEXT NOT NULL,
  window_name TEXT NOT NULL,
  window_end INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY(pool_id, window_name, window_end)
);
CREATE TABLE depth_observations (
  pool_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY(pool_id, block_id)
);
CREATE INDEX depth_pool_time ON depth_observations(pool_id, timestamp);
