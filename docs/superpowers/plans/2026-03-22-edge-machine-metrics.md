# Edge Machine Metrics — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform Cryonix from a trading bot into an edge machine by implementing 4 metrics (Alpha Decay, Mutation Fitness, Capital Velocity, ECR) + fixing the existing Kill Rate checker + upgrading AI Brain prompts to consume these metrics.

**Architecture:** Each metric is a standalone Python script in `scripts/strategy-lab/` that reads from Postgres/Redis and writes results to Redis. A single cron wrapper runs all metrics. The dashboard and AI Brain consume the Redis keys. Kill Rate already exists in auto-trade/route.ts but the result-checker isn't running — needs a fix.

**Tech Stack:** Python 3.11 (metrics scripts), TypeScript (Kill Rate fix in auto-trade), Redis (output), Postgres (input)

---

## Current State

| Component | Exists? | Data? |
|-----------|---------|-------|
| Kill Rate — phantom logging | ✅ `auto-trade/route.ts` | 292 phantoms logged |
| Kill Rate — result checker | ✅ `checkPhantomResults()` | **0 results** (not running?) |
| Alpha Decay | ❌ | 33 calibration snapshots in Postgres |
| Mutation Fitness | ❌ | config_version on every trade (in Postgres) |
| Capital Velocity | ❌ | trades + positions in Postgres/Redis |
| ECR | ❌ | OHLCV data from engine (CCXT) |
| AI Brain prompt | ✅ `scripts/strategy-lab/ai_brain.py` | Needs metrics context |
| Dashboard metrics | ❌ | No API route for metrics |

## File Map

```
MODIFY  apps/web/src/app/api/auto-trade/route.ts       # Task 1: Fix Kill Rate checker
CREATE  scripts/strategy-lab/edge_metrics.py             # Task 2-5: Alpha Decay + MFS + CV + ECR
MODIFY  scripts/strategy-lab/ai_brain.py                 # Task 6: Upgrade Brain prompts
CREATE  apps/web/src/app/api/metrics/route.ts            # Task 7: Dashboard API
MODIFY  apps/web/src/app/page.tsx                        # Task 7: Dashboard widget (optional)
```

---

## Task 1: Fix Kill Rate — Phantom Result Checker

**Problem:** `checkPhantomResults()` exists in auto-trade/route.ts but produces 0 results despite 292 logged phantoms. The checker likely isn't being called, or the 4h time window logic is broken.

**Files:**
- Modify: `apps/web/src/app/api/auto-trade/route.ts` (find `checkPhantomResults`)

- [ ] **Step 1: Read the checkPhantomResults function and the main cycle loop**

Find where `checkPhantomResults()` is defined and where (if anywhere) it's called. Check the time window logic.

- [ ] **Step 2: Ensure checkPhantomResults runs every cycle**

In the main monitor/cycle function (the code that runs every 30s), verify that `checkPhantomResults()` is called. If it's not called, add it to the monitor loop (after position monitoring, before signal processing):

```typescript
// In the main cycle function, add:
await checkPhantomResults();
```

- [ ] **Step 3: Fix the time window logic**

The current logic checks `age < 4h` (too recent) and `age > 5h` (too old). This 1-hour window means phantoms are only checked between 4h-5h after rejection. If the checker doesn't run during that window, the phantom is lost.

Fix: process ALL phantoms older than 4h, then remove them from the list:

