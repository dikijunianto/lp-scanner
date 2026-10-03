# Sprint 9 reliability

Implementation preserves existing architecture, migrations, history and UI. Everything remains read-only. No Strategy Lab, wallet, transactions or recommendations.

## Deadline investigation

Sprint8 run2689 lasted39.504s. Its original child trace was not persisted; the exact responsible operation cannot be recovered. The previous API performed synchronous full-history SQLite aggregates in the same event loop as foreground scans. Such work prevents AbortController timers from running. Awake Sprint9 profiling confirms several-second aggregate work (HOT coverage2.467s; database growth1.153s; outcome coverage0.780s), supporting this mechanism without pretending it proves the historical query.

The scanner now has a separate supervisor process and one disposable child per scan. Default15s; configured maximum20s. The parent kills a hung child, records a deadline failure and aborted pending spans, retains committed partial data, and prevents overlapping children. A deterministic child that enters an infinite synchronous loop is terminated in the1500ms test. Process startup counts in root duration. OS suspension can delay any process; clock events and keep-awake are recorded, and affected observations cannot pass.

Every scan retains compact root duration/deadline/error metadata. Full child spans persist for failures, slow scans and configurable5% routine samples; raw retention48h (24–72h configurable). Debug notes expire while aggregate worker metrics remain. Clock detection distinguishes wall/monotonic divergence from a scheduler delay; CPU blocking is never declared proven sleep. Workers retain confirmed cursors, refetch heads each cycle, expire data by timestamps and use existing idempotent job keys on wake.

Diagnostics aggregates run in their own worker. API reads one compact materialized record; age is measured from aggregation start. Stale summaries are clearly marked and fail hourly evidence. Profiling is persisted in the summary. Pre-run20-request local smoke p95: reliability4.415ms, data-health3.709ms. Browser reload/navigation40ms, including read-only heading verification within a0.262s control call; this is a local smoke, not a24h page latency distribution.

Validation:136 deterministic tests passed; lint/typecheck/production build passed. Live SQLite full integrity `ok`, ANALYZE and TRUNCATE checkpoint passed with services stopped. Pre-migration backup retained at data/before-sprint9.sqlite. Sprint8 frozen archive checksum and restored integrity verified; compaction dry-run found0 eligible event/snapshot rows,0 affected signals/outcomes. No compaction executed.

## Remaining proof

Actual uninterrupted24h run and27-field final report are required. Targets are not claimed from startup measurements. See24h-burnin.md and readiness-v3.md. BSC remains outside selected-chain readiness.
