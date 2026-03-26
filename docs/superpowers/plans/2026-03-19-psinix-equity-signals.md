# Ψnix Equity & Macro Signals — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add equity market (S&P 500, NASDAQ) and DXY dollar index signals to Ψnix by consuming data already available through Aktienix's Redis state and Finnhub API, plus Aktienix's rich macro event intelligence.

**Architecture:** Two new signal sources in signal-collector.ts that read from Aktienix's existing Redis keys. One new lightweight equity-fetcher module that polls S&P 500/NASDAQ/DXY from Finnhub free API every 5 minutes and writes to Redis. No changes to Aktienix itself — Ψnix reads passively.

**Tech Stack:** TypeScript, Finnhub REST API (free tier, 60 calls/min), ioredis, existing signal-collector pattern

---

## Data Available Now in Redis (from Aktienix)

| Redis Key | Data | Relevance for Ψnix |
|-----------|------|-------------------|
| `aktienix:feargreed` | CNN F&G score, VIX, S&P momentum, put/call | VIX + momentum = equity risk appetite |
| `aktienix:putcall` | CBOE put/call ratio | Extreme readings = contrarian signal |
| `aktienix:macro:event_states` | FOMC, inflation, oil shock, recession, trade war | Macro events with bullish/bearish tickers + confidence |

## Data We Need to Add

| Redis Key | Data | Source | Poll |
|-----------|------|--------|------|
| `psinix:equity:spy` | S&P 500 price + daily change % | Finnhub `/quote?symbol=SPY` | 5min |
| `psinix:equity:qqq` | NASDAQ 100 price + daily change % | Finnhub `/quote?symbol=QQQ` | 5min |
| `psinix:equity:dxy` | Dollar Index proxy via UUP ETF | Finnhub `/quote?symbol=UUP` | 5min |

Finnhub free tier: 60 API calls/minute, plenty for 3 quotes every 5 min.

---

## File Structure

| File | Changes |
|------|---------|
| `packages/agents/src/psinix/equity-fetcher.ts` | **NEW** — Polls SPY/QQQ/UUP from Finnhub, writes to Redis |
| `packages/agents/src/psinix/signal-collector.ts` | Add 3 new signal methods: getEquitySignal, getMacroEvents, getVixSignal |
| `packages/agents/src/psinix/psinix-agent.ts` | Start equity fetcher in initialize() |
| `psinix.toml` | Add [equity] section with Finnhub config |
| `Dockerfile.psinix` | No changes needed (ioredis already installed) |

---

### Task 1: Equity Fetcher — Polls SPY/QQQ/UUP from Finnhub

Lightweight poller that runs in the Ψnix process and writes equity data to Redis.

**Files:**
- Create: `packages/agents/src/psinix/equity-fetcher.ts`

- [ ] **Step 1: Create equity-fetcher.ts**

