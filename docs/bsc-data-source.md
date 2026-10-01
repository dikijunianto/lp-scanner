# BSC data sources

Configure a log-capable HTTPS RPC with `BSC_LOG_RPC_URL`. An archive-capable endpoint can be supplied with `BSC_ARCHIVE_RPC_URL`; multiple HTTP sources may be listed in `BSC_LOG_RPC_URLS`. `BSC_LOG_WSS_URL` optionally enables live Swap notifications. Existing live and historical indexer URLs remain supported. Keep provider credentials in `.env`, not in source control.

Startup probes check chain identity, recent `eth_getLogs`, a historical block, and historical `eth_call`. The reliability page shows live logs, historical logs, archive state, and WebSocket connection status independently. A configured URL is not assumed capable until a probe or verified indexer request succeeds. Public BSC RPCs are not used for expected production `eth_getLogs` work. Without a capable confirmed-range source, the worker records `BSC_LIVE_FEES_DISABLED_NO_CAPABLE_SOURCE` and does not spend cycles on impossible public log queries.

The WebSocket subscribes to Pancake V3 Swap logs and new heads. It reconnects with backoff, checks liveness, deduplicates transaction/log identities, and wakes the live worker when a notified swap is confirmed. Persistent fee cursors advance only after contiguous confirmed HTTP/indexer ranges pass block-hash checks; this also resumes after WebSocket disconnect and handles reorgs. A WebSocket alone cannot prove empty block ranges and therefore cannot make a fee window COMPLETE. Historical repair stays on the separate history worker.

If no managed source is configured, BSC readiness remains `BSC_NOT_READY`. Solana and Base readiness do not depend on BSC.
