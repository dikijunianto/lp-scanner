# Base live ingestion

Live fees use a separate confirmed contiguous cursor from historical backfill. Stale cursors resume at last confirmed block+1; ranges halve on provider range errors. Reorg validation remains in place, and recorded gaps remain explicit. No age-based cursor reset hides missing history. Fair oldest-cursor selection prevents recently served pools monopolizing a slot. Errors retry after15s; rate-limit errors after60s. BSC without configured capable log sources does not repeatedly request known-incapable public logs.

Validated pinned V3 token addresses, decimals and fee tier can be used independently of USD liquidity valuation. Missing USD prices therefore preserve raw swaps with null USD volume/fees; these windows never count as completeUSD fee coverage. No fake price is inserted.

Every HOT pool remains in all-HOT reporting. Active denominator removes only fresh complete EVENT_DERIVED windows that prove NO_ACTIVITY. Missing infrastructure stays in the denominator. Cursor reasons distinguish no recent activity, RPC failure, timeout, rate limit, stuck cursor, starvation, stale head andunknown. Stored heads must be fresh as well as cursor timestamp; missing heads cannot become healthy evidence.

±5% V3 depth caches pinned state, tick bitmap words and liquidityNet within bounded coverage. Exact-block/state-key reuse is safe. Cross-block reuse is deliberately unavailable without Mint/Burn invalidation evidence; unchanged current tick alone cannot prove unchanged liquidityNet. Meteora fetches only required±5% arrays and retries once when active-bin state moves. Depth requires state/price age, publication freshness and price drift constraints. Stale depth never counts current.10% data not fetched in the5% path remains null.
