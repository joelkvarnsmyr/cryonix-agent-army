# Edge Machine Phase 2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the Edge Machine transformation: act on metrics data, restore Telegram alerts, deploy security fix, build metrics dashboard, add ECR trend, and shift vocabulary.

**Architecture:** 7 independent tasks — all can execute in parallel except Task 5-6 (dashboard) which share the same page. Tasks 1-4 are config/infra changes. Tasks 5-6 are frontend. Task 7 is a vocabulary refactor across logging.

**Tech Stack:** TOML config, Docker Compose, Bash (VM ops), Next.js/React (dashboard), TypeScript

---

## File Map

```
MODIFY  cryonix.toml                                           # Task 1: Disable declining patterns
CREATE  apps/web/src/app/api/auto-trade/alpha-gate.ts           # Task 2: Auto alpha-decay gate
MODIFY  ~/cryonix/.env (VM only)                                # Task 3: Telegram keys
MODIFY  docker-compose.prod.yml (VM deploy only)                # Task 4: Deploy docker-proxy
CREATE  apps/web/src/hooks/useMetrics.ts                        # Task 5: Metrics hook
CREATE  apps/web/src/app/metrics/page.tsx                       # Task 5+6: Metrics dashboard
MODIFY  apps/web/src/components/dashboard/dashboard-layout.tsx  # Task 5: Nav entry
MODIFY  apps/web/src/app/api/auto-trade/route.ts                # Task 7: Vocabulary shift
```

---

## Task 1: Act on Alpha Decay — Disable Declining Patterns

**Problem:** Alpha Decay data confirms 3 patterns with negative EV + declining trend:
- BOLLINGER_SQUEEZE: EV=-0.024, slope=-0.012 (declining)
- BOLLINGER_SQUEEZE+RSI_OVERSOLD: EV=-0.067, slope=-0.010 (declining)
- RSI_OVERSOLD: EV=-0.257, slope=-0.007 (declining)

The EV model already blocks these via `calibration:patterns`, but we should also add them to `weak_solo_patterns` and re-enable `dip_focus_mode` which was disabled.

**Files:**
- Modify: `cryonix.toml`

- [ ] **Step 1: Read current pattern config**

Read `cryonix.toml` sections `[patterns]` and `[ev_model]`.

- [ ] **Step 2: Update cryonix.toml**

```toml
[patterns]
# Re-enable dip focus — backtest data + alpha decay confirm value patterns outperform
dip_focus_mode = true

# Weak solo patterns — these have confirmed declining edge (Alpha Decay 2026-03-22)
# RSI_OVERSOLD: EV=-0.257, declining | EMA/MACD: poor solo WR
weak_solo_patterns = ["RSI_OVERSOLD", "EMA_BULLISH_CROSS", "MACD_BULLISH_CROSS", "BOLLINGER_SQUEEZE"]
```

Adding BOLLINGER_SQUEEZE to weak_solo means it only fires when combined with another pattern (e.g., BOLLINGER_SQUEEZE + RSI_OVERSOLD, BOLLINGER_SQUEEZE + VOLUME_SPIKE). Solo BOLLINGER_SQUEEZE (the worst offender) gets blocked.

- [ ] **Step 3: Deploy config to VM**

```bash
tar cf - cryonix.toml | ssh azureuser@openclaw-vm "cd ~/cryonix && tar xf -"
```

No container rebuild needed — auto-trader reads cryonix.toml on each cycle.

- [ ] **Step 4: Verify in logs**

```bash
ssh azureuser@openclaw-vm "docker logs cryonix-auto-trader-1 --tail 10 --since 60s"
```

Expected: Solo BOLLINGER_SQUEEZE signals now rejected with "Weak solo pattern".

- [ ] **Step 5: Commit**

```bash
git add cryonix.toml
git commit -m "fix(strategy): disable declining patterns based on Alpha Decay data

BOLLINGER_SQUEEZE added to weak_solo_patterns (EV=-0.024, declining).
Re-enabled dip_focus_mode. Alpha Decay confirmed: value combos outperform
solo patterns. RSI_OVERSOLD solo already blocked (EV=-0.257)."
```

---

