# CLAUDE.md

Guidance for Claude Code when working with this repository.

## Project Overview

Cryonix is an autonomous AI crypto trading system. Python engine scans markets and generates signals, Next.js dashboard executes trades on Binance and provides a monitoring UI. Deployed as Docker Compose on an Azure VM.

## Monorepo Structure

```
apps/web/                    # Next.js 15 (dashboard + API routes + trade execution)
packages/
  engine/                    # Python 3.11 FastAPI (Docker) - scanning + analysis
  agents/                    # TypeScript agent system (Orchestrator, MarketScout, ClaudeAssistant)
  database/                  # Drizzle ORM schema (20 tables, Postgres)
  types/                     # Shared TypeScript types + Zod schemas
  ui/                        # shadcn/ui component library
  intelligence/              # Python ML module (Docker, stub)
scripts/
  deploy/
    auto-deploy.sh             # Pull-based auto-deploy with work lock + rollback
    deploy.sh                  # Manual deploy from local via SSH
    deploy-vm.sh               # Runs on VM after manual deploy
    backup-postgres.sh         # Daily Postgres backup (7-day rotation)
    health-monitor.sh          # Health check + Telegram alerts (cron every 5 min)
  services/
    auto-trader.mjs            # ESM auto-trader for Docker
    ws-server.mjs              # ESM WebSocket server for Docker
    telegram-interactive.mjs   # Interactive Telegram bot (@cryptonixis_bot)
    telegram-bot.mjs           # Evolution report bot (@cryonixEvolution_bot)
  evolution/
    copilot-evolution.mjs      # Claude Code CLI evolution engine (autonomous analysis + mutation)
    run_evolution.sh           # Cron wrapper (every 2h)
    verify_deep_value.py       # Post-mutation verification
    verify_grid.py             # Post-mutation verification
    prompts/evolution_prompt.txt
  strategy-lab/                # Calibration & analysis tools
    calibrate.py               #   Pattern EV calibration (--days 30) + Postgres snapshot
    self_calibrate.py          #   Signal accuracy self-calibration + Postgres snapshot
    morning_report.py          #   Daily morning report
    baseline.py                #   Baseline freeze mode (freeze/unfreeze/status/compare)
    x_sentiment.py             #   X/Twitter sentiment scanner
    engine_diagnostik.py       #   Engine diagnostics
  telegram-scraper/            # Telegram signal scraper (Python/Telethon, Docker)
    scraper.py                 #   Main Telethon event listener + Redis/Postgres writer
    parser.py                  #   Multi-format signal parser (Cornix, simple, emoji)
  aktienix/                    # Aktienix stock trading helper scripts
    close-position.ts          #   CLI: close Alpaca position (used by Brain via Claude Code)
  lib/
    load-toml.mjs              # TOML config loader utility
```

## Commands

```bash
# Development
pnpm install                 # Install all dependencies
pnpm dev                     # Start Next.js dev (http://localhost:3000)
pnpm build                   # Production build all packages
pnpm type-check              # TypeScript check across monorepo

# Infrastructure (Docker)
docker compose up -d                                    # Dev: engine + redis + postgres
docker compose -f docker-compose.prod.yml up -d --build # Prod: all 10 containers

# Aktienix (stock trading agent + brain)
docker compose -f docker-compose.prod.yml up -d --build aktienix aktienix-brain
docker logs aktienix --tail 20              # Runner logs
docker logs aktienix-brain --tail 20        # Brain logs

# Polymarket Scanner
docker compose -f docker-compose.prod.yml up -d --build polymarket-scanner
docker logs cryonix-polymarket-scanner-1 --tail 20

# Database (from packages/database)
pnpm db:generate             # Generate Drizzle migrations
pnpm db:push                 # Push schema to database
pnpm db:studio               # Open Drizzle Studio UI

# Deploy to VM
git archive --format=tar HEAD | ssh azureuser@openclaw-vm "cd ~/cryonix && tar xf -"
ssh azureuser@openclaw-vm "cd ~/cryonix && docker compose -f docker-compose.prod.yml up -d --build"

# Baseline mode (freeze mutations to measure clean performance)
# Requires: set -a && source .env && set +a && TELEGRAM_EVOLUTION_BOT_TOKEN=$TELEGRAM_BOT_TOKEN
python3 scripts/strategy-lab/baseline.py freeze        # Freeze AI Brain + Evolution, take snapshot
python3 scripts/strategy-lab/baseline.py status        # Show frozen state + trade count
python3 scripts/strategy-lab/baseline.py unfreeze      # Unfreeze + take end snapshot
python3 scripts/strategy-lab/baseline.py compare <id>  # Compare baseline vs post-baseline
```

