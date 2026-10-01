-- UNIQUE(pool_id,timestamp) already creates an identical SQLite autoindex.
DROP INDEX snapshots_pool_time;
