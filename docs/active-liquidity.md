# Sprint 2: active liquidity enrichment

The existing providers, worker, SQLite history, scoring and UI remain in place. Enrichment runs between discovery and snapshot analysis. All RPC methods are read-only and explicitly allowlisted. No signing, wallet connection, transaction submission or trading feature was added.

## Methodology and formulas

### Meteora DLMM — `DLMM_ACTIVE_BIN_V1`

Uses official `@meteora-ag/dlmm` 1.9.14 account coder and bin/PDA helpers. Verifies mainnet genesis, account owner, pair identity, pool enabled state, active bin-array index, mint ownership and initialized mint decimals. Reads pairs in groups of 20, derives active-bin arrays, then rereads each pair + its array + token mints in one confirmed account context. A crossing into another array is unavailable until the next scan. The context slot's block time must be fresh.

`X = activeBin.amountX / 10^decimalsX`

`Y = activeBin.amountY / 10^decimalsY`

`activeLiquidityUsd = X × priceXUsd + Y × priceYUsd`

`pairPrice = (1 + binStep / 10000)^activeId × 10^(decimalsX-decimalsY)`

Amounts are actual market-making balances of the active bin, excluding protocol fees and separate limit-order balances. They do not sum neighboring bins or substitute vault balances/total TVL. One-sided and zero bins are valid observations. Source is `ONCHAIN_DERIVED`.

The SDK ESM distribution currently imports Anchor's CommonJS BN as a named export, which fails under this Node/tsx runtime. We load the official CommonJS entry with `createRequire`; its account layouts remain the source of truth. Optional bigint native bindings are disabled; the supported pure-JS path is used.

### Uniswap V3 Base / PancakeSwap V3 BSC — `V3_VIRTUAL_RESERVES_V1`

Verifies chain ID and protocol factory. Reads `slot0`, current `liquidity`, token identities, fee tier and tick spacing through Multicall3. Reads unique token decimals through a second Multicall. Calls are pinned to the same block number, and its hash/timestamp are checked again afterwards. Failed inner calls leave the affected pool unavailable. Rejects locked pools, invalid bounds, malformed ABI, inconsistent ticks/prices, decimals, tokens or factory.

For raw current in-range liquidity `L` and `s = sqrtPriceX96 / 2^96`:

`Xvirtual = L / s / 10^decimals0`

`Yvirtual = L × s / 10^decimals1`

`activeLiquidityUsd = Xvirtual × price0Usd + Yvirtual × price1Usd`

`pairPrice = s² × 10^(decimals0-decimals1)`; tick cross-check uses `1.0001^tick` with the same decimal adjustment. `slot0.tick` may sit one tick below the mathematical price at a crossed boundary.

This is a defensible **local depth proxy**, not the sum of tokens deposited in currently active positions. Virtual reserves can greatly exceed TVL. Recovering actual active-position capital requires each position's range; a single `L` and current tick cannot determine it. Source is deliberately `ESTIMATED`, with the on-chain method and raw state retained. Never compare its ratios directly against DLMM bin capital as equivalent yields.

## Prices, confidence and expiry

Use existing provider prices: Meteora Data API token `price`, or GeckoTerminal base/quote `*_token_price_usd`, associated by mint/address rather than display order. Both prices must be finite, positive, fetched within 180 seconds, and agree with on-chain pair price within 10%. There is no $1 stablecoin assumption or TVL-derived price. Missing prices give unavailable, including optional subgraph mode, which currently supplies no token USD price observations.

Neither indexer supplies a verified USD price publication timestamp in the consumed schema. Fetch time is recorded separately. Thus both methods are **MEDIUM**, not HIGH. Pair-price agreement detects inconsistency, but cannot prove absolute USD accuracy if both prices are wrong together. Thin/manipulated pools and stale provider caches remain limitations.

Store `activeLiquiditySource`, `activeLiquidityConfidence`, `activeLiquidityUpdatedAt`, `activeLiquidityExpiresAt`, reason, method, block/slot, raw state, canonical token identities, decimals, amounts, prices and provider/fetch time. OFFICIAL_API is reserved for future directly published active-liquidity values. Missing state is UNAVAILABLE; no fabricated zeros.

Block/slot age is at most 120 seconds, with 30 seconds future-clock tolerance. Expiry is the earlier of state age and price-fetch age limits. Current API/UI values and derived ratios expire without rewriting historical snapshots. The browser clock expires displayed results even if subsequent requests fail. Reliable filter accepts fresh MEDIUM/HIGH observations, including a measured zero; division by zero remains null.

`feeEfficiency(window) = fees(window) / activeLiquidityUsd`

`capitalTurnover(window) = volume(window) / activeLiquidityUsd`

Missing, expired or zero denominator yields null. Missing numerator likewise yields null. Pool-wide past fees/volume divided by instantaneous liquidity are activity indicators, not returns to an individual LP. Default EVM discovery still lacks actual fee amounts, so EVM fee efficiency remains null even when turnover is available. No fee-rate × volume proxy is silently introduced.

