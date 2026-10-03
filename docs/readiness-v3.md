# Readiness V3

Solana+Base only; BSC separately reports BSC_NOT_READY_NO_LOG_SOURCE when no capable configured source exists. No Strategy Lab implementation.

Required gates: real24h and24 orderly healthy hourly checkpoints; foregroundp95<=15s,p99/max<=20s,zero breaches; Base active freshness>=90% at>=90% checkpoints; current complete active1hfees>=80% at>=80%; reliableHOTprices>=80% and current5%depth>=70% of reliably priced pools at>=90% checkpoints; core continuity>=99%,largest gap<=120s;4hPRICE_RANGE_COMPLETE>=70%,24h>=60% mature eligibleSTANDARDsignals; new-jobp95lateness<=10min; measured totalgrowth<=0.15GiB/day after24h; runway>=90d; healthy selected-chain provider evidence throughout. Preferred price90%,growth0.10GiB/day,runway180d do not change minimum gates.

Hourly denominator retains missing HOT infrastructure; only proven NO_ACTIVITY removes active pools. Stale quotes/depth fail. PARTIAL outcomes do not count PRICE_RANGE_COMPLETE. The latter requires both endpoint prices, favorable/adverse moves and all range survival/time fields with valid continuity; fee/depth grades are separate. Historical gaps are not fabricated. Fair scheduling interleaves horizons and bounded changed-evidence retries repair older fields without monopolizing new due jobs.

ReturnREADY only when every gate passes; otherwiseNOT_READY with exact passed/failed/borderline lists. The initial production smoke isNOT_READY;24h gate evaluation remainspending. The dataset-freeze command refuses Sprint9 unless a fresh materialized summary isREADY. Additional storage is required whenever measured growth/free space cannot provide90days; snapshot-only rates cannot waive that gate.