```typescript
/**
 * EquityFetcher — Polls S&P 500, NASDAQ, DXY from Finnhub free API.
 * Writes to Redis for signal-collector consumption.
 *
 * Finnhub free: 60 calls/min. We make 3 calls every 5min = trivial.
 * No auth needed for basic quotes, but API key improves rate limits.
 */

interface EquityQuote {
    symbol: string;
    price: number;
    change: number;       // $ change from previous close
    changePct: number;    // % change from previous close
    prevClose: number;
    timestamp: number;
}

export class EquityFetcher {
    private redis: any;
    private finnhubKey: string | null;
    private interval: ReturnType<typeof setInterval> | null = null;
    private pollMs: number;

    // ETF proxies for market indices
    private symbols = [
        { ticker: 'SPY', key: 'psinix:equity:spy', label: 'S&P 500' },
        { ticker: 'QQQ', key: 'psinix:equity:qqq', label: 'NASDAQ 100' },
        { ticker: 'UUP', key: 'psinix:equity:uup', label: 'DXY (USD bull)' },
    ];

    constructor(redis: any, finnhubKey?: string, pollMs: number = 300_000) {
        this.redis = redis;
        this.finnhubKey = finnhubKey || process.env.FINNHUB_API_KEY || null;
        this.pollMs = pollMs;
    }

    start(): void {
        // First fetch immediately
        this.fetchAll().catch(() => {});
        this.interval = setInterval(() => this.fetchAll().catch(() => {}), this.pollMs);
        console.log(`[equity] Polling SPY/QQQ/UUP every ${this.pollMs / 1000}s`);
    }

    stop(): void {
        if (this.interval) clearInterval(this.interval);
    }

    private async fetchAll(): Promise<void> {
        for (const { ticker, key, label } of this.symbols) {
            try {
                const quote = await this.fetchQuote(ticker);
                if (!quote) continue;

                await this.redis.set(key, JSON.stringify(quote));
                await this.redis.expire(key, 600); // 10min TTL
            } catch {
                // Non-critical — old data still usable
            }
        }
    }

    private async fetchQuote(ticker: string): Promise<EquityQuote | null> {
        const baseUrl = 'https://finnhub.io/api/v1/quote';
        const tokenParam = this.finnhubKey ? `&token=${this.finnhubKey}` : '';
        const url = `${baseUrl}?symbol=${ticker}${tokenParam}`;

        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) return null;

        const data = await res.json();
        // Finnhub quote: c=current, d=change, dp=change%, pc=prevClose, t=timestamp
        if (!data.c || data.c === 0) return null;

        return {
            symbol: ticker,
            price: data.c,
            change: data.d ?? 0,
            changePct: data.dp ?? 0,
            prevClose: data.pc ?? data.c,
            timestamp: Date.now(),
        };
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/agents/src/psinix/equity-fetcher.ts
git commit -m "feat(psinix): add equity fetcher — SPY/QQQ/UUP from Finnhub"
```

---

### Task 2: Add Equity + Macro Signals to SignalCollector

Three new signal sources:

1. **σ_equity** — S&P 500/NASDAQ daily change → directional signal for crypto
2. **σ_dxy** — DXY (dollar) change → INVERSE signal for crypto
3. **σ_macro** — Aktienix macro events (FOMC, inflation, recession) → aggregate sentiment

**Files:**
- Modify: `packages/agents/src/psinix/signal-collector.ts`

- [ ] **Step 1: Add getEquitySignal() method**

After the existing signal methods, add:

```typescript
    // ── Equity Market — S&P 500 / NASDAQ correlation ─────────────────

    /**
     * S&P 500 + NASDAQ daily change → directional crypto signal.
     * Research: BTC-NASDAQ correlation 0.52 average, spikes to 0.88.
     * SPY change weighted 40%, QQQ 60% (NASDAQ correlates stronger).
     */
    private async getEquitySignal(): Promise<PsiSignal | null> {
        try {
            let weightedChange = 0;
            let totalWeight = 0;

            for (const [key, weight] of [['psinix:equity:spy', 0.4], ['psinix:equity:qqq', 0.6]] as const) {
                const raw = await this.redis.get(key);
                if (!raw) continue;
                const data = JSON.parse(raw);
                const age = Date.now() - (data.timestamp ?? 0);
                if (age > 15 * 60_000) continue; // Stale after 15min

                // Daily change % → direction. +2% day = strong bull, -2% = strong bear
                const changePct = data.changePct ?? 0;
                const direction = Math.max(-1, Math.min(1, changePct / 2)); // ±2% = ±1.0
                weightedChange += direction * weight;
                totalWeight += weight;
            }

            if (totalWeight < 0.3) return null;
            const compositeDir = weightedChange / totalWeight;
            if (Math.abs(compositeDir) < 0.05) return null;

            return {
                sourceId: 'equity:spx_qqq',
                direction: Math.max(-1, Math.min(1, compositeDir)),
                weight: 0.6, // High weight — strong proven correlation
                timestamp: Date.now(),
            };
        } catch {
            return null;
        }
    }
```

- [ ] **Step 2: Add getDxySignal() method**