## Budget and performance

Defaults enrich the first 40 Meteora pools (discovery TVL ordering) and first 20 V3 pools per chain. Other discovered pools explicitly say outside enrichment limit. `ACTIVE_LIQUIDITY_*` settings in `.env.example` control limits, state/price ages and cross-price tolerance. Public RPC URLs are defaults; configured URLs override them. No fallback provider can silently switch chain.

Meteora uses seven RPC requests for 40 targets. V3 uses four RPC requests per chain at the default cap: chain/header batch, state Multicall, decimals Multicall, final header. Aggregates are capped at 140 inner calls. Initial direct RPC batches triggered Base per-call rate limits; Multicall resolved that in live verification.

Run 262: 754 discovered, 79 enriched (39 Meteora, 20 Base, 20 BSC), 675 unavailable (674 outside budget; one token-price disagreement). Protocol enrichment took 1.534s / 2.380s / 3.740s respectively, concurrently. Whole scan was 6.856s, versus roughly 3–4s before enrichment; these are individual observations, not a sustained benchmark. Public endpoints can throttle/fail. Increasing caps increases work and may age prices past their limits.

## Manual verification (2026-09-22)

Official SDK `DLMM.create(...).getActiveBin()` independently matched the scanner's raw balances and active IDs on two real pools:

| Pool | Active bin | Raw X / raw Y | Result |
| --- | ---: | --- | --- |
| YZY/USDC `DQ9weJhfiU4iL5LUoeshDrm5KxDHCMiSbnnKJz7buMcf` | -124 | 68849977190 / 20117296740 | Exact SDK match; both decimals 6 |
| TRUMP/USDC `9d9mb8kooFfaD3SctgZtkxQypkshx6ezhbKio89ixyy2` | 154 | 2602296668 / 0 | Exact SDK match; one-sided bin |

SDK prices also matched the derived bin prices (0.2911720277591737 and 2.1556264830512152). USD totals change with indexer prices even when token balances stay constant. Captured mainnet pair/array/mint bytes are frozen in the deterministic test fixture; tests never call mainnet.

Base WETH/USDC `0xb4cb800910b228ed3d0834cf79d697127bbb00e5`: separately reread `slot0`, `liquidity` and canonical factory `getPool` at block `0x31408c7`. State and factory matched; independent recomputation gave $4,865,778.4557930445, matching stored USD. Provider TVL was $359,166.7597, illustrating why virtual depth is not TVL. Public BSC rejected older block rereads (`missing trie node`); historical verification requires an archive provider or immediate comparison.

An immediate second check at Base block `0x314094f` recomputed WETH/USDC at $3,651,034.3227661136 exactly. BSC USDT/WBNB `0x172fcd41e0913e95784454622d1c3724f546f849`, block `0x75a7b6c`, matched raw state and canonical factory registration; independent USD calculation was $201,336,573.61070275 versus stored $201,336,573.61070272 (relative floating-point error 1.48e-16).

Final resume check on 2026-09-23, run 420: 768 discovered, 79 enriched (39/20/20), 689 unavailable (688 outside budget and one price disagreement). Scan duration 7.313s. All 187,186 pre-Sprint-2 snapshots were compared byte-for-byte against the SQLite backup: zero missing or changed; current database then held 309,590 snapshots. The dashboard retains older pool rows, so its total exceeds current discovery counts.

Validation: 48 deterministic tests, lint, typecheck and production build pass. Live browser verified reliable filter (79 matching pools), provenance, USD values and ratios on TRUMP/USDC.

No claim that protocol UI TVL equals active-bin capital or virtual depth. Sources do not publish this application's chosen USD denominator directly. Confidence in the raw state does not certify indexer USD prices.

## Sources

- [Official Meteora SDK](https://github.com/MeteoraAg/dlmm-sdk/tree/main/ts-client) and [IDL](https://github.com/MeteoraAg/dlmm-sdk/blob/main/ts-client/src/dlmm/idl/idl.json)
- [Solana getMultipleAccounts](https://solana.com/docs/rpc/http/getmultipleaccounts)
- [Uniswap V3 math primer: virtual liquidity](https://blog.uniswap.org/uniswap-v3-math-primer-2)
- [Uniswap V3 pool-state interface](https://github.com/Uniswap/v3-core/blob/main/contracts/interfaces/pool/IUniswapV3PoolState.sol)
- [Uniswap deployments](https://developers.uniswap.org/deployments)
- [PancakeSwap V3 deployments](https://developer.pancakeswap.finance/contracts/v3/addresses)
- [Multicall3 deployments](https://github.com/mds1/multicall/blob/main/deployments.json)

Next sprint: timestamped independent USD pricing, measured V3 fee windows, and bounded tick-range depth before expanding cross-protocol ranking or enrichment coverage.
