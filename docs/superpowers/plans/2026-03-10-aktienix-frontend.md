# Aktienix Frontend Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `/aktienix` dashboard page and supporting API routes + hooks within `apps/web`, following established Cryonix patterns, displaying stock portfolio data from the AktienixAgent via Redis.

**Architecture:** Four lightweight API routes read `aktienix:*` Redis keys (written by AktienixAgent), plus a market-hours helper that computes ET market state inline. Three React hooks poll these routes. One dashboard page composes the UI using the same design system as `apps/web/src/app/page.tsx`.

**Tech Stack:** Next.js 15 App Router, TypeScript, Recharts, `@cryonix/ui` (shadcn), Redis via `@/lib/redis`, Tailwind CSS (same dark theme as Cryonix dashboard).

---

## Redis Key Contract

The frontend expects the following keys written by AktienixAgent (other agents are responsible for the writes):

| Key | Type | Written by |
|-----|------|-----------|
| `aktienix:account` | JSON | AktienixAgent → account loop |
| `aktienix:positions` | JSON array | AktienixAgent → position loop |
| `aktienix:trades:history` | JSON array | AktienixAgent → on close |
| `aktienix:signals:recent` | JSON array | AktienixAgent → on evaluate |
| `aktienix:agent:status` | JSON | AktienixAgent → heartbeat |

API routes gracefully return empty/null when keys are missing (agent not yet running).

---

## File Map

### New files (create)
```
apps/web/src/app/api/aktienix/
  status/route.ts          — Agent heartbeat + market hours (ET)
  portfolio/route.ts       — Account balances from Redis
  positions/route.ts       — Open stock positions from Redis
  trades/route.ts          — Recent closed trades from Redis

apps/web/src/hooks/
  useAktienix.ts           — Four polling hooks (portfolio, positions, trades, status)

apps/web/src/app/aktienix/
  page.tsx                 — Main dashboard (balance, equity curve, positions, trades, health)
```

### Modified files
```
apps/web/src/components/dashboard/dashboard-layout.tsx   — Add "Stocks" nav link
```

---

## Chunk 1: API Routes

### Task 1: `status` API route

**Files:**
- Create: `apps/web/src/app/api/aktienix/status/route.ts`

Market hours are computed from current UTC time converted to ET (UTC−5 standard, UTC−4 daylight). No external calls. Returns agent heartbeat from Redis.

- [ ] **Step 1: Create the route file**

```typescript
// apps/web/src/app/api/aktienix/status/route.ts
import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';

export const dynamic = 'force-dynamic';

type MarketPhase = 'pre' | 'regular' | 'after' | 'closed';

function getMarketHours(): { phase: MarketPhase; isOpen: boolean; localTime: string } {
  const now = new Date();
  // Determine ET offset: EDT (UTC-4) Mar–Nov, EST (UTC-5) Nov–Mar
  const jan = new Date(now.getFullYear(), 0, 1).getTimezoneOffset();
  const jul = new Date(now.getFullYear(), 6, 1).getTimezoneOffset();
  const isDST = now.getTimezoneOffset() < Math.max(jan, jul);
  const etOffset = isDST ? -4 : -5;
  const etMs = now.getTime() + (now.getTimezoneOffset() + etOffset * 60) * 60_000;
  const et = new Date(etMs);
  const day = et.getDay(); // 0=Sun, 6=Sat
  const h = et.getHours();
  const m = et.getMinutes();
  const mins = h * 60 + m;
  const localTime = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} ET`;

  if (day === 0 || day === 6) return { phase: 'closed', isOpen: false, localTime };
  if (mins < 240) return { phase: 'closed', isOpen: false, localTime };   // before 04:00
  if (mins < 570) return { phase: 'pre', isOpen: false, localTime };       // 04:00–09:30
  if (mins < 960) return { phase: 'regular', isOpen: true, localTime };    // 09:30–16:00
  if (mins < 1200) return { phase: 'after', isOpen: false, localTime };    // 16:00–20:00
  return { phase: 'closed', isOpen: false, localTime };
}

