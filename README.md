# Cryonix Agent Army

**Autonomous AI crypto trading system — Python engine + Next.js dashboard + self-evolving strategy**

## Architecture

```
Python Engine (Docker)           Next.js (Docker)              Background Workers
 MarketScout Tank                 Dashboard UI                  auto-trader (30s poll)
  - 45 USDC pairs / 15m          API routes                    ws-server (real-time)
  - QuantGuild analysis           GROK AI validation            telegram-bot
  - NewsScout AI sentiment        Binance execution
  - ADX regime detection          Capital Allocator
  - Multi-TF trend (1h+4h)       X sentiment (standalone)
  - MOMENTUM_GAINER scanner      Calibration/EV model
       |                               |
       v                               v
     Redis  <----------------------> Postgres
  (signal queue, state,         (signals, trades, positions,
   regime, sentiment,            position_history,
   daily state, calibration)     daily backups)
```

### Signal Flow

```
MarketScout (CCXT) → QuantGuild patterns → ADX regime + HTF trend filter
  → SELL signals skipped early (spot-only mode)
  → RiskGate (≥65% conf) → Redis pending queue → Auto-Trader polls
  → EV model filter (reject negative-EV, min 5 trades sample)
  → X sentiment alert check (reject if hack/exploit/delist/lawsuit/ban/scam/fraud/…)
  → GROK AI validates — fail-closed (reject on parse failure)
  → GainerScanner boost (only when direction matches signal)
  → Capital Allocator budget check (signal pool vs grid pool)
  → Order book spread check (reject >0.3% spread)
  → Binance BUY (spot) + STOP_LOSS_LIMIT order → Position monitor (SL/TP/trailing)
  → Market regime → Redis → Capital Allocator adjusts pools dynamically
```

### Evolution Pipeline

```
Cron (every 2h) → Gather performance data (Postgres) + calibration + X sentiment
  → GROK analyzes + generates Copilot CLI instruction
  → Copilot CLI executes code changes (1-3 surgical tweaks)
  → Output validation (reject refusal keywords)
  → Diff-size guard (>100 lines = abort)
  → git add scoped to CRITICAL_FILES only (no git add .)
  → Verification (type-check, tests, invariant scripts)
  → Auto-commit + Docker deploy to production
```

## Monorepo Structure

```
apps/web/                    # Next.js 15 dashboard + API routes
  src/app/api/
    auto-trade/              # Core trading logic (risk, AI, execution, capital allocator)
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
  backup-postgres.sh         # Daily Postgres backup (7-day rotation)
  strategy-lab/              # Standalone Python tools
    calibrate.py             # Pattern EV calibration (cron: every 6h)
    x_sentiment.py           # X/Twitter sentiment scanner (cron: every 15min)
    morning_report.py        # Daily performance report (cron: 06:00 UTC)
    engine_diagnostik.py     # Container health & log analysis
    backtest_momentum.py     # Momentum gainer backtester
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
| RSI Extreme | BUY/SELL | RSI < 35 (buy) or > 70 (sell), Wilder's EMA |
| Bollinger Squeeze | BUY/SELL | Band width bottom 20%, price position |
| Volume Spike | BUY/SELL | 2x+ average volume with price momentum |
| MACD Crossover | BUY/SELL | Signal line cross |
| EMA 9/21 Cross | BUY/SELL | Fast/slow EMA crossover |
| Dip Buy | BUY | 5%+ drawdown from 20-bar high, recovering |
| Deep Value Crash | BUY | 8%+ drawdown, multi-TF RSI, capitulation volume |
| MOMENTUM_GAINER | BUY | GainerScanner top movers (24h >5%) + RSI/volume confirmation |

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
- Multi-TF RSI: non-oversold 1h → -3% confidence penalty

## Risk Management

| Parameter | Value |
|-----------|-------|
| Min confidence | 65% |
| Position sizing | Half-Kelly, max 15% capital per position |
| Stop-loss | 4×ATR + Binance-native STOP_LOSS_LIMIT on every buy |
| Take-profit | 6×ATR |
| Trailing stop | 3% below high water mark (activates at 1.5% profit), persisted in Redis |
| Daily loss limit | 5% of capital |
| Max positions | 5 concurrent (4 signal + 2 grid) |
| Max trades/day | 6 |
| Spread check | Reject >0.3% bid-ask spread |
| EV filter | Reject negative-EV patterns (min 5 trades sample) |
| X sentiment | Block BUY on negative news (hack/exploit/delist/lawsuit/ban/scam/fraud/investigation/vulnerability) |
| GROK AI validation | Fail-closed — reject on parse failure |
| Position locking | Redis NX + 5s TTL, 3 retries (prevents double execution) |
| Daily state | Redis-backed (survives worker restarts) |

## Capital Allocator

Single source of truth for strategy budgets — visible via `GET /api/auto-trade` response.

| Pool | Base Allocation | Purpose |
|------|----------------|---------|
| Signal pool | 65% | Signal-based trades (QuantGuild patterns) |
| Grid pool | 25% | Grid trading positions |
| Reserve | 10% | Always held back (safety buffer) |

**Per-strategy position limits:** MAX_SIGNAL_POSITIONS=4, MAX_GRID_POSITIONS=2

### Regime-Based Rebalancing

| Regime | Signal Pool | Grid Pool | Reserve |
|--------|-------------|-----------|---------|
| Ranging (default) | 65% | 25% | 10% |
| Volatile | 70% | 0% (paused) | 30% |
| Trending | 72% | 18% | 10% |

Market regime is written to Redis by the Python engine and read by the Capital Allocator to dynamically adjust pool sizes.

## CONFIG

| Key | Value | Notes |
|-----|-------|-------|
| MAX_OPEN_POSITIONS | 5 | Realistic for ~$42 capital |
| MAX_POSITION_SIZE_PCT | 0.15 | 15% — fewer but larger positions |
| MIN_CONFIDENCE | 0.65 | 65% minimum |
| MAX_TRADES_PER_DAY | 6 | |
| MAX_DAILY_LOSS_PCT | 0.05 | 5% daily loss limit |
| TRAILING_STOP_PCT | 3.0 | 3% below high water mark |
| TRADING_MODE | spot | Synced across TS + Python |
| SIGNAL_POOL_PCT | 0.65 | Capital allocator: signal budget |
| GRID_POOL_PCT | 0.25 | Capital allocator: grid budget |
| RESERVE_PCT | 0.10 | Capital allocator: reserve |
| MAX_SIGNAL_POSITIONS | 4 | Max concurrent signal trades |
| MAX_GRID_POSITIONS | 2 | Max concurrent grid trades |

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
  → Alerts (hack, exploit, delist, lawsuit, ban, scam, fraud, investigation, vulnerability) → Blocks BUY signals
  → Sentiment context injected into GROK AI validation prompt
```