```typescript
async function checkPhantomResults(): Promise<void> {
    try {
        const phantoms = await redis.lrange('phantom:rejected', 0, -1);
        const toKeep: string[] = [];
        let checked = 0;

        for (const raw of phantoms) {
            const phantom = JSON.parse(raw);
            const age = Date.now() - phantom.rejectedAt;

            if (age < 4 * 3600 * 1000) {
                toKeep.push(raw); // Too recent, keep for later
                continue;
            }

            // Old enough — check result
            try {
                const ticker = await exchange.fetchTicker(phantom.symbol);
                const priceNow = ticker.last ?? ticker.close ?? 0;
                if (priceNow <= 0) { toKeep.push(raw); continue; }

                const phantomPnl = ((priceNow - phantom.entryPrice) / phantom.entryPrice) * 100;

                await redis.lpush('phantom:results', JSON.stringify({
                    ...phantom,
                    priceAfter: priceNow,
                    phantomPnlPct: Math.round(phantomPnl * 100) / 100,
                    wouldHaveWon: phantomPnl > 0,
                    checkedAt: Date.now(),
                }));
                await redis.ltrim('phantom:results', 0, 499);
                checked++;
            } catch {
                toKeep.push(raw); // Price fetch failed, retry later
            }
        }

        // Replace the rejected list with only the unexpired entries
        if (checked > 0) {
            const pipe = redis.pipeline();
            pipe.del('phantom:rejected');
            if (toKeep.length > 0) {
                pipe.rpush('phantom:rejected', ...toKeep);
            }
            await pipe.exec();
        }

        // Recalculate Kill Rate
        const results = (await redis.lrange('phantom:results', 0, -1)).map(r => JSON.parse(r));
        if (results.length > 0) {
            const profitable = results.filter((r: any) => r.wouldHaveWon).length;
            const killRate = (profitable / results.length) * 100;
            // Per-filter breakdown
            const byReason: Record<string, { won: number; total: number }> = {};
            for (const r of results) {
                const key = r.reason ?? 'unknown';
                if (!byReason[key]) byReason[key] = { won: 0, total: 0 };
                byReason[key].total++;
                if (r.wouldHaveWon) byReason[key].won++;
            }
            await redis.set('metrics:kill_rate', JSON.stringify({
                killRate: Math.round(killRate * 10) / 10,
                profitable,
                total: results.length,
                byFilter: byReason,
                timestamp: Date.now(),
            }), 'EX', 86400);
            if (checked > 0) {
                console.log(`[KILL-RATE] Checked ${checked} phantoms. KR=${killRate.toFixed(1)}% (${profitable}/${results.length} profitable)`);
            }
        }
    } catch (err) {
        console.warn('[KILL-RATE] checkPhantomResults error:', err instanceof Error ? err.message : err);
    }
}
```

- [ ] **Step 4: Verify by checking Redis after deployment**

```bash
ssh azureuser@openclaw-vm "docker exec cryonix-redis-1 redis-cli GET metrics:kill_rate"
# Should show JSON with killRate, profitable, total after 4+ hours
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/api/auto-trade/route.ts
git commit -m "fix(metrics): activate Kill Rate phantom checker + per-filter breakdown

checkPhantomResults was not being called in the monitor loop or had a
too-narrow time window. Fixed: process all phantoms >4h old, remove
processed entries, add per-filter Kill Rate breakdown."
```

---

## Task 2: Alpha Decay Rate — Is Our Strategy Dying?

**Problem:** BOLLINGER_SQUEEZE went from 42% WR → 25% WR but nobody noticed until the audit. We have 33 calibration snapshots in Postgres but nobody computes the trend.

**Files:**
- Create: `scripts/strategy-lab/edge_metrics.py`

- [ ] **Step 1: Create edge_metrics.py with Alpha Decay calculation**

