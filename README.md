# Cryonix Agent Army

**Autonomous AI crypto trading system — Python engine + Next.js dashboard + self-evolving strategy**

## Architecture

```
Python Engine (Docker)           Next.js (Docker)              Background Workers
 MarketScout Tank                 Dashboard UI                  auto-trader (30s poll)
  - 45 USDC pairs / 15m          API routes                    ws-server (real-time)
  - QuantGuild analysis           GROK AI validation            telegram-bot
  - NewsScout AI sentiment        Binance execution
  - ADX regime detection          X sentiment scanning
  - Multi-TF trend (1h+4h)       Calibration/EV model
       |                               |
       v                               v
     Redis  <----------------------> Postgres
  (signal queue, state,         (signals, trades, positions,
   sentiment, calibration)       position_history)
```

### Signal Flow

```
MarketScout (CCXT) → QuantGuild patterns → ADX regime + HTF trend filter
  → RiskGate (≥65% conf) → Redis pending queue → Auto-Trader polls
  → EV model filter (reject negative-EV patterns)
  → X sentiment alert check (reject if hack/exploit/delist)
  → GROK AI validates (with ADX, regime, HTF, EV, sentiment context)
  → Order book spread check (reject >0.3% spread)
  → Binance BUY (spot only) → Position monitor (SL/TP/trailing)
```

### Evolution Pipeline

```
Cron (every 2h) → Gather performance data (Postgres) + calibration + X sentiment
  → GROK analyzes + generates Copilot CLI instruction
  → Copilot CLI executes code changes (1-3 surgical tweaks)
  → Verification (type-check, tests, invariant scripts)
  → Auto-commit + Docker deploy to production
```

## Monorepo Structure

```
apps/web/                    # Next.js 15 dashboard + API routes
  src/app/api/
    auto-trade/              # Core trading logic (risk, AI, execution, monitoring)
    calibration/             # Pattern win rate calibration (Postgres → Redis)
    x-sentiment/             # X/Twitter sentiment via GROK xAI search
    health/                  # System health checks
    signals/                 # Signal history
    portfolio/               # Live Binance balances
packages/
  engine/                    # Python 3.11 — MarketScout, NewsScout, QuantGuild
  database/                  # Drizzle ORM — Postgres schema
  types/                     # Shared TypeScript types + Zod schemas
  ui/                        # shadcn/ui components
scripts/
  copilot-evolution.mjs      # Autonomous GROK→Copilot evolution engine
  auto-trader.mjs            # Docker-compatible auto-trader
  ws-server.mjs              # WebSocket server
  run_calibration.sh         # Calibration + sentiment cron
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

Deployed via Docker Compose (8 containers) on Azure ARM64 VM with Caddy reverse proxy.

```bash
# Deploy updates
docker compose -f docker-compose.prod.yml up -d --build
```

See [OPS.md](./OPS.md) for operations guide.

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

### Market Regime Detection

| Regime | Condition | Effect |
|--------|-----------|--------|
| Trending | ADX ≥ 25 | Trend-following signals boosted |
| Ranging | ADX < 25 | Trend signals penalized -5%, mean-reversion preferred |
| Volatile | ATR expansion > 2× | Extra caution on entries |

### Higher Timeframe Filter

- Fetches 1h + 4h candles for every signal (EMA9/EMA21 alignment)
- BUY + bearish HTF → -10% confidence penalty
- BUY + bullish HTF → +5% confidence boost

## Risk Management

| Parameter | Value |
|-----------|-------|
| Min confidence | 65% |
| Position sizing | Half-Kelly, max 35% capital |
| Stop-loss | 4×ATR (evolved from 2×ATR) |
| Take-profit | 6×ATR |
| Trailing stop | 3% below high water mark (activates at 1.5% profit) |
| Daily loss limit | 5% of capital |
| Max positions | 5 concurrent |
| Max trades/day | 6 |
| Spread check | Reject >0.3% bid-ask spread |
| EV filter | Reject patterns with negative expected value |
| X sentiment | Block BUY if breaking negative news (hack/exploit/delist) |
| GROK AI validation | Second opinion on every signal |

## Self-Calibration (EV Model)

Pattern performance is tracked from closed trades and used to filter future signals:

```
POST /api/calibration → Queries Postgres → Computes win rate, avg win/loss, EV per pattern
  → Stores in Redis (calibration:patterns, 24h TTL)
  → Auto-trade reads EV → Rejects negative-EV patterns
```

## X/Twitter Sentiment

```
POST /api/x-sentiment → GROK with search:on → Analyzes X buzz for 13 coins
  → Scores (-3 to +3) per coin → Redis (sentiment:{SYMBOL}, 15min refresh)
  → Alerts (hack, exploit, delist) → Blocks BUY signals
  → Sentiment context injected into GROK AI validation prompt
```

## Trading Pairs (45)

**Tier 1:** BTC, ETH
**Tier 2:** SOL, BNB, XRP
**Tier 3:** ADA, AVAX, LINK, DOT, NEAR, ATOM
**Tier 4:** SUI, ARB, OP, SEI, ICP, FIL, THETA, TAO
**Tier 5:** DOGE, SHIB, PEPE, WIF, BONK, FLOKI
**Tier 6:** POL, RENDER, INJ, TIA, JUP, AAVE, UNI, LDO, CRV, PENDLE, APT, MANA, SAND, GALA, IMX, ALGO, HBAR, VET

## Tech Stack

- **Engine**: Python 3.11, LangGraph, Pandas, CCXT
- **Dashboard**: Next.js 15, React 19, Tailwind, TradingView, Recharts
- **AI**: xAI GROK (grok-3-mini, grok-4-1-fast-reasoning) via OpenAI SDK
- **Data**: Postgres (Drizzle ORM), Redis (signal queue + state + calibration + sentiment)
- **Evolution**: GROK analysis → GitHub Copilot CLI mutation → auto-deploy
- **Infra**: Docker Compose, Caddy reverse proxy, Azure ARM64 VM
- **Tooling**: Turborepo, pnpm workspaces, TypeScript 5.8

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/auto-trade` | GET/POST | Auto-trader status, positions, trigger |
| `/api/calibration` | GET/POST | Pattern EV calibration data |
| `/api/x-sentiment` | GET/POST | X/Twitter sentiment scores |
| `/api/health` | GET | System health (4 service checks) |
| `/api/portfolio` | GET | Live Binance balances |
| `/api/signals` | GET | Trading signals from DB |

## Cron Jobs

| Schedule | Script | Purpose |
|----------|--------|---------|
| */15 * * * * | curl x-sentiment | X sentiment refresh |
| 0 */6 * * * | run_calibration.sh | Pattern calibration + sentiment |
| 0 */2 * * * | run_evolution.sh | Autonomous strategy evolution (paused) |

## License

Private - All Rights Reserved
