# Dashboard v2 — Design

**Date:** 2026-02-20
**Status:** Approved
**Problem:** The current dashboard was built for a 45-symbol, multi-strategy trading system with grid DCA, agent orchestration, and advanced analytics. The system now trades 2 symbols (INJ, ATOM), spot-only, no grid, baseline frozen. The dashboard is 80% dead weight.

## Context

### What the system actually does now

- Trades **INJ/USDC and ATOM/USDC only** (symbol whitelist)
- **Spot-only** mode (no shorting, no margin)
- **Grid trading disabled** (grid_pool_pct = 0)
- **Baseline frozen** (measuring signal quality overhaul impact)
- ~4 trades per symbol per month after HTF veto + multi-TF filtering
- Evolution + AI Brain paused during freeze
- 8 Docker services running (postgres, redis, engine, web, auto-trader, ws-server, telegram-bot, telegram-scraper)

### What the dashboard shows today

- 17 active components across 5 rows in a 3-column grid
- 24 dead/unused components still in codebase
- 27 API routes (many for features not in use)
- AgentFlow architecture diagram, EvolutionPanel, SignalPipeline, ConfigCard, PatternPerformance, AiImpactChart, CostsCard, ProcessViewer — all irrelevant for a quick status glance

### What the user wants

- **Quick status overview** — "Is it running? Do I have positions? Am I making money?" in 10 seconds
- **Single page** — no analytics, no backtest tabs
- **Two charts** — P&L over time + price candlesticks for INJ/ATOM
- **Old dashboard preserved** at `/legacy` route

## Design

### Layout: 4 rows, full width

```
┌─────────────────────────────────────────────────────────────────┐
│ ROW 1: StatusBar (new component)                                │
│ $41.23 (+$0.82) │ INJ $2.34 ▲ │ ATOM $8.71 ▼ │ Frozen 🧊     │
│ 2 open │ 0 pending │ Health 4/4 │ Live │ 14:32 UTC             │
└─────────────────────────────────────────────────────────────────┘

┌────────────────────────────────┬────────────────────────────────┐
│ ROW 2 LEFT: PriceChart         │ ROW 2 RIGHT: Positions + Trades│
│ (reused, INJ/ATOM tabs only)  │ Open positions (reused)         │
│ Candlestick + volume          │ ─────────────────────────       │
│ 15m/1H/4H/1D timeframes      │ Last 5 trades (reused)          │
│                                │                                │
└────────────────────────────────┴────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ ROW 3: P&L Chart (reused, full width)                           │
│ Bar chart per trade + total P&L / best / worst stats            │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ ROW 4: HealthGrid (reused, horizontal)                          │
│ Redis ● 2ms │ Postgres ● 5ms │ Engine ● 12ms │ Binance ● 45ms  │
└─────────────────────────────────────────────────────────────────┘
```

### Component inventory

| Component | Source | Changes |
|-----------|--------|---------|
| **StatusBar** | New | Compact top bar combining portfolio value, coin prices, freeze status, position count, health summary |
| **PriceChart** | Reused from `price-chart.tsx` | Filter symbol selector to INJ/ATOM only (read from config whitelist) |
| **PositionsCard** | Reused from `positions-card.tsx` | No changes needed |
| **TradeActivity** | Reused from `trade-activity.tsx` | No changes needed |
| **PnlChart** | Reused from `pnl-chart.tsx` | No changes, render full width |
| **HealthGrid** | Reused from `health-grid.tsx` | Render as single horizontal row instead of 2x2 grid |
| **DashboardLayout** | Reused from `dashboard-layout.tsx` | Update nav: remove Analytics/Backtest tabs, keep Terminal only |

### New component: StatusBar

Replaces SystemVitals, PortfolioCard, and AgentFlow in a single compact row.

```typescript
// Data sources (existing hooks, no new APIs)
usePortfolio(15000)     // totalValue, dailyPnl
useMultipleTickers()    // INJ, ATOM prices
useAutoTrade(10000)     // positions count, pending signals, daily state
useSystemHealth(30000)  // healthy service count
```

Display as a horizontal bar with pipe-separated sections:

| Section | Data | Format |
|---------|------|--------|
| Portfolio | totalValue + dailyPnl | `$41.23 (+$0.82 +2.0%)` green/red |
| Coin prices | INJ, ATOM current price + 24h% | `INJ $2.34 ▲1.2%` |
| Freeze status | Check `.baseline-frozen` via auto-trade response or static | `Frozen` badge if frozen |
| Positions | Open count / max | `2/2 open` |
| Pending | Pending signal count | `0 pending` |
| Health | Healthy / total | `4/4 healthy` with colored dot |
| Mode | Testnet vs Live | `LIVE` or `TESTNET` badge |
| Clock | UTC time | `14:32 UTC` |

