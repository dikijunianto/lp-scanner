# Sprint 8 measured validation

The uninterrupted production run on 1 October 2026, 14:18:26–18:18:26 WIB, completed four hours. Its result is **FAIL**, and Solana + Base remain **NOT_READY**. BSC is **BSC_NOT_READY**. No Strategy Lab, signing, or trading was added.

Evidence is retained locally in `reports/burnin-2026-10-01T07-17-26-516Z.json` and its application log. The report includes all 216 scan durations, including failed scans. There were 240 healthy samples, zero failed health samples, no interruption, and a maximum sample gap of 60.348 seconds. Coverage below uses the last saved sample, approximately one minute before completion; later restart measurements are not substituted into this cohort. Base HOT IDs were recovered from the compact snapshot minute matching that sample, then matched to its saved cursors.

| # | Requested metric | Measured result |
| --- | --- | --- |
| 1 | Historical 486-second outlier | Coincided with a 398-second macOS sleep on 28 September. JavaScript timers could not execute during suspension. This does not explain the new outlier below. |
| 2 | Foreground median / p95 / p99 | 5.599 / 7.408 / 14.266 seconds, all 216 scans. |
| 3 | Maximum foreground scan | **39.504 seconds**, run 2689; one scan breached 20 seconds. |
| 4 | Base cursor lag | HOT: 5/10 FRESH, 2/10 DELAYED, 3/10 STALE; nearest-rank median 118.532 seconds, p95/max 4,018.532 seconds. All 30 stored Base cursors: 5 fresh, 2 delayed, 23 stale. |
| 5 | Base HOT complete current 1h fees | **5/10 = 50%**, below 80%. |
| 6 | BSC source | No configured capable source; `BSC_LIVE_FEES_DISABLED_NO_CAPABLE_SOURCE`. Optional HTTP/WSS integration implemented, live WSS unverified. |
| 7 | BSC current fees | **0/35 HOT pools**. No historical or partial window substituted. |
| 8 | HOT Solana + Base reliable prices | **20/107 = 18.69%**: Solana 15/97, Base 5/10. |
| 9 | HOT selected-chain current ±5% depth | **8/20 reliably priced = 40%**; also 8/107 of all selected HOT pools. |
| 10 | 4h core continuity | Last sample: **31,385/31,385 = 100%**, 142 tracked pools, 115 mature. End-time stored-state recomputation: 31,225/31,226 = 99.997%; mature cohort 27,715/27,715. |
| 11 | Largest core gap | **60 seconds**, including normal minute spacing. |
| 12 | Selected STANDARD 4h PRICE_RANGE_COMPLETE | **317/1,743 = 18.19%**, below 70%. |
| 13 | Selected mature 24h PRICE_RANGE_COMPLETE | **0/1,739**, below 60%. |
| 14 | NEW outcome p95 lateness | **270.151 seconds = 4.50 minutes**, 781 completed new jobs in last sample. Legacy completions reported separately: 9,764. |
| 15 | DB size | Burn-in file: 8,580,988,928 → **8,615,747,584 bytes (8.024 GiB)**. Frozen consistent DB includes final shutdown WAL: 8,615,895,040 bytes. |
| 16 | DB growth before / after | Prior supplied provisional estimate ~0.24 GiB/day; not a comparable allocation measurement. This run: **0.7908 GiB/day positive table/index allocation**; actual file extension 34,758,656 bytes / 4h (~0.194 GiB/day). Freed pages were reused. |
| 17 | Full snapshot growth before / after | Historical pre-Sprint-7 estimate ~341,000 rows and 1.1 GiB/day. Sprint 8: **3,351 rows and 14,196,736 table bytes / 4h** (~20,106 rows and 0.0793 GiB/day). No same-window Sprint-7 control exists; do not claim a controlled percentage reduction. |
| 18 | Free disk | **20.005 GiB at burn-in end**; the verified frozen archive subsequently consumes another 1.230 GiB. Space varies with other Mac activity. |
| 19 | Disk runway | **25.30 days** using end free space / measured allocation, below 180. |
| 20 | 4h burn-in | **FAIL** solely on its stability predicate because maximum scan exceeded 20 seconds. Additional readiness gates also fail. |
| 21 | Solana + Base readiness | **NOT_READY**. |
| 22 | BSC readiness | **BSC_NOT_READY**. |
| 23 | Remaining blockers | Deadline breach; low prices/depth/Base fees; immature tracked cohorts; inadequate 4h/24h outcome coverage; excessive allocation and short runway; missing BSC source; slow synchronous diagnostics. |
| 24 | Recommended Sprint 9 | Isolate/profile synchronous diagnostics and deadline stalls, close HOT pricing/state/depth gaps, secure capable chain providers, reduce measured event/index growth, then repeat clean 4h and extend to 24h. Strategy Lab stays deferred. |

