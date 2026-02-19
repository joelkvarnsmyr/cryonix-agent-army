# AGENTS.md — AI & Autonomous Systems

This document describes all autonomous agents and AI-powered systems in Cryonix.

## Overview

Cryonix runs multiple autonomous systems that scan markets, validate trades, execute orders, and self-improve. This document maps each system, its role, schedule, and data flow.

## 1. Python MarketScoutTank (Signal Generator)

- **Type:** Autonomous scanner
- **Schedule:** Continuous loop, every 10 seconds
- **Location:** `packages/engine/src/tanks/market_scout_tank.py`
- **What it does:** Scans 45 USDC pairs via CCXT (Binance), runs QuantGuild pattern detection (8 patterns: RSI, Bollinger, MACD, EMA, Volume Spike, Dip Buy, Deep Value Crash, Momentum Gainer), applies RiskGate confidence threshold (configurable via `risk.min_confidence` in `cryonix.toml`, currently 60%), queues approved signals to Redis `trades:pending`.
- **AI component:** None -- pure technical analysis
- **Output:** Trading signals with confidence scores, persisted to Postgres via `/api/signals`

## 2. Grok AI Validator (Trade Gatekeeper)

- **Type:** AI validation gate (fail-closed)
- **Schedule:** On-demand -- called for each signal before execution
- **Location:** `apps/web/src/app/api/auto-trade/route.ts` (`getAIValidation` function)
- **Model:** `grok-4-1-fast-reasoning` (xAI API, configurable via `[ai]` section in `cryonix.toml`)
- **What it does:** Receives a signal with pattern, confidence, market data, sentiment scores, and calibration EV. Sends to Grok with reasoning mode enabled (`reasoning_effort = "high"`). Returns approve/reject with reasoning, blended confidence score, and optional adjusted SL/TP levels. Enables xAI live search for real-time X/news context. If AI is unavailable, signal is REJECTED (fail-closed).
- **Confidence blending:** `final = (TA * 0.60) + (AI * 0.40)` (weights configurable in `cryonix.toml`)
- **Output:** Approved/rejected signal with AI reasoning, token usage stats

## 3. Auto-Trader (Execution Engine)

- **Type:** Autonomous trading loop
- **Schedule:** Polls every 30 seconds (`timing.auto_trader_poll_ms = 30000`)
- **Location:** `scripts/services/auto-trader.mjs` -> `apps/web/src/app/api/auto-trade/route.ts`
- **What it does:**
  1. Monitors open positions (SL/TP/trailing stop/stagnation exit after 8h)
  2. Reads `trades:pending` from Redis
  3. Capital Allocator check (regime-based, strategy budgets)
  4. GainerScanner boost (+10% confidence for top movers)
  5. Telegram Signal boost (+5-12% if external channels agree; Phase 1: log only)
  6. CMC Fear & Greed adjustment (extreme fear: DV boost, extreme greed: penalty)
  7. CMC BTC dominance penalty (alts penalized when BTC dom rising)
  8. Filters: SPOT_ONLY, max positions (5), daily limit (10), CMC market cap rank (top 500), FDV/MC ratio (<4x), EV model (reject negative-EV patterns), X sentiment (reject on hack/exploit alerts), order book spread (max 0.3%)
  9. Grok AI validation (fail-closed, blends confidence)
  10. Executes BUY on Binance via CCXT
  11. Places native STOP_LOSS_LIMIT safety order
  12. Tags trade with `config_version` hash (8-char SHA256 of `cryonix.toml`)
- **AI component:** Grok validation (step 9)
- **Output:** Executed trades, position monitoring, instance-locked (60s TTL)

## 4. Evolution Engine (Self-Improver)

