# Live event continuity

Separate Base and BSC live processes rank watched, active-signal, and HOT pools, read confirmed Swap logs, persist event identity `(pool, block, txHash, logIndex)`, and update minute buckets and 5m/30m/1h/4h/24h windows. Historical fees/prices, due outcomes, depth, compact snapshots, economics, and foreground scans each have separate processes. A failed historical call cannot occupy a live or outcome slot. Each event stores its source type and hashed source ID. Live cursors expose observed and confirmed head, block and time lag, source, and last update in data health.

Configure `BASE_LIVE_INDEXER_URL`, `BSC_LIVE_INDEXER_URL`, `BASE_HISTORICAL_INDEXER_URL`, or `BSC_HISTORICAL_INDEXER_URL` for a vendor-neutral HTTP swap indexer. The endpoint receives GET query parameters `chain`, `pool`, `fromBlock`, and `toBlock`. Its JSON response must be:

```json
{
  "chain": "base",
  "pool": "0x0000000000000000000000000000000000000001",
  "fromBlock": 100,
  "throughBlock": 120,
  "complete": true,
  "endBlockHash": "0x...64 hex characters...",
  "logs": []
}
```

Each log must use `eth_getLogs` fields plus `blockTimestamp` (hex seconds). Empty `logs` is valid only with explicit `complete: true`, a covering `throughBlock`, and an `endBlockHash` for the requested `toBlock` matching RPC. The adapter checks each populated block's timestamp and hash against RPC. It rejects malformed amounts, duplicate conflicts, wrong pools, wrong ranges, removed logs, missing timestamps, and block disagreement. When RPC logs are available, one populated block is sample-checked for transaction hash, log index, pool, block, topics, and encoded amounts. Disagreements stop that range; unavailable RPC samples lower confidence without inventing a match. Source health, latency, latest indexed block, and disagreement counts are saved. A recently failed indexer cools down for one minute before retry.

The read-only RPC router also supports several configured endpoints, probes `eth_getLogs` and archive capability, uses circuit breakers, and can classify a historical archive source. The existing protocol subgraphs provide hourly pool aggregates, not a verified complete Swap-event stream. They are not treated as raw events. BSC public endpoints may not serve logs: [BNB Chain's RPC documentation](https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/json-rpc-endpoint/) notes that its listed public mainnet endpoints disable `eth_getLogs`. A capable RPC or indexer must be configured for dependable BSC windows.

Window `continuityState` is `COMPLETE`, `PARTIAL`, `GAPPED`, `STALE`, or `UNAVAILABLE`; coverage start, end, percentage, and event source are persisted. On a restarted cursor that skips blocks, an explicit gap stays open until a contiguous repair covers the full range. Data health counts only recent, complete 1-hour windows. A zero-swap range still needs a verified complete source response.