## Task 2: Kill Rate Action Framework

**Problem:** Kill Rate data arrives in ~4h. We need a framework that automatically loosens filters when KR > 30% (too many profitable signals killed).

**Files:**
- Modify: `apps/web/src/app/api/auto-trade/route.ts` (in checkPhantomResults or near the risk check function)

- [ ] **Step 1: Add Kill Rate advisory logging**

After the Kill Rate is computed in `checkPhantomResults()`, add advisory logging that the AI Brain can act on:

```typescript
// After computing killRate and byFilter:
if (killRate > 30) {
    console.warn(`[KILL-RATE] WARNING: ${killRate.toFixed(1)}% of rejected signals were profitable — filters may be too aggressive`);
    // Find the most aggressive filter
    const sorted = Object.entries(byFilter)
        .filter(([, s]) => s.total >= 5)
        .map(([reason, s]) => ({ reason, rate: (s.won / s.total) * 100, ...s }))
        .sort((a, b) => b.rate - a.rate);
    if (sorted.length > 0) {
        console.warn(`[KILL-RATE] Worst filter: "${sorted[0].reason}" kills ${sorted[0].rate.toFixed(0)}% profitable signals (${sorted[0].won}/${sorted[0].total})`);
    }
    // Store advisory for AI Brain
    await redis.set('metrics:kill_rate_advisory', JSON.stringify({
        killRate,
        worstFilter: sorted[0] ?? null,
        recommendation: killRate > 50 ? 'URGENT: loosen filters' : 'REVIEW: consider loosening',
        timestamp: Date.now(),
    }), 'EX', 86400);
}
```

This is advisory-only — AI Brain reads `metrics:kill_rate_advisory` and can adjust config. No auto-loosening (too dangerous without human oversight).

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/app/api/auto-trade/route.ts
git commit -m "feat(metrics): add Kill Rate advisory for AI Brain

When KR > 30%, logs warning + stores advisory in Redis for AI Brain.
Identifies worst filter (highest profitable-rejection rate).
Advisory only — no auto-loosening."
```

---

## Task 3: Restore Telegram Keys

**Problem:** Telegram keys were lost on 2026-03-15 when .env was overwritten. Telegram bot, scraper, and all trade alerts are down.

**NOTE:** This task requires the user to provide credentials. The subagent should output exact instructions for the user to follow.

**Files:**
- Modify: `~/cryonix/.env` on VM (manual, user-provided keys)
- Modify: `docker-compose.prod.yml` (change telegram restart policy back)

- [ ] **Step 1: Prepare .env additions template**

Create the exact lines the user needs to add to `~/cryonix/.env`:

```bash
# The user needs to get these values:
# 1. TELEGRAM_INTERACTIVE_BOT_TOKEN — go to @BotFather on Telegram, /mybots → @cryptonixis_bot → API Token
# 2. TELEGRAM_BOT_TOKEN — same for @cryonixEvolution_bot
# 3. TELEGRAM_CHAT_ID — message @userinfobot on Telegram, it replies with your ID
# 4. TELEGRAM_API_ID + TELEGRAM_API_HASH — go to https://my.telegram.org → API development tools
# 5. TELEGRAM_SESSION — run: docker exec -it cryonix-engine-1 python3 /app/scripts/telegram-scraper/setup_session.py

echo "
# Telegram Bot (Interactive + Alerts)
TELEGRAM_INTERACTIVE_BOT_TOKEN=<from @BotFather>
TELEGRAM_BOT_TOKEN=<from @BotFather>
TELEGRAM_CHAT_ID=<from @userinfobot>

# Telegram Scraper (Signal channels)
TELEGRAM_API_ID=<from my.telegram.org>
TELEGRAM_API_HASH=<from my.telegram.org>
TELEGRAM_SESSION=<from setup_session.py>
" >> ~/cryonix/.env
```

Print these instructions for the user and STOP. Do not proceed until user confirms keys are set.

- [ ] **Step 2: Change telegram restart policy back to unless-stopped**

Once keys are set, in `docker-compose.prod.yml`:

```yaml
  telegram-bot:
    restart: unless-stopped    # was: "no" (temporary while keys missing)

  telegram-scraper:
    restart: unless-stopped    # was: "no"
