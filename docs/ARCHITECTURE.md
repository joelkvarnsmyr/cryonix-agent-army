# Cryonix System Architecture

## Overview

Cryonix is a regime-aware AI trading system built as a Turborepo monorepo. It features autonomous trading agents that scan cryptocurrency markets, detect patterns across 8 detectors, validate signals through a multi-stage pipeline (risk gate → capital allocation → EV filter → sentiment → GROK AI), and execute trades on Binance with dynamic capital allocation and comprehensive risk management. State is coordinated through Redis; audit logging via Postgres.

## System Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              MARKET DATA LAYER                               │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │   Binance    │  │    CCXT      │  │  Historical  │  │   WebSocket  │     │
│  │     API      │──│   Adapter    │──│    Data      │──│    Feeds     │     │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘     │
└─────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         SIGNAL GENERATION LAYER                              │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                     MARKET SCOUT (market_scout.py)                    │   │
│  │  • 24/7 scanning        • GainerScanner (MOMENTUM_GAINER)            │   │
│  │  • Regime detection      • Writes market:regime to Redis             │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                       │                                      │
│                                       ▼                                      │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                     QUANT GUILD (quant.py) — 8 Pattern Detectors     │   │
│  │  Bollinger Squeeze │ RSI Extreme │ Volume Spike │ MACD Crossover     │   │
│  │  EMA 9/21 Cross    │ Dip Buy     │ Deep Value   │ MOMENTUM_GAINER    │   │
│  │  + Regime classification (volatile / trending / ranging)             │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│         │ SELL signals skipped (spot-only)                                    │
│         ▼                                                                    │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                     RISK GATE (see cryonix.toml [risk] min_confidence) │   │
│  │  → Approved signals written to Redis pending queue                    │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          EXECUTION PIPELINE (auto-trade/route.ts)            │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                   CAPITAL ALLOCATOR                                   │   │
│  │  Pools: see cryonix.toml [capital] signal/grid/reserve_pct           │   │
│  │  Regime overrides:                                                    │   │
│  │    volatile  → grid paused, reserve increased                        │   │
│  │    trending  → more capital to signals                               │   │
│  │    ranging   → default (grid works well in ranges)                   │   │
│  │  Tracks per-strategy usage via Redis positions                       │   │
│  │  Exposed in API response for dashboard                               │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│         │                                                                    │
│         ▼                                                                    │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │  EV Filter   │→ │  X Sentiment │→ │ GROK AI      │→ │ Spread Check │     │
│  │ ≥5 trades    │  │ 12 keywords  │  │ Validation   │  │ Max slippage │     │
│  │ reject -EV   │  │ Redis alert  │  │ (fail-closed)│  │ [exits] cfg  │     │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘     │
│                                                                │             │
│                                                                ▼             │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                          BINANCE EXECUTION                            │   │
│  │  • Market/Limit BUY order via CCXT                                   │   │
│  │  • Native STOP_LOSS_LIMIT placed as safety net                       │   │
│  │  • Position monitor (30s loop: SL / TP / trailing stop)              │   │
│  │  • Position locking via Redis NX                                     │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              STATE LAYER                                     │
│  ┌──────────────────────────────┐  ┌────────────────────────────────────┐   │
│  │         Redis (KV)           │  │         Postgres (Drizzle)         │   │
│  │  • market:regime    (1h TTL) │  │  • trades        • signals         │   │
│  │  • positions:open            │  │  • positions     • agent_actions    │   │
│  │  • risk:portfolio_state (7d) │  │  • portfolio     • backtest_results │   │
│  │  • calibration:patterns      │  │  • users         • market_data      │   │
│  │  • sentiment:{SYMBOL} (1h)   │  │                                    │   │
│  │  • scanner:top_movers        │  │                                    │   │
│  └──────────────────────────────┘  └────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              PRESENTATION LAYER                              │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                         NEXT.JS DASHBOARD                             │   │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐      │   │
│  │  │ Portfolio  │  │  Signals   │  │   Trade    │  │   Risk     │      │   │
│  │  │  Summary   │  │   Panel    │  │   Panel    │  │  Monitor   │      │   │
│  │  └────────────┘  └────────────┘  └────────────┘  └────────────┘      │   │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐      │   │
│  │  │ Backtest   │  │ Positions  │  │   Chart    │  │   Agent    │      │   │
│  │  │  Results   │  │  Manager   │  │   View     │  │   Status   │      │   │
│  │  └────────────┘  └────────────┘  └────────────┘  └────────────┘      │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │              STRATEGY LAB (read-only analytics layer)                 │   │
│  │  calibrate.py     │ morning_report.py │ x_sentiment.py               │   │
│  │  engine_diagnostik.py │ backtest_momentum.py                         │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Component Descriptions

