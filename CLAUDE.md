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
  database/                  # Drizzle ORM schema (19 tables, Postgres)
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
    x_sentiment.py             #   X/Twitter sentiment scanner
    engine_diagnostik.py       #   Engine diagnostics
  telegram-scraper/            # Telegram signal scraper (Python/Telethon, Docker)
    scraper.py                 #   Main Telethon event listener + Redis/Postgres writer
    parser.py                  #   Multi-format signal parser (Cornix, simple, emoji)
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
docker compose -f docker-compose.prod.yml up -d --build # Prod: all 8 containers

# Database (from packages/database)
pnpm db:generate             # Generate Drizzle migrations
pnpm db:push                 # Push schema to database
pnpm db:studio               # Open Drizzle Studio UI

# Deploy to VM
git archive --format=tar HEAD | ssh azureuser@openclaw-vm "cd ~/cryonix && tar xf -"
ssh azureuser@openclaw-vm "cd ~/cryonix && docker compose -f docker-compose.prod.yml up -d --build"
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
- `scripts/evolution/copilot-evolution.mjs` - Claude Code CLI autonomous evolution engine
- `scripts/telegram-scraper/scraper.py` - Telegram channel signal scraper (Telethon/Python, Docker)

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
  -> analyzePerformance(): pattern P&L from trades + position_history
  -> Generate mutation plan via Claude Code
  -> Backup cryonix.toml → .evolution-backups/{run_id}/
  -> Apply mutation + verify
  -> Compute structured TOML diff (old vs new params)
  -> Log to evolution_runs (structured changes_made JSONB)
  -> Log to config_changes table (change_type='evolution')
  -> Commit with [Auto-Evolution {run_id}] prefix
```

## Database Schema (19 tables)

`users`, `portfolio`, `positions`, `trades`, `signals`, `market_data`, `agent_actions`, `ml_models`, `orchestrator_state`, `risk_checks`, `backtest_results`, `validation_history`, `position_history`, `telegram_signals`, `telegram_channels`, `evolution_runs`, `config_changes`, `calibration_history`

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
- Redis key patterns: `trades:pending`, `trades:approved`, `positions:open`, `sentiment:{SYMBOL}`, `agent:{NAME}:status`, `risk:portfolio_state`, `signals:telegram:active`, `telegram:signal:{SYMBOL}`, `telegram:dedup:{channel}:{symbol}:{action}`, `cmc:global`, `cmc:fear_greed`, `cmc:mcap:{SYMBOL}`
- Docker networking: containers use service names (web, engine, redis, postgres) not localhost
- `host.docker.internal` for dev Docker -> host communication
- Auto-trader is SPOT_ONLY (rejects SELL signals, only BUY)
- **Risk parameters**: single source of truth is `CONFIG` in `auto-trade/route.ts`
- **Config version tracking**: Every trade is tagged with an 8-char SHA256 hash of `cryonix.toml`. Utility: `apps/web/src/lib/config-version.ts`
- **Change tracking**: Parameter changes logged to `config_changes` table. Evolution system computes structured diffs automatically.
- **Calibration history**: Daily snapshots persisted to `calibration_history` table (ON CONFLICT upsert).
- **Telegram commands**: `/status`, `/positions`, `/trades`, `/pnl`, `/signals`, `/risk`, `/audit`, `/gainers`, `/evolve`, `/cost`, `/journal`, `/help`
- **Analytics page**: `/analytics` — trade journal, config version comparison, pattern performance
