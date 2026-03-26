# Ψnix Research & Validation Framework — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform Ψnix from a prototype with synthetic data into a validated research platform with real market data, adaptive weights, comprehensive backtesting, and full test coverage.

**Architecture:** Replace synthetic entropy with real Binance OHLCV via ccxt. Add Cryonix TA signal collection from Redis `trades:pending`. Implement Bayesian weight updating that learns from trade outcomes. Build a backtesting engine that replays historical data through the Ψ function. All changes are test-first.

**Tech Stack:** TypeScript, ccxt (public API, no auth), ioredis, node:test, Postgres (psinix_trades)

---

## File Structure

| File | Responsibility |
|------|---------------|
| `packages/agents/src/psinix/psi-engine.ts` | Core Ψ computation (modify: add Bayesian update method) |
| `packages/agents/src/psinix/signal-collector.ts` | Signal aggregation (modify: add cryonix_ta + market regime) |
| `packages/agents/src/psinix/psinix-agent.ts` | Main agent (modify: real OHLCV, Bayesian feedback loop) |
| `packages/agents/src/psinix/bayesian-weights.ts` | **NEW** — Bayesian posterior weight tracker |
| `packages/agents/src/psinix/ohlcv-fetcher.ts` | **NEW** — Real OHLCV via ccxt (public, no auth) |
| `packages/agents/src/psinix/backtester.ts` | **NEW** — Historical Ψ replay engine |
| `packages/agents/src/psinix/psi-engine.test.ts` | Unit tests (modify: add Bayesian + integration tests) |
| `packages/agents/src/psinix/bayesian-weights.test.ts` | **NEW** — Bayesian weight update tests |
| `packages/agents/src/psinix/backtester.test.ts` | **NEW** — Backtester validation tests |
| `scripts/strategy-lab/psinix_backtest.ts` | **NEW** — CLI backtest runner with real Binance data |
| `Dockerfile.psinix` | Modify: add ccxt dependency |

---

### Task 1: Real OHLCV Data — Replace Synthetic Entropy

The entropy calculation is the β parameter in Ψ. Currently it uses random noise (meaningless). We need real Binance OHLCV candles via ccxt public API (no auth needed).

**Files:**
- Create: `packages/agents/src/psinix/ohlcv-fetcher.ts`
- Modify: `packages/agents/src/psinix/psinix-agent.ts:438-451`
- Modify: `Dockerfile.psinix`

- [ ] **Step 1: Add ccxt to Dockerfile**

```dockerfile
# In Dockerfile.psinix, add ccxt to npm install line
RUN npm install --no-save \
    @iarna/toml@2 \
    dotenv@16 \
    ioredis@5 \
    pg@8 \
    ws@8 \
    zod@3 \
    tsx@4 \
    typescript@5 \
    ccxt@4

# Also add COPY for backtest script (after existing COPY lines):
COPY scripts/strategy-lab/psinix_backtest.ts ./scripts/strategy-lab/
```

- [ ] **Step 2: Create ohlcv-fetcher.ts with tests inline**

```typescript
// packages/agents/src/psinix/ohlcv-fetcher.ts
/**
 * OHLCVFetcher — Real Binance candle data for entropy calculation.
 * Uses ccxt public API (no authentication needed).
 * Caches candles per symbol+timeframe with configurable TTL.
 */

interface Candle {
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

export class OHLCVFetcher {
    private exchange: any = null;
    private cache = new Map<string, { candles: Candle[]; fetchedAt: number }>();
    private cacheTtlMs: number;

    constructor(cacheTtlMs: number = 60_000) {
        this.cacheTtlMs = cacheTtlMs;
    }

    async initialize(): Promise<void> {
        try {
            const ccxt = await import('ccxt');
            const Binance = (ccxt as any).binance ?? (ccxt as any).default?.binance;
            this.exchange = new Binance({ enableRateLimit: true });
            console.log('[ohlcv] Binance public API connected');
        } catch (err: any) {
            console.warn('[ohlcv] ccxt init failed:', err.message);
        }
    }

    /**
     * Fetch recent close prices for entropy calculation.
     * Returns array of close prices (most recent last).
     */
    async getClosePrices(symbol: string, timeframe: string = '15m', limit: number = 50): Promise<number[]> {
        const candles = await this.getCandles(symbol, timeframe, limit);
        return candles.map(c => c.close);
    }

    /**
     * Fetch OHLCV candles with caching.
     */
    async getCandles(symbol: string, timeframe: string = '15m', limit: number = 50): Promise<Candle[]> {
        if (!this.exchange) return [];

        const cacheKey = `${symbol}:${timeframe}`;
        const cached = this.cache.get(cacheKey);
        if (cached && Date.now() - cached.fetchedAt < this.cacheTtlMs) {
            return cached.candles;
        }

        try {
            const raw = await this.exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
            const candles: Candle[] = raw.map((r: any[]) => ({
                timestamp: r[0],
                open: r[1],
                high: r[2],
                low: r[3],
                close: r[4],
                volume: r[5],
            }));
            this.cache.set(cacheKey, { candles, fetchedAt: Date.now() });
            return candles;
        } catch (err: any) {
            console.warn(`[ohlcv] Fetch ${symbol} ${timeframe} failed:`, err.message);
            return cached?.candles ?? [];
        }
    }

    /**
     * Get ATR (Average True Range) for volatility context.
     */
    async getATR(symbol: string, period: number = 14): Promise<number> {
        const candles = await this.getCandles(symbol, '15m', period + 1);
        if (candles.length < 2) return 0;

        let trSum = 0;
        for (let i = 1; i < candles.length; i++) {
            const c = candles[i];
            const prevClose = candles[i - 1].close;
            const tr = Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
            trSum += tr;
        }
        return trSum / (candles.length - 1);
    }
}
```

- [ ] **Step 3: Wire OHLCVFetcher into psinix-agent.ts**