### Market Scout (`packages/engine/src/tanks/market_scout.py`)
24/7 market scanner and regime detector.

**Responsibilities:**
- Scan watchlist symbols (BTC, ETH, SOL, BNB, etc.)
- Run 8 pattern detectors via QuantGuild
- GainerScanner for MOMENTUM_GAINER detection (top movers 3%+ in 1h)
- Classify market regime and write to Redis `market:regime` (1h TTL)
- Skip SELL signals early (spot-only system)
- Emit BUY signals that pass the confidence risk gate (configured in `cryonix.toml [risk] min_confidence`)

### Quant Guild (`packages/engine/src/guilds/quant.py`)
Core analysis engine with 8 pattern detectors + regime classification.

**Pattern Detectors:**

| # | Pattern | Detection Logic | Confidence |
|---|---------|----------------|------------|
| 1 | Bollinger Squeeze | BB width in bottom N% (see `[indicators] bollinger_squeeze_pct`), price near band | 0.75–0.95 |
| 2 | RSI Extreme | RSI below `[indicators] rsi_oversold` (oversold) | 0.75–0.92 |
| 3 | Volume Spike | Volume > `[indicators] volume_spike_threshold` × average | 0.65–0.85 |
| 4 | MACD Crossover | Signal line cross (bullish/bearish) | 0.68 |
| 5 | EMA 9/21 Cross | EMA9 crosses EMA21 | 0.76 |
| 6 | Dip Buy | Drawdown from high (see `[patterns] dip_buy_drawdown`), RSI below `dip_buy_max_rsi` | 0.70–0.85 |
| 7 | Deep Value Crash | Large crash (see `[patterns] deep_value_threshold`) with velocity analysis | 0.80–0.93 |
| 8 | MOMENTUM_GAINER | GainerScanner top mover + RSI/vol confirmation | 0.72–0.93 |

**Regime Classification (`_classify_regime`):**
- **volatile** — ATR > 2× mean
- **trending** — ADX ≥ `[indicators] adx_trending_threshold`
- **ranging** — default (neither volatile nor trending)

### Capital Allocator (`apps/web/src/app/api/auto-trade/route.ts`)
Sits between risk checks and execution. Manages capital budgets per strategy pool.

**Pool Allocation:**

Configured in `cryonix.toml [capital]` — see `signal_pool_pct`, `grid_pool_pct`, `reserve_pct`.

| Pool | Config Key | Purpose |
|------|-----------|---------|
| Signal | `signal_pool_pct` | Pattern-based signal trades |
| Grid | `grid_pool_pct` | Grid trading strategies |
| Reserve | `reserve_pct` | Always held back as buffer |

**Regime-Based Dynamic Allocation:**

Regime overrides are applied dynamically based on `market:regime` from Redis. In volatile regimes, grid is paused and reserve is increased. In trending regimes, more capital flows to signals. Ranging uses the default split from config.

**Key Behaviors:**
- Reads `market:regime` from Redis (set by market_scout.py)
- Tracks per-strategy usage via Redis position keys
- Budget check performed before every trade
- Allocation state exposed in API response for dashboard display
- Position limits: see `cryonix.toml [limits]` for `max_signal_positions`, `max_grid_positions`

### Risk Management — Consolidated

**Single source of truth:** `CONFIG` object in `auto-trade/route.ts`. Python `risk_manager.py` limits are synced with this CONFIG.

**Risk Limits** (all values configured in `cryonix.toml` — sections shown below):

| Limit | Config Section & Key | Purpose |
|-------|---------------------|---------|
| Max Daily Loss | `[risk] max_daily_loss_pct` | Circuit breaker on daily drawdown |
| Max Weekly Loss | `[risk] max_weekly_loss_pct` | Weekly cumulative loss limit |
| Max Position Size | `[capital] max_position_size_pct` | Per-position cap |
| Min Confidence | `[risk] min_confidence` | Signal minimum threshold |
| Volatility Pause | `[risk] volatility_pause_atr_pct` | Volatility threshold |
| Max Trades/Day | `[limits] max_trades_per_day` | Trade frequency limit |
| Max Open Positions | `[limits] max_open_positions` | Concurrent position limit |
| Consecutive Loss Limit | `[risk] max_consecutive_losses` | Cooling-off trigger |
| Max Slippage | `[exits] max_slippage_pct` | Spread check before execution |

