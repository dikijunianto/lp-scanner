# Base fee and cursor coverage

A live cursor bounding an hour is insufficient proof. Successful confirmed ingestion persists explicit block/time intervals; reorgs invalidate affected coverage. A materialized1h fee window requires a gapless interval union and complete swap USD valuation, alongside existing source, continuity and freshness checks. Covered zero-event windows are COMPLETE_ZERO_ACTIVITY.

HOT ACTIVE excludes only proven NO_RECENT_SWAPS. UNKNOWN, INFRA_FAILURE and active stale/delayed pools remain in that denominator. The UI separately reports active/all-HOT/no-activity lag median, p90, p95, max, and unknown counts.

Fee waterfall: allHOT → active → live event complete → swap prices complete → fee window complete. Failures distinguish infrastructure, reorg, source gaps, cursor gaps, immature windows, unpriced swaps and unavailable events. Saved-window timestamps govern valuation counts. Current Base unpriced events receive priority over older repair work; valuation still requires actual time-compatible price evidence.

EVM live reads retain reserved per-minute request capacity. State/depth admission leaves that capacity available; Solana has no unused EVM reservation. Targets remain measured80% complete fees at90% hourly checkpoints, and90% fresh active cursors at95% hourly checkpoints (the stricter explicit Sprint10H requirement).
