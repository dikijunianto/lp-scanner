CREATE TABLE storage_measurements (
  measured_at INTEGER PRIMARY KEY,
  database_bytes INTEGER NOT NULL,
  free_bytes INTEGER NOT NULL,
  objects_json TEXT NOT NULL
);