```

- [ ] **Step 3: Deploy and start telegram containers**

```bash
tar cf - docker-compose.prod.yml | ssh azureuser@openclaw-vm "cd ~/cryonix && tar xf -"
ssh azureuser@openclaw-vm "cd ~/cryonix && docker compose -f docker-compose.prod.yml up -d telegram-bot telegram-scraper"
```

- [ ] **Step 4: Verify**

```bash
ssh azureuser@openclaw-vm "docker logs cryonix-telegram-bot-1 --tail 5"
# Expected: "🤖 Starting Cryonix Interactive Telegram Bot..."
ssh azureuser@openclaw-vm "docker logs cryonix-telegram-scraper-1 --tail 5"
# Expected: "Starting Telegram Signal Scraper"
```

- [ ] **Step 5: Commit**

```bash
git add docker-compose.prod.yml
git commit -m "fix(infra): restore telegram restart policy (keys re-added)"
```

---

## Task 4: Deploy Docker Socket Proxy to VM

**Problem:** Docker socket proxy was committed but never deployed. Brain containers still use direct socket mount on VM.

**Files:** None to modify (already committed). Deploy only.

- [ ] **Step 1: Deploy docker-compose.prod.yml to VM**

```bash
tar cf - docker-compose.prod.yml | ssh azureuser@openclaw-vm "cd ~/cryonix && tar xf -"
```

- [ ] **Step 2: Start docker-proxy + restart brain containers**

```bash
ssh azureuser@openclaw-vm "cd ~/cryonix && \
  docker compose -f docker-compose.prod.yml up -d docker-proxy && \
  docker compose -f docker-compose.prod.yml up -d --build aktienix-brain huntrix-brain"
```

- [ ] **Step 3: Verify proxy works**

```bash
# Check proxy is running
ssh azureuser@openclaw-vm "docker ps | grep docker-proxy"

# Check brain can restart aktienix via proxy
ssh azureuser@openclaw-vm "docker exec aktienix-brain sh -c 'DOCKER_HOST=tcp://docker-proxy:2375 docker ps --format {{.Names}} | head -3'"
```

- [ ] **Step 4: Verify no direct socket mounts remain**

```bash
ssh azureuser@openclaw-vm "docker inspect aktienix-brain | grep docker.sock"
# Expected: no output (socket mount removed)
```

---

## Task 5: Metrics Dashboard Page

**Problem:** Edge metrics exist in Redis + API (`/api/metrics`) but no way to visualize them.

**Files:**
- Create: `apps/web/src/hooks/useMetrics.ts`
- Create: `apps/web/src/app/metrics/page.tsx`
- Modify: `apps/web/src/components/dashboard/dashboard-layout.tsx` (add nav entry)

- [ ] **Step 1: Create useMetrics hook**

Create `apps/web/src/hooks/useMetrics.ts`:

```typescript
'use client';
import { useState, useEffect } from 'react';

export interface MetricsData {
    killRate: { killRate: number; profitable: number; total: number; byFilter?: Record<string, { won: number; total: number }> } | null;
    alphaDecay: { patterns: Record<string, { slope: number; trend: string; periods: number; latestEv: number }> } | null;
    mutationFitness: { versions: Array<{ configVersion: string; trades: number; winRate: number; avgPnl: number; sharpe: number }>; comparisons: Array<{ from: string; to: string; deltaSharpe: number; improved: boolean }> } | null;
    capitalVelocity: { velocity: number; volume: number; trades: number; days: number } | null;
    edgeCaptureRatio: { ecr: number; realized: number; theoretical: number; period: string } | null;
}

