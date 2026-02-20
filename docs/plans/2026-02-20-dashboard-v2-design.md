# Dashboard v2 — Design

**Date:** 2026-02-20
**Status:** Approved
**Problem:** The dashboard was built for a 45-symbol, multi-strategy system with grid DCA, agent orchestration, and advanced analytics. The system now trades 2 symbols (INJ, ATOM) on a $40 spot-only account. The dashboard is 80% dead weight.

## Goal

Replace the overbuilt 3-column, 17-component dashboard with a single-page, single-column layout. One file. ~200 lines. Honest about what the system actually is.

## Layout

```
┌──────────────────────────────┐
│  CRYONIX          🟢  22:35  │  Minimal header: logo + health dot + UTC clock
├──────────────────────────────┤
│                              │
│       $40.22                 │  Balance card: big number, daily + 7d P&L
│    +$0.10 today (+0.25%)     │  Freeze badge if baseline frozen
│    +$1.20 / 7d              │
│                              │
├──────────────────────────────┤
│                              │
│   ───╱──╲───╱────           │  Equity curve: 30d line chart (Recharts)
│                              │
├──────────────────────────────┤
│  INJ +0.8%    │  ATOM  —     │  Position cards: side by side
│  $2.45→$2.47  │  no position │  Entry, current, SL, P&L per position
│  SL $2.10     │              │
├──────────────────────────────┤
│  Recent trades (5)           │  Last 5 closed trades: symbol, P&L, time
│  INJ +$0.12 · ATOM -$0.05   │
├──────────────────────────────┤
│  🟢 Redis  🟢 Postgres       │  Health: single row of status dots
│  🟢 Engine 🟢 Binance        │
└──────────────────────────────┘
```

## Decisions

### Why single-column, not 2-column
The system trades 4 times per month. A candlestick chart for that is a Bloomberg terminal for a savings account. The equity curve shows the trend — that's enough. Single column is mobile-first and honest about the data density.

### Why one file, not 7 components
With 5 sections and ~200 lines, separate component files add folder complexity without benefit. Each section is 20-40 lines. If it grows beyond 300 lines, refactor then.

### Why reuse hooks, not raw fetch
The existing hooks (usePortfolio, useAutoTrade, useSystemHealth) have error handling, caching, and refresh intervals already tested in production. Rewriting fetch+polling from scratch is unnecessary work.

### Why keep /legacy
The old dashboard moves to `/legacy/page.tsx` — costs nothing, provides a fallback. If the new dashboard breaks, `/legacy` works instantly. Delete it later when v2 is stable.

### Why no candlestick chart
You check prices on Telegram. You trade 4 times/month. The candlestick chart was the heaviest component (lightweight-charts library, 277 lines). The equity curve tells you if the system is making money — that's what matters.

### Why no animations
Framer Motion added visual polish to the old dashboard but serves no purpose on a status-glance page. Removing it simplifies the bundle and the code.

## Implementation

### New file: `apps/web/src/app/page.tsx` (~200 lines)

All sections inline. Uses existing hooks for data. Recharts for the equity curve (already a dependency).

```tsx
"use client";

import { usePortfolio } from '@/hooks/use-portfolio';
import { useAutoTrade } from '@/hooks/use-auto-trade';
import { useSystemHealth } from '@/hooks/use-system-health';
import { useEffect, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

export default function HomePage() {
  // Data from existing hooks
  const { data: portfolio } = usePortfolio(15000);
  const { data: autoTrade } = useAutoTrade(10000);
  const { data: health } = useSystemHealth(30000);

  // Equity curve: fetch on mount + 60s refresh
  const [equity, setEquity] = useState([]);
  useEffect(() => {
    const load = () => fetch('/api/chart-data?action=pnl')
      .then(r => r.json()).then(setEquity).catch(() => {});
    load();
    const id = setInterval(load, 60000);
    return () => clearInterval(id);
  }, []);

  // Recent trades: fetch from journal
  const [trades, setTrades] = useState([]);
  useEffect(() => {
    const load = () => fetch('/api/analytics/journal?days=7')
      .then(r => r.json()).then(d => setTrades(d.trades?.slice(0, 5) || []))
      .catch(() => {});
    load();
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="min-h-screen bg-background text-foreground p-4 max-w-2xl mx-auto space-y-4">
      {/* Header */}
      {/* Balance Card */}
      {/* Equity Curve */}
      {/* Position Cards */}
      {/* Recent Trades */}
      {/* Health Row */}
    </div>
  );
}
```