export async function GET() {
  const marketHours = getMarketHours();

  let agentStatus: Record<string, unknown> | null = null;
  try {
    const raw = await redis.get('aktienix:agent:status');
    if (raw) agentStatus = JSON.parse(raw as string);
  } catch { /* redis unavailable */ }

  return NextResponse.json({
    market: marketHours,
    agent: agentStatus ?? { running: false, broker: 'unknown', lastPoll: null },
    timestamp: new Date().toISOString(),
  });
}
```

- [ ] **Step 2: Verify route loads** — Run `pnpm dev` and open `http://localhost:3000/api/aktienix/status`. Expect JSON with `market` and `agent` keys.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/api/aktienix/status/route.ts
git commit -m "feat(aktienix): add status API route with ET market hours"
```

---

### Task 2: `portfolio` API route

**Files:**
- Create: `apps/web/src/app/api/aktienix/portfolio/route.ts`

- [ ] **Step 1: Create the route file**

```typescript
// apps/web/src/app/api/aktienix/portfolio/route.ts
import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';

export const dynamic = 'force-dynamic';

export interface AktienixAccount {
  portfolioValue: number;
  buyingPower: number;
  settledCash: number;
  isPatternDayTrader: boolean;
  dailyPnl: number;
  dailyPnlPct: number;
  updatedAt: string | null;
}