**Safety Layers:**
- AI validation is **fail-closed** — if GROK is unreachable, trade is rejected
- Binance-native `STOP_LOSS_LIMIT` order placed as safety net on every trade
- Position locking via **Redis NX** (prevents duplicate entries on same symbol)
- Circuit breaker auto-resets daily/weekly
- Portfolio state tracked in Redis `risk:portfolio_state` (7-day TTL)

### Market Regime Flow

```
quant.py _classify_regime()
  │  ATR > 2× mean → volatile
  │  ADX ≥ threshold → trending  (see [indicators] adx_trending_threshold)
  │  else           → ranging
  ▼
market_scout.py → Redis SET market:regime (1h TTL)
  ▼
auto-trade/route.ts reads market:regime
  │
  ├─→ Capital Allocator: adjusts pool percentages
  ├─→ Grid strategy: paused if volatile
  ├─→ Confidence penalties applied per regime
  └─→ Passed to GROK AI validator as context
```

## Signal Pipeline

Full signal lifecycle from detection to execution:

```
MarketScout (market_scout.py)
  → QuantGuild (quant.py): 8 pattern detectors + MOMENTUM_GAINER
    → Regime classification → Redis market:regime
    → SELL signals skipped early (spot-only)
    → Risk Gate (see [risk] min_confidence) → Redis pending queue
      → Capital Allocator (budget check per strategy pool)
        → EV filter (≥5 trades sample, reject negative EV)
          → X sentiment alert check (12 keywords via x_sentiment.py)
            → GROK AI validation (fail-closed, with regime/EV/sentiment context)
              → Spread check (see [exits] max_slippage_pct)
                → Binance BUY (market/limit order via CCXT)
                  → Native STOP_LOSS_LIMIT order placed
                    → Position monitor (30s loop: SL / TP / trailing stop)
```

## Strategy Lab (Analytics Layer — Read-Only)

Located in `scripts/strategy-lab/`. These tools analyze and calibrate the system but never execute trades.

| Script | Purpose |
|--------|---------|
| `calibrate.py` | Calculates per-pattern win rates & EV from trade history; writes `calibration:patterns` to Redis for the EV filter |
| `morning_report.py` | Daily briefing: last 24h trade analysis, what-if SL width simulation, identifies dragging patterns |
| `x_sentiment.py` | Calls GROK xAI with live X/Twitter search; stores sentiment scores (−3 to +3) in Redis `sentiment:{SYMBOL}` (1h TTL) |
| `engine_diagnostik.py` | Container health check, Docker log parsing, Redis/Postgres connectivity verification, crash analysis |
| `backtest_momentum.py` | Backtests MOMENTUM_GAINER strategy against historical trades; measures GainerScanner effectiveness |

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/auto-trade` | POST | Main signal execution pipeline (full pipeline) |
| `/api/portfolio` | GET | Live portfolio balances |
| `/api/signals` | GET | Trading signals queue |
| `/api/analyze` | POST | GROK AI analysis |
| `/api/trade` | POST | Execute trade |
| `/api/risk-check` | POST | Pre-trade risk validation |
| `/api/risk` | GET | Current risk status |
| `/api/backtest` | POST | Run backtest |
| `/api/positions` | GET/POST/DELETE | Position management |
| `/api/validate-signal` | POST | Signal validation |
| `/api/calibration` | GET | Pattern stats & EV calibration data |
| `/api/grid-config` | GET/POST | Grid trading configuration |
| `/api/market` | GET | Market data queries |
| `/api/scanner-history` | GET | GainerScanner historical data |
| `/api/x-sentiment` | GET | X/Twitter sentiment polls |
| `/api/health` | GET | System health checks |
| `/api/tanks` | GET | Tank engine status |
| `/api/orchestrator` | POST | Trade orchestration |
| `/api/process-log` | GET | Log streaming |
| `/api/agents` | POST | LLM agent coordination |
| `/api/chat` | POST | Chat interface (copilot) |

## Redis Keys (State Coordination)

| Key | TTL | Purpose |
|-----|-----|---------|
| `market:regime` | 1h | Current regime: volatile / trending / ranging |
| `positions:open` | — | Live open positions (per-strategy tracking) |
| `risk:portfolio_state` | 7d | Daily/weekly P&L, circuit breaker state |
| `calibration:patterns` | — | Per-pattern win rates & EV (set by calibrate.py) |
| `sentiment:{SYMBOL}` | 1h | X/Twitter sentiment score (−3 to +3) |
| `scanner:top_movers` | — | GainerScanner top movers data |

## Database Schema

**Core Tables (Postgres via Drizzle ORM):**
- `users` - User accounts
- `portfolio` - Portfolio snapshots
- `positions` - Open/closed positions
- `trades` - Trade executions
- `signals` - Trading signals
- `market_data` - OHLCV candles
- `agent_actions` - Agent activity log
- `backtest_results` - Backtest history

## Environment Variables

```bash
# AI
XAI_API_KEY=xai-...