```python
#!/usr/bin/env python3
"""
Edge Machine Metrics — Alpha Decay, Mutation Fitness, Capital Velocity, ECR.

Run: python3 scripts/strategy-lab/edge_metrics.py
Cron: every 6h alongside calibration

Reads: Postgres (calibration_history, trades, position_history)
Writes: Redis metrics:alpha_decay, metrics:mutation_fitness, metrics:capital_velocity, metrics:ecr
"""

import os, sys, json, time
import numpy as np
from datetime import datetime, timedelta

import psycopg2
import redis

POSTGRES_URL = os.environ.get('POSTGRES_URL', 'postgres://postgres:password@localhost:5432/cryonix')
KV_URL = os.environ.get('KV_URL', 'redis://localhost:6379')

def get_pg():
    return psycopg2.connect(POSTGRES_URL)

def get_redis():
    return redis.from_url(KV_URL, decode_responses=True)

# ── Alpha Decay Rate ────────────────────────────────────────────

def compute_alpha_decay(pg, r):
    """
    Linear regression on EV per pattern over last N calibration snapshots.
    αD = slope of EV trend. If αD < -0.3 over 14 days → strategy dying.
    """
    cur = pg.cursor()
    cur.execute("""
        SELECT snapshot_date, patterns
        FROM calibration_history
        WHERE run_type = 'calibration'
        ORDER BY snapshot_date DESC
        LIMIT 14
    """)
    rows = cur.fetchall()
    if len(rows) < 3:
        print(f'[ALPHA-DECAY] Not enough snapshots ({len(rows)}), need 3+')
        return

    # Build per-pattern time series
    pattern_series: dict[str, list[tuple[float, float]]] = {}
    base_date = datetime.strptime(rows[-1][0], '%Y-%m-%d')

    for date_str, patterns_json in rows:
        if not patterns_json:
            continue
        patterns = patterns_json if isinstance(patterns_json, dict) else json.loads(patterns_json)
        day_offset = (datetime.strptime(date_str, '%Y-%m-%d') - base_date).days

        for pattern_name, data in patterns.items():
            if not isinstance(data, dict):
                continue
            ev = None
            wr = data.get('winRate', data.get('win_rate', 0))
            avg_win = data.get('avgWin', data.get('avg_win', 0))
            avg_loss = data.get('avgLoss', data.get('avg_loss', 0))
            trades = data.get('trades', 0)
            if trades >= 3 and wr is not None:
                ev = (wr / 100) * abs(avg_win) - (1 - wr / 100) * abs(avg_loss)
            if ev is not None:
                pattern_series.setdefault(pattern_name, []).append((day_offset, ev))

    # Compute slope for each pattern
    result = {}
    for pattern, series in pattern_series.items():
        if len(series) < 3:
            continue
        x = np.array([s[0] for s in series])
        y = np.array([s[1] for s in series])
        if x.std() == 0:
            continue
        slope = np.polyfit(x, y, 1)[0]
        trend = 'declining' if slope < -0.001 else 'improving' if slope > 0.001 else 'stable'
        result[pattern] = {
            'slope': round(float(slope), 6),
            'trend': trend,
            'periods': len(series),
            'latestEv': round(float(y[0]), 4),  # Most recent
        }

    r.set('metrics:alpha_decay', json.dumps({
        'patterns': result,
        'timestamp': int(time.time() * 1000),
    }), ex=86400)

    declining = [p for p, d in result.items() if d['trend'] == 'declining']
    print(f'[ALPHA-DECAY] {len(result)} patterns analyzed. Declining: {declining or "none"}')
    return result
```

- [ ] **Step 2: Commit alpha decay**

```bash
git add scripts/strategy-lab/edge_metrics.py
git commit -m "feat(metrics): add Alpha Decay Rate — track pattern EV trends

Linear regression on calibration_history snapshots per pattern.
αD slope shows if strategy edge is declining, stable, or improving.
Writes to Redis metrics:alpha_decay."
```

---

## Task 3: Mutation Fitness Score — Did The Change Help?

**Files:**
- Modify: `scripts/strategy-lab/edge_metrics.py` (append)

- [ ] **Step 1: Add Mutation Fitness Score to edge_metrics.py**

Append to the same file:

```python
# ── Mutation Fitness Score ──────────────────────────────────────

def compute_mutation_fitness(pg, r):
    """
    Sharpe-like ratio per config_version. Compares consecutive versions.
    MFS > 0 = mutation helped. MFS < 0 three times → auto-revert candidate.
    """
    cur = pg.cursor()
    # Get trades grouped by config_version (last 30 days)
    cur.execute("""
        SELECT config_version,
               COUNT(*) as trades,
               AVG(CASE WHEN pnl > 0 THEN 1.0 ELSE 0.0 END) as win_rate,
               AVG(pnl) as avg_pnl,
               STDDEV(pnl) as std_pnl,
               MIN(timestamp) as first_trade,
               MAX(timestamp) as last_trade
        FROM trades
        WHERE timestamp > NOW() - INTERVAL '30 days'
          AND status = 'CLOSED'
          AND config_version IS NOT NULL
        GROUP BY config_version
        HAVING COUNT(*) >= 3
        ORDER BY MIN(timestamp) ASC
    """)
    versions = cur.fetchall()
    if len(versions) < 2:
        print(f'[MFS] Not enough config versions ({len(versions)}), need 2+')
        return

    results = []
    for i, (cv, trades, wr, avg_pnl, std_pnl, first, last) in enumerate(versions):
        sharpe = float(avg_pnl / std_pnl) if std_pnl and std_pnl > 0 else 0
        results.append({
            'configVersion': cv,
            'trades': trades,
            'winRate': round(float(wr) * 100, 1),
            'avgPnl': round(float(avg_pnl), 6),
            'sharpe': round(sharpe, 3),
        })

    # Compare consecutive versions
    comparisons = []
    for i in range(1, len(results)):
        prev = results[i - 1]
        curr = results[i]
        delta_sharpe = curr['sharpe'] - prev['sharpe']
        comparisons.append({
            'from': prev['configVersion'],
            'to': curr['configVersion'],
            'deltaSharpe': round(delta_sharpe, 3),
            'improved': delta_sharpe > 0,
        })

    r.set('metrics:mutation_fitness', json.dumps({
        'versions': results,
        'comparisons': comparisons,
        'timestamp': int(time.time() * 1000),
    }), ex=86400)

    improvements = sum(1 for c in comparisons if c['improved'])
    print(f'[MFS] {len(comparisons)} mutations compared. {improvements}/{len(comparisons)} improved.')
    return results
```