export async function GET() {
  try {
    const raw = await redis.get('aktienix:account');
    if (!raw) {
      const empty: AktienixAccount = {
        portfolioValue: 0, buyingPower: 0, settledCash: 0,
        isPatternDayTrader: false, dailyPnl: 0, dailyPnlPct: 0, updatedAt: null,
      };
      return NextResponse.json(empty);
    }
    const data = JSON.parse(raw as string) as AktienixAccount;
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
```

- [ ] **Step 2: Verify** — Open `http://localhost:3000/api/aktienix/portfolio`. Returns zeros when Redis key is absent (agent not running). No error thrown.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/api/aktienix/portfolio/route.ts
git commit -m "feat(aktienix): add portfolio API route"
```

---

### Task 3: `positions` API route

**Files:**
- Create: `apps/web/src/app/api/aktienix/positions/route.ts`

- [ ] **Step 1: Create the route file**

```typescript
// apps/web/src/app/api/aktienix/positions/route.ts
import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';

export const dynamic = 'force-dynamic';

export interface AktienixPosition {
  symbol: string;
  qty: number;
  avgEntryPrice: number;
  currentPrice: number;
  marketValue: number;
  unrealizedPl: number;
  unrealizedPlPct: number;
  stopLoss: number;
  takeProfit: number;
  openedAt: string;
}

export async function GET() {
  try {
    const raw = await redis.get('aktienix:positions');
    const positions: AktienixPosition[] = raw ? JSON.parse(raw as string) : [];
    return NextResponse.json({ positions });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
```

- [ ] **Step 2: Verify** — GET returns `{ positions: [] }` when key absent.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/api/aktienix/positions/route.ts
git commit -m "feat(aktienix): add positions API route"
```

---

### Task 4: `trades` API route

**Files:**
- Create: `apps/web/src/app/api/aktienix/trades/route.ts`

- [ ] **Step 1: Create the route file**

```typescript
// apps/web/src/app/api/aktienix/trades/route.ts
import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';

export const dynamic = 'force-dynamic';

export interface AktienixTrade {
  symbol: string;
  qty: number;
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  pnlPct: number;
  signal: string | null;
  openedAt: string;
  closedAt: string;
  exitReason: string | null;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const limit = Math.min(parseInt(searchParams.get('limit') || '20', 10), 100);

  try {
    const raw = await redis.get('aktienix:trades:history');
    const all: AktienixTrade[] = raw ? JSON.parse(raw as string) : [];
    const trades = all.slice(0, limit);
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const winCount = trades.filter(t => t.pnl > 0).length;
    return NextResponse.json({
      trades,
      summary: {
        total: trades.length,
        winRate: trades.length > 0 ? winCount / trades.length : 0,
        totalPnl,
      },
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
```

- [ ] **Step 2: Verify** — GET returns `{ trades: [], summary: { total: 0, winRate: 0, totalPnl: 0 } }`.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/api/aktienix/trades/route.ts
git commit -m "feat(aktienix): add trades history API route"
```

---

## Chunk 2: React Hooks

### Task 5: `useAktienix` hooks

**Files:**
- Create: `apps/web/src/hooks/useAktienix.ts`

One file exports four named hooks — same pattern as `useAutoTrade.ts`.

- [ ] **Step 1: Create the hooks file**

```typescript
// apps/web/src/hooks/useAktienix.ts
'use client';

import { useState, useEffect, useCallback } from 'react';
import type { AktienixAccount } from '@/app/api/aktienix/portfolio/route';
import type { AktienixPosition } from '@/app/api/aktienix/positions/route';
import type { AktienixTrade } from '@/app/api/aktienix/trades/route';

// ── Status ────────────────────────────────────────────────────────────────────

interface MarketHours {
  phase: 'pre' | 'regular' | 'after' | 'closed';
  isOpen: boolean;
  localTime: string;
}

interface AgentStatus {
  running: boolean;
  broker: string;
  lastPoll: string | null;
}

interface AktienixStatus {
  market: MarketHours;
  agent: AgentStatus;
  timestamp: string;
}

export function useAktienixStatus(refreshInterval = 30_000) {
  const [data, setData] = useState<AktienixStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetch_ = useCallback(async () => {
    try {
      const res = await fetch('/api/aktienix/status');
      setData(await res.json());
      setError(null);
    } catch (e: any) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    fetch_();
    const id = setInterval(fetch_, refreshInterval);
    return () => clearInterval(id);
  }, [fetch_, refreshInterval]);

  return { data, error };
}

// ── Portfolio ─────────────────────────────────────────────────────────────────

export function useAktienixPortfolio(refreshInterval = 15_000) {
  const [data, setData] = useState<AktienixAccount | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetch_ = useCallback(async () => {
    try {
      const res = await fetch('/api/aktienix/portfolio');
      setData(await res.json());
      setError(null);
    } catch (e: any) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    fetch_();
    const id = setInterval(fetch_, refreshInterval);
    return () => clearInterval(id);
  }, [fetch_, refreshInterval]);

  return { data, error };
}

// ── Positions ─────────────────────────────────────────────────────────────────

export function useAktienixPositions(refreshInterval = 15_000) {
  const [positions, setPositions] = useState<AktienixPosition[]>([]);
  const [error, setError] = useState<string | null>(null);

  const fetch_ = useCallback(async () => {
    try {
      const res = await fetch('/api/aktienix/positions');
      const json = await res.json();
      setPositions(json.positions ?? []);
      setError(null);
    } catch (e: any) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    fetch_();
    const id = setInterval(fetch_, refreshInterval);
    return () => clearInterval(id);
  }, [fetch_, refreshInterval]);

  return { positions, error };
}

// ── Trades ────────────────────────────────────────────────────────────────────

interface TradesSummary {
  total: number;
  winRate: number;
  totalPnl: number;
}

export function useAktienixTrades(limit = 20, refreshInterval = 30_000) {
  const [trades, setTrades] = useState<AktienixTrade[]>([]);
  const [summary, setSummary] = useState<TradesSummary>({ total: 0, winRate: 0, totalPnl: 0 });
  const [error, setError] = useState<string | null>(null);

  const fetch_ = useCallback(async () => {
    try {
      const res = await fetch(`/api/aktienix/trades?limit=${limit}`);
      const json = await res.json();
      setTrades(json.trades ?? []);
      setSummary(json.summary ?? { total: 0, winRate: 0, totalPnl: 0 });
      setError(null);
    } catch (e: any) {
      setError(e.message);
    }
  }, [limit]);

  useEffect(() => {
    fetch_();
    const id = setInterval(fetch_, refreshInterval);
    return () => clearInterval(id);
  }, [fetch_, refreshInterval]);

  return { trades, summary, error };
}
```

- [ ] **Step 2: Verify types compile** — Run `pnpm type-check` from repo root. Expect 0 new errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/hooks/useAktienix.ts
git commit -m "feat(aktienix): add useAktienix polling hooks"
```

---

## Chunk 3: Dashboard Page

### Task 6: `/aktienix` dashboard page

**Files:**
- Create: `apps/web/src/app/aktienix/page.tsx`

Design mirrors `apps/web/src/app/page.tsx` — dark card layout, max-w-2xl centered, Recharts AreaChart for equity, two-column position grid.

- [ ] **Step 1: Create the page**

```typescript
// apps/web/src/app/aktienix/page.tsx
'use client';

import { useEffect, useState } from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import {
  useAktienixStatus,
  useAktienixPortfolio,
  useAktienixPositions,
  useAktienixTrades,
} from '@/hooks/useAktienix';

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

const PHASE_LABEL: Record<string, string> = {
  pre: 'PRE-MARKET',
  regular: 'MARKET OPEN',
  after: 'AFTER-HOURS',
  closed: 'MARKET CLOSED',
};

const PHASE_COLOR: Record<string, string> = {
  pre: 'text-amber-400',
  regular: 'text-emerald-400',
  after: 'text-amber-400',
  closed: 'text-muted-foreground',
};

export default function AktienixPage() {
  const { data: status } = useAktienixStatus(30_000);
  const { data: portfolio } = useAktienixPortfolio(15_000);
  const { positions } = useAktienixPositions(15_000);
  const { trades, summary } = useAktienixTrades(20, 30_000);

  const [clock, setClock] = useState('');
  useEffect(() => {
    const tick = () => setClock(new Date().toISOString().slice(11, 16));
    tick();
    const id = setInterval(tick, 10_000);
    return () => clearInterval(id);
  }, []);

  // Build a fake equity curve from closed trades for the chart
  const equityData = (() => {
    if (trades.length === 0) return [];
    let cum = 0;
    return [...trades].reverse().map(t => {
      cum += t.pnl;
      return { time: t.closedAt, cumulative: cum };
    });
  })();

  const phase = status?.market.phase ?? 'closed';
  const isOpen = status?.market.isOpen ?? false;
  const etTime = status?.market.localTime ?? '--:-- ET';
  const brokerLabel = status?.agent.broker ?? 'unknown';
  const agentRunning = status?.agent.running ?? false;

  const portfolioValue = portfolio?.portfolioValue ?? 0;
  const buyingPower = portfolio?.buyingPower ?? 0;
  const settledCash = portfolio?.settledCash ?? 0;
  const dailyPnl = portfolio?.dailyPnl ?? 0;
  const dailyPnlPct = portfolio?.dailyPnlPct ?? 0;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-2xl mx-auto p-4 space-y-4">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm font-bold tracking-wider text-muted-foreground">AKTIENIX</span>
            <span className={`text-xs font-mono ${PHASE_COLOR[phase]}`}>
              {PHASE_LABEL[phase]}
            </span>
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className={`w-2 h-2 rounded-full ${agentRunning ? 'bg-emerald-400 animate-pulse' : 'bg-red-400'}`} />
              {brokerLabel}
            </span>
            <span className="font-mono">{clock} UTC</span>
            <span className="font-mono text-muted-foreground/60">{etTime}</span>
          </div>
        </div>

        {/* Balance */}
        <div className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-6 text-center">
          <div className="text-xs text-muted-foreground mb-1 font-mono">PORTFOLIO VALUE</div>
          <div className="text-3xl font-bold tracking-tight" style={{ color: 'hsl(142, 76%, 55%)' }}>
            ${portfolioValue.toFixed(2)}
          </div>
          <div className="mt-1 flex items-center justify-center gap-3 text-sm">
            <span className={dailyPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}>
              {dailyPnl >= 0 ? '+' : ''}{dailyPnl.toFixed(2)} today ({dailyPnlPct >= 0 ? '+' : ''}{dailyPnlPct.toFixed(2)}%)
            </span>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3 text-xs text-muted-foreground">
            <div className="rounded-lg bg-white/[0.03] p-2">
              <div className="text-muted-foreground/60 mb-0.5">Buying Power</div>
              <div className="font-mono text-foreground">${buyingPower.toFixed(2)}</div>
            </div>
            <div className="rounded-lg bg-white/[0.03] p-2">
              <div className="text-muted-foreground/60 mb-0.5">Settled Cash</div>
              <div className="font-mono text-foreground">${settledCash.toFixed(2)}</div>
            </div>
          </div>
        </div>

        {/* Equity Curve */}
        {equityData.length > 1 && (
          <div className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-4">
            <div className="text-xs text-muted-foreground mb-2">Cumulative P&L (from trades)</div>
            <ResponsiveContainer width="100%" height={140}>
              <AreaChart data={equityData}>
                <defs>
                  <linearGradient id="aktGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(142, 76%, 55%)" stopOpacity={0.3} />
                    <stop offset="100%" stopColor="hsl(142, 76%, 55%)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="time" hide />
                <YAxis hide domain={['dataMin', 'dataMax']} />
                <Tooltip
                  contentStyle={{ background: 'hsl(220, 55%, 7%)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, fontSize: 12 }}
                  labelFormatter={(v) => new Date(v as string).toLocaleDateString()}
                  formatter={(v: number) => [`$${v.toFixed(2)}`, 'Cumulative P&L']}
                />
                <Area type="monotone" dataKey="cumulative" stroke="hsl(142, 76%, 55%)" strokeWidth={2} fill="url(#aktGrad)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Open Positions */}
        {positions.length > 0 && (
          <div>
            <div className="text-xs text-muted-foreground mb-2">Open positions ({positions.length})</div>
            <div className="grid grid-cols-2 gap-3">
              {positions.map(pos => {
                const plColor = pos.unrealizedPl >= 0 ? 'text-emerald-400' : 'text-red-400';
                return (
                  <div key={pos.symbol} className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-4">
                    <div className="text-xs text-muted-foreground mb-1">{pos.symbol}</div>
                    <div className={`text-lg font-semibold ${plColor}`}>
                      {pos.unrealizedPl >= 0 ? '+' : ''}{pos.unrealizedPlPct.toFixed(2)}%
                    </div>
                    <div className="text-xs text-muted-foreground mt-1 space-y-0.5">
                      <div>${pos.avgEntryPrice.toFixed(2)} &rarr; ${pos.currentPrice.toFixed(2)}</div>
                      <div>SL ${pos.stopLoss.toFixed(2)} · TP ${pos.takeProfit.toFixed(2)}</div>
                      <div className={plColor}>
                        {pos.unrealizedPl >= 0 ? '+' : ''}${pos.unrealizedPl.toFixed(2)}
                      </div>
                      <div className="text-muted-foreground/50">{pos.qty} shares · {timeAgo(pos.openedAt)}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {positions.length === 0 && (
          <div className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-4 text-center">
            <div className="text-sm text-muted-foreground/50">No open positions</div>
          </div>
        )}

        {/* Recent Trades */}
        <div className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs text-muted-foreground">Recent trades</div>
            {summary.total > 0 && (
              <div className="flex gap-3 text-xs text-muted-foreground">
                <span>WR: <span className={summary.winRate >= 0.5 ? 'text-emerald-400' : 'text-amber-400'}>{(summary.winRate * 100).toFixed(0)}%</span></span>
                <span className={summary.totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                  {summary.totalPnl >= 0 ? '+' : ''}${summary.totalPnl.toFixed(2)} total
                </span>
              </div>
            )}
          </div>
          {trades.length === 0 ? (
            <div className="text-sm text-muted-foreground/50">No trades yet</div>
          ) : (
            <div className="space-y-1.5">
              {trades.slice(0, 8).map((t, i) => (
                <div key={i} className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-muted-foreground w-12">{t.symbol}</span>
                    {t.signal && <span className="text-xs text-muted-foreground/60">{t.signal}</span>}
                    {t.exitReason && <span className="text-xs text-muted-foreground/40">{t.exitReason}</span>}
                  </div>
                  <div className="flex items-center gap-3">
                    <span className={t.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                      {t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}
                    </span>
                    <span className="text-xs text-muted-foreground w-14 text-right">{timeAgo(t.closedAt)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Market Hours Info */}
        <div className="flex items-center justify-center gap-4 py-2 text-xs text-muted-foreground">
          {[
            { label: 'Pre-market', hours: '04:00–09:30 ET' },
            { label: 'Regular', hours: '09:30–16:00 ET' },
            { label: 'After-hours', hours: '16:00–20:00 ET' },
          ].map(s => (
            <span key={s.label} className="flex items-center gap-1">
              <span className={`w-1.5 h-1.5 rounded-full ${phase === s.label.toLowerCase().replace('-', '').split(' ')[0] && isOpen ? 'bg-emerald-400' : 'bg-white/10'}`} />
              {s.label}
            </span>
          ))}
        </div>

      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify page renders** — Open `http://localhost:3000/aktienix`. Should render without errors. Shows zeros/empty states since agent isn't writing to Redis yet.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/aktienix/page.tsx
git commit -m "feat(aktienix): add main dashboard page"
```

---

### Task 7: Add nav link to dashboard layout

**Files:**
- Modify: `apps/web/src/components/dashboard/dashboard-layout.tsx`

- [ ] **Step 1: Read the current navItems in dashboard-layout.tsx**

Open `apps/web/src/components/dashboard/dashboard-layout.tsx` and find the `navItems` array.

- [ ] **Step 2: Add "Stocks" link**

Find the navItems array and add:
```typescript
{ href: '/aktienix', label: 'Stocks', icon: TrendingUp },
```

Import `TrendingUp` from `lucide-react` if not already imported.

- [ ] **Step 3: Verify** — Dashboard nav shows "Stocks" link. Clicking navigates to `/aktienix`.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/dashboard/dashboard-layout.tsx
git commit -m "feat(aktienix): add Stocks nav link to dashboard layout"
```

---

## Chunk 4: Type Check & Verification

### Task 8: Final type check

- [ ] **Step 1: Run type check**

```bash
cd C:\Projects\Code\Crypto\cryonix-agent-army
pnpm type-check
```

Expected: 0 new errors introduced by this work.

- [ ] **Step 2: Verify build**

```bash
pnpm build
```

Expected: Successful build (aktienix page is statically generated or force-dynamic as needed).

- [ ] **Step 3: Final commit if any fixes needed**

```bash
git add -p
git commit -m "fix(aktienix): resolve type-check issues"
```

---

## Summary

After all tasks are complete:

| Route | Purpose |
|-------|---------|
| `GET /api/aktienix/status` | Market hours + agent heartbeat |
| `GET /api/aktienix/portfolio` | Account balances |
| `GET /api/aktienix/positions` | Open stock positions |
| `GET /api/aktienix/trades?limit=N` | Closed trade history |
| `/aktienix` | Dashboard page |

**Data dependency:** All API routes read from Redis `aktienix:*` keys written by AktienixAgent. Dashboard shows zeros/empty states gracefully when agent is not running — no crashes.