# Exchange
BINANCE_API_KEY=...
BINANCE_API_SECRET=...
BINANCE_TESTNET=true

# Database
POSTGRES_URL=...

# Redis
KV_URL=...

# App
NEXT_PUBLIC_APP_URL=http://localhost:3000
ENABLE_AUTO_TRADING=false
```

## Directory Structure

```
cryonix/
├── apps/
│   └── web/                          # Next.js dashboard
│       ├── src/
│       │   ├── app/
│       │   │   ├── api/
│       │   │   │   ├── auto-trade/   # Main signal execution pipeline + Capital Allocator
│       │   │   │   ├── risk-check/   # Pre-trade risk validation
│       │   │   │   ├── calibration/  # Pattern stats & EV data
│       │   │   │   ├── grid-config/  # Grid trading configuration
│       │   │   │   ├── x-sentiment/  # X/Twitter sentiment
│       │   │   │   ├── scanner-history/ # GainerScanner data
│       │   │   │   ├── portfolio/    # Portfolio state
│       │   │   │   ├── positions/    # Position management
│       │   │   │   ├── signals/      # Signal queue
│       │   │   │   ├── market/       # Market data
│       │   │   │   ├── health/       # System health
│       │   │   │   └── ...           # Additional routes
│       │   │   └── page.tsx          # Dashboard
│       │   ├── components/           # React components
│       │   ├── hooks/                # Custom hooks
│       │   └── lib/                  # Utilities
│       └── scripts/                  # Dev scripts
├── packages/
│   ├── engine/                       # Python trading engine
│   │   └── src/
│   │       ├── core/
│   │       │   ├── risk_manager.py   # Risk limits (synced with auto-trade CONFIG)
│   │       │   ├── state_sync.py     # Redis state synchronization
│   │       │   └── market_data.py    # Market data fetching
│   │       ├── guilds/
│   │       │   └── quant.py          # QuantGuild: 8 pattern detectors + regime classification
│   │       ├── tanks/
│   │       │   └── market_scout.py   # 24/7 scanner, GainerScanner, regime → Redis
│   │       └── models/               # Data models
│   ├── agents/                       # Trading agents (TypeScript)
│   │   └── src/
│   │       ├── orchestrator/
│   │       ├── market-scout/
│   │       ├── signal-validator/
│   │       ├── risk-manager/
│   │       ├── executor/
│   │       ├── backtester/
│   │       └── utils/
│   ├── database/                     # Drizzle ORM
│   │   └── src/
│   │       ├── schema.ts
│   │       └── *.repository.ts
│   ├── types/                        # Shared types
│   │   └── src/
│   │       └── index.ts
│   └── ui/                           # shadcn/ui
├── scripts/
│   ├── strategy-lab/                 # Analytics (read-only)
│   │   ├── calibrate.py              # EV model, pattern weights → Redis
│   │   ├── morning_report.py         # Daily briefing, what-if SL simulation
│   │   ├── x_sentiment.py            # GROK xAI X/Twitter search → Redis
│   │   ├── engine_diagnostik.py      # Container health, crash analysis
│   │   └── backtest_momentum.py      # Momentum strategy simulation
│   ├── auto-trader.mjs               # Node.js auto-trading orchestrator
│   └── evolve.py                     # Evolution engine
├── docs/                             # Documentation
└── CLAUDE.md                         # AI context
```
