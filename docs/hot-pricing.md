# HOT pricing

Solana+Base are the economic refresh priority. DefiLlama and CoinGecko retain publication timestamps, source, observation time, confidence and resolution. Optional timestamped independent adapters fit the existing source interface. A missing timestamp never becomes an observed-at publication timestamp. Single-source observations cap atMEDIUM; duplicated consensus constituents do not count as independent sources. Weak sources never automatically becomeHIGH. Price disagreement remains visible and blocks derivation.

Cross-asset pricing uses another validated pool, an approved address-bound SOL/WETH/USDC reference with fresh independent USD evidence, aligned timestamps<=120s and>=100,000USD actual deposited-liquidity lower bound. Formula: token0USD=pairPrice(token1/token0)*token1USD; inverse for token1. Exact scored pool excluded; EVM addresses normalized. Recursive derived references excluded. Provenance records DERIVED_CROSS_PRICE, originating pool/address, reference source/publication time, state time/block and liquidity evidence. Confidence caps atMEDIUM and expires with the oldest evidence.

Meteora active-bin balances provide a conservative actual deposited lower bound when the reference side has independent pricing. V3 virtual reserves are not actual deposited collateral and never qualify as derivation liquidity. Approved references are address lists, not symbols. Other assets require an explicit approved mapping; USDT symbols alone do not qualify.

HOT diagnostics report token failures separately: unsupported sampled sources, timeout, rate limit, stale, disagreement orUNKNOWN. Mapping/too-new classifications require evidence and are not inferred from missing quotes. Provider details remain attached to token records. Existing non-timestamped pair quotes remain unsupported. New source integrations requiring credentials have not been invented; the80% target remains a measured gate, not a confidence downgrade.

## Measured 24h result

Reliable selected HOT pair pricing ended at 22/104 (21.154%): Solana 17/96, Base 5/8. All 82 unavailable pools remain included; the 80% target passed at 0/24 hourly checkpoints. Current depth among reliably priced pools was 13/22 (59.091%). Timestamp/source expansion has not met readiness. [Full measured evidence](sprint9-validation.md).
