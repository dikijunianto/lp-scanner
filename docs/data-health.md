# Data health and coverage

`/diagnostics/data-health` reads `/api/diagnostics/data-health`. The page shows RPC capability/health without URLs, last-hour request and historical-price call counts, current pair-price and depth coverage, current complete fee windows, historical stored complete windows, unpriced-swap reasons, fee backfill queue, oldest job, and worker lag. It also displays local infrastructure alerts for unavailable log RPC, scans over 25 seconds, and old fee jobs. These alerts are separate from LP opportunity alerts and send no external messages.

Current fee coverage requires a complete event-derived 1h or 4h window ending within five minutes of the request. Historical coverage counts all stored event-derived fee windows by chain and duration. A restarted cursor can reduce current coverage while historical stored windows remain intact. The research coverage page still reports the latest completed scan; the health page reports live fee-window freshness separately.

Unknown capability, missing price, stale depth, and provider failure are distinct states. `UNAVAILABLE` never means zero swaps, zero liquidity, or zero fees. Current vs historical counts may have different pool denominators; inspect both before drawing a trend. Worker cycles may exceed one minute during provider probing or backfill; queue length and lag expose that delay.
