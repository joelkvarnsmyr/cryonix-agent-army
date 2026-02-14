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
  database/                  # Drizzle ORM schema (13 tables, Postgres)
  types/                     # Shared TypeScript types + Zod schemas
  ui/                        # shadcn/ui component library
  intelligence/              # Python ML module (Docker, stub)
scripts/
  auto-trader.mjs            # ESM auto-trader for Docker
  ws-server.mjs              # ESM WebSocket server for Docker
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
docker compose -f docker-compose.prod.yml up -d --build # Prod: all 7 containers

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

Runs in Docker. Two autonomous tanks on continuous loops:

- **MarketScoutTank** - Scans 15 USDC pairs every 10s via CCXT. Uses QuantGuild for pattern detection (RSI, Bollinger, MACD, EMA, Volume Spike, Dip Buy, Deep Value Crash). Approved signals go to Redis `trades:pending` queue.
- **NewsScoutTank** - RSS sentiment analysis every 15min. Stores scores in Redis `sentiment:{SYMBOL}`.

Key modules:
- `src/guilds/quant.py` - QuantGuild: all technical analysis + pattern detection
- `src/core/market_data.py` - CCXT wrapper with caching, multi-timeframe support
- `src/core/risk_gate.py` - Confidence threshold + risk checks before queueing
- `src/core/state_sync.py` - Redis state management
- `src/tanks/base.py` - BaseTank with LangGraph pipeline (scan -> analyze -> risk -> execute)

### Next.js App (apps/web)

Dashboard + API routes + trade execution:

- **Dashboard** (page.tsx): 3-column layout - stats/signals, risk gate/chart, positions/trade
- **Auto-trade API** (api/auto-trade/route.ts): Core execution loop. Monitors positions (SL/TP/trailing), processes Redis queue, GROK AI validation, Binance execution
- **Health API** (api/health/route.ts): Checks Redis, Postgres, Engine, MarketScout

### TypeScript Agents (packages/agents)

Legacy agent system. Key classes:
- `OrchestratorAgent` - Coordinator for TS agent lifecycle
- `MarketScoutAgent` - TS-side scanner (being replaced by Python MarketScoutTank)
- `ClaudeAssistantAgent` - GROK chat integration

### Background Workers

- `scripts/auto-trader.mjs` - Polls `/api/auto-trade` every 30s
- `scripts/ws-server.mjs` - WebSocket server for real-time dashboard updates

## Data Flow

```
MarketScoutTank (Python, every 10s)
  -> Fetch 15m OHLCV via CCXT (Binance)
  -> QuantGuild pattern detection (7 detectors)
  -> RiskGate (confidence >= 75%)
  -> Redis trades:pending queue
  -> Signal persisted to Postgres via /api/signals

Auto-Trader (Node, every 30s)
  -> GET /api/auto-trade
  -> Read trades:pending from Redis
  -> Filter: SPOT_ONLY, max positions, daily limits
  -> GROK AI validation (second opinion)
  -> Execute BUY on Binance via CCXT
  -> Store position in Redis positions:open
  -> Monitor SL/TP/trailing stop
```

## Database Schema (13 tables)

`users`, `portfolio`, `positions`, `trades`, `signals`, `market_data`, `agent_actions`, `ml_models`, `orchestrator_state`, `risk_checks`, `backtest_results`, `validation_history`, `position_history`

Time-series tables indexed on `timestamp`. Crypto amounts use decimal precision.

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
```

## Key Conventions

- Python engine packages use `echo` skip for `pnpm build` since they run in Docker
- Redis key patterns: `trades:pending`, `trades:approved`, `positions:open`, `sentiment:{SYMBOL}`, `agent:{NAME}:status`, `risk:portfolio_state`
- Docker networking: containers use service names (web, engine, redis, postgres) not localhost
- `host.docker.internal` for dev Docker -> host communication
- Auto-trader is SPOT_ONLY (rejects SELL signals, only BUY)
