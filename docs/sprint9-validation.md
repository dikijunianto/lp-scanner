# Sprint 9 measured validation — 4 October 2026

**Selected-chain readiness: NOT_READY. Raw burn-in acceptance: FAIL. Observed deadline, health and tracked snapshot cadence checks: PASS.** No Strategy Lab dataset freeze was created.

Production implementation `6141b96`, launch documentation `3c22aec`, branch `codex/sprint-9-reliability`. Actual window: 3 October 20:09:54.927 to 4 October 20:09:54.932 WIB (24.000001389 wall-clock hours). Keep-awake enabled; launcher and owned services stopped automatically after report creation. No runtime edits or restarts occurred during the window.

Raw evidence `reports/burnin-2026-10-03T13-09-15-803Z.json`, SHA-256 `5be664687add1d8dc593cce09893e411b1bb7a5e9303bf369614ed79be6c04cb`. Supplemental local evidence: `reports/sprint9-final-audit.json`, `reports/sprint9-integrity-after-burnin.json`, `reports/sprint9-restart-smoke.json`. Raw JSON remains unchanged.

## Required 27-field report

| # | Field | Actual result |
|---|---|---|
| 1 | Root cause of the historical 39.5s scan | Exact operation unproven: original trace absent. Shared synchronous diagnostic aggregates blocking the scanner event loop are a supported mechanism; Sprint 9 separates both workers and supervises scan children. |
| 2 | Full-window foreground latency | 1,360 scans: median 3.324s; p95 5.284s; p99 6.030s; maximum 8.183s. Includes every persisted root trace started within the window. |
| 3 | Deadline breaches | 0. No root errors; all 1,360 scanner runs are degraded. Source errors: Meteora 80, Uniswap 16, PancakeSwap 14; none discarded. |
| 4 | Mac sleep / clock events | 0 recorded SYSTEM_CLOCK_JUMP or proven sleep events; 151 SYSTEM_SCHEDULER_DELAY events, maximum 26.893s. Raw clock discrepancy 84.622s is invalid endpoint accounting, not evidence of sleep. |
| 5 | Diagnostics API / page latency | Post-restart 20 requests each: reliability p95 4.951ms; data-health 4.808ms. Page reload 45ms; NOT_READY verified within 171ms. Local smoke only, no full-window page latency distribution. |
| 6 | Base HOT cursor freshness | 7/8 = 87.5%; all HOT 8, active-or-missing 8, proven NO_ACTIVITY 0. Hourly freshness target reached at 0/24 checkpoints. |
| 7 | Base HOT cursor lag | Nearest-rank median 35.311s; p95/max 189,031.311s (52.509h). Known 8/8; unknown 0. All pools retained, including xdp RPC_FAILURE. |
| 8 | Base HOT active current 1h fees | 4/8 = 50%; all-HOT denominator also 8. Hourly 80% target reached at 0/24 checkpoints. |
| 9 | HOT Solana + Base reliable pair prices | 22/104 = 21.154%: Solana 17/96, Base 5/8. Missing 82 pools remain in denominator. Hourly 80% target reached at 0/24. |
| 10 | HOT current ±5% depth | 13/22 = 59.091% among reliably priced HOT pools; 17/104 = 16.346% among all HOT pools (some depth has unavailable current pair pricing). Hourly 70% priced target reached at 1/24. |
| 11 | Core snapshot continuity | 149,614/149,614 = 100%, 369 pools across 1,183 recorded HOT tracking intervals; 69 mature. Reliable price fields 26,610 (17.786%), fees 45,351 (30.312%), depth 12,352 (8.256%). Cadence does not imply economic completeness. |
| 12 | Largest unexplained snapshot gap | 0 tracked gaps over 120s. Full-window interval audit maximum 65.073s; saved boundary-sensitive diagnostic maximum 89.384s. Unfiltered consecutive-row audit has 755 gaps over 120s, maximum 20.683h, across separate HOT tracking intervals; excluded tracking periods are explicit, not fabricated continuity. |
| 13 | 4h PRICE_RANGE_COMPLETE | Saved end summary: 728/3,136 = 23.214%. PARTIAL and older COMPLETE labels do not qualify. Post-stop audit: 731/3,136 (some completion writes occurred after summary generation). Acceptance uses saved summary. |
| 14 | 24h PRICE_RANGE_COMPLETE | 0/1,935 = 0%. Post-stop mature STANDARD selected cohort: 1,934 PARTIAL, 1 UNAVAILABLE. No PARTIAL promoted to complete. |
| 15 | New-outcome p95 lateness | 268,999ms = 4.483min, 7,533 completed new jobs. Post-stop audit retained 44 due incomplete new jobs: 30m 12, 1h 3, 4h 29; maximum overdue 173.638s. Completed-only p95 is explicitly not a pending-job percentile. |
| 16 | Total database size | End physical SQLite 8.660561GiB; WAL 113,085,792 bytes. Post-checkpoint database 9,300,336,640 bytes (8.661613GiB). |
| 17 | Actual total allocation growth | 0.456674GiB/day over 24.019748 profile hours. max(net occupied 392,892,416; DB + WAL expansion 490,753,344; 0) bytes. Profiling brackets the 24h operational window. |
| 18 | Top growth contributors | WAL expansion 98,319,680 bytes; pool_snapshots 92,631,040; fee_events 90,972,160; fee_events unique index 30,220,288; core_snapshots 26,226,688; fee_windows 18,644,992. Net tables 285,728,768; indexes 107,163,648 bytes. Full object ledger below. |
| 19 | Full-snapshot growth | pool_snapshots 0.086198GiB/day (table only); core_snapshots separately 0.024405GiB/day. Neither substitutes for total allocation growth. |
| 20 | Free disk | 35.566093GiB at final storage profile; retained backups/archive included in filesystem use. |
| 21 | Disk runway | 77.881 days from total measured growth. ADDITIONAL STORAGE REQUIRED at this rate: about 5.53GiB more free space for 90 days, excluding reserve. |
| 22 | 24 hourly SLO series | 24/24 healthy fresh checkpoints, 1,441 samples, 0 failed samples, maximum sample spacing 60.752s. Cursor 0/24; fees 0/24; prices 0/24; depth 1/24; snapshot 24/24; providers healthy 7/24. Hour-by-hour ledger below; no bad evidence reset. |
| 23 | Selected-chain readiness | Solana + Base NOT_READY. Raw burn-in acceptance FAIL; observed deadline/health/cadence operational checks PASS. Clock validation cannot establish a clean accepted PASS. |
| 24 | BSC readiness | BSC_NOT_READY_NO_LOG_SOURCE: bscSource.liveLogs=false, historicalLogs=false, archiveState=false, WebSocket DISABLED. Raw report/UI BSC_NOT_READY and passing BSC_LOG_SOURCE reflect stale PUBLIC metadata; they are not proof of a configured capable source. |
| 25 | Exact failed readiness gates | OUTCOME_4H, OUTCOME_24H, BASE_CURSOR_HOURLY, BASE_FEES_HOURLY, HOT_PRICE, HOT_DEPTH, STORAGE_GROWTH, STORAGE_RUNWAY, PROVIDER_STABILITY. Separately raw burn-in clock acceptance fails; it is outside the 17 readiness gates. |
| 26 | Strategy Lab dataset freeze | NO new Sprint 9 freeze: readiness failed. Sprint 8 frozen checksum/restored integrity verified; its dry-run compaction had 0 eligible event/snapshot rows and 0 affected protected signals/outcomes. No execution. |
| 27 | Recommended Sprint 10 | Reliability follow-up before Strategy Lab: fix simultaneous clock endpoints and BSC configured-source gating, retain per-hour HOT membership/lag evidence, resolve Base RPC rate limits/budgets and persistent xdp cursor lag, expand timestamped reliable pricing, recover priced depth and mature complete outcomes, and reduce measured table/index/WAL growth or provide external capacity. Then a new, separately identified 24h run. |

