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

Visit **http://localhost:3000**

📖 **Full guide**: [QUICKSTART.md](./QUICKSTART.md)
🚀 **Deploy guide**: [DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md)

---

## 🤖 Multi-Agent Architecture

```
           ┌─────────────────────┐
           │  ORCHESTRATOR       │
           │  (Coordinator)      │
           └──────────┬──────────┘
                      │
        ┌─────────────┼─────────────┐
        │             │             │
   ┌────▼────┐   ┌───▼────┐   ┌───▼─────┐
   │ MARKET  │   │ GROK   │   │ RISK    │
   │ SCOUT   │   │ AI     │   │ MANAGER │
   └─────────┘   └────────┘   └─────────┘
```

### Implemented Agents ✅

| Agent | Status | Description |
|-------|--------|-------------|
| **Orchestrator** 🎯 | ✅ Active | Master coordinator for all agents |
| **Market Scout** 🔍 | ✅ Active | 24/7 market scanning, pattern detection |
| **GROK Assistant** 💬 | ✅ Active | AI-powered chat & analysis |

### Pattern Detectors

- ✅ **Bollinger Squeeze** - Volatility compression patterns
- ✅ **Volume Spike** - Unusual volume detection
- 🔄 **Triangle Breakout** - Coming soon
- 🔄 **Momentum Shift** - Coming soon

### Coming Soon 🔄

- [ ] **Analyst Agent** - Multi-timeframe validation
- [ ] **Risk Manager** - Portfolio risk management
- [ ] **Executor Agent** - Smart order execution
- [ ] **Reporter Agent** - Performance analytics
- [ ] **Learning Agent** - ML model training

---

## 🎨 Dashboard Features

### ✅ Live Components

| Component | Features |
|-----------|----------|
| **Portfolio Summary** | Total value, Daily P&L, Cash/Positions breakdown |
| **AI Signals** | Real-time signals, Confidence scores, Pattern reasoning |
| **Trading Chart** | TradingView integration, 15min candles, Live updates |
| **Active Positions** | Open positions, Live P&L, Entry/current prices |
| **Quick Trade** | Position sizing, Risk calculator, R:R ratio |

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
// Agents
GET  /api/agents          # Get agent statuses
POST /api/agents          # Start/stop agents { action: 'start' | 'stop' }

// Chat
POST /api/chat            # Chat with GROK { message, context? }

// Signals
GET  /api/signals         # Get recent signals ?limit=10
POST /api/signals         # Create new signal

// Coming soon
GET  /api/positions       # Get open positions
POST /api/trades          # Execute trade
GET  /api/portfolio       # Get portfolio status
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
- [x] Next.js 14 with App Router
- [x] Shared packages (agents, database, ui, types)
- [x] Basic agents (Orchestrator, Market Scout, GROK)
- [x] Trading dashboard UI
- [x] Binance integration via CCXT
- [x] GROK AI integration

### 🔄 Phase 2: Core Trading (IN PROGRESS)
- [ ] Analyst Agent with multi-timeframe analysis
- [ ] Risk Manager with Kelly Criterion
- [ ] Executor Agent with smart routing
- [ ] WebSocket real-time updates
- [ ] More pattern detectors

### 📋 Phase 3: ML & Intelligence
- [ ] Learning Agent with pattern classification
- [ ] Historical backtesting
- [ ] Market regime detection
- [ ] Strategy optimization

### 🚀 Phase 4: Production
- [ ] Comprehensive tests
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
