# Unified LP Scanner

A local, read-only concentrated-liquidity monitor for Meteora DLMM (Solana), Uniswap V3 (Base), and PancakeSwap V3 (BSC). It separates observed activity from risk, records historical snapshots, and detects changes against each pool’s own history.

No wallet connection, seed phrase, private key, transaction signing, or movement of funds exists in this application. Zenith is treated as an LP management interface, not a data source. The scanner identifies the supported pool protocols; it does not certify that a particular pool is supported by Zenith.

## Run locally

Use Node.js 22.13+ and pnpm 11. The application was developed on macOS Apple Silicon with Node 24. SQLite may compile a native module; install Apple Command Line Tools with `xcode-select --install` if needed.

```sh
pnpm install
cp .env.example .env
pnpm db:migrate
pnpm dev
```

Open **http://localhost:3000**. The API listens only on `127.0.0.1:3001`; the dashboard proxies its read-only GET routes. Both services start with one command. The first scan runs immediately. Subsequent scans start 60 seconds after the prior scan completes, avoiding overlapping work.

For continuous operation:

```sh
pnpm build
pnpm start
```

No environment variables or API keys are required for the default feeds. Copying `.env.example` makes defaults and optional settings explicit. Never commit `.env`.

| Command           | Purpose                                                       |
| ----------------- | ------------------------------------------------------------- |
| `pnpm dev`        | Dashboard and background scanner, with development reload     |
| `pnpm build`      | Production frontend build                                     |
| `pnpm start`      | Production dashboard plus API and worker                      |
| `pnpm scanner`    | One scan, then exit; use when the main application is stopped |
| `pnpm db:migrate` | Apply pending versioned SQL migrations                        |
| `pnpm test`       | Vitest checks using synthetic test fixtures and mocked HTTP   |
| `pnpm lint`       | ESLint                                                        |
| `pnpm typecheck`  | TypeScript check                                              |

Run one worker per database. Stop `pnpm dev` before starting production or the standalone scanner.

## Architecture

```text
Next.js dashboard → local GET proxy → Fastify API
                                         │
                                background scanner
                                         │
                         Meteora / EVM adapters
                                         │
                           normalization + analytics
                                         │
                          SQLite / Drizzle repository
                                         │
                          local alerts / optional Telegram
```

- `src/adapters`: source validation with Zod, pagination, source-specific normalization, timeouts, retries, request pacing, candle caching and optional read-only RPC enrichment.
- `src/core`: normalized pools, ratios, snapshot history, transparent activity/risk scoring, surge detection and historical range analysis.
- `src/db`: Drizzle schema, repository and migration runner. WAL and indexes support local concurrent reads. A PostgreSQL migration would replace this storage implementation and SQL dialect, not the adapters or analytics.
- `src/workers`: isolated per-source scans, nonoverlapping scheduling, alerts and persistent cooldowns.
- `src/api`: local Fastify GET endpoints, validation and request rate limiting.
- `src/app` and `src/components`: responsive dark dashboard, filters, sorting, pool detail, charts, metadata, risk warnings and range simulator.

Tables: `pools`, `pool_snapshots`, `tokens`, `alerts`, `scanner_runs`, `app_settings`, `candles`, `schema_migrations`. Current pool records update; historical snapshots append. Completed candles are retained separately. All unsupported numerical fields are `null`, never zero-filled.

## Sources and coverage

Official documentation and live responses were inspected before implementation on 2026-09-22. References and field decisions are recorded in [docs/data-sources.md](docs/data-sources.md).

| Source                           | Default behavior                                                                              | Data limits                                                                                                                                                                                          |
| -------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Meteora Data API                 | Paginated `/pools`, TVL ≥ $10,000, up to 1,000 pools sorted by TVL                            | Fees, volume, metadata, dynamic fee rate, bin step and creation time. Active-bin USD enrichment for the first 40 pools via official SDK account decoding. Optional windows remain null when omitted. |
| GeckoTerminal Base Uniswap V3    | First page of up to 20 protocol-specific pools                                                | Pair price, TVL, volume, swap counts and pool age. Event fees warm up for up to three eligible pools; current V3 virtual reserves and bounded depth are separate.                                    |
| GeckoTerminal BSC PancakeSwap V3 | First page of up to 20 protocol-specific pools                                                | Same discovery limits. Bounded event fees account for emitted protocol fees where a complete window exists. No paid key required.                                                                    |
| Optional protocol V3 subgraph    | Preferred if a URL is configured; falls back to public discovery on failure                   | Hourly fees and volume only when every expected completed UTC hour is present. Provider/indexer fees are not a personalized LP payout.                                                               |
| Optional Base/BSC RPC            | Checks chain ID and block freshness, then Multicall reads current V3 state and token decimals | No transactions, signing, or wallet interaction. Discovery does not need RPC.                                                                                                                        |

