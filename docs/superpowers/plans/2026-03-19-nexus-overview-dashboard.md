# Nexus Overview Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a unified overview page (`/overview`) that aggregates and visualizes performance data from all 7 trading instances (Cryonix, Vedic, Aktienix, Solanix, Polynix, Copynix, Ψnix) with rich charts, data visualizations, and a command-center feel.

**Architecture:** A new Next.js page at `/overview` with a server-side aggregation API route (`/api/overview`) that fetches from all existing per-instance API routes in parallel. Frontend uses Recharts (already in the project) for charts and a card-grid layout. Each instance gets a performance card with sparkline + KPIs. A top summary row shows total portfolio value, blended win rate, and daily P&L across all instances.

**Tech Stack:** Next.js 15, React 19, Tailwind CSS, Recharts (already installed), shadcn/ui components, existing per-instance API routes

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `apps/web/src/app/api/overview/route.ts` | Aggregation API — fetches all instance APIs in parallel, returns unified payload |
| Create | `apps/web/src/app/overview/page.tsx` | Overview page — layout + data fetching |
| Create | `apps/web/src/components/overview/portfolio-summary.tsx` | Top row: total portfolio, daily P&L, blended win rate, instance count |
| Create | `apps/web/src/components/overview/instance-card.tsx` | Per-instance performance card with sparkline + KPIs |
| Create | `apps/web/src/components/overview/equity-comparison-chart.tsx` | Multi-line equity curve comparing all instances |
| Create | `apps/web/src/components/overview/signal-activity-feed.tsx` | Unified recent signals/trades feed across instances |
| Create | `apps/web/src/components/overview/system-health-grid.tsx` | Health status grid for all services |
| Create | `apps/web/src/hooks/useOverview.ts` | SWR hook for `/api/overview` with auto-refresh |
| Modify | `apps/web/src/components/dashboard/dashboard-layout.tsx` | Add Overview to NAV_GROUPS as first item in cryonix group |
| Modify | `apps/web/src/components/command-palette.tsx` | Add Overview to command palette |

---

### Task 1: Aggregation API Route

**Files:**
- Create: `apps/web/src/app/api/overview/route.ts`

This API route fetches data from all existing per-instance APIs in parallel and returns a unified payload. It uses internal fetch to `localhost:3000` since all API routes are in the same Next.js app.

- [ ] **Step 1: Create the aggregation API route**