Also runs standalone via `scripts/strategy-lab/x_sentiment.py` (cron: every 15min).

## Trading Pairs (45)

**Tier 1:** BTC, ETH
**Tier 2:** SOL, BNB, XRP
**Tier 3:** ADA, AVAX, LINK, DOT, NEAR, ATOM
**Tier 4:** SUI, ARB, OP, SEI, ICP, FIL, THETA, TAO
**Tier 5:** DOGE, SHIB, PEPE, WIF, BONK, FLOKI
**Tier 6:** POL, RENDER, INJ, TIA, JUP, AAVE, UNI, LDO, CRV, PENDLE, APT, MANA, SAND, GALA, IMX, ALGO, HBAR, VET

## Tech Stack

- **Engine**: Python 3.11, LangGraph, Pandas, CCXT (spot mode)
- **Dashboard**: Next.js 15, React 19, Tailwind, TradingView, Recharts
- **AI**: xAI GROK (grok-3-mini, grok-4-1-fast-reasoning) via OpenAI SDK
- **Data**: Postgres (Drizzle ORM, daily backups), Redis (signal queue + state + regime + calibration + sentiment)
- **Evolution**: GROK analysis → GitHub Copilot CLI mutation → auto-deploy
- **Infra**: Docker Compose, Caddy reverse proxy, Azure ARM64 VM
- **Tooling**: Turborepo, pnpm workspaces, TypeScript 5.8

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/auto-trade` | GET/POST | Auto-trader status, positions, capital budget, trigger |
| `/api/calibration` | GET/POST | Pattern EV calibration data |
| `/api/x-sentiment` | GET/POST | X/Twitter sentiment scores |
| `/api/health` | GET | System health (4 service checks) |
| `/api/portfolio` | GET | Live Binance balances |
| `/api/signals` | GET | Trading signals from DB |

## Cron Jobs

| Schedule | Script | Purpose |
|----------|--------|---------|
| 0 */2 * * * | run_evolution.sh | Autonomous strategy evolution (every 2h) |
| */15 * * * * | strategy-lab/x_sentiment.py | X sentiment refresh (standalone Python) |
| 0 */6 * * * | strategy-lab/calibrate.py | Pattern calibration (standalone Python) |
| 0 3 * * * | backup-postgres.sh | Postgres daily backup (7-day rotation) |
| 0 6 * * * | strategy-lab/run.sh | Morning report (daily) |

## License

Private - All Rights Reserved
