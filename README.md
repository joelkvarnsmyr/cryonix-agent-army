# Cryonix Agent Army

**Autonomous AI crypto trading system - Python engine + Next.js dashboard on Docker**

## Architecture

```
Python Engine (Docker)           Next.js (Docker)              Background Workers
 MarketScout Tank                 Dashboard UI                  auto-trader (30s poll)
  - 15 USDC pairs / 10s          API routes                    ws-server (real-time)
  - QuantGuild analysis           GROK AI validation
  - NewsScout sentiment           Binance execution
       |                               |
       v                               v
     Redis  <----------------------> Postgres
  (signal queue, state)         (signals, trades, positions)
```

### Signal Flow

```
MarketScout (CCXT) -> QuantGuild patterns -> RiskGate (>=75% conf)
  -> Redis pending queue -> Auto-Trader polls -> GROK AI validates
  -> Binance BUY (spot only) -> Position monitor (SL/TP/trailing)
```

## Monorepo Structure

```
apps/web/                    # Next.js 15 dashboard + API routes
packages/
  engine/                    # Python 3.11 (Docker) - MarketScout, NewsScout, QuantGuild
  agents/                    # TypeScript agent system (Orchestrator, BaseAgent)
  database/                  # Drizzle ORM - 13 tables (Postgres)
  types/                     # Shared TypeScript types + Zod schemas
  ui/                        # shadcn/ui components
  intelligence/              # Python ML module (Docker)
scripts/
  auto-trader.mjs            # Docker-compatible auto-trader
  ws-server.mjs              # Docker-compatible WebSocket server
```

## Quick Start (Local Dev)

```bash
pnpm install

# Start infrastructure
docker compose up -d          # Redis, Postgres, Python engine

# Start Next.js
pnpm dev                      # http://localhost:3000
```

Required env vars in `apps/web/.env.local`:

```
BINANCE_API_KEY=...
BINANCE_API_SECRET=...
XAI_API_KEY=xai-...
POSTGRES_URL=postgres://postgres:password@localhost:5432/cryonix
KV_URL=redis://localhost:6379
```

## Production (Azure VM)

Deployed via Docker Compose (7 containers) on Azure ARM64 VM, accessed via Tailscale.

```bash
# Deploy updates
git archive --format=tar HEAD | ssh azureuser@openclaw-vm "cd ~/cryonix && tar xf -"
ssh azureuser@openclaw-vm "cd ~/cryonix && docker compose -f docker-compose.prod.yml up -d --build"
```

See [OPS.md](./OPS.md) for full deployment guide, endpoints, and operations.

## Pattern Detectors (QuantGuild)

| Pattern | Action | Trigger |
|---------|--------|---------|
| RSI Extreme | BUY/SELL | RSI < 35 (buy) or > 70 (sell) |
| Bollinger Squeeze | BUY/SELL | Band width bottom 20%, price position |
| Volume Spike | BUY/SELL | 2x+ average volume with price momentum |
| MACD Crossover | BUY/SELL | Signal line cross |
| EMA 9/21 Cross | BUY/SELL | Fast/slow EMA crossover |
| Dip Buy | BUY | 5%+ drawdown from 20-bar high, recovering |
| Deep Value Crash | BUY | 8%+ drawdown, multi-TF RSI, capitulation volume |

## Risk Management

| Parameter | Value |
|-----------|-------|
| Min confidence | 75% |
| Position sizing | Half-Kelly, max 35% capital |
| Deep value sizing | Up to 50% capital at 80%+ confidence |
| Stop-loss | ATR-based (2x normal, 3x deep value) |
| Trailing stop | 1% below high water mark |
| Daily loss limit | 5% |
| Max positions | 2 concurrent |
| GROK AI validation | Second opinion on every signal |

## Trading Pairs (15)

BTC/USDC, ETH/USDC, SOL/USDC, BNB/USDC, XRP/USDC, AVAX/USDC, ADA/USDC,
LINK/USDC, NEAR/USDC, DOGE/USDC, ARB/USDC, OP/USDC, SUI/USDC, ATOM/USDC, ICP/USDC

## Tech Stack

- **Engine**: Python 3.11, FastAPI, LangGraph, Pandas, CCXT
- **Dashboard**: Next.js 15, React 19, Tailwind, TradingView, Recharts
- **AI**: xAI GROK (grok-3-mini-fast) via OpenAI SDK
- **Data**: Postgres (Drizzle ORM), Redis (signal queue + state)
- **Infra**: Docker Compose, Caddy reverse proxy, Tailscale VPN
- **Tooling**: Turborepo, pnpm workspaces, TypeScript 5.8

## Database (13 tables)

`users`, `portfolio`, `positions`, `trades`, `signals`, `market_data`,
`agent_actions`, `ml_models`, `orchestrator_state`, `risk_checks`,
`backtest_results`, `validation_history`, `position_history`

## API Endpoints

See [OPS.md](./OPS.md) for the full list. Key endpoints:

- `GET /api/auto-trade` - Auto-trader status, positions, P&L
- `GET /api/health` - System health (4 service checks)
- `GET /api/portfolio` - Live Binance balances
- `POST /api/trade` - Execute trade on Binance
- `GET /api/signals` - Trading signals from DB

## License

Private - All Rights Reserved