```typescript
    // ── DXY — Dollar Index (inverse correlation) ─────────────────────

    /**
     * Dollar strength → INVERSE crypto signal.
     * Research: BTC-DXY correlation -0.4 to -0.8.
     * Strong dollar = bearish crypto, weak dollar = bullish crypto.
     */
    private async getDxySignal(): Promise<PsiSignal | null> {
        try {
            const raw = await this.redis.get('psinix:equity:uup');
            if (!raw) return null;

            const data = JSON.parse(raw);
            const age = Date.now() - (data.timestamp ?? 0);
            if (age > 15 * 60_000) return null;

            const changePct = data.changePct ?? 0;
            // INVERSE: dollar up = crypto down
            const direction = Math.max(-1, Math.min(1, -changePct / 1.5)); // ±1.5% = ±1.0
            if (Math.abs(direction) < 0.05) return null;

            return {
                sourceId: 'macro:dxy',
                direction,
                weight: 0.5, // Moderate-high — consistent inverse correlation
                timestamp: Date.now(),
            };
        } catch {
            return null;
        }
    }
```

- [ ] **Step 3: Add getMacroEvents() method**

```typescript
    // ── Aktienix Macro Events — FOMC, inflation, oil, recession ──────

    /**
     * Reads Aktienix macro event intelligence from Redis.
     * Aggregates bearish/bullish signals from active macro events.
     * Events like FOMC rate hikes, inflation surges, oil shocks → bearish crypto.
     */
    private async getMacroEvents(): Promise<PsiSignal | null> {
        try {
            // aktienix:macro:event_states is a Redis HASH
            const events = await this.redis.hgetall('aktienix:macro:event_states');
            if (!events || Object.keys(events).length === 0) return null;

            let bearishScore = 0;
            let bullishScore = 0;
            let eventCount = 0;

            // Crypto-relevant event types and their impact
            const cryptoImpact: Record<string, number> = {
                'fed_rate_hike': -0.8,      // Rate hikes → bearish crypto
                'fomc_statement_release': -0.3, // FOMC uncertainty
                'fomc_economic_projections': -0.2,
                'inflation_surge': -0.6,     // Inflation → hawkish Fed → bearish
                'recession_fear': -0.5,      // Risk-off → bearish crypto
                'oil_supply_shock': -0.4,    // Supply shock → inflation → bearish
                'middle_east_conflict': -0.3, // Geopolitical risk
                'trade_war_tariffs': -0.4,   // Trade uncertainty
                'ukraine_russia_escalation': -0.3,
            };

            for (const [eventId, rawValue] of Object.entries(events)) {
                try {
                    const event = JSON.parse(rawValue as string);
                    // Only consider active events (detected/developing)
                    if (event.phase === 'resolved') continue;

                    const impact = cryptoImpact[eventId] ?? 0;
                    if (impact === 0) continue;

                    const confidence = event.confidence ?? 0.5;
                    const score = impact * confidence;

                    if (score < 0) bearishScore += Math.abs(score);
                    else bullishScore += score;
                    eventCount++;
                } catch { continue; }
            }

            if (eventCount === 0) return null;

            const netScore = bullishScore - bearishScore;
            // Normalize: cap at ±1
            const direction = Math.max(-1, Math.min(1, netScore));
            if (Math.abs(direction) < 0.05) return null;

            return {
                sourceId: 'macro:events',
                direction,
                weight: 0.5,
                timestamp: Date.now(),
            };
        } catch {
            return null;
        }
    }
```

- [ ] **Step 4: Wire into collect() method**

Add after existing signals (before `return signals;`):

```typescript
        // ── Equity market (S&P 500 + NASDAQ) ──
        const equity = await this.getEquitySignal();
        if (equity) signals.push(equity);

        // ── DXY Dollar Index (inverse) ──
        const dxy = await this.getDxySignal();
        if (dxy) signals.push(dxy);

        // ── Aktienix Macro Events (FOMC, inflation, etc.) ──
        const macro = await this.getMacroEvents();
        if (macro) signals.push(macro);
```

- [ ] **Step 5: Extend RedisReader interface with hgetall**