## Architecture

### Python Engine (packages/engine)

Runs in Docker. Three autonomous tanks + one scanner on continuous loops:

- **MarketScoutTank** - Scans 45 USDC pairs every 10s via CCXT. Uses QuantGuild for pattern detection (RSI, Bollinger, MACD, EMA, Volume Spike, Dip Buy, Deep Value Crash, Momentum Gainer). Approved signals go to Redis `trades:pending` queue.
- **NewsScoutTank** - RSS sentiment analysis every 15min. Stores scores in Redis `sentiment:{SYMBOL}`.
- **CMCScout** - CoinMarketCap API (Free tier) every 10min. Writes macro data to Redis: Fear & Greed index (`cmc:fear_greed`), global metrics (`cmc:global`), per-symbol market cap + rank + FDV (`cmc:mcap:{SYMBOL}`). Requires `CMC_API_KEY` env var + `coinmarketcap.enabled=true` in cryonix.toml.

**Architecture notes:**
- **Capital allocator** splits capital into signal pool (SIGNAL_POOL_PCT), grid pool (GRID_POOL_PCT), and reserve (RESERVE_PCT)
- **Market regime** propagated from engine → Redis → capital allocator
- **AI validation** is fail-closed (signal rejected if validation unavailable, not fail-open)
- **Python engine** is spot-only mode (`config.py` synced with TypeScript CONFIG)

Key modules:
- `src/guilds/quant.py` - QuantGuild: all technical analysis + pattern detection
- `src/core/market_data.py` - CCXT wrapper with caching, multi-timeframe support
- `src/core/risk_gate.py` - Confidence threshold + risk checks before queueing
- `src/core/state_sync.py` - Redis state management
- `src/tanks/base.py` - BaseTank with LangGraph pipeline (scan -> analyze -> risk -> execute)
- `src/tanks/cmc_scout.py` - CoinMarketCap API integration (Fear & Greed, market cap, global metrics)

### Next.js App (apps/web)

Dashboard + API routes + trade execution:

- **Dashboard** (page.tsx): 3-column layout - stats/signals, risk gate/chart, positions/trade
- **Analytics** (analytics/page.tsx): Trade journal table, config version comparison, pattern performance
- **Auto-trade API** (api/auto-trade/route.ts): Core execution loop. Monitors positions (SL/TP/trailing), processes Redis queue, GROK AI validation, Binance execution. Tags every trade with `config_version` hash.
- **Trade Journal API** (api/analytics/journal/route.ts): Reads position_history (fallback: trades), returns journal + summary + config comparison
- **Health API** (api/health/route.ts): Checks Redis, Postgres, Engine, MarketScout

### TypeScript Agents (packages/agents)

Legacy agent system. Key classes:
- `OrchestratorAgent` - Coordinator for TS agent lifecycle
- `MarketScoutAgent` - TS-side scanner (being replaced by Python MarketScoutTank)
- `ClaudeAssistantAgent` - GROK chat integration

### Background Workers

- `scripts/services/auto-trader.mjs` - Polls `/api/auto-trade` every 30s
- `scripts/services/ws-server.mjs` - WebSocket server for real-time dashboard updates
- `scripts/services/telegram-interactive.mjs` - Interactive Telegram bot (@cryptonixis_bot)
- `scripts/services/telegram-bot.mjs` - Evolution report bot (@cryonixEvolution_bot)
- `scripts/evolution/copilot-evolution.mjs` - Claude Code CLI autonomous evolution engine (respects baseline freeze)
- `scripts/strategy-lab/ai_brain.py` - AI Brain autonomous analysis (every 6h + acute trigger, respects baseline freeze)
- `scripts/strategy-lab/watchlist_agent.py` - Watchlist rotation agent (Tue+Fri 05:00 UTC, twice-weekly symbol rotation via Grok)
- `scripts/telegram-scraper/scraper.py` - Telegram channel signal scraper (Telethon/Python, Docker)
- `scripts/services/aktienix-runner.ts` - Aktienix stock trading agent loop (Alpaca, Docker)
- `scripts/services/aktienix-brain.ts` - AktienixBrain autonomous portfolio analyst (Claude Code CLI, Docker)
- `scripts/services/polymarket-scanner.ts` - Polymarket prediction market intelligence (every 15min, Docker)

## Data Flow