## Acceptance limitations and maintenance

The launcher captures `finished=Date.now()` at the window boundary, then performs final diagnostics and two full storage profiles before evaluating `performance.now()`. The wall and monotonic end points are different. The resulting 84.622s discrepancy includes post-window work and cannot diagnose suspension or prove actual clock drift. No corrected monotonic endpoint exists; the original FAIL is retained. Fix instrumentation and rerun rather than relabeling this report.

The final saved diagnostic summary was generated 30.621s before the window ended. SQL audited after shutdown can include final worker writes after that summary; its outcome counts are labeled separately. HOT membership changes are preserved through tracking intervals. Consecutive snapshots across inactive intervals are not expected cadence. Minute samples omit HOT details, but hourly checkpoints retain them. The hourly Base lag distribution includes every active-or-missing HOT pool, with known and unknown denominators explicitly reported below.

All 110 source error records were inspected: 75 report source unavailable/configuration/connectivity; 35 report failed/timed-out upstream requests. Generic saved messages cannot distinguish each underlying network exception. All 1,360 runs are degraded because incomplete protocol discovery fields remain unavailable, even when source status is not error. Zero root crashes does not imply zero provider failures.

136 tests, lint, typecheck and production build passed against unchanged implementation before launch. After automatic shutdown, full SQLite integrity returned `ok`, ANALYZE completed, and TRUNCATE checkpoint returned `(0,0,0)` in 96.465s. Production restarted successfully; health is `ok`, `readOnly=true`, all service-running flags true; diagnostics summary fresh. Browser verified READ-ONLY and NOT_READY. Base remains degraded with request-budget/rate-limit evidence; BSC source remains disabled. These are live limitations, not a healthy-provider claim. No VACUUM, destructive compaction, automatic archival or history rewrite ran. Pre-migration backup and Sprint 8 frozen archive retained.

