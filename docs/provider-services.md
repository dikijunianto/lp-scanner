# Required provider services

Solana and Base report POOL_DISCOVERY, PRICE, CURRENT_STATE, LIVE_EVENTS and DEPTH_STATE independently. A fresh successful source satisfies its service even if an unused fallback fails. Fresh degraded evidence is DEGRADED; missing/stale evidence is UNAVAILABLE. Default freshness is180s.

Discovery comes from actual completed source results; price from observed source successes; state/depth-state capability from validated pinned state; Base live from actual ingestion cursor writes. Individual reconstruction failures remain in the depth waterfall, not hidden by source capability. Solana LIVE_EVENTS is optional because its API fee methodology does not claim complete event ingestion. All other selected-chain services are required.

BSC remains excluded. BSC_NOT_READY_NO_LOG_SOURCE applies unless a capable live source is explicitly configured and currently healthy. Historical PUBLIC metadata cannot qualify a missing configuration. Per-pool cursor freshness remains separately gated even when another pool proves the service operates.
