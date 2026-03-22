# Missing Metrics — Kill Rate, Alpha Decay, Edge Capture Ratio

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development

**Goal:** Implement 3 critical metrics that measure WHY trades win/lose and WHAT opportunities we miss, not just WHAT happened.

**Architecture:** Shadow-execute rejected signals (phantom trades), track pattern EV decay over time, compute theoretical max P&L for ECR. All stored in Redis + logged for dashboard consumption.

**Tech Stack:** TypeScript (auto-trade route.ts), Python (calibrate.py), Redis

---

## Metric 1: Kill Rate — Are we throwing away gold?

**Problem:** 700+ signals/day rejected. How many would have been profitable?

**Solution:** Shadow-track rejected signals. After rejection, store the signal's entry price. 4 hours later, check what happened to the price. Calculate phantom P&L.

**Formula:** `KR = profitable_rejected / total_rejected`

If KR > 30% → filters too aggressive, we're killing profitable hypotheses.

### Implementation

In `auto-trade/route.ts`, every time a signal is rejected in `passesRiskChecks()` or after AI validation, log it to Redis with timestamp + entry price:

```typescript
// After each rejection in the main signal processing loop:
await redis.lpush('phantom:rejected', JSON.stringify({
    symbol: signal.symbol,
    action: signal.action,
    entryPrice: signal.entry_price,
    confidence: signal.confidence,
    pattern: signal.patterns?.join(', '),
    reason: riskCheck.reason,
    rejectedAt: Date.now(),
}));
await redis.ltrim('phantom:rejected', 0, 499); // Keep last 500
```

Separate checker (runs every cycle in monitor loop):
```typescript
// Check rejected signals from 4h ago — what happened?
const phantoms = await redis.lrange('phantom:rejected', 0, -1);
for (const raw of phantoms) {
    const phantom = JSON.parse(raw);
    const age = Date.now() - phantom.rejectedAt;
    if (age < 4 * 3600 * 1000) continue; // Too recent
    if (age > 5 * 3600 * 1000) continue; // Too old, already checked

    // Fetch current price
    const ticker = await exchange.fetchTicker(phantom.symbol);
    const priceNow = ticker.last;
    const phantomPnl = ((priceNow - phantom.entryPrice) / phantom.entryPrice) * 100;

    // Log to Redis
    await redis.lpush('phantom:results', JSON.stringify({
        ...phantom,
        priceAfter4h: priceNow,
        phantomPnlPct: phantomPnl,
        wouldHaveWon: phantomPnl > 0,
    }));
    await redis.ltrim('phantom:results', 0, 199);
}

// Calculate Kill Rate
const results = await redis.lrange('phantom:results', 0, -1);
const parsed = results.map(r => JSON.parse(r));
const profitable = parsed.filter(r => r.wouldHaveWon).length;
const killRate = parsed.length > 0 ? (profitable / parsed.length * 100) : 0;
await redis.set('metrics:kill_rate', JSON.stringify({
    killRate: Math.round(killRate * 10) / 10,
    profitable,
    total: parsed.length,
    timestamp: Date.now(),
}), 'EX', 86400);
```

---

## Metric 2: Alpha Decay Rate — Is our strategy dying?

**Problem:** BOLLINGER_SQUEEZE had 42% WR in February, 25% now. How fast is the edge dying?

**Solution:** Trend line on calibration_history snapshots per pattern. Already have the data in Postgres — just need to compute decay.

**Formula:** `αD = (EV_recent - EV_previous) / time_days`

If αD < -30% over 14 days → alert: strategy is dying.

### Implementation

In calibration cron (or as a new lightweight check), query last 4 calibration snapshots and compute slope:

```sql
SELECT snapshot_date, patterns
FROM calibration_history
WHERE run_type = 'pattern_ev'
ORDER BY snapshot_date DESC
LIMIT 4;
```

For each pattern, extract EV per snapshot and compute linear regression slope. Store in Redis:

```
metrics:alpha_decay → {
    "BOLLINGER_SQUEEZE": { slope: -0.15, trend: "declining", periods: 4 },
    "DIP_BUY": { slope: 0.02, trend: "stable", periods: 4 },
}
```

---

## Metric 3: Edge Capture Ratio — The one number that matters

**Problem:** We don't know if we're capturing 0.1% or 5% of available market edge.

**Solution:** For each symbol in watchlist, compute theoretical max P&L (buy every local bottom, sell every local top on 15m candles). Compare with our actual P&L.

**Formula:** `ECR = realized_PnL / theoretical_max_PnL`

### Implementation

Compute theoretical max from 15m OHLCV data (already fetched by engine):

```python
def theoretical_max_pnl(ohlcv_15m, capital):
    """Perfect trader: buy every dip, sell every peak."""
    total_return = 0
    for i in range(1, len(ohlcv_15m)):
        change = (ohlcv_15m[i][4] - ohlcv_15m[i-1][4]) / ohlcv_15m[i-1][4]
        if change > 0:  # Would have been long
            total_return += abs(change)
    return capital * total_return
```

Store daily: `metrics:ecr → { ecr: 0.012, realized: -1.97, theoretical: 164.5, period: "30d" }`

ECR of 1-2% = normal. ECR increasing = system learning. ECR decreasing = market changing faster than we adapt.

---

## File Map

| File | Change |
|------|--------|
| `apps/web/src/app/api/auto-trade/route.ts` | Add phantom logging on rejections + kill rate calculation |
| `scripts/strategy-lab/metrics.py` | NEW — Alpha Decay + ECR calculator (cron) |
| `cryonix.toml` | Add `[metrics]` config section |

---

## Implementation Order

1. **Kill Rate** (auto-trade route.ts) — Most actionable, tells us if filters are too aggressive
2. **Alpha Decay** (metrics.py) — Tells evolution when a strategy is dying
3. **ECR** (metrics.py) — The north star metric
