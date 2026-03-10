# Architecture Decision Records (ADR)

Strategic decisions for the Cryonix trading system.
Each entry captures **Why** (context), **What** (decision), and **How** (consequences).

Status: `Active` | `Superseded` | `Deferred` | `Reverted`

## Index (newest first)

| ADR | Date | Status | Summary |
|-----|------|--------|---------|
| [027](027-grok-analysis-and-rotation.md) | 2026-03-10 | Active | Grok analysis tool, signal hunter (auto-inject), smart position rotation |
| [026](026-ai-prompt-dip-specialization.md) | 2026-02-25 | Active | Specialized AI prompts for dip vs trend signals (fix 88% dip rejection) |
| [025](025-trending-exception-adx.md) | 2026-02-25 | Active | Allow trend signals through dip focus when ADX > 30 + HTF aligned |
| [024](024-x-sentiment-refinement.md) | 2026-02-25 | Active | X sentiment from defensive-only to active confidence boosts |
| [014](014-telegram-scraper-ai-parser.md) | 2026-02-25 | Active | AI fallback parser + sentiment detection + channel upgrade |
| [013](013-self-calibration-cron.md) | 2026-02-25 | Active | Schedule self_calibrate.py every 6h to measure filter effectiveness |
| [012](012-telegram-bot-redesign.md) | 2026-02-25 | Active | Event-driven alerts instead of 100+ daily spam messages |
| [011](011-smart-dip-hunter-strategy.md) | 2026-02-25 | Active | Focus on dip/value patterns, block pure trend-following (ADX exception) |
| [010](010-full-system-audit.md) | 2026-02-25 | Active | 4-phase systematic audit with 21+ fixes across all services |
| [023](023-symbol-whitelist-expansion.md) | 2026-02-22 | Active | Expand from 2 to 15 quality USDC symbols |
| [022](022-signal-quality-overhaul.md) | 2026-02-20 | Active | HTF hard veto, multi-TF confirmation, regime-gated pattern selection |
| [021](021-dashboard-v2.md) | 2026-02-20 | Active | Replace 40-component dashboard with single-file ~200-line layout |
| [020](020-backtest-gate.md) | 2026-02-20 | Active | Backtest-as-a-function quality gate for Evolution + AI Brain |
| [006](006-baseline-freeze-mechanism.md) | 2026-02-20 | Active | Freeze mutations to measure clean trading performance |
| [019](019-integration-test-suite.md) | 2026-02-19 | Active | 25-group / 82-test Bash integration test with safety guards |
| [008](008-ai-brain-autonomous-tuning.md) | 2026-02-18 | Active | Grok-powered autonomous parameter tuning every 6h + acute triggers |
| [018](018-signal-bottleneck-fixes.md) | 2026-02-17 | Active | Expand position slots, add stagnation exits, fix instance lock |
| [017](017-passive-earn-strategy.md) | 2026-02-17 | Deferred | Phased idle-capital yield (Binance Earn, liquid staking, DeFi) |
| [016](016-aktienix-stock-trading.md) | 2026-02-17 | Deferred | US stock trading via Alpaca Markets with cross-market macro filter |
| [009](009-coinmarketcap-integration.md) | 2026-02-17 | Active | CoinMarketCap Free tier for macro intelligence (F&G, BTC dom, MC) |
| [015](015-centralized-config.md) | 2026-02-16 | Active | Centralize 89+ config values into single cryonix.toml |
| [007](007-evolution-system.md) | 2026-02-15 | Active | Claude Code CLI autonomous code mutation every 2h |
| [005](005-grok-ai-validation-fail-closed.md) | 2026-02-14 | Active | Fail-closed AI validation — reject signals when AI unavailable |
| [004](004-capital-allocator-split-pool.md) | 2026-02-14 | Active | Split capital into signal pool, grid pool, and reserve |
| [003](003-spot-only-mode.md) | 2026-02-14 | Active | No leverage, no shorts — spot-only BUY execution |
| [002](002-hybrid-architecture.md) | 2026-02-13 | Active | Python engine + TypeScript dashboard hybrid monorepo |
| [001](001-semi-autonomous-trading.md) | 2026-02-13 | Active | Semi-autonomous trading with human-set guardrails |