- **Type:** Autonomous code mutation system
- **Schedule:** Every 2 hours (cron: `0 */2 * * *`)
- **Location:** `scripts/evolution/copilot-evolution.mjs`
- **What it does:**
  1. Analyzes recent trade performance (last 48h: pattern P&L, exit types, win rates, trade frequency, GainerScanner missed opportunities)
  2. Smart trigger detection (P&L < -$2, structural issues: slTooTight, trailingKillingProfits, overTrading, etc.)
  3. Gathers calibration EV data from Redis and X sentiment context
  4. Generates mutation plan via **Claude Code CLI** (`claude -p` with model `claude-opus-4-6`)
  5. Backs up critical files to `.evolution-backups/{run_id}/`
  6. Claude Code directly applies mutation (parameter changes in `cryonix.toml` or code changes to quant.py, risk_gate.py, risk_manager.py, route.ts)
  7. Diff-size guard: rejects changes > 100 lines
  8. Scoped staging: only `CONFIG.CRITICAL_FILES` are staged (no `git add .`)
  9. Verification suite: `verify_deep_value.py`, `verify_grid.py`, `pnpm build`, `pnpm type-check`, `pnpm test`
  10. Computes structured TOML diff and logs to `config_changes` table
  11. Commits with `[Auto-Evolution {run_id}]` prefix
  12. Reports to Telegram with run summary and token usage
- **AI component:** Claude Code CLI (claude-opus-4-6) for analysis and mutation
- **Safety:** Max 100 lines changed, backup + rollback, verification gate, protected risk controls (never removes SL/position limits/daily loss limits), git stash protection for uncommitted work
- **Output:** Parameter optimizations, structured change logs in `evolution_runs` and `config_changes` tables

## 5. Pattern Calibrator (EV Analyst)

- **Type:** Statistical analysis pipeline
- **Schedule:** Every 6 hours (cron: `0 */6 * * *`)
- **Location:** `scripts/strategy-lab/calibrate.py`
- **What it does:** Queries trade history (default: 30-day lookback, min 3 trades per pattern), calculates Expected Value per pattern: `EV = (winRate * avgWin) - ((1-winRate) * |avgLoss|)`. Writes results to Redis `calibration:patterns` (24h TTL) and daily snapshot to Postgres `calibration_history` table (upsert on `snapshot_date, run_type`).
- **AI component:** None -- pure statistics
- **Output:** Pattern EV scores consumed by auto-trader's EV model filter (blocks negative-EV patterns)

## 6. Self-Calibrator (Accuracy Auditor)

- **Type:** Prediction accuracy checker
- **Schedule:** Runs as part of calibration pipeline (every 6h)
- **Location:** `scripts/strategy-lab/self_calibrate.py`
- **What it does:** Compares signal predictions to actual price outcomes. Measures per-pattern hit rate, filter effectiveness (acted vs skipped), opportunity cost for skipped signals. Writes to Redis `calibration:accuracy` (48h TTL) and daily Postgres snapshot to `calibration_history`.
- **AI component:** None -- statistical analysis
- **Output:** Filter effectiveness scores, recommendations (LOOSEN/REDUCE/REVIEW)

## 7. CMCScout (Macro Data Provider)

- **Type:** Market data fetcher
- **Schedule:** Every 10 minutes (`coinmarketcap.poll_interval_seconds = 600`)
- **Location:** `packages/engine/src/tanks/cmc_scout.py`
- **What it does:** Fetches Fear & Greed index, global market cap, BTC dominance, per-symbol market cap, rank, and FDV from CoinMarketCap API (Free tier). Writes to Redis keys: `cmc:fear_greed`, `cmc:global`, `cmc:mcap:{SYMBOL}`.
- **Requires:** `CMC_API_KEY` env var + `coinmarketcap.enabled = true` in `cryonix.toml`
- **AI component:** None -- data pipeline
- **Output:** Macro data consumed by auto-trader for confidence adjustments, regime override, and market cap/FDV filters

## 8. NewsScoutTank (Sentiment Scanner)