Default discovery is deliberately bounded, and the source-health panel reports caps. Set `METEORA_MAX_POOLS=0` to scan all pools matching `METEORA_MIN_TVL`; set `METEORA_MIN_TVL=0` to include low-liquidity pools. Blacklisted Meteora pools are excluded by discovery. `EVM_PAGES` accepts 1–10 pages (20 pools/page). Pagination while markets change can shift pool membership; Meteora results are deduplicated.

Historical OHLCV is fetched on opening a pool detail, cached for five minutes and persisted. These are completed five-minute candles from the last day, not snapshots converted into fictitious OHLCV. Realized volatility becomes available for pools with a complete contiguous candle history. Subsequent scans reuse retained candles when their timestamps cover the requested window. There is no continuous candle crawl for every pool. Optional subgraph pools do not request Gecko candles because canonical token order may differ; those pools currently show no range simulation.

Public APIs can be delayed, incomplete or unavailable. Observation timestamps mean when this scanner received data, not a certified block timestamp. Failed sources keep their last observation, visibly marked stale after three scan intervals. A source failure does not prevent other adapters from writing snapshots.

Sprint 2 adds active-liquidity provenance to each row and pool detail, plus a **Reliable active liquidity** filter (fresh HIGH/MEDIUM; V3 estimates remain labeled). Sprint 3 adds timestamped independent USD prices, event-derived EVM fee windows, and bounded ±1/2.5/5/10% depth. See [pricing](docs/pricing.md), [fees](docs/fees.md), and [liquidity depth](docs/liquidity-depth.md). Older indexer prices still have unknown publication times and remain explicitly LOW when no independent quote is available.

## Metric definitions

- **TVL:** total USD liquidity reported by the provider, including inactive liquidity.
- **Active liquidity:** actual active-bin token balances valued in USD for DLMM; an explicitly labeled virtual-reserve depth estimate for V3. Provenance, confidence, block/slot, token amounts, decimals and prices are stored. See [Sprint 2 methodology](docs/active-liquidity.md). These protocol denominators are not equivalent deposited capital.
- **Fee efficiency:** `fees / activeLiquidityUsd`, shown as a percentage for 1h and 24h. Null if either input is missing or denominator is zero. Pool-wide fees against current active capital would still be an approximation, not individual-position yield.
- **Capital turnover:** `volume / activeLiquidityUsd`. Separate from `volume24h / tvlUsd`, which is TVL turnover.
- **Fee / volume acceleration:** current hourly amount divided by the 24h average hourly amount. `3×` means three times that average, not +300%. A zero baseline produces null, not infinity.
- **Liquidity change:** percentage change versus a stored observation 30 minutes ago (up to two minutes earlier). TVL and active liquidity are tracked independently.
- **Pair price:** quote tokens per base token; not necessarily USD. Gecko’s USD price-change percentages are not mixed into this pair-price series.
- **Price changes:** derived from observations at 5m, 30m, 1h, 4h and 24h. They remain unknown during warmup or data gaps. Target snapshots must be no more than two minutes older than the target; very coarse scan intervals can leave these metrics unavailable.
- **Trend:** requires 30m, 1h and 4h changes. All within ±3%: ranging. All above +1% with 4h >3%: trending up; symmetric for down. Absolute 1h ≥20% or 4h ≥35%: extreme move. Other combinations remain unknown rather than forcing a classification. This measures changes, not whether every intervening price stayed inside a band.
- **Realized volatility:** square root of the sum of squared log returns over completed, contiguous five-minute candles, multiplied by 100. Not annualized. Insufficient candle coverage stays unknown.

No APR projections are displayed. High fees can accompany adverse selection, impermanent loss, volatility, range exits, token restrictions, liquidity loss, gas costs and market manipulation. High activity does not necessarily mean profit.

## Activity and risk scores

These are transparent heuristics, not calibrated probabilities or expected returns. Read [src/core/analytics.ts](src/core/analytics.ts) for the full formulas.

Activity components use `weight × clamp(value / target, 0, 1)`:

| Component                         | Maximum points | Saturation target |
| --------------------------------- | -------------: | ----------------: |
| Fee efficiency 1h                 |             25 |         0.01 (1%) |
| Capital turnover 1h               |             20 |                5× |
| Volume acceleration               |             15 |                3× |
| Fee acceleration                  |             15 |                3× |
| Swap count 1h                     |             10 |             1,000 |
| Unique traders 1h                 |             10 |               300 |
| 4h average fee rate / 24h average |              5 |                1× |

Missing inputs do not earn points and weights are **not** redistributed. Coverage is the sum of available weights. No inputs means a null score. Therefore default public feeds cannot achieve 100, and the default 80-point alert may be unreachable without richer data. This is intentional. Explanations show components earning at least 60% of their available weight. Scores from different coverage levels are not directly comparable.

