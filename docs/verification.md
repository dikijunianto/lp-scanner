# Local verification — 2026-09-22

Verified on macOS arm64, Node.js 24.1.0, pnpm 11.19.0.

- Dependencies installed; peer dependency check passed. TypeScript 5.9.3 and ESLint 9 are pinned for compatibility with the current Next/React lint plugins.
- Database migration succeeded.
- Vitest: **29 tests passed** across analytics, normalization, mocked adapters, bounded candle retrieval, source/orientation changes, persistence, retention, cooldowns and source-failure isolation.
- TypeScript typecheck: passed.
- ESLint: passed without warnings.
- Production Next.js build: passed.
- Production services started on loopback ports 3000 and 3001.
- Health endpoint returned HTTP 200 with `readOnly: true`.
- First scan persisted 753 pools: 713 Meteora, 20 Base Uniswap V3, 20 BSC PancakeSwap V3. Counts vary with discovery and retained observations.
- After six scans, SQLite contained 4,522 snapshots, 755 current/retained pools, 407 tokens, 850 candles and five nonsecret settings.
- Live sample detail requests on Solana/Base/BSC returned HTTP 200, real candle histories, and four range simulations. Solana sample: 274 candles; Base and BSC samples: 287 each. Missing candles remain gaps and can prevent realized-volatility calculations.
- Browser checks confirmed live dashboard rows, Base filtering, encoded pool-address navigation, score/risk explanations and historical charts. No browser console errors were reported for the checked detail page.
- At a 390px viewport, both dashboard and detail document widths stayed within the viewport; wide tables scroll within their containers.
- Graceful stop/restart preserved snapshots.

Meteora, GeckoTerminal, and keyless fallback paths were verified live. Optional user-supplied GraphQL/RPC providers and Telegram delivery were not live-tested without configuration. Telegram tests disable sending. No 30-minute live surge or 24-hour continuous-runtime soak is claimed; those algorithms are verified with deterministic fixtures. This is the Sprint 1 baseline. Sprint 2 active-liquidity results are documented in [active-liquidity.md](active-liquidity.md). V4 and advanced token-risk checks remain outside current coverage; see README limitations.

The application was left running locally. No LaunchAgent was installed, so it is not configured to restart after login or reboot.