Replace the synthetic `getRecentPrices()` and CoinGecko `updatePrices()`:

```typescript
// In psinix-agent.ts — add import at top
import { OHLCVFetcher } from './ohlcv-fetcher';

// Add to class fields
private ohlcv = new OHLCVFetcher(60_000); // 1min cache

// In initialize():
await this.ohlcv.initialize();

// Replace getRecentPrices():
private async getRecentPrices(symbol: string): Promise<number[]> {
    return this.ohlcv.getClosePrices(symbol, '15m', 50);
}

// Replace updatePrices():
private async updatePrices(): Promise<void> {
    for (const symbol of this.config.trading.symbols) {
        const prices = await this.ohlcv.getClosePrices(symbol, '15m', 1);
        if (prices.length > 0) {
            this.priceCache.set(symbol, prices[prices.length - 1]);
        }
    }
}
```

- [ ] **Step 4: Run existing tests to verify no regression**

Run: `cd packages/agents/src/psinix && npx tsx psi-engine.test.ts`
Expected: All 15+ assertions pass (pure math tests, no external deps)

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/psinix/ohlcv-fetcher.ts packages/agents/src/psinix/psinix-agent.ts Dockerfile.psinix
git commit -m "feat(psinix): replace synthetic entropy with real Binance OHLCV via ccxt"
```

---

### Task 2: Cryonix TA Signal Collection

The Python engine writes signals to `trades:pending` Redis queue. Psinix should read these and convert to PsiSignals. Also read `market:regime` for market state context.

**Files:**
- Modify: `packages/agents/src/psinix/signal-collector.ts`

- [ ] **Step 1: Write failing test for TA signal parsing**

Add to `psi-engine.test.ts` (add import at top: `import { SignalCollector } from './signal-collector';`):

```typescript
test('parseTASignal: converts trades:pending JSON to PsiSignal', () => {
    const raw = JSON.stringify({
        symbol: 'BTC/USDC',
        action: 'BUY',
        confidence: 82,
        patterns: ['dip_buy', 'rsi_oversold'],
        timestamp: Date.now(),
    });
    const signal = SignalCollector.parseTASignal(raw, 'BTC');
    assert(signal !== null, 'Should parse valid signal');
    assert(signal!.direction > 0, 'BUY → positive direction');
    assertApprox(signal!.direction, 0.64, 0.01, 'confidence 82 → (82-50)/50 = 0.64');
    assertApprox(signal!.weight, 0.7, 0.01, 'TA weight should be 0.7');
});

test('parseTASignal: SELL → negative direction', () => {
    const raw = JSON.stringify({ symbol: 'ETH/USDC', action: 'SELL', confidence: 90 });
    const signal = SignalCollector.parseTASignal(raw, 'ETH');
    assert(signal !== null, 'Should parse');
    assert(signal!.direction < 0, 'SELL → negative direction');
});