Risk separately adds points for low liquidity (20), new pool (15), new token (15), high volatility (25), extreme hourly moves (25), TVL collapse (25), active liquidity collapse (25), abnormal fee spikes (15), high holder concentration (20/token), enabled freeze/mint authorities (10 each/token), unverified provider metadata (5/token), and directional trends (10). Blacklisted metadata adds 50 when encountered. The result is capped at 100.

There are 16 data checks; missing checks add `ceil(missing / 16 × 35)` uncertainty points. Coverage reports the fraction of known checks. All-missing risk is 35, never a safety claim. Provider metadata verification is not verified contract source. Token age, mint authority, holder concentration, EVM tax/restriction detection, and contract verification are currently unavailable and explicitly disclosed.

## Activity surge

A surge requires both hourly fees and hourly volume to reach at least `SURGE_MULTIPLIER` (default 3×) their values recorded 30 minutes earlier, with a minimum `SURGE_MIN_HOURLY_FEES` of $10. This compares overlapping hourly windows; it is a conservative rate-change heuristic, not a disjoint-volume estimate. No baseline or zero baseline means no surge.

`quietSurge` additionally requires the multi-timeframe ranging classification. It means limited measured net changes, not proof that price never broke out between observations. The detail page distinguishes sustained activity, fading spikes, mixed activity and fresh surges when the necessary fee windows exist.

## Historical range simulator

Bands are fixed at ±2.5%, ±5%, ±10%, ±15% around the current pair price. For each, the simulator reports:

- Bounds and percentage of complete candles whose entire high–low range fits.
- Mean and longest observed consecutive in-range run in minutes.
- In-range → out-of-range exits divided by adjacent observed transitions.
- Continuous V3 concentration proxy `2 / (2 − sqrt(1−w) − 1/sqrt(1+w))`, versus full-range capital at the band center.

Gaps break runs; boundaries censor runs. Observed run length is not expected future survival. This is retrospective occupancy, not a strategy backtest, and does not model actual entries, fee share, impermanent loss, rebalancing, taxes or gas. The concentration proxy is not a bin-aware Meteora calculation. Missing candles show no result. Bin-aware and tick-aware executable ranges are future work.

## Configuration and optional keys

See [.env.example](.env.example) for every option. Values are validated at startup without echoing secrets.

- `DATABASE_PATH`: local SQLite path, default `./data/scanner.sqlite`.
- `SCAN_INTERVAL_SECONDS`: default 60; minimum 15.
- `RETENTION_DAYS`: default **0, keep all**. Positive values delete older snapshots, candles, alerts and scanner runs. Pool/token current records remain. Back up before shortening retention.
- `METEORA_API_URL`, `GECKO_API_URL`: provider URL overrides.
- `METEORA_REQUESTS_PER_SECOND`: default 5, below Meteora’s documented 30 RPS.
- `GECKO_REQUESTS_PER_MINUTE`: default 20, shared by both EVM adapters and candle requests in one process.
- `BASE_SUBGRAPH_URL`, `BSC_SUBGRAPH_URL`: optional chain-correct V3 GraphQL endpoints. The Graph typically uses an API key in the URL and provider usage limits apply. No hardcoded key or paid subscription is required for the basic scanner.
- `BASE_RPC_URL`, `BSC_RPC_URL`: read-only RPC overrides; empty values use public defaults. `SOLANA_RPC_URL` likewise overrides Solana mainnet RPC. Enrichment caps use `ACTIVE_LIQUIDITY_METEORA_LIMIT` (40) and `ACTIVE_LIQUIDITY_EVM_LIMIT` (20 per chain); zero disables that enrichment. `ACTIVE_LIQUIDITY_ENABLED=false` disables all enrichment.
- `HTTP_TIMEOUT_MS`, `HTTP_RETRIES`, `LOG_LEVEL`: default 15s, 2 retries, info. Retry transient failures with exponential backoff; respect bounded Retry-After values. Schema errors and permanent client errors do not retry.
- Alert thresholds and cooldown are environment-configured. No settings-write API is exposed.

### Telegram

Optional. Create a Telegram bot and configure:

```dotenv
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_CHAT_ID=your-chat-id
APP_URL=http://localhost:3000
```

Alerts fire for **surge OR (minimum activity AND maximum risk AND minimum 1h fee efficiency)**. The surge branch intentionally bypasses the risk threshold; messages include risk. Rules are configured through `ALERT_*` and `SURGE_*` environment variables.