Passed readiness gates: OBSERVATION_24H, FOREGROUND_P95, FOREGROUND_P99, FOREGROUND_MAX, DEADLINE_BREACHES, SNAPSHOT_CONTINUITY, SNAPSHOT_MAX_GAP, NEW_OUTCOME_LATENESS. Borderline labels from report: OBSERVATION_24H, SNAPSHOT_CONTINUITY. These labels do not waive failed gates or the invalid clock comparison.

## Hourly checkpoint series

Latency columns are independent one-hour root-trace distributions; all other fields use that saved checkpoint. Every checkpoint has healthy continuous samples and a fresh summary; every hour has zero breaches and 100% tracked snapshot coverage. Pool membership changes remain in the denominators.

| Hour | Scans | Median / p95 / p99 / max (s) | Base fresh / active (all) | Fees / active | Price % | Depth / priced % | 4h complete / eligible | 24h complete / eligible | New p95 min | Provider healthy | DB / free GiB |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 57 | 3.221 / 5.284 / 5.595 / 5.595 | 0/7 (7) | 0/7 | 25.00 | 39.13 | 0/1935 | 0/1935 | 4.477 | no | 8.335 / 37.208 |
| 2 | 56 | 3.301 / 4.693 / 5.183 / 5.183 | 0/8 (8) | 0/8 | 26.73 | 22.22 | 0/1935 | 0/1935 | 4.478 | no | 8.343 / 37.161 |
| 3 | 57 | 3.125 / 5.452 / 5.563 / 5.563 | 6/8 (8) | 4/8 | 28.00 | 53.57 | 0/1935 | 0/1935 | 4.476 | no | 8.398 / 35.439 |
| 4 | 57 | 3.112 / 4.941 / 5.199 / 5.199 | 5/6 (6) | 2/6 | 28.18 | 58.06 | 0/1935 | 0/1935 | 4.476 | no | 8.412 / 35.874 |
| 5 | 57 | 3.170 / 3.969 / 5.512 / 5.512 | 5/9 (9) | 4/9 | 25.00 | 62.07 | 18/1967 | 0/1935 | 4.461 | no | 8.431 / 36.000 |
| 6 | 57 | 3.066 / 4.298 / 5.994 / 5.994 | 5/7 (7) | 5/7 | 22.86 | 33.33 | 45/2002 | 0/1935 | 4.463 | yes | 8.448 / 35.980 |
| 7 | 57 | 3.051 / 5.181 / 5.571 / 5.571 | 2/7 (7) | 4/7 | 23.58 | 52.00 | 71/2057 | 0/1935 | 4.461 | no | 8.459 / 36.127 |
| 8 | 57 | 3.071 / 4.655 / 6.287 / 6.287 | 3/7 (7) | 4/7 | 20.56 | 50.00 | 105/2145 | 0/1935 | 4.464 | no | 8.471 / 36.117 |
| 9 | 57 | 3.295 / 4.759 / 6.505 / 6.505 | 6/7 (7) | 4/7 | 21.15 | 54.55 | 161/2245 | 0/1935 | 4.464 | yes | 8.483 / 36.086 |
| 10 | 57 | 3.222 / 4.942 / 5.978 / 5.978 | 6/7 (7) | 4/7 | 17.00 | 5.88 | 219/2311 | 0/1935 | 4.475 | no | 8.494 / 36.059 |
| 11 | 57 | 3.261 / 4.889 / 4.974 / 4.974 | 4/6 (6) | 3/6 | 14.74 | 50.00 | 286/2415 | 0/1935 | 4.477 | no | 8.505 / 35.986 |
| 12 | 56 | 3.244 / 5.801 / 6.149 / 6.149 | 8/9 (9) | 5/9 | 24.07 | 57.69 | 313/2451 | 0/1935 | 4.477 | no | 8.521 / 33.655 |
| 13 | 57 | 3.648 / 5.589 / 6.456 / 6.456 | 5/10 (10) | 5/10 | 20.75 | 63.64 | 362/2526 | 0/1935 | 4.478 | no | 8.535 / 35.918 |
| 14 | 57 | 3.188 / 5.347 / 5.580 / 5.580 | 6/8 (8) | 4/8 | 22.02 | 41.67 | 417/2586 | 0/1935 | 4.478 | yes | 8.552 / 35.865 |
| 15 | 56 | 3.550 / 5.045 / 6.498 / 6.498 | 6/8 (8) | 5/8 | 21.55 | 48.00 | 426/2603 | 0/1935 | 4.478 | no | 8.563 / 35.845 |
| 16 | 57 | 3.321 / 5.562 / 5.798 / 5.798 | 3/4 (4) | 2/4 | 14.71 | 0.00 | 483/2685 | 0/1935 | 4.478 | no | 8.574 / 35.838 |
| 17 | 57 | 3.260 / 4.739 / 6.051 / 6.051 | 5/9 (9) | 4/9 | 18.18 | 55.56 | 518/2733 | 0/1935 | 4.479 | no | 8.584 / 35.796 |
| 18 | 56 | 3.831 / 5.729 / 6.433 / 6.433 | 1/6 (6) | 2/6 | 14.58 | 28.57 | 546/2789 | 0/1935 | 4.478 | no | 8.595 / 35.764 |
| 19 | 57 | 3.797 / 5.040 / 6.030 / 6.030 | 3/8 (8) | 5/8 | 17.65 | 72.22 | 591/2868 | 0/1935 | 4.479 | no | 8.605 / 35.726 |
| 20 | 56 | 3.335 / 5.673 / 6.309 / 6.309 | 7/8 (8) | 4/8 | 26.32 | 53.33 | 630/2957 | 0/1935 | 4.480 | yes | 8.617 / 34.220 |
| 21 | 56 | 4.035 / 5.644 / 5.875 / 5.875 | 6/8 (8) | 4/8 | 21.43 | 66.67 | 642/2986 | 0/1935 | 4.480 | yes | 8.628 / 35.662 |
| 22 | 56 | 4.026 / 5.968 / 8.183 / 8.183 | 6/7 (7) | 4/7 | 18.81 | 42.11 | 664/3017 | 0/1935 | 4.482 | yes | 8.639 / 35.675 |
| 23 | 57 | 3.942 / 5.476 / 7.249 / 7.249 | 5/6 (6) | 4/6 | 17.89 | 41.18 | 679/3052 | 0/1935 | 4.483 | yes | 8.648 / 35.621 |
| 24 | 56 | 3.489 / 5.640 / 6.176 / 6.176 | 7/8 (8) | 4/8 | 21.15 | 59.09 | 728/3136 | 0/1935 | 4.483 | no | 8.660 / 35.566 |

