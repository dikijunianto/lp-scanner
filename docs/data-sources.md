# Source inspection and normalization decisions

Inspected official docs and actual API responses on 2026-09-22.

## Meteora

- [Official Data API overview](https://github.com/MeteoraAg/docs/blob/main/developer-guides/dlmm/api-reference/overview.mdx)
- [Production Swagger](https://dlmm.datapi.meteora.ag/swagger-ui/)
- [Production OpenAPI document](https://dlmm.datapi.meteora.ag/api-docs/openapi.json)

`GET /pools` accepts 1-based pagination, up to 1,000 rows/page, `sort_by=tvl:desc`, and filters such as `tvl>=10000 && is_blacklisted=false`. Live response fields used: address, token_x/y metadata, tvl, current_price, created_at (milliseconds), dynamic_fee_pct (percentage), pool_config.bin_step, volume and fees keyed by time window. Missing 5m values remain null. No public active-liquidity USD field exists in the inspected PoolResponse schema.

`GET /pools/{address}` provides a single pool’s metadata. Discovery already contains those fields, so no extra call is made for every pool. `GET /pools/{address}/ohlcv?timeframe=5m&start_time=...&end_time=...` uses Unix seconds and returns OHLCV rows. Live testing showed that a 24-hour request at 5m resolution is rejected with `time range too large`; four 6-hour slices work and overlapping boundary timestamps are deduplicated. `GET /pools/{address}/volume/history` provides historical volume, fees and protocol fees in time buckets; it is a documented extension point, while this MVP records live fee/volume windows itself. The scanner does not invent five-minute fee windows from hourly averages.

Meteora `fees` and `protocol_fees` are separate fields. The application uses the provider’s `fees` field, never adds protocol fees to it and does not claim it is what a specific LP would receive. Token `freeze_authority_disabled=false` maps to an enabled freeze-authority warning. Metadata `is_verified` is distinct from a token security audit.

## Uniswap

The older documentation URL redirects to the new developers site:

- [Subgraph overview](https://developers.uniswap.org/docs/ecosystem/subgraphs/overview)
- [V3 entities](https://developers.uniswap.org/docs/ecosystem/subgraphs/concepts/v3/entities)
- [V3 query examples](https://developers.uniswap.org/docs/ecosystem/subgraphs/guides/v3-query-examples)

V3 entity definitions distinguish `token0Price` (token0 per token1) and `token1Price` (token1 per token0). The latter matches our pair convention. Pool `liquidity` is not USD active liquidity. Optional configured subgraphs query complete `poolHourData` intervals with `volumeUSD` and `feesUSD`, not lifetime counters mislabeled as 1h. Missing hourly rows are not assumed to be zero. Subgraph fees may include protocol-level accounting differences; they are provider-reported amounts.

## PancakeSwap

- [Official subgraph documentation](https://developer.pancakeswap.finance/apis/subgraph)
- [Official subgraph repository](https://github.com/pancakeswap/pancake-subgraph)

The official documentation lists V3 Exchange subgraphs separately from MasterChef and V2. BSC V3 Exchange is listed as `Hv1GncLY5docZoGtXjo4kwbTvxm3MAhVZqBZE4sUT9eZ` in The Graph explorer. Users supply their chain-correct gateway URL when opting into subgraph enrichment. The Graph requires an API key associated with provider usage; no key is embedded in this project.

## Keyless EVM fallback

- [GeckoTerminal public API guide](https://apiguide.geckoterminal.com/)
- [API reference](https://www.geckoterminal.com/dex-api)

Live protocol-specific discovery was inspected at:

- `/networks/base/dexes/uniswap-v3-base/pools`
- `/networks/bsc/dexes/pancakeswap-v3-bsc/pools`

The adapter checks each record’s DEX relationship and token addresses. Pair price is `base_token_price_quote_token`. `reserve_in_usd` is total liquidity; it is not active liquidity. `volume_usd` windows m5/m30/h1/h24 are mapped directly. h6 is not relabeled h4. Transaction buys+sells are swap counts; buyers+sellers are not summed into unique traders because sets can overlap. Fee percentages in pool names are not parsed into measured USD fees.

The provider’s USD price-change percentages do not describe quote-token pair returns. Changes are computed from our own consistent pair-price history instead. OHLCV requests specify `currency=token&token=base`, matching quote-per-base prices. Candle timestamps are converted from seconds to milliseconds, sorted, validated, and incomplete candles excluded.

Provider services and response schemas may change. Live API availability is not a guarantee; tests use clearly marked synthetic fixtures.

Sprint 2 adds on-chain active-liquidity enrichment after discovery; see [methodology, price provenance and verification](active-liquidity.md).