A per-pool, per-kind cooldown persists in SQLite before sending. Delivery status is local/sent/failed/unknown. A timed-out send is not retried to avoid duplicate Telegram messages; the cooldown remains active. Without configuration, local alerts are still stored. Localhost links only work on the machine running the scanner; use an explicitly configured reachable URL if needed. Never expose the unauthenticated local app publicly without adding access control.

## macOS operation and storage

Use production mode for 24/7 operation. macOS cannot scan while asleep; keep the Mac powered and use System Settings’ sleep controls as appropriate. A closed laptop lid can still put the machine to sleep. Never infer continuous market coverage across sleep gaps.

An editable LaunchAgent example is in [docs/com.local.lp-scanner.plist](docs/com.local.lp-scanner.plist). Replace `PROJECT_PATH`, `PNPM_PATH`, `NODE_BIN_DIRECTORY` and `LOG_DIRECTORY` with absolute paths (`command -v pnpm` and `command -v node` locate the binaries). Create the log directory, build the app first, and copy the configured file to `~/Library/LaunchAgents/com.local.lp-scanner.plist`. Then:

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.local.lp-scanner.plist
launchctl kickstart gui/$(id -u)/com.local.lp-scanner
# Stop it before development, changing Node versions, or maintenance:
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.local.lp-scanner.plist
```

The example restarts on exit; it is not installed automatically. Logs are plain files and need rotation. SQLite storage scales with pool count and scan frequency. Keeping all data indefinitely can consume gigabytes per day at large discovery caps. Reduce `METEORA_MAX_POOLS`, increase the interval, or choose retention deliberately; inspect `du -sh data` regularly. The scanner queries only time slices needed for metrics instead of loading every historical row for each pool.

Back up SQLite after stopping the app; copy the whole `data` directory, including WAL files if present. Do not copy a lone database file while writes are active. Retention does not compact the database file; use SQLite maintenance offline if disk reclamation is needed.

## Reliability and troubleshooting

- **Empty first screen:** wait for the first scan; inspect the source-health panel and `/api/health`. No fake production rows exist.
- **Missing fees or efficiency:** EVM event-derived fees need a full confirmed block window and timestamped historical prices; 24h windows take a day to warm up. Liquidity is unavailable outside the enrichment budget or when state/prices fail validation. Missing, stale or zero active liquidity gives null efficiency and turnover; total TVL is never substituted.
- **No surge:** at least 30 minutes of suitable own-pool history is needed; a quiet-surge classification needs 4h price history. 24h changes need a day.
- **No volatility/range result:** open pool details to fetch candles. Gaps and insufficient history deliberately produce unknown values.
- **Partial source:** source fields or optional enrichments are unavailable. Other protocols continue. Old rows remain with their observation timestamp.
- **API 429 or slow scans:** reduce EVM pages/request rates; providers also enforce per-IP limits shared with other applications.
- **Port occupied:** stop the previous app. `API_PORT` changes the API port and dashboard proxy together; the web port can be set with Next’s `PORT` environment variable.
- **SQLite build errors:** use a supported native arm64 Node installation and Xcode Command Line Tools, then reinstall dependencies. Do not mix Rosetta x64 modules with arm64 Node.
- **Interrupted process:** completed snapshots remain committed. A scanner run interrupted by process termination can remain recorded as running; later completed runs supersede it.
- **Failed optional subgraph:** confirm chain and V3 schema. The adapter falls back to the public feed. A schema mismatch never fabricates fees.

Graceful SIGINT/SIGTERM handling stops scheduling, waits for current requests/work, and closes SQLite. Database operations are transactional per source. HTTP logs omit provider URLs, raw responses and secrets. Fastify rate limiting is local process scope. React escapes provider text; addresses and numeric fields are validated at ingress.

## Current limitations and next work

1. Backfill and reconcile historical oracle observations so newly followed pools can show trustworthy 4h/24h event fee windows sooner. Preserve the current no-guessing rule for gaps and stale prices.
2. Add optional token-risk sources for token creation time, authorities, concentration, transfer restrictions and verified contract source. Current coverage is intentionally incomplete.
3. Add a budgeted background OHLCV crawl and verified source timestamps. At present candles are fetched on detail views and stored.
4. Validate optional subgraph/RPC integrations against user-selected providers; default public feeds are the live path verified locally. Add pool discovery beyond capped ranked pages where needed.
5. Add Uniswap V4 only after modeling pool IDs, hooks and dynamic fees explicitly; **V4 is not implemented**. Other EVM chains can instantiate `EvmPoolAdapter` with a chain/DEX configuration.
6. Add a point-in-time replay/backtest using retained price, fee, depth, snapshot and alert observations. The current range simulator is descriptive only.
7. For large archives, use normalized metric columns, aggregation and PostgreSQL. The current repository stores validated snapshot JSON for MVP flexibility, with indexed pool/time access.

No Docker is required. No autonomous trading features are included.