## Final Base all-HOT cursor ledger

| Pool address | Fresh | Lag s | Reason | Complete 1h USD fees |
|---|---|---|---|---|
| 0xb4cb800910b228ed3d0834cf79d697127bbb00e5 | True | 29.311 | HEALTHY | True |
| 0xd0b53d9277642d899df5c87a3966a349a798f224 | True | 35.311 | HEALTHY | True |
| 0x9c087eb773291e50cf6c6a90ef0f4500e349b903 | True | 41.311 | HEALTHY | False |
| 0xfbb6eed8e7aa03b138556eedaf5d271a5e1e43ef | True | 35.311 | HEALTHY | True |
| 0x7aea2e8a3843516afa07293a10ac8e49906dabd1 | True | 29.311 | HEALTHY | True |
| 0x29183f918920a2aef0115a9c7374945589968aea | True | 55.311 | RPC_FAILURE | False |
| 0x3d5d143381916280ff91407febeb52f2b60f33cf | True | 41.311 | HEALTHY | False |
| 0x2df380544b88adb3ad0a94100dcc45fd705aae2d | False | 189031.311 | RPC_FAILURE | False |

## All table/index allocation changes

All 115 dbstat objects, including zero and signed changes. Measurement interval 24.019748h starts just before operational observation and ends during final profiling. Tables and indexes sum to net occupied-page growth; WAL is separate physical growth and is not attributed to a table.

