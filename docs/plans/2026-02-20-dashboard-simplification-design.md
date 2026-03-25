# Dashboard Simplification Design

## Context

The trading system was simplified from 15 symbols to 2 (INJ + ATOM), 5 positions to 2, and targets a $40 account. The current dashboard has 40 components, 3 pages, candlestick charts, correlation matrices, grid managers — none of which are used. The user gets updates via Telegram and wants a single-screen overview.

## Goal

Replace the overbuilt 3-column dashboard with a single-page, single-column layout showing: balance, equity curve, positions, recent trades, and system health.

## Design

### Layout: Single page, single column, 5 sections

```
┌──────────────────────────────┐
│  CRYONIX          🟢  22:35  │  Header: logo + health dot + clock
├──────────────────────────────┤
│                              │
│       $40.22                 │  Balance card: big number
│    +$0.10 today (+0.25%)     │  Daily P&L + 7d P&L
│                              │
├──────────────────────────────┤
│                              │
│   ───╱──╲───╱────           │  Equity curve: 30d line chart
│                              │
├──────────────────────────────┤
│  INJ +0.8%    │  ATOM  —     │  Positions: 2 cards side by side
│  $2.45→$2.47  │  no position │
├──────────────────────────────┤
│  Recent trades (5)           │  Trade list + health status row
│  🟢 Redis · 🟢 Postgres · 🟢 Engine │
└──────────────────────────────┘
```

### What stays
- All API routes (used by auto-trader, Telegram bot, engine)
- `/api/health` — health data
- `/api/positions` — open positions
- `/api/chart-data` — equity curve data
- `/api/analytics/journal` — recent trades
- `/api/portfolio` — balance data

### What gets removed from page.tsx
- 3-column grid layout
- AgentFlow, SignalPipeline, ProcessViewer
- PriceChart (candlestick), PnlChart, AiImpactChart, PatternPerformance
- EvolutionPanel, ConfigCard, CostsCard
- PortfolioDonut, RiskMonitor, CorrelationMatrix
- GridManager, DeepValueAlerts, QuickTrade, TankMonitor
- MarketTicker, PriceTicker, SignalValidator
- Dashboard navbar with tabs

### What gets removed as pages
- `/analytics` page (trade journal — available via Telegram /journal)
- `/backtest` page (we run backtests from CLI)

### Component files
- Keep: None of the old components. Write new inline sections in page.tsx.
- The page is simple enough that separate component files add complexity without benefit. Everything in one file (~200 lines).

### Data fetching
- Client-side fetch on mount + 30s polling interval
- Endpoints: `/api/portfolio`, `/api/positions`, `/api/health`, `/api/analytics/journal?days=7`
- Equity curve: `/api/chart-data?type=equity&days=30`

### Styling
- Dark background, glass-morphism cards (existing tailwind theme)
- Single column, mobile-friendly
- No framer-motion animations (unnecessary)
- Recharts for equity curve (already a dependency)

### Dashboard layout
- Replace current dashboard-layout.tsx (navbar, tabs, health pills, WS) with a minimal header: logo text + health dot + UTC clock
- No navigation needed — single page
