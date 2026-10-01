# Production burn-in

Build first, then run `pnpm burnin --hours=4`. The same command accepts `--hours=12` and `--hours=24`. It starts production services if needed, checks the read-only health endpoint, prevents macOS sleep with `caffeinate`, and samples `/diagnostics/reliability` once per minute. Reports and app logs are written under ignored `reports/` files.

The final JSON includes every scan duration in its median, p95, p99, and maximum; failed scans are not dropped. It includes sample failures and gaps, live cursors, HOT coverage, snapshot continuity, outcome lateness, provider errors, worker backlog, disk safety, and before/after database and table sizes. An interrupted run or sample gap above three minutes fails. For a clean result, also inspect each readiness gate and its denominator. A burn-in PASS alone does not mean Strategy Lab READY.

Keep the Mac powered and connected for the entire run. Closing the lid or stopping the command may interrupt observation. If the command started the app, it stops those services after writing the report. `pnpm start` can restart them afterward.