| Object | Kind | Start bytes | End bytes | Delta bytes | GiB/day |
|---|---|---|---|---|---|
| pool_snapshots | table | 7258406912 | 7351037952 | 92631040 | 0.086198 |
| fee_events | table | 478875648 | 569847808 | 90972160 | 0.084655 |
| sqlite_autoindex_fee_events_1 | index | 170930176 | 201150464 | 30220288 | 0.028122 |
| core_snapshots | table | 13824000 | 40050688 | 26226688 | 0.024405 |
| fee_windows | table | 14929920 | 33574912 | 18644992 | 0.017350 |
| fee_events_chain_tx_log | index | 99704832 | 117776384 | 18071552 | 0.016817 |
| sqlite_autoindex_core_snapshots_1 | index | 9621504 | 27430912 | 17809408 | 0.016573 |
| fee_events_pool_time | index | 88174592 | 103882752 | 15708160 | 0.014617 |
| signal_episodes | table | 66334720 | 81805312 | 15470592 | 0.014396 |
| signal_outcomes | table | 75898880 | 87678976 | 11780096 | 0.010962 |
| price_observations | table | 156233728 | 161775616 | 5541888 | 0.005157 |
| hourly_slo_checkpoints | table | 4096 | 5345280 | 5341184 | 0.004970 |
| outcome_retry_state | table | 20480 | 4747264 | 4726784 | 0.004399 |
| depth_observations | table | 5148672 | 9515008 | 4366336 | 0.004063 |
| core_snapshots_time | index | 1773568 | 5210112 | 3436544 | 0.003198 |
| fee_events_time | index | 17145856 | 20217856 | 3072000 | 0.002859 |
| sqlite_autoindex_fee_windows_1 | index | 3018752 | 5828608 | 2809856 | 0.002615 |
| fee_minute_buckets | table | 5787648 | 8007680 | 2220032 | 0.002066 |
| price_asset_source_time | index | 85626880 | 87756800 | 2129920 | 0.001982 |
| price_asset_time | index | 90468352 | 92598272 | 2129920 | 0.001982 |
| alerts | table | 10727424 | 12845056 | 2117632 | 0.001971 |
| sqlite_autoindex_pool_snapshots_1 | index | 158158848 | 160215040 | 2056192 | 0.001913 |
| fee_events_unpriced | index | 8736768 | 10764288 | 2027520 | 0.001887 |
| sqlite_autoindex_fee_minute_buckets_1 | index | 3723264 | 5201920 | 1478656 | 0.001376 |
| scanner_runs | table | 3371008 | 4739072 | 1368064 | 0.001273 |
| pools | table | 6463488 | 7757824 | 1294336 | 0.001204 |
| worker_runs | table | 1904640 | 2904064 | 999424 | 0.000930 |
| sqlite_autoindex_depth_observations_1 | index | 1019904 | 1966080 | 946176 | 0.000880 |
| depth_pool_time | index | 970752 | 1875968 | 905216 | 0.000842 |
| live_ingestion_runs | table | 143360 | 864256 | 720896 | 0.000671 |
| sqlite_autoindex_outcome_retry_state_1 | index | 4096 | 720896 | 716800 | 0.000667 |
| prices_observed_time | index | 20332544 | 20832256 | 499712 | 0.000465 |
| live_ingestion_chain_time | index | 77824 | 524288 | 446464 | 0.000415 |
| price_backfill_attempts | table | 1851392 | 2289664 | 438272 | 0.000408 |
| sqlite_autoindex_price_backfill_attempts_1 | index | 1716224 | 2101248 | 385024 | 0.000358 |
| snapshots_time | index | 30015488 | 30367744 | 352256 | 0.000328 |
| signals_pool_time | index | 1253376 | 1581056 | 327680 | 0.000305 |
| historical_price_cache | table | 585728 | 839680 | 253952 | 0.000236 |
| outcome_due_created | index | 1126400 | 1372160 | 245760 | 0.000229 |
| outcomes_ready | index | 1536000 | 1736704 | 200704 | 0.000187 |
| rpc_request_minutes | table | 462848 | 655360 | 192512 | 0.000179 |
| outcomes_due | index | 1556480 | 1740800 | 184320 | 0.000172 |
| sqlite_autoindex_rpc_request_minutes_1 | index | 442368 | 626688 | 184320 | 0.000172 |
| sqlite_autoindex_signal_outcomes_1 | index | 827392 | 1011712 | 184320 | 0.000172 |
| signals_type_time | index | 729088 | 905216 | 176128 | 0.000164 |
| sqlite_autoindex_historical_price_cache_1 | index | 286720 | 446464 | 159744 | 0.000149 |
| storage_measurements | table | 12288 | 167936 | 155648 | 0.000145 |
| outcomes_completed_time | index | 983040 | 1118208 | 135168 | 0.000126 |
| core_tracking_intervals | table | 94208 | 208896 | 114688 | 0.000107 |
| core_tracking_open | index | 90112 | 192512 | 102400 | 0.000095 |
| sqlite_autoindex_core_tracking_intervals_1 | index | 90112 | 192512 | 102400 | 0.000095 |
| diagnostic_summaries | table | 159744 | 241664 | 81920 | 0.000076 |
| scan_traces | table | 4096 | 57344 | 53248 | 0.000050 |
| core_writer_runs | table | 24576 | 73728 | 49152 | 0.000046 |
| alerts_pool_kind_time | index | 274432 | 319488 | 45056 | 0.000042 |
| signals_start_time | index | 208896 | 249856 | 40960 | 0.000038 |
| price_request_minutes | table | 61440 | 94208 | 32768 | 0.000030 |
| sqlite_autoindex_price_request_minutes_1 | index | 61440 | 94208 | 32768 | 0.000030 |
| scan_slow_calls | table | 12288 | 36864 | 24576 | 0.000023 |
| tokens | table | 528384 | 552960 | 24576 | 0.000023 |
| depth_failures | table | 40960 | 61440 | 20480 | 0.000019 |
| scan_metrics | table | 40960 | 61440 | 20480 | 0.000019 |
| depth_reconstruction_cache | table | 135168 | 147456 | 12288 | 0.000011 |
| sqlite_autoindex_depth_failures_1 | index | 45056 | 57344 | 12288 | 0.000011 |
| system_clock_events | table | 4096 | 12288 | 8192 | 0.000008 |
| live_fee_cursors | table | 12288 | 16384 | 4096 | 0.000004 |
| pools_chain_protocol | index | 40960 | 45056 | 4096 | 0.000004 |
| sqlite_autoindex_tokens_1 | index | 49152 | 53248 | 4096 | 0.000004 |
| app_settings | table | 4096 | 4096 | 0 | 0.000000 |
| candles | table | 417792 | 417792 | 0 | 0.000000 |
| dataset_versions | table | 4096 | 4096 | 0 | 0.000000 |
| event_source_checks | table | 4096 | 4096 | 0 | 0.000000 |
| event_source_checks_chain_time | index | 4096 | 4096 | 0 | 0.000000 |
| event_sources | table | 4096 | 4096 | 0 | 0.000000 |
| fee_backfill_due | index | 4096 | 4096 | 0 | 0.000000 |
| fee_backfill_jobs | table | 16384 | 16384 | 0 | 0.000000 |
| fee_backfill_priority | index | 4096 | 4096 | 0 | 0.000000 |
| fee_block_checkpoints | table | 278528 | 278528 | 0 | 0.000000 |
| fee_checkpoints_desc | index | 167936 | 167936 | 0 | 0.000000 |
| fee_cursors | table | 12288 | 12288 | 0 | 0.000000 |
| fee_gaps | table | 20480 | 20480 | 0 | 0.000000 |
| fee_gaps_open | index | 16384 | 16384 | 0 | 0.000000 |
| live_fee_chain_lag | index | 4096 | 4096 | 0 | 0.000000 |
| live_pool_health | table | 4096 | 4096 | 0 | 0.000000 |
| one_active_signal_episode | index | 4096 | 4096 | 0 | 0.000000 |
| rpc_providers | table | 4096 | 4096 | 0 | 0.000000 |
| schema_migrations | table | 4096 | 4096 | 0 | 0.000000 |
| sqlite_autoindex_app_settings_1 | index | 4096 | 4096 | 0 | 0.000000 |
| sqlite_autoindex_candles_1 | index | 151552 | 151552 | 0 | 0.000000 |
| sqlite_autoindex_cohort_aggregates_1 | index | 12288 | 12288 | 0 | 0.000000 |
| sqlite_autoindex_dataset_versions_1 | index | 4096 | 4096 | 0 | 0.000000 |
| sqlite_autoindex_depth_reconstruction_cache_1 | index | 4096 | 4096 | 0 | 0.000000 |
| sqlite_autoindex_diagnostic_summaries_1 | index | 4096 | 4096 | 0 | 0.000000 |
| sqlite_autoindex_event_sources_1 | index | 4096 | 4096 | 0 | 0.000000 |
| sqlite_autoindex_fee_backfill_jobs_1 | index | 4096 | 4096 | 0 | 0.000000 |
| sqlite_autoindex_fee_block_checkpoints_1 | index | 155648 | 155648 | 0 | 0.000000 |
| sqlite_autoindex_fee_cursors_1 | index | 4096 | 4096 | 0 | 0.000000 |
| sqlite_autoindex_fee_gaps_1 | index | 16384 | 16384 | 0 | 0.000000 |
| sqlite_autoindex_hourly_slo_checkpoints_1 | index | 4096 | 4096 | 0 | 0.000000 |
| sqlite_autoindex_live_fee_cursors_1 | index | 4096 | 4096 | 0 | 0.000000 |
| sqlite_autoindex_live_pool_health_1 | index | 4096 | 4096 | 0 | 0.000000 |
| sqlite_autoindex_pools_1 | index | 114688 | 114688 | 0 | 0.000000 |
| sqlite_autoindex_rpc_providers_1 | index | 4096 | 4096 | 0 | 0.000000 |
| sqlite_autoindex_schema_migrations_1 | index | 4096 | 4096 | 0 | 0.000000 |
| sqlite_autoindex_watchlist_1 | index | 4096 | 4096 | 0 | 0.000000 |
| sqlite_autoindex_watchlist_history_1 | index | 4096 | 4096 | 0 | 0.000000 |
| sqlite_schema | index | 28672 | 28672 | 0 | 0.000000 |
| sqlite_sequence | index | 4096 | 4096 | 0 | 0.000000 |
| sqlite_stat1 | index | 4096 | 4096 | 0 | 0.000000 |
| watchlist | table | 4096 | 4096 | 0 | 0.000000 |
| watchlist_history | table | 4096 | 4096 | 0 | 0.000000 |
| scan_phase_run | index | 114688 | 81920 | -32768 | -0.000030 |
| cohort_aggregates | table | 774144 | 729088 | -45056 | -0.000042 |
| scan_phase_spans | table | 507904 | 372736 | -135168 | -0.000126 |
| sqlite_autoindex_scan_phase_spans_1 | index | 454656 | 307200 | -147456 | -0.000137 |