```typescript
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

interface InstanceData {
  id: string;
  label: string;
  accent: string;
  status: 'online' | 'offline' | 'degraded';
  portfolioValue: number;
  dailyPnl: number;
  dailyPnlPct: number;
  totalPnl: number;
  winRate: number;
  totalTrades: number;
  openPositions: number;
  maxPositions: number;
  recentTrades: Array<{
    symbol: string;
    side: string;
    pnl: number;
    timestamp: string;
  }>;
  equityCurve: Array<{ date: string; value: number }>;
}

interface OverviewPayload {
  timestamp: string;
  totalPortfolioValue: number;
  totalDailyPnl: number;
  blendedWinRate: number;
  instancesOnline: number;
  instancesTotal: number;
  instances: InstanceData[];
}

const BASE_URL = process.env.NEXTJS_API_URL || 'http://localhost:3000';

async function safeFetch(url: string, timeoutMs = 5000): Promise<any> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function fetchCryonix(): Promise<InstanceData> {
  const [portfolio, autoTrade, journal] = await Promise.all([
    safeFetch(`${BASE_URL}/api/portfolio`),
    safeFetch(`${BASE_URL}/api/auto-trade`),
    safeFetch(`${BASE_URL}/api/analytics/journal?days=30`),
  ]);

  const positions = autoTrade?.positions ?? [];
  const summary = journal?.summary ?? {};
  const equityData = journal?.journal?.map((t: any) => ({
    date: t.closedAt?.split('T')[0] ?? '',
    value: t.cumulativePnl ?? 0,
  })) ?? [];

  return {
    id: 'cryonix',
    label: 'CRYONIX',
    accent: 'cyan',
    status: portfolio ? 'online' : 'offline',
    portfolioValue: portfolio?.totalValue ?? 0,
    dailyPnl: autoTrade?.dailyState?.dailyPnl ?? 0,
    dailyPnlPct: autoTrade?.dailyState?.dailyPnlPct ?? 0,
    totalPnl: summary.totalPnl ?? 0,
    winRate: summary.winRate ?? 0,
    totalTrades: summary.totalTrades ?? 0,
    openPositions: positions.length,
    maxPositions: 3,
    recentTrades: (journal?.journal ?? []).slice(0, 5).map((t: any) => ({
      symbol: t.symbol,
      side: t.side ?? 'BUY',
      pnl: t.pnl ?? 0,
      timestamp: t.closedAt ?? t.openedAt ?? '',
    })),
    equityCurve: equityData,
  };
}

async function fetchVedic(): Promise<InstanceData> {
  const [status, trades] = await Promise.all([
    safeFetch(`${BASE_URL}/api/vedic/status`),
    safeFetch(`${BASE_URL}/api/vedic/trades`),
  ]);

  // Response shape: { scout, moon, planets, trader, btd, futures, bayes, timestamp }
  const trader = status?.trader ?? {};
  const btd = status?.btd ?? {};
  const futures = status?.futures ?? {};
  const totalBalance = (trader.balance ?? 0) + (btd.balance ?? 0) + (futures.balance ?? 0);
  const totalPnl = (trader.totalPnl ?? 0) + (btd.totalPnl ?? 0) + (futures.totalPnl ?? 0);
  const totalTrades = (trader.trades ?? 0) + (btd.trades ?? 0) + (futures.trades ?? 0);
  const totalWins = (trader.wins ?? 0) + (btd.wins ?? 0) + (futures.wins ?? 0);
  const openPositions = (trader.openPositions ?? 0) + (btd.openPositions ?? 0) + (futures.openPositions ?? 0);

  return {
    id: 'vedic',
    label: 'VEDIC',
    accent: 'purple',
    status: status?.scout?.running ? 'online' : 'offline',
    portfolioValue: totalBalance,
    dailyPnl: 0,
    dailyPnlPct: 0,
    totalPnl,
    winRate: totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0,
    totalTrades,
    openPositions,
    maxPositions: 10,
    recentTrades: (trades?.trades ?? []).slice(0, 5).map((t: any) => ({
      symbol: t.base_asset ?? t.symbol ?? '',
      side: t.action ?? 'BUY',
      pnl: t.pnl ?? 0,
      timestamp: t.timestamp ?? '',
    })),
    equityCurve: [],
  };
}

async function fetchAktienix(): Promise<InstanceData> {
  const [portfolio, trades] = await Promise.all([
    safeFetch(`${BASE_URL}/api/aktienix/portfolio`),
    safeFetch(`${BASE_URL}/api/aktienix/trades?limit=20`),
  ]);

  // Portfolio response: { portfolioValue, buyingPower, settledCash, dailyPnl, dailyPnlPct }
  // Trades summary: { total, winRate (0-1 ratio), totalPnl }
  const summary = trades?.summary ?? {};

  return {
    id: 'aktienix',
    label: 'AKTIENIX',
    accent: 'violet',
    status: portfolio ? 'online' : 'offline',
    portfolioValue: portfolio?.portfolioValue ?? 0,
    dailyPnl: portfolio?.dailyPnl ?? 0,
    dailyPnlPct: portfolio?.dailyPnlPct ?? 0,
    totalPnl: summary.totalPnl ?? 0,
    winRate: (summary.winRate ?? 0) * 100, // API returns 0-1 ratio, normalize to 0-100
    totalTrades: summary.total ?? 0,
    openPositions: 0, // portfolio route does not include positions count
    maxPositions: 5,
    recentTrades: (trades?.trades ?? []).slice(0, 5).map((t: any) => ({
      symbol: t.symbol ?? '',
      side: t.side ?? 'BUY',
      pnl: t.realizedPnl ?? 0,
      timestamp: t.timestamp ?? '',
    })),
    equityCurve: [],
  };
}

async function fetchSolanix(): Promise<InstanceData> {
  const [data, positions] = await Promise.all([
    safeFetch(`${BASE_URL}/api/solanix/status`),
    safeFetch(`${BASE_URL}/api/solanix/positions`),
  ]);

  // Response: { status: string|null, account: object|null, risk, shadows, timestamp }
  const account = data?.account ?? {};

  return {
    id: 'solanix',
    label: 'SOLANIX',
    accent: 'amber',
    status: data?.status === 'running' ? 'online' : 'offline',
    portfolioValue: account.portfolioValue ?? account.portfolio_value ?? 0,
    dailyPnl: account.dailyPnl ?? account.daily_pnl ?? 0,
    dailyPnlPct: account.dailyPnlPct ?? 0,
    totalPnl: account.totalPnl ?? account.total_pnl ?? 0,
    winRate: account.winRate ?? 0,
    totalTrades: account.totalTrades ?? 0,
    openPositions: (positions?.positions ?? []).length,
    maxPositions: 5,
    recentTrades: [],
    equityCurve: [],
  };
}

async function fetchPolynix(): Promise<InstanceData> {
  const [data, trades] = await Promise.all([
    safeFetch(`${BASE_URL}/api/polynix/status`),
    safeFetch(`${BASE_URL}/api/polynix/trades`),
  ]);

  // Response: { status, agent: { running, paperTrading }, account, risk, lastSignal, timestamp }
  const account = data?.account ?? {};

  return {
    id: 'polynix',
    label: 'POLYNIX',
    accent: 'orange',
    status: data?.agent?.running ? 'online' : 'offline',
    portfolioValue: account.balance ?? 0,
    dailyPnl: data?.risk?.daily_pnl ?? data?.risk?.dailyPnl ?? 0,
    dailyPnlPct: 0,
    totalPnl: account.total_pnl ?? account.totalPnl ?? 0,
    winRate: account.winRate ?? 0,
    totalTrades: account.trades ?? 0,
    openPositions: account.openBets ?? 0,
    maxPositions: 10,
    recentTrades: (trades?.trades ?? []).slice(0, 5).map((t: any) => ({
      symbol: t.asset ?? t.market_title ?? '',
      side: t.side ?? 'YES',
      pnl: t.realized_pnl ?? t.realizedPnl ?? 0,
      timestamp: t.settled_at ?? '',
    })),
    equityCurve: [],
  };
}

async function fetchCopynix(): Promise<InstanceData> {
  const [data, trades] = await Promise.all([
    safeFetch(`${BASE_URL}/api/copynix/status`),
    safeFetch(`${BASE_URL}/api/copynix/trades?limit=20`),
  ]);

  // Response: { status, paperTrading, trackedWallets, portfolioValue (top-level!),
  //             totalPositions, tradesToday, account, risk, timestamp }
  const summary = trades?.summary ?? {};

  return {
    id: 'copynix',
    label: 'COPYNIX',
    accent: 'cyan',
    status: data?.status === 'running' ? 'online' : 'offline',
    portfolioValue: data?.portfolioValue ?? 0, // top-level field, not inside account
    dailyPnl: data?.risk?.dailyPnlDollar ?? 0,
    dailyPnlPct: 0,
    totalPnl: summary.totalPnl ?? 0,
    winRate: summary.winRate ?? 0,
    totalTrades: summary.totalTrades ?? 0,
    openPositions: data?.totalPositions ?? 0,
    maxPositions: 5,
    recentTrades: (trades?.trades ?? []).slice(0, 5).map((t: any) => ({
      symbol: t.symbol ?? '',
      side: t.side ?? 'BUY',
      pnl: t.realized_pnl ?? t.realizedPnl ?? 0,
      timestamp: t.timestamp ?? '',
    })),
    equityCurve: trades?.equityCurve ?? [],
  };
}

async function fetchPsinix(): Promise<InstanceData> {
  const [data, trades] = await Promise.all([
    safeFetch(`${BASE_URL}/api/psinix/status`),
    safeFetch(`${BASE_URL}/api/psinix/trades?limit=20`),
  ]);

  // Response: raw Redis 'psinix:state' pass-through, or { status: 'offline' }
  const isOnline = data && data.status !== 'offline';
  const summary = trades?.summary ?? {};

  return {
    id: 'psinix',
    label: 'ΨNIX',
    accent: 'violet',
    status: isOnline ? 'online' : 'offline',
    portfolioValue: data?.portfolioValue ?? data?.portfolio_value ?? 0,
    dailyPnl: 0,
    dailyPnlPct: 0,
    totalPnl: data?.total_pnl ?? data?.totalPnl ?? summary.totalPnl ?? 0,
    winRate: data?.winRate != null ? data.winRate : (summary.winRate ?? 0),
    totalTrades: (data?.wins ?? 0) + (data?.losses ?? 0) || (summary.total ?? 0),
    openPositions: data?.positions ?? 0,
    maxPositions: 3,
    recentTrades: (trades?.trades ?? []).slice(0, 5).map((t: any) => ({
      symbol: t.symbol ?? '',
      side: t.side ?? 'BUY',
      pnl: t.realized_pnl ?? t.realizedPnl ?? 0,
      timestamp: t.timestamp ?? '',
    })),
    equityCurve: [],
  };
}

export async function GET() {
  const instances = await Promise.all([
    fetchCryonix(),
    fetchVedic(),
    fetchAktienix(),
    fetchSolanix(),
    fetchPolynix(),
    fetchCopynix(),
    fetchPsinix(),
  ]);

  const totalPortfolioValue = instances.reduce((sum, i) => sum + i.portfolioValue, 0);
  const totalDailyPnl = instances.reduce((sum, i) => sum + i.dailyPnl, 0);
  const totalTrades = instances.reduce((sum, i) => sum + i.totalTrades, 0);
  const weightedWinRate = totalTrades > 0
    ? instances.reduce((sum, i) => sum + i.winRate * i.totalTrades, 0) / totalTrades
    : 0;
  const instancesOnline = instances.filter(i => i.status === 'online').length;

  const payload: OverviewPayload = {
    timestamp: new Date().toISOString(),
    totalPortfolioValue,
    totalDailyPnl,
    blendedWinRate: weightedWinRate,
    instancesOnline,
    instancesTotal: instances.length,
    instances,
  };

  return NextResponse.json(payload);
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd apps/web && npx tsc --noEmit 2>&1 | tail -20`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/api/overview/route.ts
git commit -m "feat(overview): add aggregation API route for all instances"
```

---

### Task 2: useOverview Hook

**Files:**
- Create: `apps/web/src/hooks/useOverview.ts`

- [ ] **Step 1: Create the SWR-style polling hook**

```typescript
"use client";