export function useMetrics(refreshMs = 60_000) {
    const [data, setData] = useState<MetricsData | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let active = true;
        const load = async () => {
            try {
                const res = await fetch('/api/metrics');
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const json = await res.json();
                if (active) { setData(json); setError(null); }
            } catch (e) { if (active) setError(String(e)); }
        };
        load();
        const id = setInterval(load, refreshMs);
        return () => { active = false; clearInterval(id); };
    }, [refreshMs]);

    return { data, error };
}
```

- [ ] **Step 2: Create metrics dashboard page**

Create `apps/web/src/app/metrics/page.tsx` with 5 cards:

1. **ECR (North Star)** — Big number, color-coded (green if positive, red if negative)
2. **Alpha Decay** — Table of patterns with trend indicators (↑ ↓ →)
3. **Kill Rate** — Percentage + per-filter breakdown
4. **Mutation Fitness** — Timeline of config versions with Sharpe deltas
5. **Capital Velocity** — Simple stat card

```typescript
'use client';

import { useMetrics } from '@/hooks/useMetrics';
import { DashboardLayout } from '@/components/dashboard/dashboard-layout';

const TREND_ICON: Record<string, string> = { declining: '↓', improving: '↑', stable: '→' };
const TREND_COLOR: Record<string, string> = { declining: 'text-red-400', improving: 'text-emerald-400', stable: 'text-muted-foreground/50' };

