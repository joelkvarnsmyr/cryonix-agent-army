# 🤖 Cryonix AI Trading Dashboard

**Multi-Agent AI Trading System powered by GROK & Binance**

> ⚡ **Quick Start**: See [QUICKSTART.md](./QUICKSTART.md) to get running in 5 minutes!

---

## 📁 Project Structure

```
cryonix-agent-army/              # Turborepo Monorepo
├── apps/
│   └── web/                     # Next.js 14 App (Frontend + API)
├── packages/
│   ├── agents/                  # Trading Agents (TypeScript)
│   │   ├── orchestrator/        # Master coordinator
│   │   ├── market-scout/        # Pattern detection & signals
│   │   ├── claude-assistant/    # GROK AI chat
│   │   └── base-agent.ts        # Base agent class
│   ├── database/                # Drizzle ORM + Vercel Postgres
│   │   └── schema.ts            # Database schema
│   ├── ui/                      # Shared shadcn/ui Components
│   └── types/                   # Shared TypeScript Types
├── turbo.json                   # Turborepo Config
└── pnpm-workspace.yaml          # pnpm Workspace
```

---

## 🚀 Quick Start

```bash
# Install dependencies
pnpm install

# Setup environment
cp .env.example apps/web/.env.local

# Edit .env.local with your API keys
nano apps/web/.env.local

# Run development server
pnpm dev
```

Visit **http://localhost:3003**

⚠️ **LIVE TRADING WARNING**: This system now executes REAL trades on Binance. Use testnet or start with small amounts!

📖 **Full guide**: [QUICKSTART.md](./QUICKSTART.md)
🚀 **Deploy guide**: [DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md)

---

## 🤖 "The Glass Tank" Hybrid Architecture (In Transition)

> 🚧 **Architectural Pivot in Progress**
> We are currently upgrading from a Serverless-only architecture to a **Hybrid System**. 
> The TypeScript Agents (`packages/agents`) are being migrated to the Python Engine (`packages/engine`) to enable persistent, stateful trading.

Cryonix uses a **Hybrid Architecture** to solve the "Serverless Trap".

### 🧠 The Brain: `packages/engine` (Python)
- **Technology:** Python 3.11, LangGraph, DSPy, Pandas-TA.
- **Runtime:** Persistent Docker Container. **Stateful & 24/7.**
- **Responsibility:**
  - **Tanks:** Autonomous agents running continuous loops.
  - **Guilds:** Intelligence layers (Oracle, Scribe, Quant).
  - **Risk Gates:** Mandatory middleware that validates *every* trade.

### 💅 The Face: `apps/web` (Next.js)
- **Technology:** Next.js 15, React, Tailwind.
- **Runtime:** Serverless (Vercel).
- **Responsibility:**
  - **Dashboard:** Visualizes the "Brain's" state in real-time.
  - **Control Plane:** Human-in-the-loop "Approve" buttons.

```
┌──────────────────────┐      ┌───────────────────────────┐
│   The Face (Web)     │      │     The Brain (Engine)    │
│  (Next.js / Vercel)  │      │      (Python / Docker)    │
│                      │      │                           │
│   [ Dashboard ] <────┼──────┼──── [ Redis State Sync ]  │
│                      │      │                           │
│   [ Approve Btn ] ───┼──────┼───> [   Risk Gate    ]    │
│                      │      │            │              │
└──────────────────────┘      │     [ Execution Tank ]    │
                              │            ▼              │
                              │       [  Binance  ]       │
                              └───────────────────────────┘
```

### Implemented Agents ✅

| Agent | Status | Description |
|-------|--------|-------------|
| **Orchestrator** 🎯 | ✅ Active | Master coordinator for all agents |
| **Market Scout** 🔍 | ✅ Active | 24/7 market scanning, pattern detection |
| **Risk Manager** 🛡️ | ✅ Active | Kelly Criterion, circuit breakers, ATR stops |
| **Executor** ⚡ | ✅ Active | Smart order execution with position monitoring |
| **Backtester** 📊 | ✅ Active | Walk-forward optimization, performance metrics |
| **Signal Validator** ✓ | ✅ Active | Multi-source consensus validation |
| **GROK Assistant** 💬 | ✅ Active | AI-powered chat & analysis |

### Pattern Detectors