```typescript
export interface RedisReader {
    get(key: string): Promise<string | null>;
    keys(pattern: string): Promise<string[]>;
    lrange(key: string, start: number, stop: number): Promise<string[]>;
    hgetall(key: string): Promise<Record<string, string> | null>; // NEW — for macro events hash
}
```

- [ ] **Step 6: Run tests**

Run: `npx tsx packages/agents/src/psinix/psi-engine.test.ts`
Expected: All pass (new methods are in collector, not engine)

- [ ] **Step 7: Commit**

```bash
git add packages/agents/src/psinix/signal-collector.ts
git commit -m "feat(psinix): add equity, DXY, macro event signals from Aktienix data"
```

---

### Task 3: Wire EquityFetcher + hgetall into PsinixAgent

Start the equity fetcher in initialize() and add hgetall to the Redis adapter.

**Files:**
- Modify: `packages/agents/src/psinix/psinix-agent.ts`
- Modify: `psinix.toml`

- [ ] **Step 1: Add to psinix.toml**

```toml
[equity]
# Finnhub API key (free tier: 60 calls/min). Empty = no equity data.
finnhub_api_key = ""
# Poll interval for equity quotes (ms) — 5 minutes
poll_interval_ms = 300000
```

- [ ] **Step 2: Update PsinixConfig interface**

Add to PsinixConfig:
```typescript
    equity: { finnhub_api_key: string; poll_interval_ms: number };
```

- [ ] **Step 3: Add to loadConfig defaults**

```typescript
equity: { finnhub_api_key: '', poll_interval_ms: 300_000 },
```

And in the parsed section:
```typescript
equity: { ...defaults.equity, ...(parsed as any).equity },
```

- [ ] **Step 4: Import and start EquityFetcher**

```typescript
import { EquityFetcher } from './equity-fetcher';

// Add field:
private equityFetcher: EquityFetcher | null = null;

// In initialize(), after Redis connect:
if (this.redis) {
    this.equityFetcher = new EquityFetcher(
        this.redis,
        this.config.equity.finnhub_api_key || undefined,
        this.config.equity.poll_interval_ms,
    );
    this.equityFetcher.start();
}
```

- [ ] **Step 5: Wire hgetall in Redis adapter**

Update the collector creation:
```typescript
this.collector = new SignalCollector({
    get: async (key: string) => this.redis.get(key),
    keys: async (pattern: string) => this.redis.keys(pattern),
    lrange: async (key: string, start: number, stop: number) => this.redis.lrange(key, start, stop),
    hgetall: async (key: string) => this.redis.hgetall(key),
});
```

- [ ] **Step 6: Stop fetcher in stop()**

```typescript
this.equityFetcher?.stop();
```

- [ ] **Step 7: Run all tests**

```bash
npx tsx packages/agents/src/psinix/psi-engine.test.ts
npx tsx packages/agents/src/psinix/bayesian-weights.test.ts
npx tsx packages/agents/src/psinix/price-signals.test.ts
```

- [ ] **Step 8: Commit**

```bash
git add packages/agents/src/psinix/psinix-agent.ts psinix.toml
git commit -m "feat(psinix): wire equity fetcher + hgetall for macro events"
```

---

### Task 4: Deploy and Verify

- [ ] **Step 1: Deploy**

```bash
git archive --format=tar HEAD | ssh azureuser@openclaw-vm "cd ~/cryonix && tar xf -"
ssh azureuser@openclaw-vm "cd ~/cryonix && docker compose -f docker-compose.prod.yml up -d --build psinix"
```

- [ ] **Step 2: Wait 2 minutes, check signals**

```bash
ssh azureuser@openclaw-vm "docker logs cryonix-psinix-1 --tail 20"
```

Expected: 4-6 signals per symbol (price×3 + polymarket + regime + equity/dxy/macro).
If Finnhub key not set: equity/DXY won't fire, but macro events will (read from Aktienix data).

- [ ] **Step 3: Verify macro events are being read**

```bash
ssh azureuser@openclaw-vm "docker logs cryonix-psinix-1 2>&1 | grep 'macro:events'"
```

Even without Finnhub key, macro events from Aktienix should provide a new independent signal source (FOMC, inflation data already in Redis).