import { useState, useEffect, useCallback } from 'react';

interface InstanceData {
  id: string;
  label: string;
  accent: string;
  status: 'online' | 'offline' | 'degraded';
  portfolioValue: number;
  dailyPnl: number;
  dailyPnlPct: number;
  totalPnl: number;
  winRate: number;
  totalTrades: number;
  openPositions: number;
  maxPositions: number;
  recentTrades: Array<{
    symbol: string;
    side: string;
    pnl: number;
    timestamp: string;
  }>;
  equityCurve: Array<{ date: string; value: number }>;
}

interface OverviewData {
  timestamp: string;
  totalPortfolioValue: number;
  totalDailyPnl: number;
  blendedWinRate: number;
  instancesOnline: number;
  instancesTotal: number;
  instances: InstanceData[];
}

export function useOverview(refreshInterval = 30000) {
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/overview');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, refreshInterval);
    return () => clearInterval(id);
  }, [fetchData, refreshInterval]);

  return { data, loading, error, refetch: fetchData };
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/hooks/useOverview.ts
git commit -m "feat(overview): add useOverview polling hook"
```

---

### Task 3: Portfolio Summary Component

**Files:**
- Create: `apps/web/src/components/overview/portfolio-summary.tsx`

- [ ] **Step 1: Create the top-row summary component**

```tsx
"use client";