- ✅ **Bollinger Squeeze** - Volatility compression patterns
- ✅ **Volume Spike** - Unusual volume detection
- ✅ **Triangle Breakout** - Chart pattern breakouts
- ✅ **RSI Divergence** - Momentum divergence detection

### Risk Management Features

- ✅ **Kelly Criterion** - Optimal position sizing
- ✅ **Circuit Breakers** - Automatic trading halt on rapid losses
- ✅ **ATR-based Stops** - Dynamic stop-loss/take-profit
- ✅ **Correlation Checks** - Asset group correlation limits
- ✅ **Weekly Loss Limits** - Extended loss protection

### Coming Soon 🔄

- [ ] **Reporter Agent** - Performance analytics
- [ ] **Learning Agent** - ML model training

---

## 🎨 Dashboard Features

### ✅ Live Components

| Component | Features |
|-----------|----------|
| **Portfolio Summary** 💰 | ✅ Real Binance account balances<br>✅ USD values for all holdings<br>✅ Stablecoins (cash) vs crypto positions<br>✅ Auto-refresh every 30 seconds |
| **AI Signals** 🤖 | ✅ GROK AI analysis (Swedish)<br>✅ BUY/SELL/HOLD signals with confidence<br>✅ Entry, target, and stop-loss prices<br>✅ Click "Analyze All" or individual coins |
| **Trading Chart** 📊 | ✅ TradingView integration<br>✅ Live price updates<br>✅ Multiple timeframes |
| **Active Positions** 📈 | ✅ Real-time P&L tracking<br>✅ Entry/current price comparison<br>✅ Live updates from Binance |
| **Quick Trade** ⚡ | ⚠️ **LIVE TRADING**<br>✅ Real-time price updates (every 5s)<br>✅ Portfolio risk % calculator<br>✅ Executes REAL market orders<br>⚠️ Use with caution! |

---

## 📊 Tech Stack

### Frontend
- **Next.js 14** (App Router + Server Components)
- **TypeScript** - Type safety
- **Tailwind CSS** - Styling
- **shadcn/ui** - UI components
- **TradingView** - Charts

### Backend
- **Next.js API Routes** - REST & WebSocket
- **Drizzle ORM** - Type-safe SQL
- **Vercel Postgres** - Database
- **Vercel KV** - Redis cache

### AI & Trading
- **xAI GROK** (OpenAI-compatible)
- **Binance API** (via CCXT)
- **ccxt** - Unified exchange library

### DevOps
- **Turborepo** - Monorepo management
- **pnpm** - Fast package manager
- **Vercel** - Hosting & CI/CD

---

## 🔌 API Endpoints

```typescript
// Market Data (LIVE)
GET  /api/market          # Live market data
  ?symbol=BTCUSDT         # Ticker, OHLCV, orderbook from Binance

// Portfolio (LIVE)
GET  /api/portfolio       # Real Binance account balances
                          # Returns USDC, BNB, and all holdings with USD values

// Trading (⚠️ LIVE TRADING)
POST /api/trade           # Execute REAL buy/sell orders
  { symbol, side, quantity, type }

// AI Analysis (GROK)
POST /api/analyze         # GROK AI market analysis
  { symbol }              # Returns BUY/SELL/HOLD with reasoning

// Backtesting
POST /api/backtest        # Run backtest simulation
  { symbols, startDate, endDate, initialCapital, patterns }

// Signal Validation
POST /api/validate-signal # Validate signal with multi-source consensus
  { symbol, action, confidence, entryPrice, stopLoss, targetPrice }

// Risk Management
GET  /api/risk            # Get current risk status
POST /api/risk-check      # Check if trade passes risk rules
  { symbol, side, confidence, entryPrice, stopLoss, targetPrice }

// Agent Management
GET  /api/agents          # Get agent statuses
POST /api/agents          # Start/stop agents

// Orchestrator
GET  /api/orchestrator/status  # Get orchestrator state
POST /api/orchestrator/start   # Start orchestrator
POST /api/orchestrator/stop    # Stop orchestrator

// Signals & Chat
GET  /api/signals         # Get recent signals
POST /api/chat            # Chat with GROK
```

---

## 🔐 Environment Variables

```bash
# Vercel Postgres (auto-populated)
POSTGRES_URL=
POSTGRES_PRISMA_URL=

# Vercel KV Redis (auto-populated)
KV_URL=
KV_REST_API_URL=

# xAI GROK API
XAI_API_KEY=xai-...

# Binance API
BINANCE_API_KEY=...
BINANCE_API_SECRET=...
BINANCE_TESTNET=true  # Use testnet for development

# App
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

---

## 🧪 Development

```bash
# Install dependencies
pnpm install