export default function MetricsPage() {
    const { data, error } = useMetrics(30_000);
    const ecr = data?.edgeCaptureRatio;
    const ad = data?.alphaDecay;
    const kr = data?.killRate;
    const mfs = data?.mutationFitness;
    const cv = data?.capitalVelocity;

    return (
        <DashboardLayout>
            <div className="max-w-4xl mx-auto space-y-4">
                {/* Header */}
                <div className="rounded-lg border border-rose-400/30 bg-rose-400/5 px-4 py-2 flex items-center justify-between">
                    <span className="text-rose-400 text-[10px] font-mono font-bold tracking-widest">EDGE MACHINE — METRICS</span>
                    <span className="text-xs text-muted-foreground/60 font-mono">Live data from /api/metrics</span>
                </div>

                {/* ECR — North Star */}
                <div className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-6 text-center">
                    <div className="text-[10px] font-mono text-muted-foreground/50 tracking-widest mb-2">EDGE CAPTURE RATIO</div>
                    <div className={`text-4xl font-bold font-mono ${ecr && ecr.ecr >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {ecr ? `${ecr.ecr.toFixed(2)}%` : '—'}
                    </div>
                    {ecr && (
                        <div className="text-xs text-muted-foreground/40 mt-1 font-mono">
                            realized ${ecr.realized.toFixed(2)} / theoretical ${ecr.theoretical.toFixed(2)} ({ecr.period})
                        </div>
                    )}
                </div>

                {/* Row: Kill Rate + Capital Velocity */}
                <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-4 text-center">
                        <div className="text-[10px] font-mono text-muted-foreground/50 tracking-widest mb-1">KILL RATE</div>
                        <div className={`text-2xl font-bold font-mono ${kr && kr.killRate > 30 ? 'text-amber-400' : 'text-foreground'}`}>
                            {kr ? `${kr.killRate}%` : '—'}
                        </div>
                        <div className="text-[10px] text-muted-foreground/40 font-mono">
                            {kr ? `${kr.profitable}/${kr.total} profitable rejections` : 'awaiting data (~4h)'}
                        </div>
                    </div>
                    <div className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-4 text-center">
                        <div className="text-[10px] font-mono text-muted-foreground/50 tracking-widest mb-1">CAPITAL VELOCITY</div>
                        <div className="text-2xl font-bold font-mono text-foreground">
                            {cv ? `${cv.velocity.toFixed(2)}x` : '—'}
                        </div>
                        <div className="text-[10px] text-muted-foreground/40 font-mono">
                            {cv ? `${cv.trades} trades, $${cv.volume.toFixed(0)} vol, ${cv.days.toFixed(0)}d` : 'no data'}
                        </div>
                    </div>
                </div>

                {/* Alpha Decay */}
                <div className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm">
                    <div className="px-4 py-3 border-b border-white/[0.04]">
                        <h3 className="text-sm font-mono font-bold tracking-wider text-rose-400">ALPHA DECAY</h3>
                    </div>
                    {ad ? (
                        <div className="divide-y divide-white/[0.04]">
                            {Object.entries(ad.patterns)
                                .sort(([,a], [,b]) => a.slope - b.slope)
                                .map(([pattern, d]) => (
                                <div key={pattern} className="px-4 py-2 flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                        <span className={`text-sm font-mono ${TREND_COLOR[d.trend]}`}>{TREND_ICON[d.trend]}</span>
                                        <span className="text-xs font-mono">{pattern}</span>
                                    </div>
                                    <div className="flex items-center gap-4 text-xs font-mono">
                                        <span className={d.latestEv >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                                            EV: {d.latestEv.toFixed(4)}
                                        </span>
                                        <span className="text-muted-foreground/40">
                                            slope: {d.slope.toFixed(4)}
                                        </span>
                                        <span className="text-muted-foreground/30">{d.periods}p</span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div className="p-6 text-center text-sm text-muted-foreground/50">No alpha decay data</div>
                    )}
                </div>

                {/* Mutation Fitness */}
                <div className="rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm">
                    <div className="px-4 py-3 border-b border-white/[0.04]">
                        <h3 className="text-sm font-mono font-bold tracking-wider text-foreground">MUTATION FITNESS</h3>
                    </div>
                    {mfs && mfs.comparisons.length > 0 ? (
                        <div className="divide-y divide-white/[0.04]">
                            {mfs.comparisons.map((c, i) => (
                                <div key={i} className="px-4 py-2 flex items-center justify-between">
                                    <span className="text-xs font-mono text-muted-foreground/60">
                                        {c.from.slice(0,8)} → {c.to.slice(0,8)}
                                    </span>
                                    <span className={`text-sm font-mono font-bold ${c.improved ? 'text-emerald-400' : 'text-red-400'}`}>
                                        {c.improved ? '↑' : '↓'} {c.deltaSharpe > 0 ? '+' : ''}{c.deltaSharpe.toFixed(3)}
                                    </span>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div className="p-6 text-center text-sm text-muted-foreground/50">No mutation data</div>
                    )}
                </div>

                {error && (
                    <div className="rounded-lg border border-red-400/30 bg-red-400/5 p-3 text-xs text-red-400 font-mono">{error}</div>
                )}
            </div>
        </DashboardLayout>
    );
}
```

- [ ] **Step 3: Add nav entry in dashboard-layout.tsx**

In `apps/web/src/components/dashboard/dashboard-layout.tsx`, find the NAV_GROUPS array. Add after the last entry (HUNTRIX):

```typescript
{
    id: 'metrics',
    label: 'METRICS',
    accent: 'text-rose-400',
    dot: 'bg-rose-400',
    glow: 'shadow-[0_0_8px_rgba(251,113,133,0.5)]',
    items: [
        { href: '/metrics', label: 'Metrics', icon: Activity, desc: 'Edge machine metrics' },
    ],
},
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/hooks/useMetrics.ts apps/web/src/app/metrics/page.tsx \
        apps/web/src/components/dashboard/dashboard-layout.tsx
git commit -m "feat(dashboard): add Edge Machine metrics page

/metrics page showing ECR (north star), Alpha Decay (pattern trends),
Kill Rate (filter aggression), Mutation Fitness (config evolution),
Capital Velocity (money utilization). Polls /api/metrics every 30s."
```

---

## Task 6: ECR Trend in Dashboard

**Problem:** ECR is a snapshot. We need the trend (ECR over time) to see if the system is learning.

**Files:**
- Modify: `scripts/strategy-lab/edge_metrics.py` (store ECR history)
- Modify: `apps/web/src/app/api/metrics/route.ts` (return ECR history)
- Modify: `apps/web/src/app/metrics/page.tsx` (add sparkline chart)

- [ ] **Step 1: Store ECR history in Redis list**

In `edge_metrics.py`, after computing ECR, append to a Redis list:

```python
# After r.set('metrics:ecr', ...):
r.lpush('metrics:ecr:history', json.dumps({
    'ecr': round(ecr, 4),
    'realized': round(realized, 4),
    'theoretical': round(total_theoretical, 2),
    'timestamp': int(time.time() * 1000),
}))
r.ltrim('metrics:ecr:history', 0, 89)  # Keep last 90 data points (~22 days at 6h intervals)
```

- [ ] **Step 2: Add ECR history to API**

In `apps/web/src/app/api/metrics/route.ts`, add to the Promise.all:

```typescript
redis.lrange('metrics:ecr:history', 0, -1),
```

Parse and return as `ecrHistory`:

```typescript
ecrHistory: ecrHistoryRaw ? (ecrHistoryRaw as string[]).map((r: string) => JSON.parse(r)).reverse() : [],
```

- [ ] **Step 3: Add sparkline to metrics page**

In `apps/web/src/app/metrics/page.tsx`, add a Recharts AreaChart under the ECR card:

```typescript
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

// In the ECR section, after the big number:
{data?.ecrHistory && data.ecrHistory.length > 1 && (
    <div className="h-24 mt-3">
        <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data.ecrHistory}>
                <defs>
                    <linearGradient id="ecrGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#fb7185" stopOpacity={0.3}/>
                        <stop offset="95%" stopColor="#fb7185" stopOpacity={0}/>
                    </linearGradient>
                </defs>
                <Area type="monotone" dataKey="ecr" stroke="#fb7185" fill="url(#ecrGrad)" strokeWidth={1.5} />
                <XAxis dataKey="timestamp" hide />
                <YAxis hide domain={['auto', 'auto']} />
                <Tooltip
                    contentStyle={{ background: '#1a1a2e', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, fontSize: 11 }}
                    formatter={(v: number) => [`${v.toFixed(4)}%`, 'ECR']}
                    labelFormatter={(ts: number) => new Date(ts).toLocaleDateString()}
                />
            </AreaChart>
        </ResponsiveContainer>
    </div>
)}
```

- [ ] **Step 4: Commit**

```bash
git add scripts/strategy-lab/edge_metrics.py apps/web/src/app/api/metrics/route.ts \
        apps/web/src/app/metrics/page.tsx
git commit -m "feat(metrics): add ECR trend sparkline with 90-point history

ECR history stored in Redis list (90 points, ~22 days at 6h intervals).
Dashboard shows ECR sparkline chart under the north star number."
```

---

## Task 7: Vocabulary Shift — Hypothesis-Driven Language

**Problem:** Codebase uses "signal" (implies certainty) and "filter" (implies removal). Better: "hypothesis" (implies testing) and "conviction gate" (implies building confidence).

**Scope:** Console.log messages only in auto-trade/route.ts. No variable renames (too risky for trading code), no config changes. Just user-facing log strings.

**Files:**
- Modify: `apps/web/src/app/api/auto-trade/route.ts`

- [ ] **Step 1: Replace key log messages**

Find and replace these log strings that ACTUALLY EXIST in the file:

```
"[BUY-FILTER]"       → "[CONVICTION]"
"Weak solo pattern"  → "Low-conviction solo hypothesis"
"Negative EV"        → "Negative expected value"
```

NOTE: Do NOT rename `RISK_REJECTED` — it's a status value in data structures, not just a log string. Do NOT try to rename `[SIGNAL]` or `"Signal persisted"` or `"Rejected"` — these strings do not exist in auto-trade/route.ts.

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/app/api/auto-trade/route.ts
git commit -m "refactor: shift vocabulary from signals to hypotheses in logs

Console messages now use hypothesis-driven language:
signal → hypothesis, filter → conviction gate, rejected → filtered.
Variable names unchanged (too risky for live trading code)."
```

---

## Execution Order

```
Phase A (parallel): Task 1 (alpha decay action) + Task 2 (KR advisory) + Task 4 (deploy proxy)
Phase B (parallel): Task 5 (metrics dashboard) + Task 6 (ECR trend) + Task 7 (vocabulary)
Phase C (user-driven): Task 3 (telegram keys — requires user input)
```

| Task | What | Effort | Needs User? |
|------|------|--------|-------------|
| 1 | Disable declining patterns | 3 min | No |
| 2 | Kill Rate advisory | 5 min | No |
| 3 | Telegram keys | 10 min | **Yes** — user provides tokens |
| 4 | Deploy docker-proxy | 5 min | No |
| 5 | Metrics dashboard | 10 min | No |
| 6 | ECR trend sparkline | 5 min | No |
| 7 | Vocabulary shift | 5 min | No |