```
MarketScoutTank (Python, every 10s)
  -> Fetch 15m OHLCV via CCXT (Binance)
  -> QuantGuild pattern detection (8 detectors + GainerScanner check)
  -> RiskGate (confidence >= 65%)
  -> Redis trades:pending queue
  -> Signal persisted to Postgres via /api/signals

CMCScout (Python, every 10min, requires CMC_API_KEY)
  -> Fetch global metrics (total MC, BTC dominance, F&G)
  -> Fetch quotes for 45 symbols (rank, MC, FDV)
  -> Write to Redis: cmc:global, cmc:fear_greed, cmc:mcap:{SYMBOL}

PolymarketScanner (TypeScript, every 15min, no auth needed)
  -> Fetch top 50 events by 24h volume from Gamma API
  -> Classify: crypto, fed, oil, geopolitik (keyword-based)
  -> Volume-weighted sentiment scoring (0-100 per category)
  -> Write to Redis: polymarket:crypto, polymarket:fed, polymarket:oil, polymarket:geopolitik, polymarket:summary
  -> Consumed by: auto-trade (crypto confidence adjustments) + aktienix (sector overlays)

Auto-Trader (Node, every 30s)
  -> GET /api/auto-trade
  -> Read trades:pending from Redis
  -> Capital Allocator check (Regime-based, Strategy budgets)
  -> GainerScanner boost (+10% confidence for top movers)
  -> Telegram Signal boost (+5-12% if external channels agree, Phase 1: log only)
  -> CMC Fear & Greed adjustment (extreme fear: DV boost, extreme greed: penalty)
  -> CMC BTC dominance penalty (alts penalized when BTC dom rising)
  -> Filter: SPOT_ONLY, max positions, daily limits
  -> CMC Market Cap filter (reject rank > 500, reject FDV/MC > 4x)
  -> CMC Global regime override (MC crash → volatile regime)
  -> **Dip Focus Filter** (require DIP_BUY/DEEP_VALUE_CRASH/BOLLINGER_SQUEEZE)
  -> EV Model Filter (reject negative EV patterns)
  -> X Sentiment Check (reject on hack/exploit alerts)
  -> GROK AI validation (fail-closed, blends confidence)
  -> Order Book Spread Check (max 0.3%)
  -> Execute BUY on Binance via CCXT
  -> Place Native STOP_LOSS_LIMIT order (safety net)
  -> Store position in Redis positions:open
  -> Tag trade with config_version (SHA256 hash of cryonix.toml)
  -> Monitor SL/TP/trailing stop

Calibration Pipeline (Python, every 6h + daily)
  -> calibrate.py: Pattern EV from trades table → Redis calibration:patterns (24h TTL)
  -> calibrate.py: Persist daily snapshot → Postgres calibration_history
  -> self_calibrate.py: Signal accuracy → Redis calibration:accuracy (48h TTL)
  -> self_calibrate.py: Persist daily snapshot → Postgres calibration_history
  -> Auto-trader reads calibration:patterns for EV model filter

Evolution System (Claude Code CLI, every 2h)
  -> Check baseline freeze flag → exit early if frozen
  -> analyzePerformance(): pattern P&L from trades + position_history
  -> Generate mutation plan via Claude Code
  -> Backup cryonix.toml → .evolution-backups/{run_id}/
  -> Apply mutation + verify
  -> Compute structured TOML diff (old vs new params)
  -> Log to evolution_runs (structured changes_made JSONB)
  -> Log to config_changes table (change_type='evolution')
  -> Commit with [Auto-Evolution {run_id}] prefix

AI Brain (Python, every 6h + acute on 3+ losses)
  -> Check baseline freeze flag → exit early if frozen
  -> Collect: closed trades, open positions, calibration, pipeline stats, capital
  -> Collect: config_changes (48h), evolution_runs (48h), previous brain actions
  -> Call Grok API for analysis + action recommendations
  -> Validate actions against safety bounds (range, delta, min patterns)
  -> Apply: update cryonix.toml + Redis + config_changes + autopilot_actions
  -> Write evolution:directives to Redis (24h TTL) for code-level insights
  -> Send Telegram report

Baseline Mechanism (Python, manual trigger)
  -> freeze: set [baseline] frozen=true in cryonix.toml
  -> Take start snapshot (trades, win rate, PnL, per-pattern) → baselines/{id}/start.json
  -> AI Brain + Evolution Engine check frozen flag and skip runs
  -> Calibration keeps running (read-only)
  -> Trading continues normally (only mutations paused)
  -> unfreeze: take end snapshot (trades since freeze) → baselines/{id}/end.json
  -> compare: baseline period vs same-duration post-baseline window
```

