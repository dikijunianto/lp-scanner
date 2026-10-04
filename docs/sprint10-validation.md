# Sprint10 validation

Status: IMPLEMENTED; final measured24h validation PENDING. No READY claim or dataset freeze.

Branch codex/sprint-10-clean-epoch continues Sprint9, preserving prior reports/history. Pre-migration consistent backup: data/before-sprint10.sqlite (9,301,786,624bytes). Additive epochs, interval/source coverage and fee-invariant migrations preserve old rows. No signing, transactions, Strategy Lab, VACUUM, automatic archival or index deletion.

Final prelaunch checks:196 deterministic tests passed; lint, typecheck and production build passed. Full live SQLite integrity returned ok in96.657s; ANALYZE completed and stopped-service TRUNCATE checkpoint returned busy0/log0/checkpointed0. Repeat full integrity with stopped services after observation. Actual process/run/epoch IDs and timing are appended once launched.

Production configuration for observation: Economic refresh30s, Meteora state limit80, HOT reservation200; other limits remain existing configuration. A one-hour preserved maturity lead precedes the actual uninterrupted24h interval. Keep-awake must stay alive. No runtime/methodology changes during either phase. Any failed evidence remains retained.

The final report must contain all33 user fields, using actual observation data: run ID; epoch ID; foreground quantiles; breaches; snapshot continuity/gaps; Base active cursor freshness and lag; fees; HOT pricing; direct/derived and failure counts; conditional/absolute depth; mature4h/24h cohorts; new outcome delay; services; DB/WAL endpoints; total allocation rate and top contributors; full-snapshot/fee-event/index/price rates; disk/runway; hourly gate compliance; selected-chain/BSC readiness; failed gates; freeze status; recommended Sprint11.

Known limits before measurement: conservative graph screens can leave thin tokens unavailable; state/depth provider budgets may still limit coverage; lossless compression and invariant references do not establish the storage target. Exact prior39.5s query remains unproven without its original trace. Final stability and readiness must be reported separately.

## Preserved lead attempt

Run3f5c8017-2a84-408a-8ea8-31dcefc86d2f / epoch7751396e-5bd0-4d40-ab6d-35d92279db45 began its maturity lead at4Oct21:17:09WIB. It was explicitly invalidated with FREEZE_COHORT_ENDPOINT_GUARD before the formal24h window: freeze must require the matching run's own READY verdict, and completed-epoch outcome eligibility must stop at endedAt. Its report/lead samples and database history remain preserved. This is a failed lead, not a completed or reset24h run.

## Preserved startup attempt

The14:22:43UTC launcher eventually started lead run9c3a08a9-06df-4d6d-9071-62db49af0513 / epochac49af46-3a39-4e78-a0ee-1033d3a022ef at21:25:15WIB. It was interrupted before observation to correct service evidence and startup polling; all five lead samples, original run evidence and invalid epoch remain retained. Neither previous lead attempt started the formal24h observation. Startup polling also approached the120requests/minute local API cap; it is now5seconds. Verified reconstruction evidence supplements pool-state evidence without suppressing per-pool failure counts.

## Active validation

Report: reports/burnin-2026-10-04T14-33-15-707Z.json. Burnin run7ca19b94-adef-4b51-8028-10a3fc2665a8; epochbb25023c-0761-433f-9a1d-eab576f9541a. Launcher62054, keep-awake62063. Lead began4Oct2026 21:34:40WIB; expected observation4Oct22:34:40–5Oct22:34:40WIB. Actual paired start/end in the persisted run remain authoritative. Methodology frozen at d263d38. Hourly follow-up is scheduled to finish the actual33-field report, verify integrity and freeze only if READY. Startup/UI checks show read-only health and correct NOT_READY/missing-data displays; required services were acceptable at epoch creation. No final coverage or storage target is claimed.