Physical DB expansion 392,433,664 bytes; WAL 14,766,112 to 113,085,792 (delta 98,319,680); freelist delta 73,728. WAL growth is conservative end-profile headroom consumption and may be reclaimed by checkpoint; no claim that it grows indefinitely at this rate.

## Hourly Base lag, pricing denominators and queues

Nearest-rank lag quantiles; missing infrastructure stays active. Queue counts are saved checkpoint totals, including chains beyond selected readiness. No per-minute lag distribution is claimed.

| Hour | Known / active | Unknown | Base median / p95 lag s | Reliable price / selected HOT | Current depth / priced | Fee jobs | Pending outcomes |
|---|---|---|---|---|---|---|
| 1 | 7/7 | 0 | 49939.729 / 107851.729 | 23/92 | 9/23 | 38 | 359 |
| 2 | 8/8 | 0 | 53536.767 / 122062.767 | 27/101 | 6/27 | 38 | 700 |
| 3 | 8/8 | 0 | 74.894 / 113434.894 | 28/100 | 15/28 | 38 | 978 |
| 4 | 6/6 | 0 | 32.341 / 117028.341 | 31/110 | 18/31 | 38 | 1477 |
| 5 | 9/9 | 0 | 74.833 / 435504.833 | 29/116 | 18/29 | 38 | 1601 |
| 6 | 7/7 | 0 | 38.100 / 124250.100 | 24/105 | 8/24 | 38 | 1673 |
| 7 | 7/7 | 0 | 128.425 / 127854.425 | 25/106 | 13/25 | 39 | 1911 |
| 8 | 7/7 | 0 | 175.951 / 154439.951 | 22/107 | 11/22 | 39 | 1825 |
| 9 | 7/7 | 0 | 31.853 / 135029.853 | 22/104 | 12/22 | 39 | 2053 |
| 10 | 7/7 | 0 | 37.724 / 138637.724 | 17/100 | 1/17 | 40 | 2037 |
| 11 | 6/6 | 0 | 48.928 / 142252.928 | 14/95 | 7/14 | 40 | 1910 |
| 12 | 9/9 | 0 | 75.095 / 145823.095 | 26/108 | 15/26 | 41 | 2220 |
| 13 | 10/10 | 0 | 116.812 / 496110.812 | 22/106 | 14/22 | 41 | 2200 |
| 14 | 8/8 | 0 | 31.331 / 373313.331 | 24/109 | 10/24 | 41 | 2316 |
| 15 | 8/8 | 0 | 34.302 / 156644.302 | 25/116 | 12/25 | 41 | 2617 |
| 16 | 4/4 | 0 | 47.802 / 160239.802 | 15/102 | 0/15 | 41 | 2828 |
| 17 | 9/9 | 0 | 96.636 / 163844.636 | 18/99 | 10/18 | 41 | 2712 |
| 18 | 6/6 | 0 | 159.780 / 167431.780 | 14/96 | 4/14 | 41 | 2655 |
| 19 | 8/8 | 0 | 171.149 / 171035.149 | 18/102 | 13/18 | 41 | 2680 |
| 20 | 8/8 | 0 | 32.200 / 174640.200 | 30/114 | 16/30 | 42 | 2961 |
| 21 | 8/8 | 0 | 102.735 / 178224.735 | 24/112 | 16/24 | 43 | 3000 |
| 22 | 7/7 | 0 | 32.414 / 181832.414 | 19/101 | 8/19 | 43 | 3147 |
| 23 | 6/6 | 0 | 26.779 / 185436.779 | 17/95 | 7/17 | 43 | 3059 |
| 24 | 8/8 | 0 | 35.311 / 189031.311 | 22/104 | 13/22 | 43 | 3219 |