### 5 inline sections

**1. Header** (~10 lines)
- Logo text "CRYONIX"
- Health dot: green if all services healthy, amber if degraded, red if any down
- UTC clock (simple `useState` + `setInterval`)

**2. Balance Card** (~30 lines)
- `portfolio.totalValue` as large number with cyan glow
- Daily P&L from `autoTrade.dailyState` (green/red)
- 7-day P&L from journal data
- "FROZEN" badge if `autoTrade.config?.baseline?.frozen`

**3. Equity Curve** (~30 lines)
- Recharts `LineChart` with `ResponsiveContainer`
- Data from `/api/chart-data?action=pnl` (cumulative P&L over time)
- Minimal styling: single cyan line, no grid, no legend
- Height: 160px

**4. Position Cards** (~40 lines)
- 2-column grid: one card per whitelist symbol (INJ, ATOM)
- If position open: symbol, entry price, current price, SL, unrealized P&L (green/red)
- If no position: symbol + "No position" muted text
- Data from `autoTrade.positions`

**5. Recent Trades** (~30 lines)
- List of last 5 closed trades
- Per trade: symbol, side badge, P&L amount (green/red), relative time ("2h ago")
- Data from `/api/analytics/journal?days=7`

**6. Health Row** (~20 lines)
- Horizontal row of service dots with labels
- Redis, Postgres, Engine, Binance
- Green/amber/red based on `health.services[].status`

### Moved file: `apps/web/src/app/legacy/page.tsx`

Current `page.tsx` content (all 17 components, 3-column layout) moved here unchanged. Accessible at `/legacy`.

### Edit: `apps/web/src/components/dashboard/dashboard-layout.tsx`

Update navigation:
```typescript
// Before
{ label: 'Terminal', href: '/' },
{ label: 'Analytics', href: '/analytics' },
{ label: 'Backtest', href: '/backtest' },

// After
{ label: 'Terminal', href: '/' },
{ label: 'Legacy', href: '/legacy' },
```

Note: The new `page.tsx` does NOT use `DashboardLayout` — it has its own minimal header. But the legacy page still imports it, and navigating to `/legacy` still shows the old chrome.

### No changes to:

- API routes (all 27 stay, used by auto-trader/Telegram/engine)
- Hooks (reused as-is)
- Component files (stay in codebase, just not imported by new page.tsx)
- Analytics/Backtest pages (still accessible by URL)
- Backend services
- Theme CSS (glass-morphism classes still available)

## Data flow

```
page.tsx
  ├─ usePortfolio(15s)      → /api/portfolio      → Balance card
  ├─ useAutoTrade(10s)       → /api/auto-trade     → Balance (daily P&L), Positions
  ├─ useSystemHealth(30s)    → /api/health          → Header dot, Health row
  ├─ fetch('/api/chart-data?action=pnl', 60s)      → Equity curve
  └─ fetch('/api/analytics/journal?days=7', 30s)    → Recent trades
```

5 endpoints total. No WebSocket needed (30s polling is fine for a status glance).

## File summary

| File | Action | Lines |
|------|--------|-------|
| `apps/web/src/app/page.tsx` | **Replace** | ~200 |
| `apps/web/src/app/legacy/page.tsx` | **Create** (move old page.tsx) | ~115 |
| `apps/web/src/components/dashboard/dashboard-layout.tsx` | **Edit** nav items | ~3 lines changed |

Total: 1 new file, 1 moved file, 1 small edit. ~200 lines of new code.

## Verification

1. `/` shows new single-column dashboard with 6 sections
2. `/legacy` shows old 17-component dashboard
3. Balance card shows correct portfolio value and daily P&L
4. Equity curve renders 30d P&L trend line
5. Position cards show INJ + ATOM status (open or empty)
6. Recent trades list shows last 5 closed trades
7. Health row shows 4 service dots with correct status
8. Mobile: stacks cleanly on small screens (already single-column)
9. No console errors, no broken API calls
10. Page loads in <1s (no heavyweight chart libraries)
