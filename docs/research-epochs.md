# Clean research epochs

Sprint10 adds ACTIVE, COMPLETE and INVALID epochs, limited to one ACTIVE row. Selected chains are Solana and Base. Epochs retain start/end, reason, methodology versions and an exact invalidation reason. Existing signals, outcomes and gaps remain historical records.

Startup requires a recent successful minute writer, recent scans without a critical deadline failure, verified database integrity, and fresh required services. New selected-chain signal episodes receive the active epoch ID; outcome jobs inherit it. CURRENT_RESEARCH_EPOCH and ALL_HISTORY are reported independently. STANDARD eligibility uses the existing HIGH/MEDIUM data-quality cohort.

A critical foreground deadline, detected integrity failure, core continuity below99% or gap above120s after startup tolerance invalidates the epoch. Required service unavailability tolerates300s by default. Missing individual token prices does not invalidate it; their pools remain in coverage denominators. Pending clean-epoch outcomes retain minute tracking even if the signal ends.

The validation includes an explicitly recorded one-hour maturity lead, followed by a separate fixed24h observation. Neither lead samples nor old outcomes substitute for24h evidence. A failed lead is retained and prevents observation startup. A methodology fingerprint is checked every minute; modifications invalidate the epoch. No automatic epoch resets occur.

Freeze requires a COMPLETE epoch, fresh READYv4 evidence, and a matching PASS run with paired duration at least24h. The full immutable backup preserves history; the manifest restricts the research cohort by epoch ID.