- **Type:** RSS sentiment analyzer
- **Schedule:** Every 15 minutes (`engine.news_scan_interval_seconds = 900`)
- **Location:** `packages/engine/src/tanks/news_scout_tank.py`
- **What it does:** Scans crypto RSS feeds, scores sentiment per symbol, stores in Redis `sentiment:{SYMBOL}`.
- **AI component:** None -- keyword-based sentiment scoring
- **Output:** Sentiment scores

## 9. X Sentiment Scanner

- **Type:** Social media sentiment monitor
- **Schedule:** Every 15 minutes (cron: `*/15 * * * *`)
- **Location:** `scripts/strategy-lab/x_sentiment.py`
- **Model:** `grok-3-mini` (xAI API with live X/Twitter search)
- **What it does:** Calls Grok xAI API with live X/Twitter search enabled for a watchlist of 13 symbols (BTC, ETH, SOL, BNB, XRP, DOGE, ADA, AVAX, LINK, NEAR, SUI, ARB, OP). Returns sentiment scores (-3 to +3), discussion volume, key narratives, and breaking news alerts per coin. Stores results in Redis: `x-sentiment:latest` (15min TTL), `sentiment:{SYMBOL}` (1h TTL), `sentiment:alert:{SYMBOL}` (30min TTL). Auto-trader rejects signals for symbols with active hack/exploit alerts.
- **AI component:** Grok-3-mini for sentiment analysis via xAI live search
- **Output:** Sentiment scores and alert flags consumed by auto-trader and evolution engine

## 10. Telegram Signal Scraper

- **Type:** External signal aggregator
- **Schedule:** Real-time (Telethon event listener, Docker container)
- **Location:** `scripts/telegram-scraper/scraper.py` + `scripts/telegram-scraper/parser.py`
- **What it does:** Connects to Telegram as a user client (MTProto via Telethon), listens to configured channels in real-time, parses trading signals in multiple formats (Cornix, simple, emoji via `parser.py`), deduplicates, stores in Redis `telegram:signal:{SYMBOL}` and Postgres `telegram_signals` table.
- **AI component:** None -- pattern-matching parser
- **Output:** External signal data for confidence boosting (Phase 1: log only; Phase 2: active boost when `boosting.telegram_boost_enabled = true`)

## 11. Morning Report (Performance Analyst)

- **Type:** Daily performance report and what-if engine
- **Schedule:** Daily at 06:00 UTC (cron: `0 6 * * *`)
- **Location:** `scripts/strategy-lab/morning_report.py`
- **What it does:** Analyzes recent trading performance, runs counterfactual scenarios (what if SL was wider/tighter?), identifies suboptimal exits, patterns dragging performance, and missed big movers.
- **AI component:** None -- statistical analysis
- **Output:** Performance report for human review

## 12. Auto-Deploy (Continuous Delivery)

- **Type:** Pull-based auto-deployer
- **Schedule:** Every minute (cron: `* * * * *`)
- **Location:** `scripts/deploy/auto-deploy.sh`
- **What it does:** Checks for new commits on the remote branch. If new commits are found and no work lock is active, pulls changes and rebuilds Docker containers. Includes deploy lock to prevent concurrent deploys and work lock protection.
- **AI component:** None -- shell script
- **Output:** Automated deployments with Telegram notifications

## 13. Health Monitor

- **Type:** System health checker
- **Schedule:** Every 5 minutes (cron: `*/5 * * * *`)
- **Location:** `scripts/deploy/health-monitor.sh`
- **What it does:** Checks the `/api/health` endpoint (Redis, Postgres, Engine, MarketScout status). Sends Telegram alert if any service is unhealthy.
- **AI component:** None -- shell script
- **Output:** Telegram alerts on failures

## 14. AI Brain (`scripts/strategy-lab/ai_brain.py`)

