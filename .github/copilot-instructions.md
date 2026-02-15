# Copilot Instructions for Cryonix

## What is Cryonix?
Autonomous AI crypto trading system. Python engine scans markets → generates signals → Node.js auto-trader executes on Binance. Monitoring via Telegram bot and Next.js dashboard. Self-improving via GROK→Copilot evolution pipeline. Deployed as Docker Compose on Azure VM.

## Monorepo Structure
```
apps/web/                    # Next.js 15 — dashboard + API routes + trade execution
packages/
  engine/                    # Python 3.11 FastAPI (Docker) — market scanning + analysis
  agents/                    # TypeScript agents (Orchestrator, MarketScout, ClaudeAssistant)
  database/                  # Drizzle ORM schema (15 tables, Postgres)
  types/                     # Shared TypeScript types + Zod schemas
  ui/                        # shadcn/ui component library
  intelligence/              # Python ML module (Docker, stub)
scripts/
  auto-trader.mjs            # Polls /api/auto-trade every 30s
  ws-server.mjs              # WebSocket server for real-time updates
  telegram-interactive.mjs   # Interactive Telegram bot (@cryptonixis_bot)
  telegram-bot.mjs           # Evolution report bot (@cryonixEvolution_bot)
  copilot-evolution.mjs      # GROK→Copilot CLI autonomous evolution engine
  copilot-agent.mjs          # Copilot agent wrapper (legacy)
```

## Tech Stack
- **Frontend**: Next.js 15, React 19, Tailwind, shadcn/ui
- **Backend**: Next.js API routes, FastAPI (Python)
- **Database**: PostgreSQL + Drizzle ORM
- **Cache/Queue**: Redis (ioredis)
- **Exchange**: Binance via CCXT
- **AI**: GROK (xAI) via OpenAI SDK, GitHub Copilot CLI
- **Infra**: Docker Compose, Caddy reverse proxy, Azure VM
- **Monitoring**: Telegram bots, WebSocket dashboard
- **Package Manager**: pnpm workspaces + Turborepo

## Commands
```bash
pnpm install              # Install all deps
pnpm dev                  # Next.js dev server
pnpm build                # Production build
pnpm type-check           # TypeScript check
pnpm test                 # Vitest tests
docker compose -f docker-compose.prod.yml up -d --build  # Deploy all services
```

## Data Flow
```
MarketScoutTank (Python, every 10s)
  → CCXT fetch 15m OHLCV from Binance
  → QuantGuild pattern detection (RSI, Bollinger, MACD, EMA, Volume, Dip, Deep Value)
  → RiskGate (confidence >= 75%)
  → Redis trades:pending → Signal to Postgres

Auto-Trader (Node, every 30s)
  → Read trades:pending from Redis
  → GROK AI validation (second opinion)
  → Execute BUY on Binance
  → Monitor SL/TP/trailing stop

Evolution Engine (nightly)
  → Analyze trade performance from Postgres
  → GROK generates improvement instruction
  → Copilot CLI applies code changes
  → Verify tests → commit & deploy
```

## Key Files
| File | Purpose |
|------|---------|
| `packages/engine/src/guilds/quant.py` | All technical analysis + pattern detection |
| `packages/engine/src/core/risk_gate.py` | Risk checks before signal queueing |
| `packages/engine/src/core/risk_manager.py` | Position sizing + portfolio risk |
| `apps/web/src/app/api/auto-trade/route.ts` | Core trade execution loop |
| `apps/web/src/app/api/health/route.ts` | System health checks |
| `packages/database/src/schema.ts` | All 15 DB tables (Drizzle) |
| `packages/types/src/index.ts` | Shared types + Zod schemas |
| `scripts/copilot-evolution.mjs` | GROK→Copilot evolution engine |
| `scripts/telegram-interactive.mjs` | Interactive Telegram bot |

## Database (15 tables)
`users`, `portfolio`, `positions`, `trades`, `signals`, `market_data`, `agent_actions`, `ml_models`, `orchestrator_state`, `risk_checks`, `backtest_results`, `validation_history`, `position_history`, `evolution_runs`

Crypto amounts use `decimal` precision. Time-series tables indexed on `timestamp`.

## Redis Key Patterns
- `trades:pending` / `trades:approved` / `trades:rejected` — trade pipeline queues
- `positions:open` — currently open positions (JSON)
- `sentiment:{SYMBOL}` — news sentiment scores
- `agent:{NAME}:status` — agent health/status
- `grid:active` / `grid:config:{SYMBOL}` — grid trading config
- `risk:portfolio_state` — portfolio risk snapshot
- `evolution:{RUN_ID}` — evolution run metadata

## Docker Services (docker-compose.prod.yml)
`postgres`, `redis`, `engine`, `web`, `auto-trader`, `ws-server`, `telegram-bot`, `caddy`

## Environment Variables
```
BINANCE_API_KEY / BINANCE_API_SECRET  # Binance trading
XAI_API_KEY                           # GROK AI (xAI)
POSTGRES_PASSWORD                     # DB password
TELEGRAM_BOT_TOKEN                    # Evolution report bot
TELEGRAM_INTERACTIVE_BOT_TOKEN        # Interactive dashboard bot
TELEGRAM_CHAT_ID                      # Owner chat ID
```

## Coding Conventions
- Python engine packages skip `pnpm build` (run in Docker)
- Docker containers use service names (web, engine, redis, postgres), not localhost
- Auto-trader is SPOT_ONLY — only BUY signals, never SELL
- All trading amounts use decimal/float precision, never integers
- Pattern types defined in `packages/types/src/index.ts` as union type
- GROK model: `grok-4-1-fast-reasoning` via OpenAI-compatible API at `https://api.x.ai/v1`

## Safety Rules (NEVER violate)
- Never remove stop-loss, max position size, or daily loss limits
- Never commit API keys or secrets to source code
- Evolution changes must pass `verify_deep_value.py` and `verify_grid.py`
- Always backup critical files before automated code changes
