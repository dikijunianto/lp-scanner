# Readiness v4

READY requires every gate; otherwise NOT_READY, with passed/failed/borderline gates. Burn-in stability PASS is independent of research readiness. Do not build Strategy Lab.

Exactly24 healthy, fresh ordered hourly checkpoints and a paired authoritative wall/monotonic interval of at least24h are required. Foreground p95≤10s, p99≤15s, max≤20s, no deadline breach. Core continuity≥99%, largest tracked gap≤120s at every hour. Base active cursors≥90% at95% of hours; median lag≤90s at90%. Fees≥80%, HOT pair prices≥80%, and depth among reliably priced HOT≥80%, each at90% of hours. Required services must remain available.

Mature current-epoch STANDARD4h PRICE_RANGE_COMPLETE≥90%; mature24h≥80%. Zero mature denominator fails. At least95% expected minute price samples and no price gap above120s are required, with reliable signal and path prices. Fee/depth missingness does not block price-range completeness. Historical outcomes remain visible separately.

New-outcome lateness p95≤10min at90% of hours. Use current-epoch jobs due/completed in the preceding hour, plus overdue pending jobs; pending lag is measured to now and reported explicitly. Final reporting additionally retains whole-observation delay. Storage≤0.15GiB/day and runway≥120days use the matching run baseline/end measurements. Preferred runway180days is distinct from the hard gate. BSC is separately NOT_READY until explicitly configured and validated.

Freeze only on fresh genuine READY, matching PASS24h run and COMPLETE clean epoch, with integrity, epoch/run IDs, cohort counts, chain set, time range, methodology and checksum in the manifest.