- [ ] **Step 2: Commit**

```bash
git add scripts/strategy-lab/edge_metrics.py
git commit -m "feat(metrics): add Mutation Fitness Score — Sharpe per config version

Compares consecutive config_version Sharpe ratios from trades table.
MFS > 0 = mutation helped. Enables data-driven evolution decisions."
```

---

## Task 4: Capital Velocity — Are Our Money Sleeping?

**Files:**
- Modify: `scripts/strategy-lab/edge_metrics.py` (append)

- [ ] **Step 1: Add Capital Velocity to edge_metrics.py**

```python
# ── Capital Velocity ────────────────────────────────────────────

def compute_capital_velocity(pg, r):
    """
    CV = total_traded_volume / avg_capital / period_days
    Low CV = money sitting idle. High CV = capital working.
    """
    cur = pg.cursor()
    cur.execute("""
        SELECT
            SUM(ABS(entry_price * quantity)) as total_volume,
            COUNT(*) as trade_count,
            MIN(timestamp) as first_trade,
            MAX(timestamp) as last_trade
        FROM trades
        WHERE timestamp > NOW() - INTERVAL '7 days'
          AND status = 'CLOSED'
    """)
    row = cur.fetchone()
    if not row or not row[0]:
        print('[CV] No closed trades in last 7 days')
        r.set('metrics:capital_velocity', json.dumps({
            'velocity': 0, 'volume': 0, 'trades': 0,
            'timestamp': int(time.time() * 1000),
        }), ex=86400)
        return

    total_volume = float(row[0])
    trade_count = row[1]
    first = row[2]
    last = row[3]

    # Get average capital (from portfolio or config)
    avg_capital = 50  # Cryonix capital (~$50 USDC deployed)
    try:
        capital_raw = r.get('risk:portfolio_state')
        if capital_raw:
            state = json.loads(capital_raw)
            avg_capital = max(float(state.get('totalValue', 50)), 1)
    except:
        pass

    days = max(1, (last - first).total_seconds() / 86400) if first and last else 7
    velocity = total_volume / avg_capital / days

    r.set('metrics:capital_velocity', json.dumps({
        'velocity': round(velocity, 3),
        'volume': round(total_volume, 2),
        'trades': trade_count,
        'days': round(days, 1),
        'avgCapital': round(avg_capital, 2),
        'timestamp': int(time.time() * 1000),
    }), ex=86400)

    print(f'[CV] Velocity={velocity:.3f}x/day ({trade_count} trades, ${total_volume:.2f} vol, {days:.1f} days)')
```

- [ ] **Step 2: Commit**

```bash
git add scripts/strategy-lab/edge_metrics.py
git commit -m "feat(metrics): add Capital Velocity — is our money working?"
```

---

## Task 5: Edge Capture Ratio — The North Star

**Files:**
- Modify: `scripts/strategy-lab/edge_metrics.py` (append)

- [ ] **Step 1: Add ECR + main() to edge_metrics.py**