## Database Schema (20 tables)

`users`, `portfolio`, `positions`, `trades`, `signals`, `market_data`, `agent_actions`, `ml_models`, `orchestrator_state`, `risk_checks`, `backtest_results`, `validation_history`, `position_history`, `telegram_signals`, `telegram_channels`, `evolution_runs`, `config_changes`, `calibration_history`, `autopilot_actions`

Time-series tables indexed on `timestamp`. Crypto amounts use decimal precision.

### Analytical Core Tables

- **`config_changes`** - Logs every parameter change (evolution/manual/calibration). Fields: `change_type`, `source`, `config_version` (8-char SHA256 hash of cryonix.toml), `parameters` (JSONB: `[{param, section, old, new}]`), `reasoning`.
- **`calibration_history`** - Daily snapshots of pattern EV calibration and self-calibration accuracy. Unique on `(snapshot_date, run_type)`. Fields: `patterns` (JSONB), `overall` (JSONB).
- **`trades.config_version`** - Every trade is tagged with the 8-char config hash active at execution time. Enables grouping trades by config version to measure impact of parameter changes.
- **`evolution_runs.changes_made`** - Now stores structured TOML diffs: `[{param, section, old, new}]` instead of the old string format.

## Types (packages/types)

Exports shared types and Zod schemas:
- Agent types: `AgentId`, `AgentStatus`, `AgentMessage`
- Trading types: `OrderSide`, `SignalAction`, `PatternType`, `TradingSignal`
- Pattern types include: `bollinger_squeeze`, `rsi_oversold`, `rsi_overbought`, `volume_spike_up`, `volume_spike_down`, `macd_bullish_cross`, `macd_bearish_cross`, `dip_buy`, `ema_bullish_cross`, `ema_bearish_cross`, `deep_value_crash`

## Environment Variables

Required in `apps/web/.env.local` (dev) or `~/cryonix/.env` (VM prod):

```
BINANCE_API_KEY=...
BINANCE_API_SECRET=...
BINANCE_TESTNET=false
XAI_API_KEY=xai-...
POSTGRES_URL=postgres://postgres:password@localhost:5432/cryonix
KV_URL=redis://localhost:6379
```

Docker-only env vars (set in docker-compose.prod.yml):
```
ENGINE_URL=http://engine:8000        # Health check reaches Python engine
NEXTJS_API_URL=http://web:3000       # Engine persists signals to Postgres
TELEGRAM_API_ID=...                  # From my.telegram.org (telegram-scraper)
TELEGRAM_API_HASH=...               # From my.telegram.org (telegram-scraper)
TELEGRAM_SESSION=...                 # Generated by setup_session.py (StringSession)
TELEGRAM_CHANNELS=...               # Comma-separated channel usernames
CONFIDENCE_BOOST_ENABLED=false       # false=log only, true=active boost
CMC_API_KEY=...                      # CoinMarketCap Free tier API key (engine)
```

## Key Conventions

