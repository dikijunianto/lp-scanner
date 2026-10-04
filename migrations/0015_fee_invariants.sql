-- Only future writes use these immutable references. Historical rows remain unchanged.
CREATE TABLE fee_event_invariants (
  id INTEGER PRIMARY KEY,
  invariant_key TEXT NOT NULL UNIQUE,
  pool_address TEXT,
  source_type TEXT,
  source_id TEXT
);
ALTER TABLE fee_events ADD COLUMN invariant_id INTEGER REFERENCES fee_event_invariants(id);