interface PortfolioSummaryProps {
  totalValue: number;
  dailyPnl: number;
  blendedWinRate: number;
  instancesOnline: number;
  instancesTotal: number;
}

export function PortfolioSummary({
  totalValue,
  dailyPnl,
  blendedWinRate,
  instancesOnline,
  instancesTotal,
}: PortfolioSummaryProps) {
  const pnlColor = dailyPnl >= 0 ? 'text-emerald-400' : 'text-red-400';
  const pnlPrefix = dailyPnl >= 0 ? '+' : '';

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {/* Total Portfolio */}
      <div className="glass-card rounded-xl p-4 border border-border/20">
        <p className="text-[10px] font-mono text-muted-foreground/60 tracking-widest uppercase mb-1">
          Total Portfolio
        </p>
        <p className="text-2xl font-bold font-mono tabular-nums text-foreground">
          ${totalValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </p>
      </div>

      {/* Daily P&L */}
      <div className="glass-card rounded-xl p-4 border border-border/20">
        <p className="text-[10px] font-mono text-muted-foreground/60 tracking-widest uppercase mb-1">
          Daily P&L
        </p>
        <p className={`text-2xl font-bold font-mono tabular-nums ${pnlColor}`}>
          {pnlPrefix}${Math.abs(dailyPnl).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </p>
      </div>

      {/* Blended Win Rate */}
      <div className="glass-card rounded-xl p-4 border border-border/20">
        <p className="text-[10px] font-mono text-muted-foreground/60 tracking-widest uppercase mb-1">
          Win Rate
        </p>
        <p className="text-2xl font-bold font-mono tabular-nums text-foreground">
          {blendedWinRate.toFixed(1)}%
        </p>
      </div>

      {/* Instances Online */}
      <div className="glass-card rounded-xl p-4 border border-border/20">
        <p className="text-[10px] font-mono text-muted-foreground/60 tracking-widest uppercase mb-1">
          Instances
        </p>
        <p className="text-2xl font-bold font-mono tabular-nums text-foreground">
          <span className="text-emerald-400">{instancesOnline}</span>
          <span className="text-muted-foreground/40">/{instancesTotal}</span>
        </p>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/overview/portfolio-summary.tsx
git commit -m "feat(overview): add PortfolioSummary top-row component"
```

---

### Task 4: Instance Card Component

**Files:**
- Create: `apps/web/src/components/overview/instance-card.tsx`

- [ ] **Step 1: Create the per-instance card with sparkline**

```tsx
"use client";

import Link from 'next/link';
import { Area, AreaChart, ResponsiveContainer } from 'recharts';

const ACCENT_COLORS: Record<string, { text: string; dot: string; chart: string; glow: string }> = {
  cyan:   { text: 'text-primary',     dot: 'bg-primary',     chart: 'hsl(191, 100%, 50%)', glow: 'shadow-[0_0_12px_hsl(191,100%,50%,0.15)]' },
  purple: { text: 'text-purple-400',  dot: 'bg-purple-400',  chart: 'hsl(270, 80%, 70%)',  glow: 'shadow-[0_0_12px_rgba(192,132,252,0.15)]' },
  violet: { text: 'text-violet-400',  dot: 'bg-violet-400',  chart: 'hsl(258, 90%, 66%)',  glow: 'shadow-[0_0_12px_rgba(167,139,250,0.15)]' },
  amber:  { text: 'text-amber-400',   dot: 'bg-amber-400',   chart: 'hsl(38, 92%, 50%)',   glow: 'shadow-[0_0_12px_rgba(251,191,36,0.15)]' },
  orange: { text: 'text-orange-400',  dot: 'bg-orange-400',  chart: 'hsl(25, 95%, 53%)',   glow: 'shadow-[0_0_12px_rgba(251,146,60,0.15)]' },
};

const INSTANCE_ROUTES: Record<string, string> = {
  cryonix: '/',
  vedic: '/vedic',
  aktienix: '/aktienix',
  solanix: '/solanix',
  polynix: '/polynix',
  copynix: '/copynix',
  psinix: '/psinix',
};

interface InstanceCardProps {
  id: string;
  label: string;
  accent: string;
  status: 'online' | 'offline' | 'degraded';
  portfolioValue: number;
  dailyPnl: number;
  totalPnl: number;
  winRate: number;
  totalTrades: number;
  openPositions: number;
  maxPositions: number;
  equityCurve: Array<{ date: string; value: number }>;
}

export function InstanceCard({
  id, label, accent, status, portfolioValue, dailyPnl, totalPnl,
  winRate, totalTrades, openPositions, maxPositions, equityCurve,
}: InstanceCardProps) {
  const colors = ACCENT_COLORS[accent] ?? ACCENT_COLORS.cyan;
  const route = INSTANCE_ROUTES[id] ?? '/';
  const pnlColor = totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400';
  const dailyColor = dailyPnl >= 0 ? 'text-emerald-400' : 'text-red-400';

  return (
    <Link href={route}>
      <div className={`glass-card rounded-xl p-4 border border-border/20 hover:border-border/40 transition-all cursor-pointer group ${colors.glow}`}>
        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${status === 'online' ? colors.dot : status === 'degraded' ? 'bg-amber-400' : 'bg-zinc-500'} ${status === 'online' ? 'animate-pulse-dot' : ''}`} />
            <span className={`text-xs font-bold font-mono tracking-wider ${colors.text}`}>{label}</span>
          </div>
          <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded ${
            status === 'online' ? 'bg-emerald-400/10 text-emerald-400' :
            status === 'degraded' ? 'bg-amber-400/10 text-amber-400' :
            'bg-zinc-500/10 text-zinc-500'
          }`}>
            {status.toUpperCase()}
          </span>
        </div>

        {/* Sparkline */}
        {equityCurve.length > 2 && (
          <div className="h-12 mb-3 -mx-1">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={equityCurve}>
                <defs>
                  <linearGradient id={`grad-${id}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={colors.chart} stopOpacity={0.3} />
                    <stop offset="100%" stopColor={colors.chart} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <Area
                  type="monotone"
                  dataKey="value"
                  stroke={colors.chart}
                  strokeWidth={1.5}
                  fill={`url(#grad-${id})`}
                  dot={false}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* KPIs */}
        <div className="grid grid-cols-2 gap-y-2 gap-x-4">
          <div>
            <p className="text-[8px] font-mono text-muted-foreground/50 uppercase">Portfolio</p>
            <p className="text-sm font-mono font-semibold tabular-nums">${portfolioValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
          </div>
          <div>
            <p className="text-[8px] font-mono text-muted-foreground/50 uppercase">Total P&L</p>
            <p className={`text-sm font-mono font-semibold tabular-nums ${pnlColor}`}>
              {totalPnl >= 0 ? '+' : ''}${Math.abs(totalPnl).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </p>
          </div>
          <div>
            <p className="text-[8px] font-mono text-muted-foreground/50 uppercase">Win Rate</p>
            <p className="text-sm font-mono font-semibold tabular-nums">{winRate.toFixed(1)}%</p>
          </div>
          <div>
            <p className="text-[8px] font-mono text-muted-foreground/50 uppercase">Positions</p>
            <p className="text-sm font-mono font-semibold tabular-nums">
              {openPositions}<span className="text-muted-foreground/40">/{maxPositions}</span>
            </p>
          </div>
        </div>

        {/* Daily P&L footer */}
        <div className="mt-3 pt-2 border-t border-border/15 flex items-center justify-between">
          <span className="text-[9px] font-mono text-muted-foreground/45">Today</span>
          <span className={`text-xs font-mono font-semibold tabular-nums ${dailyColor}`}>
            {dailyPnl >= 0 ? '+' : ''}${Math.abs(dailyPnl).toFixed(2)}
          </span>
        </div>
      </div>
    </Link>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/overview/instance-card.tsx
git commit -m "feat(overview): add InstanceCard with sparkline and KPIs"
```

---

### Task 5: System Health Grid

**Files:**
- Create: `apps/web/src/components/overview/system-health-grid.tsx`

- [ ] **Step 1: Create the health status grid**

```tsx
"use client";

interface SystemHealthGridProps {
  instances: Array<{
    id: string;
    label: string;
    accent: string;
    status: 'online' | 'offline' | 'degraded';
    openPositions: number;
    totalTrades: number;
  }>;
}

export function SystemHealthGrid({ instances }: SystemHealthGridProps) {
  const online = instances.filter(i => i.status === 'online').length;

  return (
    <div className="glass-card rounded-xl p-4 border border-border/20">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-mono font-bold text-muted-foreground/70 tracking-widest uppercase">
          System Health
        </h3>
        <span className={`text-[9px] font-mono px-2 py-0.5 rounded ${
          online === instances.length ? 'bg-emerald-400/10 text-emerald-400' : 'bg-amber-400/10 text-amber-400'
        }`}>
          {online}/{instances.length} ONLINE
        </span>
      </div>

      <div className="grid grid-cols-7 gap-1.5">
        {instances.map((inst) => (
          <div key={inst.id} className="flex flex-col items-center gap-1 p-2 rounded-lg bg-muted/10">
            <span className={`h-2.5 w-2.5 rounded-full ${
              inst.status === 'online' ? 'bg-emerald-400 animate-pulse-dot' :
              inst.status === 'degraded' ? 'bg-amber-400' : 'bg-zinc-500'
            }`} />
            <span className="text-[8px] font-mono font-bold text-muted-foreground/60 tracking-wider">
              {inst.label.slice(0, 3)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/overview/system-health-grid.tsx
git commit -m "feat(overview): add SystemHealthGrid component"
```

---

### Task 6: Signal Activity Feed

**Files:**
- Create: `apps/web/src/components/overview/signal-activity-feed.tsx`

- [ ] **Step 1: Create unified trade/signal feed**

```tsx
"use client";

const ACCENT_MAP: Record<string, string> = {
  cryonix: 'text-primary',
  vedic: 'text-purple-400',
  aktienix: 'text-violet-400',
  solanix: 'text-amber-400',
  polynix: 'text-orange-400',
  copynix: 'text-cyan-400',
  psinix: 'text-violet-400',
};

interface Trade {
  symbol: string;
  side: string;
  pnl: number;
  timestamp: string;
  instanceId: string;
  instanceLabel: string;
}

interface SignalActivityFeedProps {
  instances: Array<{
    id: string;
    label: string;
    recentTrades: Array<{
      symbol: string;
      side: string;
      pnl: number;
      timestamp: string;
    }>;
  }>;
}

function timeAgo(ts: string): string {
  if (!ts) return '';
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

export function SignalActivityFeed({ instances }: SignalActivityFeedProps) {
  // Merge all trades, sort by timestamp descending, take top 15
  const allTrades: Trade[] = instances
    .flatMap(inst =>
      inst.recentTrades.map(t => ({
        ...t,
        instanceId: inst.id,
        instanceLabel: inst.label,
      }))
    )
    .filter(t => t.timestamp)
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, 15);

  return (
    <div className="glass-card rounded-xl p-4 border border-border/20">
      <h3 className="text-xs font-mono font-bold text-muted-foreground/70 tracking-widest uppercase mb-3">
        Recent Activity
      </h3>

      {allTrades.length === 0 ? (
        <p className="text-xs text-muted-foreground/40 font-mono">No recent trades</p>
      ) : (
        <div className="space-y-1.5 max-h-[300px] overflow-y-auto scrollbar-none">
          {allTrades.map((trade, i) => (
            <div key={`${trade.instanceId}-${trade.timestamp}-${i}`} className="flex items-center gap-2 py-1.5 px-2 rounded-md hover:bg-muted/10 transition-colors">
              <span className={`text-[8px] font-mono font-bold tracking-wider ${ACCENT_MAP[trade.instanceId] ?? 'text-muted-foreground'}`}>
                {trade.instanceLabel.slice(0, 3)}
              </span>
              <span className={`text-[9px] font-mono font-medium px-1 py-0.5 rounded ${
                trade.side === 'SELL' ? 'bg-purple-500/10 text-purple-400' : 'bg-emerald-500/10 text-emerald-400'
              }`}>
                {trade.side}
              </span>
              <span className="text-xs font-mono font-medium text-foreground/80 flex-1">{trade.symbol}</span>
              {trade.pnl !== 0 && (
                <span className={`text-xs font-mono tabular-nums font-semibold ${trade.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {trade.pnl >= 0 ? '+' : ''}${trade.pnl.toFixed(2)}
                </span>
              )}
              <span className="text-[9px] font-mono text-muted-foreground/35 tabular-nums w-6 text-right">
                {timeAgo(trade.timestamp)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/overview/signal-activity-feed.tsx
git commit -m "feat(overview): add unified SignalActivityFeed"
```

---

### Task 7: Overview Page

**Files:**
- Create: `apps/web/src/app/overview/page.tsx`

- [ ] **Step 1: Create the overview page**

```tsx
"use client";

import { DashboardLayout } from '@/components/dashboard/dashboard-layout';
import { useOverview } from '@/hooks/useOverview';
import { PortfolioSummary } from '@/components/overview/portfolio-summary';
import { InstanceCard } from '@/components/overview/instance-card';
import { SystemHealthGrid } from '@/components/overview/system-health-grid';
import { SignalActivityFeed } from '@/components/overview/signal-activity-feed';

export default function OverviewPage() {
  const { data, loading, error } = useOverview(30000);

  return (
    <DashboardLayout>
      <div className="max-w-7xl mx-auto space-y-4">

        {/* Page header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold font-mono tracking-wide text-foreground/90">
              NEXUS OVERVIEW
            </h1>
            <p className="text-[10px] font-mono text-muted-foreground/45 tracking-widest uppercase">
              All trading instances • Real-time aggregation
            </p>
          </div>
          {data && (
            <span className="text-[9px] font-mono text-muted-foreground/30">
              Updated {new Date(data.timestamp).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit', second: '2-digit' })} UTC
            </span>
          )}
        </div>

        {loading && !data ? (
          <div className="flex items-center justify-center h-64">
            <div className="flex flex-col items-center gap-3">
              <div className="h-8 w-8 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
              <span className="text-xs font-mono text-muted-foreground/50">Loading all instances...</span>
            </div>
          </div>
        ) : error && !data ? (
          <div className="glass-card rounded-xl p-8 border border-red-500/20 text-center">
            <p className="text-sm font-mono text-red-400">Failed to load overview: {error}</p>
          </div>
        ) : data ? (
          <>
            {/* Top summary row */}
            <PortfolioSummary
              totalValue={data.totalPortfolioValue}
              dailyPnl={data.totalDailyPnl}
              blendedWinRate={data.blendedWinRate}
              instancesOnline={data.instancesOnline}
              instancesTotal={data.instancesTotal}
            />

            {/* Instance cards grid */}
            <div>
              <h2 className="text-[10px] font-mono font-bold text-muted-foreground/50 tracking-widest uppercase mb-2">
                Trading Instances
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                {data.instances.map((inst) => (
                  <InstanceCard key={inst.id} {...inst} />
                ))}
              </div>
            </div>

            {/* Bottom row: health + activity */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
              <div className="lg:col-span-1 space-y-3">
                <SystemHealthGrid instances={data.instances} />
              </div>
              <div className="lg:col-span-2">
                <SignalActivityFeed instances={data.instances} />
              </div>
            </div>
          </>
        ) : null}

      </div>
    </DashboardLayout>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd apps/web && npx tsc --noEmit 2>&1 | tail -20`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/overview/page.tsx
git commit -m "feat(overview): add /overview page with instance grid and activity feed"
```

---

### Task 8: Add Overview to Navigation

**Files:**
- Modify: `apps/web/src/components/dashboard/dashboard-layout.tsx`
- Modify: `apps/web/src/components/command-palette.tsx`

- [ ] **Step 1: Add Overview to CRYONIX subPages**

In `dashboard-layout.tsx`, find the CRYONIX entry in `NAV_GROUPS`. Add `/overview` as the first sub-page:

```typescript
subPages: [
  { href: '/overview',  label: 'Overview' },
  { href: '/',           label: 'Terminal' },
  { href: '/analytics',  label: 'Analytics' },
  { href: '/backtest',   label: 'Backtest' },
  { href: '/legacy',     label: 'Monitor' },
],
```

Also update the `isActive` function — `/overview` should be part of the cryonix group. The existing logic already handles this since it checks `subPages`.

- [ ] **Step 2: Add Overview to command palette**

In `command-palette.tsx`, add an Overview entry to the pages list:

```typescript
{ icon: LayoutDashboard, label: 'Overview', href: '/overview', shortcut: '⌘0' }
```

Import `LayoutDashboard` from `lucide-react`.

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd apps/web && npx tsc --noEmit 2>&1 | tail -20`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/dashboard/dashboard-layout.tsx apps/web/src/components/command-palette.tsx
git commit -m "feat(overview): add Overview to nav tabs and command palette"
```

---

### Task 9: Build Verification & Deploy

**Files:**
- None (verification + deploy)

- [ ] **Step 1: Run production build**

Run: `cd c:/Projects/Code/Crypto/cryonix-agent-army && pnpm build`
Expected: Build succeeds

- [ ] **Step 2: Deploy to VM**

```bash
git archive --format=tar HEAD | ssh azureuser@openclaw-vm "cd ~/cryonix && tar xf -"
ssh azureuser@openclaw-vm "cd ~/cryonix && docker compose -f docker-compose.prod.yml up -d --build web"
```

- [ ] **Step 3: Verify on VM**

```bash
curl -s http://openclaw-vm/api/overview | head -100
```
Expected: JSON with all 7 instances

---

## Summary

| Component | What it shows |
|-----------|--------------|
| **PortfolioSummary** | Total portfolio value, daily P&L, blended win rate, instances online |
| **InstanceCard** (×7) | Per-instance: portfolio, total P&L, win rate, positions, daily P&L, sparkline equity curve |
| **SystemHealthGrid** | Color-coded status dots for all 7 instances |
| **SignalActivityFeed** | Merged timeline of recent trades from all instances, sorted by time |

Mobile responsive: 1 col on mobile, 2 on tablet, 3-4 on desktop. Uses existing glass-card/glow styles.
