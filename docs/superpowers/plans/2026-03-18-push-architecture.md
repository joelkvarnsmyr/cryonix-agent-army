# Push-Based Trading Architecture

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development

**Goal:** Eliminate polling delays — signals execute within 2 seconds of detection, not 8 minutes.

**Architecture:** Replace auto-trader polling loop with Redis Pub/Sub event-driven execution. Engine publishes signals → auto-trade route subscribes and executes instantly.

**Tech Stack:** Redis Pub/Sub, Next.js API routes, existing Python engine

---

## Current Architecture (Polling)

```
Engine (Python, every 10s)
  → writes signal to Redis LIST (trades:pending)
  → waits...

Auto-trader (Node, polls every 15s)
  → reads Redis LIST
  → POST /api/auto-trade
  → AI validation (3-8s)
  → Execute on Binance

Total latency: 7.5min (candle) + 7.5s (poll avg) + 5s (AI) = ~8 minutes
```

**Problems:**
1. 15m candle = 7.5 min average detection delay
2. Polling adds 0-15s random delay
3. AI validation adds 3-8s per signal
4. Instance lock conflicts when poll overlaps execution

## New Architecture (Push)

```
Engine (Python, every 10s)
  → writes signal to Redis LIST (trades:pending)
  → PUBLISH signal to Redis channel "signals:new"   ← NEW

Signal Worker (Node, event-driven)                    ← NEW
  → SUBSCRIBE to "signals:new"
  → On message: immediately POST /api/auto-trade
  → No polling delay

Auto-trade route (unchanged logic)
  → Fast-track: ≥80% + 2 patterns → skip AI (0s)
  → Normal: AI validation (3-8s)
  → Execute on Binance

Total latency: 7.5min (candle) + 0s (push) + 0-5s (AI) = ~7.5 minutes
                With 5m scan: 2.5min + 0s + 0s = ~2.5 minutes
```

## Implementation

### Step 1: Engine publishes to Redis Pub/Sub

In `packages/engine/src/tanks/market_scout.py`, after writing to `trades:pending`, also publish:

```python
# After: await state_manager.redis.lpush('trades:pending', json.dumps(signal))
await state_manager.redis.publish('signals:new', json.dumps({
    'symbol': symbol,
    'action': signal['action'],
    'confidence': signal['confidence'],
    'timestamp': time.time(),
}))
```

Cost: 1 extra Redis command per signal (~0.1ms).

### Step 2: Signal Worker replaces auto-trader polling

New file: `scripts/services/signal-worker.mjs`

```javascript
// Event-driven signal processor
// Subscribes to Redis "signals:new" channel
// On message → immediately triggers /api/auto-trade POST

import Redis from 'ioredis';

const API_BASE = process.env.NEXT_PUBLIC_APP_URL || 'http://web:3000';
const KV_URL = process.env.KV_URL || 'redis://redis:6379';

const subscriber = new Redis(KV_URL);
let processing = false;

subscriber.subscribe('signals:new', (err) => {
    if (err) { console.error('[WORKER] Subscribe failed:', err); process.exit(1); }
    console.log('[WORKER] Subscribed to signals:new');
});

subscriber.on('message', async (channel, message) => {
    if (processing) return; // Prevent overlap
    processing = true;

    try {
        const signal = JSON.parse(message);
        console.log(`[WORKER] Signal: ${signal.symbol} ${signal.action} ${(signal.confidence * 100).toFixed(0)}%`);

        const res = await fetch(`${API_BASE}/api/auto-trade`, { method: 'POST' });
        const data = await res.json();

        if (data.buys > 0) console.log(`[WORKER] BOUGHT ${data.buys}!`, data.buyResults);
        if (data.rejected > 0) console.log(`[WORKER] Rejected ${data.rejected}`);
    } catch (err) {
        console.error('[WORKER] Error:', err.message);
    } finally {
        processing = false;
    }
});

// Fallback: still poll every 60s for missed signals
setInterval(async () => {
    if (processing) return;
    processing = true;
    try {
        await fetch(`${API_BASE}/api/auto-trade`, { method: 'POST' });
    } catch {} finally { processing = false; }
}, 60_000);
```

### Step 3: Keep auto-trader.mjs as health monitor only

Strip trading logic from auto-trader.mjs, keep only:
- Health check polling (every 5 min)
- Position monitoring (every 15s via GET)
- Logging

### Step 4: Docker Compose update

```yaml
signal-worker:
    build:
        context: .
        dockerfile: Dockerfile.scripts
    restart: always
    command: ["node", "scripts/services/signal-worker.mjs"]
    depends_on:
        redis: { condition: service_healthy }
        web: { condition: service_healthy }
    environment:
        - KV_URL=redis://redis:6379
        - NEXT_PUBLIC_APP_URL=http://web:3000
```

## Timing Comparison

| Scenario | Old (polling) | New (push) | Improvement |
|----------|--------------|------------|-------------|
| 15m signal + AI | 8 min | 7.5 min | 30s faster |
| 15m signal + fast-track | 7.9 min | 7.5 min | 24s faster |
| 5m fast scan + AI | 3 min | 2.5 min | 30s faster |
| 5m fast scan + fast-track | 2.9 min | **2.5 min** | 24s faster |

The real bottleneck is candle close time (not polling). Push eliminates the 15s polling delay but the dominant factor is 15m/5m candle close. The biggest wins we already got:
- 5m fast scan: -5 min avg
- AI fast-track: -5s
- 15s poll (from 30s): -7.5s avg

Push adds another ~7.5s improvement on average.

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| Redis Pub/Sub message lost | Fallback 60s poll catches anything missed |
| Worker crashes | Docker restart policy + health check |
| Duplicate execution | Instance lock (already exists, 60s TTL) |
| Message flood | `processing` flag prevents overlap |

## Recommendation

**Do this AFTER validating the current V2 engine** for 48-72 hours. The speed improvements already deployed (15s poll + AI fast-track + 5m scan) give us most of the benefit. Push architecture is incremental — ~7.5s avg improvement.

**Priority order for making the system profitable:**
1. ✅ Multiplicative confidence (prevents overconfident trades)
2. ✅ Smart rotation (frees capital for better signals)
3. ✅ AI fast-track (faster execution for strong signals)
4. ✅ 5m fast scan (catches dips 10 min earlier)
5. ⬜ HTF trend filter (prevent buying into downtrends) ← **highest remaining impact**
6. ⬜ Push architecture (incremental speed)

The HTF trend filter would have prevented all 3 losing trades yesterday (all bought during a downtrend). That's worth more than 7.5s faster execution.
