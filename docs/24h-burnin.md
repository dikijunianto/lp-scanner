# Actual 24-hour burn-in

Launch production validation with `pnpm burnin:24h`. OnmacOS it spawns `caffeinate -dimsu -w <burninPID>`: temporary display/idle/system sleep prevention tied to the launcher process; no permanent power settings. Keep the Mac connected to power with the lid open. Abrupt shutdown, lid closure or process termination can invalidate uninterrupted evidence.

Warmup waits for a healthy read-only app and fresh materialized diagnostics before starting the observation window. No startup samples or previous scans are silently substituted. Once started the window is never reset. Root trace SQL selects every scan started within the window; failures/breaches remain included. Minute health evidence, hourly checkpoints1–24, full scan distribution, providers, all-HOT details/active denominators, queue/outcomes and actual storage profiles persist in a JSON report and hourly SQLite records. Summary projection prevents recursively nested checkpoints.

Every hour must arrive within2min of its scheduled boundary and contain continuous healthy minute samples. Missed checkpoints are unhealthy evidence, never backfilled as healthy. Wall/monotonic discrepancies and clock events remain in the report. Completed stability PASS is distinct from readinessREADY. An interrupted or shorter run isFAIL and cannot satisfy observation24h.

After completion inspect every failed scan, compare all denominators, stop production services, run fullSQLite integrity/ANALYZE/safe checkpoint, restart production and verify read-only health/UI. Freeze only if fresh complete readinessV3 passes. Final evidence must report all27 metrics in the Sprint9 request; the final results are recorded in sprint9-validation.md. No software changes/restarts during the clean window; any necessary repair remains documented and requires a new separately identified full run without erasing the failed run.

## Completed validation

The actual window ran 3 October 2026 20:09:54.927 to 4 October 20:09:54.932 WIB with keep-awake. 1,360 scans, zero breaches, zero failed health samples, 24 healthy fresh hourly checkpoints. Raw result FAIL: wall-clock end was captured before final profiling, but monotonic end after it, producing an invalid 84.622s discrepancy. The report is preserved; no clean clock-valid PASS is claimed. Readiness NOT_READY and no freeze. Services stopped automatically; full integrity/ANALYZE/checkpoint passed; production restarted read-only. [Full results](sprint9-validation.md).
