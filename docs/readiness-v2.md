# Strategy Lab readiness V2

Readiness evaluates only Solana and Base; BSC has its own result. `READY` requires all of these measured gates:

| Gate | Threshold |
| --- | ---: |
| Foreground p95 / p99 | <15 s / <20 s |
| Reliable prices across HOT Solana + Base pools | ≥90% |
| Current ±5% depth among reliably priced HOT pools | ≥70% |
| Complete current one-hour fee windows across HOT Base pools | ≥80% |
| Core snapshot continuity across mature tracked pools over four hours | ≥98% |
| Largest core gap | ≤3 min |
| PRICE_RANGE_COMPLETE among eligible STANDARD 4h / mature 24h outcomes | ≥70% / ≥60% |
| New post-Sprint-8 outcome p95 lateness | <15 min |
| New storage growth after at least four hours | ≤0.15 GiB/day |
| Estimated disk runway | ≥180 days |
| Healthy Base log provider/indexer | Required |

Missing denominators fail rather than pass. PARTIAL fee windows are not COMPLETE, stale depth is not current, and missing prices are not counted as reliable. Legacy outcome delay is shown separately from new due-job delay. BSC has independent source, fee, price, and depth gates and cannot block Solana + Base.

This page is an evaluation only; it never recommends or executes a strategy. A 4-hour run cannot mature newly created 24-hour outcomes, so historical eligible cohorts remain in that denominator until a longer uninterrupted run is available.