```python
# ── Edge Capture Ratio ──────────────────────────────────────────

def compute_ecr(pg, r):
    """
    ECR = realized_PnL / theoretical_max_PnL
    Theoretical max = perfect trader buying every dip, selling every peak (15m bars).
    ECR ~1% = good. ECR ~5% = exceptional. ECR increasing = system learning.
    """
    try:
        import ccxt
        exchange = ccxt.binance({'enableRateLimit': True})
    except ImportError:
        print('[ECR] ccxt not available, skipping')
        return

    symbols = ['BTC/USDC', 'ETH/USDC', 'SOL/USDC', 'BNB/USDC']
    total_theoretical = 0
    capital_per_symbol = 50 / len(symbols)  # Rough estimate

    for symbol in symbols:
        try:
            ohlcv = exchange.fetch_ohlcv(symbol, '15m', limit=672)  # ~7 days
            if len(ohlcv) < 10:
                continue
            # Theoretical max: sum all positive close-to-close moves
            max_return = sum(
                abs((ohlcv[i][4] - ohlcv[i-1][4]) / ohlcv[i-1][4])
                for i in range(1, len(ohlcv))
                if ohlcv[i][4] > ohlcv[i-1][4]
            )
            total_theoretical += capital_per_symbol * max_return
        except Exception as e:
            print(f'[ECR] Failed to fetch {symbol}: {e}')

    if total_theoretical <= 0:
        print('[ECR] No theoretical PnL data')
        return

    # Get realized PnL (last 7 days)
    cur = pg.cursor()
    cur.execute("""
        SELECT COALESCE(SUM(pnl), 0)
        FROM trades
        WHERE timestamp > NOW() - INTERVAL '7 days'
          AND status = 'CLOSED'
    """)
    realized = float(cur.fetchone()[0])

    ecr = (realized / total_theoretical) * 100 if total_theoretical > 0 else 0

    r.set('metrics:ecr', json.dumps({
        'ecr': round(ecr, 4),
        'realized': round(realized, 4),
        'theoretical': round(total_theoretical, 2),
        'period': '7d',
        'symbols': symbols,
        'timestamp': int(time.time() * 1000),
    }), ex=86400)

    print(f'[ECR] {ecr:.4f}% — realized ${realized:.4f} / theoretical ${total_theoretical:.2f} (7d)')


# ── Main ────────────────────────────────────────────────────────

def main():
    print('=' * 50)
    print('  Edge Machine Metrics')
    print('=' * 50)

    pg = get_pg()
    r = get_redis()

    try:
        compute_alpha_decay(pg, r)
        compute_mutation_fitness(pg, r)
        compute_capital_velocity(pg, r)
        compute_ecr(pg, r)
    finally:
        pg.close()
        r.close()

    print('\nDone.')


if __name__ == '__main__':
    main()
```

- [ ] **Step 2: Test locally (if Postgres accessible) or on VM**

```bash
ssh azureuser@openclaw-vm "cd ~/cryonix && docker exec cryonix-engine-1 python3 /app/scripts/strategy-lab/edge_metrics.py"
```

- [ ] **Step 3: Commit**

```bash
git add scripts/strategy-lab/edge_metrics.py
git commit -m "feat(metrics): add ECR (Edge Capture Ratio) + main runner

ECR = realized PnL / theoretical max PnL. The north star metric.
All 4 metrics now in one script: alpha_decay, mutation_fitness,
capital_velocity, ecr. Run: python3 scripts/strategy-lab/edge_metrics.py"
```

---

## Task 6: Upgrade AI Brain Prompts

**Problem:** AI Brain asks "which pattern lost?" — should ask "which pattern's edge is decaying?" (αD), "which filters kill profitable signals?" (KR), "did the last mutation help?" (MFS).

**Files:**
- Modify: `scripts/strategy-lab/ai_brain.py`

- [ ] **Step 1: Read the AI Brain's current prompt construction**

Find where the Grok prompt is built in `ai_brain.py`. It assembles context from trades, positions, calibration, etc.

- [ ] **Step 2: Add metrics context to the prompt**

After the existing context collection, add:

```python
# Read edge metrics from Redis
metrics_context = ""
try:
    alpha_raw = r.get('metrics:alpha_decay')
    kr_raw = r.get('metrics:kill_rate')
    mfs_raw = r.get('metrics:mutation_fitness')
    cv_raw = r.get('metrics:capital_velocity')
    ecr_raw = r.get('metrics:ecr')

    if alpha_raw:
        alpha = json.loads(alpha_raw)
        declining = [f"{p}: slope={d['slope']}" for p, d in alpha.get('patterns', {}).items() if d['trend'] == 'declining']
        if declining:
            metrics_context += f"\nALPHA DECAY WARNING: These patterns have declining edge: {', '.join(declining)}\n"
            metrics_context += "Consider disabling patterns with severe decay rather than tuning parameters.\n"

    if kr_raw:
        kr = json.loads(kr_raw)
        metrics_context += f"\nKILL RATE: {kr.get('killRate', 0)}% of rejected signals would have been profitable.\n"
        if kr.get('byFilter'):
            for reason, stats in kr['byFilter'].items():
                if stats['total'] >= 5:
                    rate = (stats['won'] / stats['total']) * 100
                    if rate > 40:
                        metrics_context += f"  Filter '{reason}' kills {rate:.0f}% profitable signals — consider loosening.\n"

    if mfs_raw:
        mfs = json.loads(mfs_raw)
        comps = mfs.get('comparisons', [])
        recent_bad = sum(1 for c in comps[-3:] if not c.get('improved', True))
        if recent_bad >= 2:
            metrics_context += f"\nMUTATION WARNING: {recent_bad}/3 recent mutations degraded performance. Consider pausing evolution.\n"

    if ecr_raw:
        ecr = json.loads(ecr_raw)
        metrics_context += f"\nEDGE CAPTURE RATIO: {ecr.get('ecr', 0):.4f}% (realized ${ecr.get('realized', 0):.2f} / theoretical ${ecr.get('theoretical', 0):.2f})\n"
except Exception as e:
    metrics_context = f"\n(Metrics unavailable: {e})\n"
```

Then inject `metrics_context` into the Grok prompt, after the existing context sections.

- [ ] **Step 3: Commit**

```bash
git add scripts/strategy-lab/ai_brain.py
git commit -m "feat(brain): upgrade AI Brain with edge metrics context

Brain now reads alpha_decay, kill_rate, mutation_fitness, ECR from Redis
and includes them in Grok analysis prompt. Enables smarter decisions:
disable decaying patterns, loosen aggressive filters, revert bad mutations."
```

---

## Task 7: Dashboard Metrics API

**Files:**
- Create: `apps/web/src/app/api/metrics/route.ts`

- [ ] **Step 1: Create the metrics API route**

```typescript
import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';

export const dynamic = 'force-dynamic';

export async function GET() {
    try {
        const [krRaw, adRaw, mfsRaw, cvRaw, ecrRaw] = await Promise.all([
            redis.get('metrics:kill_rate'),
            redis.get('metrics:alpha_decay'),
            redis.get('metrics:mutation_fitness'),
            redis.get('metrics:capital_velocity'),
            redis.get('metrics:ecr'),
        ]);

        return NextResponse.json({
            killRate: krRaw ? JSON.parse(krRaw as string) : null,
            alphaDecay: adRaw ? JSON.parse(adRaw as string) : null,
            mutationFitness: mfsRaw ? JSON.parse(mfsRaw as string) : null,
            capitalVelocity: cvRaw ? JSON.parse(cvRaw as string) : null,
            edgeCaptureRatio: ecrRaw ? JSON.parse(ecrRaw as string) : null,
            timestamp: new Date().toISOString(),
        });
    } catch (e) {
        return NextResponse.json({ error: String(e) }, { status: 500 });
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/app/api/metrics/route.ts
git commit -m "feat(api): add /api/metrics endpoint for edge machine metrics

Returns kill_rate, alpha_decay, mutation_fitness, capital_velocity, ECR
from Redis. Consumed by dashboard and external monitoring."
```

---

## Execution Order

Tasks 1-5 are independent (parallel). Task 6 depends on 2-5 (needs Redis keys). Task 7 is independent.

```
Phase A (parallel): Task 1 (Kill Rate fix) + Task 2-5 (edge_metrics.py) + Task 7 (API)
Phase B (sequential): Task 6 (AI Brain upgrade, after metrics exist)
```

| Task | What | Effort |
|------|------|--------|
| 1 | Fix Kill Rate checker | 10 min |
| 2 | Alpha Decay Rate | 5 min |
| 3 | Mutation Fitness Score | 5 min |
| 4 | Capital Velocity | 5 min |
| 5 | ECR (Edge Capture Ratio) | 5 min |
| 6 | AI Brain prompt upgrade | 10 min |
| 7 | Dashboard API | 5 min |
