# Cryonix System Architecture

## Overview

Cryonix is a multi-agent AI trading system built as a Turborepo monorepo. It features autonomous trading agents that scan cryptocurrency markets, detect patterns, validate signals, and execute trades with comprehensive risk management.

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
│                            AGENT ORCHESTRATION LAYER                         │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                        ORCHESTRATOR AGENT                             │   │
│  │  • Coordinates all agents          • Routes messages                  │   │
│  │  • Health monitoring               • Emergency stop                   │   │
│  │  • Portfolio sync                  • Trading cycle management         │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                       │                                      │
│         ┌─────────────────────────────┼─────────────────────────────┐       │
│         ▼                             ▼                             ▼       │
│  ┌──────────────┐          ┌──────────────────┐          ┌──────────────┐   │
│  │ MARKET SCOUT │          │ SIGNAL VALIDATOR │          │  BACKTESTER  │   │
│  │              │          │                  │          │              │   │
│  │ • Scan 24/7  │──────────│ • Multi-source   │          │ • Walk-fwd   │   │
│  │ • Patterns   │  Signals │ • Consensus      │          │ • Metrics    │   │
│  │ • Watchlist  │          │ • Tech analysis  │          │ • Monte Carlo│   │
│  └──────────────┘          └──────────────────┘          └──────────────┘   │
│                                       │                                      │
│                                       ▼                                      │
│                            ┌──────────────────┐                              │
│                            │   RISK MANAGER   │                              │
│                            │                  │                              │
│                            │ • Kelly Criterion│                              │
│                            │ • Position sizing│                              │
│                            │ • Circuit breaker│                              │
│                            │ • Loss limits    │                              │
│                            └──────────────────┘                              │
│                                       │                                      │
│                                       ▼                                      │
│                            ┌──────────────────┐                              │
│                            │    EXECUTOR      │                              │
│                            │                  │                              │
│                            │ • Order mgmt     │                              │
│                            │ • Position track │                              │
│                            │ • Slippage calc  │                              │
│                            └──────────────────┘                              │
└─────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              DATABASE LAYER                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │   Signals    │  │  Positions   │  │   Trades     │  │  Backtests   │     │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘     │
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
└─────────────────────────────────────────────────────────────────────────────┘
```

## Agent Descriptions

### Orchestrator Agent
The master coordinator that manages all other agents.

**Responsibilities:**
- Start/stop child agents
- Route messages between agents
- Monitor agent health (every 60s)
- Sync portfolio value (every 30s)
- Trigger trading cycles (every 5m)
- Emergency stop on 5% daily loss

**Configuration:**
```typescript
{
  SCAN_INTERVAL: 5 * 60 * 1000,      // 5 minutes
  PORTFOLIO_SYNC_INTERVAL: 30 * 1000, // 30 seconds
  HEALTH_CHECK_INTERVAL: 60 * 1000,   // 1 minute
  DAILY_LOSS_LIMIT: 0.05,             // 5%
}
```

### Market Scout Agent
24/7 market scanner that detects trading patterns.

**Responsibilities:**
- Scan watchlist symbols (BTC, ETH, SOL, BNB, etc.)
- Run pattern detectors every 15 seconds
- Emit signals when patterns detected
- Track market conditions

**Pattern Detectors:**
- Bollinger Squeeze
- Volume Spike
- Triangle Breakout
- RSI Divergence

### Signal Validator Agent
Multi-source signal validation for consensus.

**Responsibilities:**
- Receive signals from Market Scout
- Validate with technical indicators
- Calculate consensus score
- Return EXECUTE/REJECT/REVIEW recommendation

**Validators:**
- Technical (RSI, MACD, MA)
- Volume confirmation
- Trend alignment
- Support/Resistance levels

### Risk Manager Agent
Position sizing and risk control using Kelly Criterion.

**Responsibilities:**
- Calculate optimal position size (Kelly)
- Check portfolio exposure limits
- Monitor daily/weekly loss limits
- Trigger circuit breakers

**Risk Limits:**
```typescript
{
  maxPortfolioRisk: 0.10,   // 10%
  maxPositionRisk: 0.02,    // 2% per trade
  maxPositionSize: 0.30,    // 30% max position
  maxOpenPositions: 5,
  dailyLossLimit: 0.03,     // 3% soft cap
  weeklyLossLimit: 0.08,    // 8% soft cap
}
```

### Executor Agent
Trade execution and order management.

**Responsibilities:**
- Execute market/limit orders via CCXT
- Place stop-loss/take-profit orders
- Track order status and fills
- Calculate execution slippage
- Report execution results

**Features:**
- OCO (One-Cancels-Other) orders
- Retry logic for failed orders
- Circuit breaker for repeated failures
- Testnet mode support

### Backtester Agent
Strategy validation on historical data.

**Responsibilities:**
- Run walk-forward backtests
- Calculate performance metrics
- Monte Carlo simulation
- Optimize strategy parameters

**Metrics:**
- Sharpe Ratio
- Sortino Ratio
- Maximum Drawdown
- Win Rate
- Profit Factor
- Risk-adjusted Returns

## Message Flow

```
1. Market Scout detects pattern
   ↓
2. Signal emitted to Orchestrator
   ↓
3. Orchestrator routes to Signal Validator
   ↓
4. Validator returns consensus score
   ↓
5. If approved, route to Risk Manager
   ↓
6. Risk Manager calculates position size
   ↓
7. If approved, route to Executor
   ↓
8. Executor places order on exchange
   ↓
9. Execution result broadcast to UI
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/portfolio` | GET | Live portfolio balances |
| `/api/signals` | GET | Trading signals |
| `/api/analyze` | POST | GROK AI analysis |
| `/api/trade` | POST | Execute trade |
| `/api/risk-check` | POST | Check risk limits |
| `/api/backtest` | POST | Run backtest |
| `/api/positions` | GET/POST/DELETE | Position management |
| `/api/validate-signal` | POST | Signal validation |

## Database Schema

**Core Tables:**
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
cryonix-agent-army/
├── apps/
│   └── web/                    # Next.js dashboard
│       ├── src/
│       │   ├── app/
│       │   │   ├── api/        # API routes
│       │   │   └── page.tsx    # Dashboard
│       │   ├── components/     # React components
│       │   ├── hooks/          # Custom hooks
│       │   └── lib/            # Utilities
│       └── scripts/            # Dev scripts
├── packages/
│   ├── agents/                 # Trading agents
│   │   └── src/
│   │       ├── orchestrator/
│   │       ├── market-scout/
│   │       ├── signal-validator/
│   │       ├── risk-manager/
│   │       ├── executor/
│   │       ├── backtester/
│   │       └── utils/
│   ├── database/               # Drizzle ORM
│   │   └── src/
│   │       ├── schema.ts
│   │       └── *.repository.ts
│   ├── types/                  # Shared types
│   │   └── src/
│   │       └── index.ts
│   └── ui/                     # shadcn/ui
├── docs/                       # Documentation
└── CLAUDE.md                   # AI context
```