## Deadline evidence and limits

Run 2689 began at 14:27:40 WIB. Three discovery HTTP calls all ended at approximately 14:28:19: Meteora 39,245 ms and both GeckoTerminal calls 39,162 ms, each with a configured 2,500 ms request timeout. Discovery spans had a configured 20,000 ms deadline. All sources failed. No sleep was recorded in that interval. The raw failure remains in the distribution. Simultaneous delayed timer/request completion is consistent with event-loop blocking, but the stored spans do not identify the responsible blocking operation; this cause is **unresolved**, not an upstream-only diagnosis.

After restart, synchronous diagnostics caused very slow responses and the dashboard displayed an unavailable error on the final smoke attempt. Read-only API health and all worker heartbeats were verified, and the diagnostics API eventually returned real data with measured storage growth. Another post-burn-in scan exceeded 20 seconds. These observations are outside the four-hour distribution and reinforce the deadline/diagnostics blocker. They are not evidence of a passing UI smoke test. Full integrity-check and profiling wall times also included long unattended host delays, so those timings are not reliable query microbenchmarks.

The readiness snapshot at the last sample still had unavailable measured growth because the second storage measurement is written after sampling ends. The post-run measurement supplies 0.7908 GiB/day, so storage growth and runway fail definitively. Snapshot cadence exceeds its SLO, but the implementation conservatively requires every currently tracked pool to have four hours of maturity; 27/142 had joined more recently, so its maturity gate remained false. This distinction must remain visible rather than dropping those pools.

Price/range completeness requires the endpoint, price return, observation coverage, and all three range results. An outcome may have complete price/range fields and incomplete fee/depth fields; this never upgrades its overall PARTIAL status to FULL_COMPLETE. New-job delay covers completed post-deployment jobs; pending jobs are shown separately. At end-time recomputation no eligible jobs were overdue. The saved pending count rose 85 → 1,042, predominantly future maturities, while fee queue length rose 32 → 33. The run does not prove long-term queue boundedness.

## Actual storage allocation

Table deltas exclude indexes; the total 141,516,800 allocated bytes includes all positive table and index deltas. Approximate bytes per added row are allocation deltas, including page slack and changes to existing rows, not serialized row sizes.

| Table | Added rows / 4h | Table bytes / 4h | Approx. bytes / added row |
| --- | ---: | ---: | ---: |
| pool_snapshots | 3,351 | 14,196,736 | 4,236 |
| fee_events | 122,628 | 58,552,320 | 477 |
| price_observations | 5,248 | 729,088 | 139 |
| signal_episodes | 438 | 2,387,968 | 5,452 |
| signal_outcomes | 1,752 | 4,644,864 | 2,651 |
| depth_observations | 1,006 | 446,464 | 444 |
| core_snapshots | 33,110 | 4,431,872 | 134 |

Major additional index allocation: fee-event primary key 19,771,392 bytes; chain/transaction/log index 11,788,288; pool/time index 9,981,952; core primary key 2,953,216. Legacy repair is included in these measured bytes. It cannot be removed from the storage forecast merely because it is old blockchain data. A steady-state rate after that repair drains is still unknown.

The removed redundant snapshot index freed 157,364,224 bytes for SQLite reuse, without rewriting history or running VACUUM. Archive dry run found zero safe eligible rows under its protected-history policy. No archival execution or destructive downsampling was performed. At this measured rate, 180 days needs approximately 142 GiB before reserves; current free space is insufficient. Plan additional usable capacity (roughly 150 GiB with a cushion), or prove a lower sustained allocation rate before relying on the disk-runway target.

## Verification and frozen data

Before the burn-in, `pnpm test` passed 99 tests; lint, typecheck, production build, and diff whitespace checks passed. After services stopped, full SQLite `PRAGMA integrity_check` returned `ok`. The pre-Sprint-8 compressed backup remains intact.

`pnpm dataset:freeze` created `data/datasets/dataset-2026-10-01T11-21-56-594Z.sqlite.gz` and its manifest. The archive is 1,320,807,016 bytes; decompression verified 8,615,895,040 bytes. SHA-256: `c809529e5cfe39b7e6134406c04920bdcced1046fa3cb4c3add1a432352ae9d8`. Manifest: `sprint8-v2`, all three chains, 1,245 pools, 12,973 signals, 51,892 outcomes, and 72,410 core snapshots. Its temporary database was removed after verification. The archive and raw live reports remain local and ignored by Git.
