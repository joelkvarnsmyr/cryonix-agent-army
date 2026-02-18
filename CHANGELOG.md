# Changelog

All notable changes to Cryonix are documented in this file.
Format based on [Keep a Changelog](https://keepachangelog.com).

## [Unreleased]

### Added
- Analytical Core: config_changes table, calibration_history table, trades.config_version tracking
- Trade Journal API (`/api/analytics/journal`) with config version comparison
- Analytics dashboard page (`/analytics`) with trade journal, config comparison, pattern performance
- `/journal` Telegram command for trade analysis with config version breakdown
- Config version hash utility — every trade tagged with 8-char SHA256 of cryonix.toml
- Structured TOML diffs in evolution system — parameter changes logged as `[{param, section, old, new}]`
- Calibration history persistence — daily snapshots saved to Postgres
- Weak pattern filter — RSI_OVERSOLD, EMA_BULLISH_CROSS, MACD_BULLISH_CROSS rejected when firing alone
- Instance lock self-healing — force-acquire stale locks from dead containers
- Stale signal cleanup — 15-minute max age for queued signals
- DUST_NOTIONAL prevention — MIN_ORDER_VALUE raised to $7.50, proactive dust exit
- `.env.example` with all environment variables documented
- Comprehensive documentation audit and updates
- CoinMarketCap scout and filter logic (Fear & Greed, market cap filters)
- AI cost tracking card on dashboard (`/api/costs` endpoint)
- `/cost` Telegram command for AI API cost tracking
- Centralized config via `cryonix.toml` (6-phase migration from hardcoded values)
- Python backtester with QuantGuild engine integration
- Telegram signal scraper (Telethon/Python) with convergence boost pipeline
- Consensus gate — require 2+ patterns before trading
- Claude Code hook for auto-deploy work lock
- Redesigned automatic Telegram messages with consistent styling
- Responsive ultrawide dashboard layout (3xl breakpoint)
- Passive income earn strategy design document

### Fixed
- Evolution system broken import (telegram-bot.mjs path)
- Signal bottleneck — Grok 4.1 upgrade, expanded grid-only pairs
- Dashboard cost tracking (`/cost` command)
- CMC type sync and HTTP header in cmc_scout
- Chart overlap, tooltip issues, and layout overflow on dashboard
- Relative import paths after directory restructuring
- Redis as source of truth for all Telegram position data
- 11 failing unit tests across 3 test files
- Unrealized P&L included in Today's P&L display
- Health API response missing summary + services fields

### Changed
- AI model upgraded to Grok 4.1 Fast Reasoning
- `docs/API.md` regenerated with all 29 current endpoints
- Legacy TypeScript READMEs marked as deprecated
- Evolution engine migrated from GROK+Copilot to Claude Code CLI
- Auto-deploy rewritten with activity lock, safe pull, and rollback
- Dashboard polling, caching, and lazy loading optimized
- All script path references updated for new directory structure
- Config display migrated to use cryonix.toml

## [0.1.0] — 2026-02-15

### Added
- Initial production deployment on Azure VM
- Python MarketScoutTank with QuantGuild (8 pattern detectors)
- Auto-trader with Grok AI validation (fail-closed)
- Strategy Lab: calibrate.py, self_calibrate.py, morning_report.py, x_sentiment.py
- Capital allocator with market regime detection
- Telegram interactive bot (@cryptonixis_bot)
- Telegram signal scraper (Telethon/Python)
- CoinMarketCap integration (Fear & Greed, market cap filters)
- Docker Compose production stack (8 containers)
- Auto-deploy with work lock + rollback
- Health monitoring with Telegram alerts
- Deep Value strategy, Grid Trading, and Evolution Engine
- Dynamic portfolio context for all agents
- Exit strategy overhaul + evolution diagnostics + data persistence
- Dashboard with Cryonix Terminal aesthetic + agent flow visualization
- Gainer scanner + 15-min pipeline reports to Telegram
- Pull-based auto-deploy on cron (every 1 min)
- Self-calibration + health monitor alerts

### Fixed
- RSI calculation, health check routing, and ops documentation
- Engine crash — NewsScoutTank init and Docker networking
- Production Docker config and Redis persistence
- NOTIONAL dust positions + prevention
- SHORT position monitoring + exit logic
- Signal flooding + stricter AI validation