# Run all apps
pnpm dev

# Run specific app
cd apps/web && pnpm dev

# Type checking
pnpm type-check

# Linting
pnpm lint

# Build for production
pnpm build
```

### Database Commands

```bash
cd packages/database

# Generate migrations
pnpm db:generate

# Push schema to DB
pnpm db:push

# Open Drizzle Studio
pnpm db:studio
```

---

## 📈 Roadmap

### ✅ Phase 1: Foundation (COMPLETE)
- [x] Turborepo monorepo
- [x] Next.js 15 with App Router
- [x] Shared packages (agents, database, ui, types)
- [x] Trading dashboard UI
- [x] **LIVE Binance integration via CCXT**
- [x] **GROK AI integration (Swedish analysis)**
- [x] **Real portfolio tracking**
- [x] **Live market data feeds**
- [x] **Real trade execution** ⚠️

### ✅ Phase 2: Agent System (COMPLETE)
- [x] Live market data integration
- [x] GROK AI analysis (BUY/SELL/HOLD signals)
- [x] Real trade execution system
- [x] **Risk Manager with Kelly Criterion**
- [x] **Orchestrator Agent** (automated trading coordinator)
- [x] **Market Scout Agent** (pattern detection)
- [x] **Executor Agent** (smart order execution)
- [x] **Backtesting Engine** (walk-forward optimization)
- [x] **Signal Validator** (multi-source consensus)
- [ ] **WebSocket real-time updates** 👈 NEXT

### 📋 Phase 3: ML & Intelligence (IN PROGRESS)
- [ ] Learning Agent with pattern classification
- [ ] Market regime detection
- [ ] Strategy optimization
- [ ] Advanced ML models

### 🚀 Phase 4: Production
- [x] Unit tests for core modules
- [ ] Integration tests
- [ ] Error monitoring (Sentry)
- [ ] Performance optimization
- [ ] Mobile responsiveness
- [ ] Production deployment

---

## 📊 Database Schema

See `packages/database/src/schema.ts`:

- **users** - User accounts
- **portfolio** - Portfolio tracking
- **positions** - Open/closed positions
- **trades** - Trade history (time-series)
- **signals** - AI trading signals
- **market_data** - Historical prices (time-series)
- **agent_actions** - Agent activity log
- **ml_models** - ML model metadata

---

## ⚠️ Security & Risk

### Production Checklist

- [ ] Start with **Binance Testnet**
- [ ] Enable **IP whitelist** on Binance API
- [ ] Set **withdrawal restrictions**
- [ ] Implement **rate limiting**
- [ ] Enable **2FA** everywhere
- [ ] Start with **small capital** ($100-500)
- [ ] Monitor **24/7** initially
- [ ] Setup **alerts** for large moves

### Risk Management

- **Max Portfolio Risk**: 10% drawdown limit
- **Max Position Risk**: 2% per trade
- **Position Sizing**: Kelly Criterion (half-Kelly)
- **Emergency Stop**: Auto-shutdown on 10% daily loss

---

## 📚 Documentation

- [QUICKSTART.md](./QUICKSTART.md) - Get running in 5 minutes
- [DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md) - Deploy to Vercel
- [TECHNICAL_DOCUMENTATION.md](./TECHNICAL_DOCUMENTATION.md) - Full spec

---

## ⚖️ Disclaimer

**This software is for educational purposes only.**

- ⚠️ Cryptocurrency trading carries significant risk
- ⚠️ Past performance ≠ future results
- ⚠️ Only trade with money you can afford to lose
- ⚠️ Developers not responsible for financial losses
- ⚠️ Always DYOR (Do Your Own Research)

---

## 🎯 Target Performance Metrics

- **Win Rate**: >55%
- **Sharpe Ratio**: >1.5
- **Max Drawdown**: <15%
- **R:R Ratio**: >1:2
- **Uptime**: >99%

---

## 🤝 Contributing

This is a private project. For support:
- Open an issue on GitHub
- Check [Discussions](../../discussions)

---

## 📄 License

Private - All Rights Reserved

---

**Built with ❤️ using Next.js, GROK AI, and Binance**

Happy Trading! 🚀📈