### File changes

```
apps/web/src/app/
  page.tsx                          # REPLACE — new v2 layout (4 rows)
  legacy/
    page.tsx                        # NEW — old page.tsx content moved here

apps/web/src/components/dashboard/
  status-bar.tsx                    # NEW — compact status bar component
  dashboard-layout.tsx              # EDIT — update nav items (remove Analytics, Backtest, add Legacy)
```

### page.tsx (v2)

```tsx
"use client";

import dynamic from 'next/dynamic';
import { DashboardLayout } from '@/components/dashboard/dashboard-layout';
import { StatusBar } from '@/components/dashboard/status-bar';
import { PositionsCard } from '@/components/dashboard/positions-card';
import { HealthGrid } from '@/components/dashboard/health-grid';
import { TradeActivity } from '@/components/dashboard/trade-activity';

const PriceChart = dynamic(
  () => import('@/components/dashboard/price-chart').then(mod => mod.PriceChart),
  { loading: () => <div className="h-[300px] w-full bg-muted/5 animate-pulse rounded-xl" />, ssr: false }
);
const PnlChart = dynamic(
  () => import('@/components/dashboard/pnl-chart').then(mod => mod.PnlChart),
  { loading: () => <div className="h-[160px] w-full bg-muted/5 animate-pulse rounded-xl" />, ssr: false }
);

export default function HomePage() {
  return (
    <DashboardLayout>
      <div className="space-y-2.5">
        {/* Row 1: Status bar */}
        <StatusBar />

        {/* Row 2: Chart + Positions/Trades */}
        <div className="grid grid-cols-12 gap-2.5">
          <div className="col-span-12 lg:col-span-7 min-w-0">
            <PriceChart />
          </div>
          <div className="col-span-12 lg:col-span-5 space-y-2.5">
            <PositionsCard />
            <TradeActivity />
          </div>
        </div>

        {/* Row 3: P&L */}
        <PnlChart />

        {/* Row 4: Health */}
        <HealthGrid />
      </div>
    </DashboardLayout>
  );
}
```

### legacy/page.tsx

Copy of current page.tsx with all 17 components. Accessible at `/legacy`. No other changes.

### Navigation update (dashboard-layout.tsx)

```typescript
// Before
const navItems = [
  { label: 'Terminal', href: '/' },
  { label: 'Analytics', href: '/analytics' },
  { label: 'Backtest', href: '/backtest' },
];

// After
const navItems = [
  { label: 'Terminal', href: '/' },
  { label: 'Legacy', href: '/legacy' },
];
```

Analytics and Backtest pages stay in the codebase (not deleted) but are removed from navigation.

## What is NOT changing

- **No API routes touched** — v2 consumes the same 5 endpoints
- **No hooks changed** — useAutoTrade, usePortfolio, useSystemHealth, useMultipleTickers all stay
- **No components deleted** — dead components stay in codebase, just unused
- **Analytics/Backtest pages stay** — still accessible by URL, just not in nav
- **Theme/styling unchanged** — same glass morphism, glow effects, dark mode
- **No backend changes** — same Docker services, same data flow

## API surface (v2 only uses these)

| Endpoint | Refresh | Consumer |
|----------|---------|----------|
| `/api/portfolio` | 15s | StatusBar |
| `/api/market?action=tickers` | 5s | StatusBar |
| `/api/auto-trade` | 10s | StatusBar, PositionsCard, TradeActivity |
| `/api/health` | 30s | StatusBar, HealthGrid, DashboardLayout |
| `/api/chart-data?action=candles` | 60s | PriceChart |
| `/api/chart-data?action=pnl` | 60s | PnlChart |
| `ws://localhost:3004` | realtime | TradeActivity, DashboardLayout |

Total: 5 REST endpoints + 1 WebSocket. Down from 27 endpoints rendered on the old dashboard.

## Verification

1. `/` shows v2 dashboard with 4 rows, 7 components
2. `/legacy` shows old dashboard with all 17 components
3. StatusBar shows correct portfolio value, coin prices, position count
4. PriceChart only shows INJ/ATOM in symbol selector
5. PositionsCard shows open positions (or empty state)
6. PnlChart renders trade P&L bars
7. HealthGrid shows all 4 services
8. No console errors, no broken API calls
9. Mobile responsive (stacks to single column)

## Migration path

1. Build v2 alongside old dashboard (no risk)
2. Test on `/` — if broken, old dashboard at `/legacy` as fallback
3. Once stable, optionally delete `/legacy` and dead components in a future cleanup