- Python engine packages use `echo` skip for `pnpm build` since they run in Docker
- Redis key patterns: `trades:pending`, `trades:approved`, `positions:open`, `sentiment:{SYMBOL}`, `agent:{NAME}:status`, `risk:portfolio_state`, `signals:telegram:active`, `telegram:signal:{SYMBOL}`, `telegram:dedup:{channel}:{symbol}:{action}`, `cmc:global`, `cmc:fear_greed`, `cmc:mcap:{SYMBOL}`, `brain:acute_trigger`, `brain:loss_streak`, `brain:blocked_patterns`, `evolution:directives`, `aktienix:state`, `aktienix:risk`, `aktienix:brain:last_run`, `aktienix:brain:cooldown`, `polymarket:crypto`, `polymarket:fed`, `polymarket:oil`, `polymarket:geopolitik`, `polymarket:summary`
- Docker networking: containers use service names (web, engine, redis, postgres) not localhost
- `host.docker.internal` for dev Docker -> host communication
- Auto-trader is SPOT_ONLY (rejects SELL signals, only BUY)
- **Risk parameters**: single source of truth is `CONFIG` in `auto-trade/route.ts`
- **Config version tracking**: Every trade is tagged with an 8-char SHA256 hash of `cryonix.toml`. Utility: `apps/web/src/lib/config-version.ts`
- **Change tracking**: Parameter changes logged to `config_changes` table. Evolution system computes structured diffs automatically.
- **Calibration history**: Daily snapshots persisted to `calibration_history` table (ON CONFLICT upsert).
- **Telegram commands**: `/status`, `/positions`, `/trades`, `/pnl`, `/signals`, `/risk`, `/audit`, `/gainers`, `/evolve`, `/cost`, `/journal`, `/help`
- **Analytics page**: `/analytics` — trade journal, config version comparison, pattern performance
- **Baseline mode**: `[baseline]` section in cryonix.toml controls freeze state. When `frozen = true`, AI Brain and Evolution Engine exit early (cron still fires but scripts return immediately). Calibration is unaffected (read-only). Snapshots stored in `baselines/` (gitignored). Three systems mutate params (Evolution 2h, AI Brain 6h, Calibration 6h) — freeze isolates their impact.
- **Smart Dip Hunter** (active since 2026-02-25): `[patterns] dip_focus_mode = true` requires every signal to contain at least one value pattern (DIP_BUY, DEEP_VALUE_CRASH, BOLLINGER_SQUEEZE). Trend-only signals (MACD+EMA) are rejected. Backtest-validated: value patterns have 80-100% WR vs 0-25% for trend-only. Signal cooldown reduced to 5min (from 15min) to catch fast dips. 3 position slots (was 2). See `docs/plans/2026-02-25-smart-dip-hunter-strategy.md` for full rationale.
- **Engine resilience**: `BaseTank.run_loop()` wraps each symbol in try/except and skips `None` outputs from LangGraph. One failed symbol no longer kills the entire scanner.
- **Backtester**: Supports 5m/15m/1h/4h/1d timeframes. Smart fetch — only primary TF + HTF context (1h/4h/1d). Run via `docker exec cryonix-engine-1 python3 /app/scripts/strategy-lab/backtest.py --symbol BTC/USDC --days 30 --json`.

## Aktienix — US Stock Trading Agent

Aktienix is a separate trading agent for US stocks via Alpaca. Runs in its own Docker containers alongside the crypto system.

### Architecture

- **Aktienix Runner** (`scripts/services/aktienix-runner.ts`) — Trading loop: scans watchlist, generates signals via technical indicators + macro intelligence, executes trades on Alpaca. Config from `aktienix.toml`.
- **AktienixBrain** (`scripts/services/aktienix-brain.ts`) — Autonomous portfolio analyst using Claude Code CLI (`claude -p`). Analyzes performance, adjusts `aktienix.toml` parameters, can close positions and restart the runner.
- **Agent modules** (`packages/agents/src/aktienix/`) — Modular components: `aktienix-agent.ts` (orchestrator), `risk-manager.ts` (circuit breakers + PDT), `exit-monitor.ts` (5-stage exit strategy), `position-sizer.ts` (fractional shares), `state-publisher.ts` (Redis state bridge), `market-hours.ts` (NYSE DST-aware guards), `config.ts` (TOML loader), `signals/stock-signal-generator.ts` (multi-factor signals).
- **Dockerfile.aktienix** — Shared image for both runner and brain. Installs: Alpaca SDK, TOML parser, OpenAI, technicalindicators, ioredis, pg, Claude Code CLI. Stubs `@cryonix/types` (type-only imports erased by tsx).

### Docker Services

- `aktienix` — Runner service. `container_name: aktienix` required (Brain uses `docker restart aktienix`).
- `aktienix-brain` — Brain service. Mounts `~/.claude:/root/.claude:ro` for Claude Code account auth (no API key needed). Mounts Docker socket for `docker restart`. Mounts `aktienix.toml` read-write.

### Brain Triggers

- **Scheduled**: 09:00-09:05 ET (pre-market review) + 16:30-16:35 ET (post-close review)
- **Acute**: consecutiveLosses >= 2 OR dailyPnlDollar < -(portfolioValue * 3%)
- **Cooldown**: Max one run per hour (Redis `aktienix:brain:last_run`, 48h TTL)
- **Budget**: $3 max per Claude Code invocation

### Key Redis Keys (Aktienix)

- `aktienix:state` — Full agent state (positions, signals, portfolio)
- `aktienix:risk` — Risk manager state (circuit breakers, PDT count)
- `aktienix:brain:last_run` — Last brain run timestamp + summary (48h TTL)
- `aktienix:brain:cooldown` — Cooldown flag (1h TTL)

### Config

- `aktienix.toml` — All Aktienix configuration (watchlist, risk params, brain bounds)
- Brain parameter bounds defined in prompt (not config) — prevents runaway mutations
- Brain can: adjust risk params, close positions, restart runner, commit config changes