test('parseTASignal: filters by symbol base', () => {
    const raw = JSON.stringify({ symbol: 'SOL/USDC', action: 'BUY', confidence: 75 });
    const signal = SignalCollector.parseTASignal(raw, 'BTC');
    assert(signal === null, 'SOL signal should be null when filtering for BTC');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx packages/agents/src/psinix/psi-engine.test.ts`
Expected: FAIL — `parseTASignal` not defined

- [ ] **Step 3: Implement TA signal collection in signal-collector.ts**

Add two methods to `SignalCollector`:

First, extend the `RedisReader` interface to support list operations:

```typescript
export interface RedisReader {
    get(key: string): Promise<string | null>;
    keys(pattern: string): Promise<string[]>;
    lrange(key: string, start: number, stop: number): Promise<string[]>; // NEW — trades:pending is a list
}
```

Then update the adapter in `psinix-agent.ts:148-151`:

```typescript
this.collector = new SignalCollector({
    get: async (key: string) => this.redis.get(key),
    keys: async (pattern: string) => this.redis.keys(pattern),
    lrange: async (key: string, start: number, stop: number) => this.redis.lrange(key, start, stop),
});
```

Now the TA signal method:

```typescript
/**
 * Cryonix TA: Read trades:pending queue (Redis LIST) for recent signals.
 * Converts confidence (0-100) → σ = (confidence-50)/50 × direction
 */
private async getCryonixTA(symbol: string): Promise<PsiSignal | null> {
    try {
        const base = symbol.split('/')[0];
        // trades:pending is a Redis LIST (engine uses rpush/lrange)
        const entries = await this.redis.lrange('trades:pending', 0, -1);
        if (!entries || entries.length === 0) return null;

        // Find most recent signal matching this symbol
        for (let i = entries.length - 1; i >= 0; i--) {
            const signal = SignalCollector.parseTASignal(entries[i], base);
            if (signal) return signal;
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * Market regime signal: trending/volatile/ranging affects conviction.
 */
private async getMarketRegime(): Promise<PsiSignal | null> {
    try {
        const raw = await this.redis.get('market:regime');
        if (!raw) return null;
        const data = JSON.parse(raw);
        // trending = positive (bull), volatile = cautious (0), ranging = slightly negative
        const regimeMap: Record<string, number> = {
            'bullish': 0.5, 'trending_up': 0.5,
            'bearish': -0.5, 'trending_down': -0.5,
            'volatile': 0, 'choppy': -0.2,
            'ranging': 0, 'neutral': 0,
        };
        const direction = regimeMap[data.regime ?? data.state ?? ''] ?? 0;
        if (direction === 0) return null;
        return {
            sourceId: 'market:regime',
            direction,
            weight: 0.3,
            timestamp: Date.now(),
        };
    } catch {
        return null;
    }
}

/**
 * Static helper for parsing a single TA signal JSON.
 */
static parseTASignal(raw: string, filterBase: string): PsiSignal | null {
    try {
        const data = JSON.parse(raw);
        const signalBase = (data.symbol ?? '').split('/')[0];
        if (signalBase !== filterBase) return null;

        const confidence = data.confidence ?? 50;
        const isBuy = (data.action ?? '').toUpperCase() === 'BUY';
        // Map confidence 0-100 → direction magnitude, then apply sign
        const magnitude = (confidence - 50) / 50; // 0-1 range for >50 confidence
        const direction = isBuy ? magnitude : -magnitude;

        return {
            sourceId: `cryonix_ta:${signalBase}`,
            direction: Math.max(-1, Math.min(1, direction)),
            weight: 0.7, // High weight — quantitative TA
            timestamp: data.timestamp ?? Date.now(),
        };
    } catch {
        return null;
    }
}
```

Wire into `collect()`:

```typescript
async collect(symbol: string): Promise<PsiSignal[]> {
    const signals: PsiSignal[] = [];

    // 1. Smart Money
    const smartMoney = await this.getSmartMoney(symbol);
    if (smartMoney) signals.push(smartMoney);

    // 2. Polymarket
    const polySignals = await this.getPolymarketSignals();
    signals.push(...polySignals);

    // 3. Fear & Greed
    const fng = await this.getFearAndGreed();
    if (fng) signals.push(fng);

    // 4. Smart Money overall
    const overall = await this.getSmartMoneyOverall();
    if (overall) signals.push(overall);

    // 5. Cryonix TA (NEW)
    const ta = await this.getCryonixTA(symbol);
    if (ta) signals.push(ta);

    // 6. Market Regime (NEW)
    const regime = await this.getMarketRegime();
    if (regime) signals.push(regime);

    return signals;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx packages/agents/src/psinix/psi-engine.test.ts`
Expected: All old + new tests pass

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/psinix/signal-collector.ts packages/agents/src/psinix/psi-engine.test.ts
git commit -m "feat(psinix): add cryonix_ta + market regime signal sources"
```

---

### Task 3: Bayesian Weight Updating

Currently all signal weights are hardcoded. Implement a Bayesian posterior tracker that adjusts weights based on whether a signal source's direction aligned with actual trade outcomes.

**Files:**
- Create: `packages/agents/src/psinix/bayesian-weights.ts`
- Create: `packages/agents/src/psinix/bayesian-weights.test.ts`
- Modify: `packages/agents/src/psinix/psinix-agent.ts`
- Modify: `packages/agents/src/psinix/signal-collector.ts`

- [ ] **Step 1: Write failing tests for Bayesian weight tracker**

```typescript
// packages/agents/src/psinix/bayesian-weights.test.ts
import { BayesianWeightTracker } from './bayesian-weights';

function assert(condition: boolean, msg: string): void {
    if (!condition) throw new Error(`FAIL: ${msg}`);
    console.log(`  ✓ ${msg}`);
}

async function runTests(): Promise<void> {
    let passed = 0;
    let failed = 0;

    const test = (name: string, fn: () => void) => {
        console.log(`\n── ${name} ──`);
        try { fn(); passed++; } catch (err) {
            console.error(`  ✗ ${err instanceof Error ? err.message : String(err)}`);
            failed++;
        }
    };

    test('Initial weight is prior (0.5)', () => {
        const tracker = new BayesianWeightTracker();
        const w = tracker.getWeight('polymarket:crypto');
        assert(w === 0.5, `Expected 0.5, got ${w}`);
    });

    test('Correct prediction increases weight', () => {
        const tracker = new BayesianWeightTracker();
        const before = tracker.getWeight('smartmoney:BTC');
        // Signal said BUY (+0.8), trade was profitable → correct
        tracker.update('smartmoney:BTC', 0.8, true);
        const after = tracker.getWeight('smartmoney:BTC');
        assert(after > before, `Weight should increase: ${before} → ${after}`);
    });

    test('Wrong prediction decreases weight', () => {
        const tracker = new BayesianWeightTracker();
        tracker.update('fear_greed', 0.5, false);
        const w = tracker.getWeight('fear_greed');
        assert(w < 0.5, `Weight should decrease: got ${w}`);
    });

    test('Weight bounded [0.1, 0.95]', () => {
        const tracker = new BayesianWeightTracker();
        for (let i = 0; i < 100; i++) tracker.update('test', 1.0, true);
        assert(tracker.getWeight('test') <= 0.95, 'Should not exceed 0.95');
        const t2 = new BayesianWeightTracker();
        for (let i = 0; i < 100; i++) t2.update('test2', 1.0, false);
        assert(t2.getWeight('test2') >= 0.1, 'Should not go below 0.1');
    });

    test('Serialization roundtrip preserves state', () => {
        const tracker = new BayesianWeightTracker();
        tracker.update('a', 0.7, true);
        tracker.update('b', -0.3, false);
        const json = tracker.serialize();
        const restored = BayesianWeightTracker.deserialize(json);
        assert(restored.getWeight('a') === tracker.getWeight('a'), 'Weight a preserved');
        assert(restored.getWeight('b') === tracker.getWeight('b'), 'Weight b preserved');
    });

    test('Decay: old observations fade', () => {
        const tracker = new BayesianWeightTracker(0.95); // decay factor
        tracker.update('src', 1.0, true);
        tracker.update('src', 1.0, true);
        const w1 = tracker.getWeight('src');
        // Apply many wrong observations
        for (let i = 0; i < 5; i++) tracker.update('src', 1.0, false);
        const w2 = tracker.getWeight('src');
        assert(w2 < w1, `Should decay: ${w1} → ${w2}`);
    });

    console.log(`\n${'═'.repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    console.log(`${'═'.repeat(50)}\n`);
    if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx packages/agents/src/psinix/bayesian-weights.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement BayesianWeightTracker**

```typescript
// packages/agents/src/psinix/bayesian-weights.ts
/**
 * BayesianWeightTracker — Adaptive signal source weighting.
 *
 * Each signal source has a "reliability" posterior that starts at prior=0.5.
 * After each trade, we update: if the source's direction aligned with
 * the trade outcome (profitable=true), its posterior increases.
 *
 * Uses exponential moving Bayesian update with decay:
 *   posterior = decay × prior + (1-decay) × likelihood
 *
 * Output weight ∈ [0.1, 0.95] — never fully trust or distrust a source.
 */

interface SourceState {
    posterior: number;   // Current reliability estimate (0-1)
    hits: number;        // Correct predictions
    misses: number;      // Incorrect predictions
    lastUpdate: number;  // Timestamp of last update
}

export class BayesianWeightTracker {
    private sources = new Map<string, SourceState>();
    private decay: number;
    private prior = 0.5;
    private minWeight = 0.1;
    private maxWeight = 0.95;

    constructor(decay: number = 0.92) {
        this.decay = decay;
    }

    getWeight(sourceId: string): number {
        return this.sources.get(sourceId)?.posterior ?? this.prior;
    }

    /**
     * Update a source's reliability based on trade outcome.
     *
     * @param sourceId   Signal source identifier
     * @param direction  The direction the source signaled (-1 to +1)
     * @param profitable Whether the resulting trade was profitable
     */
    update(sourceId: string, direction: number, profitable: boolean): void {
        const state = this.sources.get(sourceId) ?? {
            posterior: this.prior,
            hits: 0,
            misses: 0,
            lastUpdate: Date.now(),
        };

        // Likelihood: did this source's direction agree with outcome?
        // Strong directional signal that was correct → high likelihood
        const magnitude = Math.abs(direction);
        const likelihood = profitable ? 0.5 + 0.5 * magnitude : 0.5 - 0.5 * magnitude;

        // Bayesian update with decay (exponential moving average)
        state.posterior = this.decay * state.posterior + (1 - this.decay) * likelihood;

        // Clamp to bounds
        state.posterior = Math.max(this.minWeight, Math.min(this.maxWeight, state.posterior));

        if (profitable) state.hits++;
        else state.misses++;
        state.lastUpdate = Date.now();

        this.sources.set(sourceId, state);
    }

    /**
     * Get all weights as a map (for logging/debugging).
     */
    getAll(): Map<string, number> {
        const result = new Map<string, number>();
        for (const [id, state] of this.sources) {
            result.set(id, state.posterior);
        }
        return result;
    }

    /**
     * Serialize to JSON string for Redis persistence.
     */
    serialize(): string {
        const data: Record<string, SourceState> = {};
        for (const [id, state] of this.sources) {
            data[id] = state;
        }
        return JSON.stringify(data);
    }

    /**
     * Restore from serialized JSON.
     */
    static deserialize(json: string, decay?: number): BayesianWeightTracker {
        const tracker = new BayesianWeightTracker(decay);
        try {
            const data = JSON.parse(json) as Record<string, SourceState>;
            for (const [id, state] of Object.entries(data)) {
                tracker.sources.set(id, state);
            }
        } catch { /* start fresh */ }
        return tracker;
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx packages/agents/src/psinix/bayesian-weights.test.ts`
Expected: All 6 tests pass

- [ ] **Step 5: Wire into psinix-agent.ts**

Add to PsinixAgent class:

```typescript
// Import
import { BayesianWeightTracker } from './bayesian-weights';

// Field
private weights = new BayesianWeightTracker(0.92);

// In initialize() — restore from Redis:
try {
    const saved = await this.redis?.get('psinix:weights');
    if (saved) this.weights = BayesianWeightTracker.deserialize(saved, 0.92);
} catch {}

// In evaluateSymbol() — apply dynamic weights before compute:
for (const sig of signals) {
    const dynWeight = this.weights.getWeight(sig.sourceId);
    sig.weight = dynWeight;
}

// Add to PaperPosition interface:
// signalSourceIds: string[];  // Track which sources contributed to this entry

// In executeTrade() — store source IDs on position:
// signalSourceIds: signals.map(s => s.sourceId),

// In closePosition() — update only the sources that contributed:
const profitable = pnl > 0;
for (const sourceId of pos.signalSourceIds) {
    this.weights.update(sourceId, pos.side === 'LONG' ? 1 : -1, profitable);
}
// Persist to Redis
try {
    await this.redis?.set('psinix:weights', this.weights.serialize());
} catch {}

// In publishState() — include weights for observability:
const state = {
    ...existingState,
    weights: Object.fromEntries(this.weights.getAll()),
};
```

- [ ] **Step 6: Run all tests**

Run: `npx tsx packages/agents/src/psinix/psi-engine.test.ts && npx tsx packages/agents/src/psinix/bayesian-weights.test.ts`
Expected: All pass

- [ ] **Step 7: Commit**

```bash
git add packages/agents/src/psinix/bayesian-weights.ts packages/agents/src/psinix/bayesian-weights.test.ts packages/agents/src/psinix/psinix-agent.ts
git commit -m "feat(psinix): add Bayesian weight updating — signals learn from trade outcomes"
```

---

### Task 4: Backtesting Engine

Build a backtester that replays historical OHLCV data through the Ψ function with simulated signals to validate the phase convergence hypothesis.

**Files:**
- Create: `packages/agents/src/psinix/backtester.ts`
- Create: `packages/agents/src/psinix/backtester.test.ts`

- [ ] **Step 1: Write failing test for backtester**

```typescript
// packages/agents/src/psinix/backtester.test.ts
import { PsinixBacktester, type BacktestConfig } from './backtester';

function assert(condition: boolean, msg: string): void {
    if (!condition) throw new Error(`FAIL: ${msg}`);
    console.log(`  ✓ ${msg}`);
}

async function runTests(): Promise<void> {
    let passed = 0;
    let failed = 0;

    const test = (name: string, fn: () => void) => {
        console.log(`\n── ${name} ──`);
        try { fn(); passed++; } catch (err) {
            console.error(`  ✗ ${err instanceof Error ? err.message : String(err)}`);
            failed++;
        }
    };

    // Create trending up price series
    const trendUp: number[] = [];
    for (let i = 0; i < 200; i++) trendUp.push(100 + i * 0.5 + (Math.random() - 0.5) * 2);

    // Create choppy/ranging price series
    const choppy: number[] = [];
    for (let i = 0; i < 200; i++) choppy.push(100 + Math.sin(i * 0.3) * 5 + (Math.random() - 0.5) * 3);

    const defaultConfig: BacktestConfig = {
        phaseTransitionThreshold: 0.6,
        kellyFractionCap: 0.25,
        minPsiMagnitude: 0.05,
        maxPositionSizeUsd: 200,
        takeProfitPct: 5,
        stopLossPct: 3,
        trailingStopPct: 2,
        trailingActivationPct: 2.5,
        initialBalance: 1000,
    };

    test('Backtester returns valid result structure', () => {
        const bt = new PsinixBacktester(defaultConfig);
        const result = bt.run(trendUp, []);
        assert(typeof result.totalPnl === 'number', 'Has totalPnl');
        assert(typeof result.winRate === 'number', 'Has winRate');
        assert(typeof result.maxDrawdownPct === 'number', 'Has maxDrawdownPct');
        assert(typeof result.sharpeRatio === 'number', 'Has sharpeRatio');
        assert(Array.isArray(result.trades), 'Has trades array');
        assert(result.equityCurve.length > 0, 'Has equity curve');
    });

    test('No trades when signals disagree (C ≈ 0)', () => {
        const bt = new PsinixBacktester(defaultConfig);
        // Force disagreeing signals: alternate BUY/SELL
        const signals = choppy.map((_, i) => ({
            sources: [
                { id: 'a', direction: i % 2 === 0 ? 1 : -1, weight: 0.5 },
                { id: 'b', direction: i % 2 === 0 ? -1 : 1, weight: 0.5 },
            ],
        }));
        const result = bt.run(choppy, signals);
        assert(result.trades.length === 0, `Expected 0 trades, got ${result.trades.length}`);
    });

    test('Trades occur when signals agree (C ≈ 1)', () => {
        const bt = new PsinixBacktester(defaultConfig);
        const signals = trendUp.map(() => ({
            sources: [
                { id: 'a', direction: 0.8, weight: 0.7 },
                { id: 'b', direction: 0.9, weight: 0.6 },
                { id: 'c', direction: 0.7, weight: 0.5 },
            ],
        }));
        const result = bt.run(trendUp, signals);
        assert(result.trades.length > 0, `Expected trades, got ${result.trades.length}`);
    });

    test('Equity curve starts at initial balance', () => {
        const bt = new PsinixBacktester(defaultConfig);
        const result = bt.run(trendUp, []);
        assert(result.equityCurve[0] === 1000, `Expected 1000, got ${result.equityCurve[0]}`);
    });

    test('Max drawdown is non-negative', () => {
        const bt = new PsinixBacktester(defaultConfig);
        const signals = trendUp.map(() => ({
            sources: [
                { id: 'a', direction: 0.9, weight: 0.8 },
                { id: 'b', direction: 0.85, weight: 0.7 },
            ],
        }));
        const result = bt.run(trendUp, signals);
        assert(result.maxDrawdownPct >= 0, 'Max drawdown should be >= 0');
    });

    console.log(`\n${'═'.repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    console.log(`${'═'.repeat(50)}\n`);
    if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx packages/agents/src/psinix/backtester.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement backtester**

```typescript
// packages/agents/src/psinix/backtester.ts
/**
 * PsinixBacktester — Replay historical data through the Ψ function.
 *
 * Validates the phase convergence hypothesis by computing Ψ at each
 * timestep with simulated or real signal inputs, executing paper trades,
 * and computing performance metrics.
 */

import { PsiEngine, type PsiSignal } from './psi-engine';

export interface BacktestConfig {
    phaseTransitionThreshold: number;
    kellyFractionCap: number;
    minPsiMagnitude: number;
    maxPositionSizeUsd: number;
    takeProfitPct: number;
    stopLossPct: number;
    trailingStopPct: number;
    trailingActivationPct: number;
    initialBalance: number;
}

export interface SignalSnapshot {
    sources: Array<{ id: string; direction: number; weight: number }>;
}

interface BTPosition {
    entryPrice: number;
    qty: number;
    side: 'LONG' | 'SHORT';
    psi: number;
    coherence: number;
    highWatermark: number;
    trailingActive: boolean;
    entryIdx: number;
}

interface BTTrade {
    entryIdx: number;
    exitIdx: number;
    side: 'LONG' | 'SHORT';
    entryPrice: number;
    exitPrice: number;
    pnl: number;
    psi: number;
    coherence: number;
    reason: string;
}

export interface BacktestResult {
    trades: BTTrade[];
    totalPnl: number;
    winRate: number;
    wins: number;
    losses: number;
    maxDrawdownPct: number;
    sharpeRatio: number;
    equityCurve: number[];
    avgCoherenceAtEntry: number;
    avgPsiAtEntry: number;
    totalBars: number;
}

export class PsinixBacktester {
    private config: BacktestConfig;

    constructor(config: BacktestConfig) {
        this.config = config;
    }

    /**
     * Run backtest on a price series with optional signal snapshots.
     *
     * @param prices    Array of close prices (chronological)
     * @param signals   Optional per-bar signal snapshots. If empty, no trades generated.
     */
    run(prices: number[], signals: SignalSnapshot[]): BacktestResult {
        const trades: BTTrade[] = [];
        const equityCurve: number[] = [this.config.initialBalance];
        let balance = this.config.initialBalance;
        let position: BTPosition | null = null;
        let wins = 0;
        let losses = 0;
        let peakEquity = balance;
        let maxDrawdownPct = 0;

        // Need at least 20 bars for entropy window
        const entropyWindow = 20;

        for (let i = entropyWindow; i < prices.length; i++) {
            const price = prices[i];

            // Check exits
            if (position) {
                const dir = position.side === 'LONG' ? 1 : -1;
                const pnlPct = ((price - position.entryPrice) / position.entryPrice) * 100 * dir;

                // High watermark
                if (position.side === 'LONG' && price > position.highWatermark) position.highWatermark = price;
                if (position.side === 'SHORT' && price < position.highWatermark) position.highWatermark = price;

                let exitReason: string | null = null;

                if (pnlPct <= -this.config.stopLossPct) {
                    exitReason = 'SL';
                } else if (pnlPct >= this.config.takeProfitPct) {
                    exitReason = 'TP';
                } else {
                    if (pnlPct >= this.config.trailingActivationPct) position.trailingActive = true;
                    if (position.trailingActive) {
                        const hwmPnl = position.side === 'LONG'
                            ? ((position.highWatermark - position.entryPrice) / position.entryPrice) * 100
                            : ((position.entryPrice - position.highWatermark) / position.entryPrice) * 100;
                        if (hwmPnl - pnlPct >= this.config.trailingStopPct) exitReason = 'TRAIL';
                    }
                }

                if (exitReason) {
                    const pnl = (price - position.entryPrice) * position.qty * dir;
                    balance += position.qty * price;
                    if (pnl > 0) wins++; else losses++;
                    trades.push({
                        entryIdx: position.entryIdx,
                        exitIdx: i,
                        side: position.side,
                        entryPrice: position.entryPrice,
                        exitPrice: price,
                        pnl,
                        psi: position.psi,
                        coherence: position.coherence,
                        reason: exitReason,
                    });
                    position = null;
                }
            }

            // Compute Ψ if signals available and no position
            if (!position && i < signals.length && signals[i]?.sources?.length >= 2) {
                const psiSignals: PsiSignal[] = signals[i].sources.map(s => ({
                    sourceId: s.id,
                    direction: s.direction,
                    weight: s.weight,
                    timestamp: 0,
                }));

                const priceWindow = prices.slice(i - entropyWindow, i);
                const entropy = PsiEngine.computeMarketEntropy(priceWindow);
                const wr = wins + losses > 0 ? wins / (wins + losses) : 0.5;
                const result = PsiEngine.compute(psiSignals, entropy, wr, 1.5);

                if (result.phaseTransition && Math.abs(result.psi) >= this.config.minPsiMagnitude) {
                    const dollarSize = Math.min(
                        Math.abs(result.psi) * this.config.maxPositionSizeUsd,
                        balance * 0.2,
                    );
                    if (dollarSize >= 5 && balance >= dollarSize) {
                        const qty = dollarSize / price;
                        balance -= dollarSize;
                        position = {
                            entryPrice: price,
                            qty,
                            side: result.psi > 0 ? 'LONG' : 'SHORT',
                            psi: result.psi,
                            coherence: result.coherence,
                            highWatermark: price,
                            trailingActive: false,
                            entryIdx: i,
                        };
                    }
                }
            }

            // Equity curve
            const posValue = position ? position.qty * price : 0;
            const equity = balance + posValue;
            equityCurve.push(equity);

            if (equity > peakEquity) peakEquity = equity;
            const dd = peakEquity > 0 ? ((peakEquity - equity) / peakEquity) * 100 : 0;
            if (dd > maxDrawdownPct) maxDrawdownPct = dd;
        }

        // Close any open position at last price
        if (position) {
            const lastPrice = prices[prices.length - 1];
            const dir = position.side === 'LONG' ? 1 : -1;
            const pnl = (lastPrice - position.entryPrice) * position.qty * dir;
            balance += position.qty * lastPrice;
            if (pnl > 0) wins++; else losses++;
            trades.push({
                entryIdx: position.entryIdx,
                exitIdx: prices.length - 1,
                side: position.side,
                entryPrice: position.entryPrice,
                exitPrice: lastPrice,
                pnl,
                psi: position.psi,
                coherence: position.coherence,
                reason: 'EOD',
            });
        }

        // Sharpe ratio (daily-ish returns from equity curve)
        const returns: number[] = [];
        for (let i = 1; i < equityCurve.length; i++) {
            if (equityCurve[i - 1] > 0) {
                returns.push((equityCurve[i] - equityCurve[i - 1]) / equityCurve[i - 1]);
            }
        }
        const avgReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
        const stdReturn = returns.length > 1
            ? Math.sqrt(returns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / (returns.length - 1))
            : 1;
        const sharpeRatio = stdReturn > 0 ? (avgReturn / stdReturn) * Math.sqrt(252) : 0;

        const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
        const avgCoherence = trades.length > 0 ? trades.reduce((s, t) => s + t.coherence, 0) / trades.length : 0;
        const avgPsi = trades.length > 0 ? trades.reduce((s, t) => s + Math.abs(t.psi), 0) / trades.length : 0;

        return {
            trades,
            totalPnl,
            winRate: wins + losses > 0 ? wins / (wins + losses) : 0,
            wins,
            losses,
            maxDrawdownPct,
            sharpeRatio,
            equityCurve,
            avgCoherenceAtEntry: avgCoherence,
            avgPsiAtEntry: avgPsi,
            totalBars: prices.length,
        };
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx packages/agents/src/psinix/backtester.test.ts`
Expected: All 5 tests pass

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/psinix/backtester.ts packages/agents/src/psinix/backtester.test.ts
git commit -m "feat(psinix): add backtesting engine for Ψ function validation"
```

---

### Task 5: CLI Backtest Runner

Create a script that fetches real Binance data and runs the backtester, outputting results to stdout and optionally to Postgres.

**Files:**
- Create: `scripts/strategy-lab/psinix_backtest.ts`

- [ ] **Step 1: Create CLI backtest runner**

```typescript
// scripts/strategy-lab/psinix_backtest.ts
/**
 * Ψnix Backtest Runner — Run phase convergence backtests on real data.
 *
 * Usage:
 *   npx tsx scripts/strategy-lab/psinix_backtest.ts --symbol BTC/USDC --days 30
 *   npx tsx scripts/strategy-lab/psinix_backtest.ts --symbol ETH/USDC --days 90 --json
 *
 * Runs inside Docker:
 *   docker exec cryonix-psinix-1 npx tsx /app/scripts/strategy-lab/psinix_backtest.ts --symbol BTC/USDC --days 30
 */

import { PsinixBacktester, type BacktestConfig, type SignalSnapshot } from '../../packages/agents/src/psinix/backtester';
import { PsiEngine } from '../../packages/agents/src/psinix/psi-engine';

async function main() {
    const args = process.argv.slice(2);
    const symbol = args[args.indexOf('--symbol') + 1] ?? 'BTC/USDC';
    const days = parseInt(args[args.indexOf('--days') + 1] ?? '30');
    const jsonOutput = args.includes('--json');
    const timeframe = args[args.indexOf('--tf') + 1] ?? '15m';

    console.log(`\n  Ψnix Backtest — ${symbol} — ${days} days — ${timeframe}\n`);

    // Fetch OHLCV data
    const ccxt = await import('ccxt');
    const Binance = (ccxt as any).binance ?? (ccxt as any).default?.binance;
    const exchange = new Binance({ enableRateLimit: true });

    const barsPerDay: Record<string, number> = { '5m': 288, '15m': 96, '1h': 24, '4h': 6, '1d': 1 };
    const limit = Math.min((barsPerDay[timeframe] ?? 96) * days, 1000);

    console.log(`  Fetching ${limit} candles...`);
    const ohlcv = await exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
    const prices = ohlcv.map((c: any[]) => c[4]); // close prices

    console.log(`  Got ${prices.length} candles ($${prices[0]?.toFixed(2)} → $${prices[prices.length - 1]?.toFixed(2)})\n`);

    // Generate synthetic signals for hypothesis testing
    // Strategy: use price momentum + entropy as proxy signals
    const signals: SignalSnapshot[] = prices.map((_, i) => {
        if (i < 20) return { sources: [] };

        const window = prices.slice(i - 20, i);
        const sma5 = window.slice(-5).reduce((a, b) => a + b, 0) / 5;
        const sma20 = window.reduce((a, b) => a + b, 0) / 20;
        const momentumDir = sma5 > sma20 ? 0.7 : -0.7;

        const returns = [];
        for (let j = 1; j < window.length; j++) {
            returns.push((window[j] - window[j - 1]) / window[j - 1]);
        }
        const avgRet = returns.reduce((a, b) => a + b, 0) / returns.length;
        const trendDir = avgRet > 0 ? 0.5 : -0.5;

        // RSI proxy
        const gains = returns.filter(r => r > 0);
        const losses = returns.filter(r => r < 0);
        const avgGain = gains.length > 0 ? gains.reduce((a, b) => a + b, 0) / 14 : 0;
        const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((a, b) => a + b, 0)) / 14 : 0.001;
        const rsi = 100 - 100 / (1 + avgGain / avgLoss);
        const rsiDir = rsi < 35 ? 0.8 : rsi > 65 ? -0.6 : 0;

        return {
            sources: [
                { id: 'momentum', direction: momentumDir, weight: 0.6 },
                { id: 'trend', direction: trendDir, weight: 0.5 },
                { id: 'rsi', direction: rsiDir, weight: 0.7 },
            ],
        };
    });

    // Run backtest
    const config: BacktestConfig = {
        phaseTransitionThreshold: 0.6,
        kellyFractionCap: 0.25,
        minPsiMagnitude: 0.05,
        maxPositionSizeUsd: 200,
        takeProfitPct: 5,
        stopLossPct: 3,
        trailingStopPct: 2,
        trailingActivationPct: 2.5,
        initialBalance: 1000,
    };

    const bt = new PsinixBacktester(config);
    const result = bt.run(prices, signals);

    if (jsonOutput) {
        console.log(JSON.stringify(result, null, 2));
    } else {
        console.log('  ═══════════════════════════════════════');
        console.log(`  Symbol:          ${symbol}`);
        console.log(`  Period:          ${days} days (${prices.length} bars)`);
        console.log(`  Total Trades:    ${result.trades.length}`);
        console.log(`  Win Rate:        ${(result.winRate * 100).toFixed(1)}% (${result.wins}W / ${result.losses}L)`);
        console.log(`  Total PnL:       $${result.totalPnl.toFixed(2)}`);
        console.log(`  Max Drawdown:    ${result.maxDrawdownPct.toFixed(2)}%`);
        console.log(`  Sharpe Ratio:    ${result.sharpeRatio.toFixed(3)}`);
        console.log(`  Avg |Ψ| at Entry: ${result.avgPsiAtEntry.toFixed(4)}`);
        console.log(`  Avg C at Entry:  ${result.avgCoherenceAtEntry.toFixed(3)}`);
        console.log('  ═══════════════════════════════════════');

        if (result.trades.length > 0) {
            console.log('\n  Recent trades:');
            for (const t of result.trades.slice(-10)) {
                const emoji = t.pnl >= 0 ? '🟢' : '🔴';
                console.log(`    ${emoji} ${t.side} $${t.entryPrice.toFixed(2)} → $${t.exitPrice.toFixed(2)} | ${t.reason} | PnL: ${t.pnl >= 0 ? '+' : ''}$${t.pnl.toFixed(2)}`);
            }
        }
    }
}

main().catch(err => {
    console.error('Backtest failed:', err);
    process.exit(1);
});
```

- [ ] **Step 2: Test locally**

Run: `npx tsx scripts/strategy-lab/psinix_backtest.ts --symbol BTC/USDC --days 10`
Expected: Fetches candles, runs backtest, prints results table

- [ ] **Step 3: Commit**

```bash
git add scripts/strategy-lab/psinix_backtest.ts
git commit -m "feat(psinix): add CLI backtesting runner with real Binance data"
```

---

### Task 6: Enhanced Test Suite

Expand the existing test suite with integration tests, signal collector tests, and edge cases.

**Files:**
- Modify: `packages/agents/src/psinix/psi-engine.test.ts`

- [ ] **Step 1: Add integration-level tests**

Insert into `psi-engine.test.ts` **before** the `// RESULTS` section (before line 232), not at the end of the file:

```typescript
// ═══════════════════════════════════════════════════════════════
// 8. SIGNAL COLLECTOR — parseTASignal
// ═══════════════════════════════════════════════════════════════

// (Tests from Task 2 Step 1 go here)

// ═══════════════════════════════════════════════════════════════
// 9. FULL Ψ PIPELINE — Signal → Compute → Decision
// ═══════════════════════════════════════════════════════════════

test('Full pipeline: strong consensus on real-ish entropy → trade', () => {
    // Simulate trending market (low entropy)
    const trendPrices = Array.from({ length: 30 }, (_, i) => 100 + i * 0.3);
    const entropy = PsiEngine.computeMarketEntropy(trendPrices);

    // All signals agree: BUY
    const signals = [
        signal(0.8, 0.7, 'smartmoney:BTC'),
        signal(0.6, 0.5, 'polymarket:crypto'),
        signal(0.7, 0.4, 'fear_greed'),
        signal(0.9, 0.7, 'cryonix_ta:BTC'),
    ];

    const result = PsiEngine.compute(signals, entropy, 0.55, 1.5);
    assert(result.phaseTransition, 'Should detect phase transition');
    assert(result.psi > 0, 'Should be LONG signal');
    assert(result.positionPct > 0, 'Should have position size');
    console.log(`    Ψ=${result.psi.toFixed(4)} C=${result.coherence.toFixed(3)} β=${result.beta.toFixed(2)} entropy=${entropy.toFixed(3)}`);
});

test('Full pipeline: choppy market + weak signals → no trade', () => {
    // Choppy prices (high entropy)
    const choppyPrices = Array.from({ length: 30 }, () => 100 + (Math.random() - 0.5) * 10);
    const entropy = PsiEngine.computeMarketEntropy(choppyPrices);

    // Mixed signals
    const signals = [
        signal(0.3, 0.5, 'smartmoney:BTC'),
        signal(-0.2, 0.5, 'polymarket:crypto'),
        signal(0.1, 0.4, 'fear_greed'),
    ];

    const result = PsiEngine.compute(signals, entropy, 0.5, 1.0);
    assert(!result.phaseTransition || Math.abs(result.psi) < 0.05,
        `Should not produce strong signal: Ψ=${result.psi.toFixed(4)} C=${result.coherence.toFixed(3)}`);
});

test('C² scaling verification: coherence 0.7 → 49% of max', () => {
    // 0.7² = 0.49
    const signals = [signal(1, 0.8), signal(0.9, 0.7), signal(0.8, 0.6)];
    const result = PsiEngine.compute(signals, 0.4, 0.6, 1.5);
    const theoreticalMax = result.kellyFraction * 100;
    const coherenceScale = result.coherence * result.coherence;
    const scaledMax = theoreticalMax * coherenceScale;
    assert(result.positionPct <= scaledMax * 1.1, // 10% tolerance for tanh compression
        `Position ${result.positionPct.toFixed(1)}% ≤ scaled max ${scaledMax.toFixed(1)}%`);
});
```

- [ ] **Step 2: Run full test suite**

Run: `npx tsx packages/agents/src/psinix/psi-engine.test.ts`
Expected: All tests pass (original 15+ plus new 6+)

- [ ] **Step 3: Commit**

```bash
git add packages/agents/src/psinix/psi-engine.test.ts
git commit -m "test(psinix): add integration pipeline tests + signal collector tests"
```

---

### Task 7: Deploy and Verify

Build updated Psinix container and deploy to VM.

**Files:**
- Modify: `Dockerfile.psinix` (already done in Task 1)

- [ ] **Step 1: Run all test suites locally**

```bash
npx tsx packages/agents/src/psinix/psi-engine.test.ts
npx tsx packages/agents/src/psinix/bayesian-weights.test.ts
npx tsx packages/agents/src/psinix/backtester.test.ts
```

Expected: All green

- [ ] **Step 2: Run a quick backtest to validate**

```bash
npx tsx scripts/strategy-lab/psinix_backtest.ts --symbol BTC/USDC --days 7
npx tsx scripts/strategy-lab/psinix_backtest.ts --symbol ETH/USDC --days 7
npx tsx scripts/strategy-lab/psinix_backtest.ts --symbol SOL/USDC --days 7
```

Expected: Results printed for each symbol

- [ ] **Step 3: Commit all changes**

```bash
git add -A
git commit -m "feat(psinix): complete research & validation framework — real OHLCV, Bayesian weights, backtester"
```

- [ ] **Step 4: Deploy to VM**

```bash
git archive --format=tar HEAD | ssh azureuser@openclaw-vm "cd ~/cryonix && tar xf -"
ssh azureuser@openclaw-vm "cd ~/cryonix && docker compose -f docker-compose.prod.yml up -d --build psinix"
```

- [ ] **Step 5: Verify container is running**

```bash
ssh azureuser@openclaw-vm "docker logs psinix --tail 20"
```

Expected: Heartbeat logs showing real entropy values (not ~1.0 from random walk)

- [ ] **Step 6: Run backtest on VM**

```bash
ssh azureuser@openclaw-vm "docker exec psinix npx tsx /app/scripts/strategy-lab/psinix_backtest.ts --symbol BTC/USDC --days 30"
```

Expected: Full 30-day backtest results with real data
