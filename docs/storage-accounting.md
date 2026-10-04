# Storage accounting

Burn-in uses SQLite dbstat for every table/index at start/hourly/end, plus row counts, database file bytes, WAL bytes, freelist bytes and filesystem free space. Per-object signed deltas use the same methodology. Total growth is max(0,net occupied-page growth,database-file growth+WAL growth); reuse of freed pages remains visible separately. Daily rate=totalGrowthBytes*24/observedHours/2^30. Runway=freeBytes/measuredTotalBytesPerDay. Unknown/zero growth does not invent finite runway. Snapshot-only estimates never decide readiness.

Sprint8's0.079GiB/day snapshot-only and0.791GiB/day positive occupied-page estimates are different measures. Sprint9 reconciles all objects and physical allocation; actual attribution is now recorded in sprint9-validation.md. Report top contributors, snapshots separately, WAL/freelist and index deltas, including signed decreases. Archive/backup disk use is outside DB growth but affects actual free disk/runway.

Disk thresholds:HIGH<25GiB,CRITICAL<15GiB,EMERGENCY<8GiB. CRITICAL pauses historical price/fee work and verbose routine traces; depth is HOT-first. EMERGENCY pauses economic/depth/history work, keeping live ingestion, minute core writing and due outcomes. No automatic history archival/deletion orVACUUM. Raw diagnostic tracing has bounded configurable retention; compact metrics remain.

`pnpm storage:compact` defaults to dry-run. `--execute` explicitly verifies a compressed batch archive and integrity manifest before transactional deletion, preserving research/watchlist windows. Batch cap500 is not a full-table reclaim estimate. Internal SQLite pages remain reusable; deleting rows does not shrink a file. Sprint8 frozen dataset checksum verified, full integrity `ok`; dry-run0 eligible rows. No live destructive compaction executed.

SetARCHIVE_PATH to a mounted external directory for archives/cold exports/backups. Dry-run warns when archive and DB share a filesystem. Verify mount, available capacity, manifest/checksum and restored integrity before deleting any source copy manually. Live SQLite is not automatically moved. FullVACUUM needs a separate maintenance plan and sufficient headroom; incremental vacuum is not enabled on this existing database layout.

## Measured allocation

Actual total rate 0.456674GiB/day over 24.019748 profile hours: net tables 285,728,768 bytes, indexes 107,163,648, physical DB expansion 392,433,664, WAL expansion 98,319,680. Conservative total growth 490,753,344 bytes. pool_snapshots alone adds 0.086198GiB/day; fee_events adds 0.084655GiB/day before its indexes. End SQLite 8.660561GiB, WAL 113,085,792 bytes, free disk 35.566093GiB, runway 77.881 days. ADDITIONAL STORAGE REQUIRED at this rate (about 5.53GiB more free for 90 days, excluding reserve). Full post-run integrity/ANALYZE/TRUNCATE checkpoint passed. [All 115 table/index deltas and limitations](sprint9-validation.md).
