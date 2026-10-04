# HOT price coverage

Economic refresh reserves its cycle for watched/active-signal HOT pools, then remaining HOT pools, ordered by oldest observations. Cold work cannot share that refresh batch. Missing/stale direct lookup fallbacks rotate instead of repeatedly selecting the same tokens. Source coverage records successes, failures, publication timestamps, resolution, latency and confidence independently of deduplicated publications.

Graph paths use chain plus token contract, approved independently priced anchors, at most2 hops by default, aligned timestamps, no cycles, and no analyzed pool at any hop. Confidence is capped MEDIUM. Every hop records pool, block/slot, reference price/liquidity and execution impact. No symbol-only anchors or total-TVL substitution.

DLMM state reads actual SPL vault amounts for custody liquidity and active-bin amounts for execution. The1000USD notional must fit in the output-side active bin; no bin crossing is inferred. V3 custody amounts come from pinned ERC20 balance reads. Execution separately uses raw current liquidity L and square-root price s: token0 input yields s'=Ls/(L+dx*s); token1 input yields s'=s+dy/L. Decimal precision80 protects raw amounts. Reject impact above1% or movement outside the current tick-spacing cell. These conservative tests can reject usable liquidity beyond the current cell/bin; they do not claim execution depth across all ranges.

Transitions into reliable pricing enqueue ±5% reconstruction. All HOT, HOT ACTIVE and HOT SIGNAL denominators remain visible; conditional depth never substitutes for all-HOT coverage. Unproven thin-token paths remain unavailable. Provider failures are preserved rather than fabricated token-age diagnoses.

Primary references: [Uniswap SqrtPriceMath](https://github.com/Uniswap/v3-core/blob/main/contracts/libraries/SqrtPriceMath.sol), [Meteora DLMM SDK](https://github.com/MeteoraAg/dlmm-sdk/blob/main/ts-client/src/dlmm/index.ts), [SPL account layout](https://github.com/solana-program/token/blob/main/interface/src/state.rs).