- **Schedule:** Every 6h via cron + acute trigger on 3+ consecutive losses
- **AI:** Grok 3 Mini Fast (analysis + action decisions)
- **Input:** Closed trades, open positions, calibration data, pipeline stats, capital, config changes, evolution runs
- **Output:** Parameter tuning (cryonix.toml), pattern blocking (Redis), evolution directives (Redis), Telegram report
- **Safety:** Bounded ranges per action type, max 4 actions/run, confidence >= 0.7 to auto-apply
- **Communication:** Writes `evolution:directives` to Redis for Evolution Engine to consume

## Data Flow Between Agents

```
MarketScoutTank (Python, 10s loop)
  -> CCXT fetch 15m OHLCV (Binance)
  -> QuantGuild pattern detection (8 detectors)
  -> RiskGate (confidence >= 60%)
  -> Redis trades:pending
  -> Postgres via /api/signals

         +---> Auto-Trader (Node, 30s poll) <---+
         |                                       |
CMCScout --> Redis cmc:*        (macro filters)  |
NewsScout -> Redis sentiment:*  (sentiment)      |
X Sentiment -> Redis sentiment:* (hack alerts)   |
Telegram Scraper -> Redis telegram:* (boost)     |
Calibrator -> Redis calibration:* (EV filter)  --+
                        |
                        v
                  Grok AI Validator (grok-4-1-fast-reasoning)
                        |
                        v
                  Binance Execution (BUY + STOP_LOSS_LIMIT)
                        |
                        v
                  Position Monitoring (SL/TP/trailing/stagnation)
                        |
                        v
                  trades + position_history tables
                        |
                        v
        Evolution Engine <-- reads performance data
               |              + reads evolution:directives from AI Brain
               v
        Claude Code CLI (claude-opus-4-6)
               |
               v
        cryonix.toml mutation + code changes
               |
               v
        config_changes + evolution_runs tables

        AI Brain (Python, every 6h + acute trigger)
               |
               v
        Grok 3 Mini Fast (analysis + action decisions)
               |
               v
        Parameter tuning (cryonix.toml) + pattern blocking (Redis)
               |
               v
        evolution:directives -> Redis (consumed by Evolution Engine)
               |
               v
        Telegram report + autopilot_actions table
```

## Cron Schedule Summary

| System | Schedule | Cron Expression |
|--------|----------|-----------------|
| MarketScoutTank | Every 10s | Docker continuous loop |
| Auto-Trader | Every 30s | Docker continuous loop |
| CMCScout | Every 10min | Docker continuous loop |
| NewsScoutTank | Every 15min | Docker continuous loop |
| Telegram Scraper | Real-time | Docker event listener |
| X Sentiment | Every 15min | `*/15 * * * *` |
| Calibrator | Every 6h | `0 */6 * * *` |
| Morning Report | Daily 06:00 | `0 6 * * *` |
| Evolution Engine | Every 2h | `0 */2 * * *` |
| AI Brain | Every 6h + acute | `0 */6 * * *` + loss trigger |
| Health Monitor | Every 5min | `*/5 * * * *` |
| Postgres Backup | Daily 03:00 | `0 3 * * *` |
| Auto-Deploy | Every 1min | `* * * * *` |

## AI Model Usage Summary

| System | Model | Provider | Purpose |
|--------|-------|----------|---------|
| Grok AI Validator | grok-4-1-fast-reasoning | xAI | Trade signal approval/rejection |
| X Sentiment Scanner | grok-3-mini | xAI | Social media sentiment analysis |
| Evolution Engine | claude-opus-4-6 | Anthropic (Claude Code CLI) | Performance analysis + code mutation |
| AI Brain | grok-3-mini-fast | xAI | Autonomous parameter tuning + directives |

## Configuration

All trading parameters live in `cryonix.toml` (single source of truth). AI-specific settings are in the `[ai]` section:

```toml
[ai]
enabled = true
model = "grok-4-1-fast-reasoning"
reasoning_effort = "high"
temperature = 0.1
max_tokens = 800
ta_weight = 0.60
ai_weight = 0.40
```

See `cryonix.toml` for the complete configuration with inline documentation.
