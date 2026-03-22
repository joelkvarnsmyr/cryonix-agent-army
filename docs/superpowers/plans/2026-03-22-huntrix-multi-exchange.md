# Huntrix Multi-Exchange + Pump Profiling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add multi-exchange support (Binance + Bybit + MEXC) with cross-exchange routing and pump duration profiling to Huntrix.

**Architecture:** ExchangeManager abstracts multiple CCXT instances behind a unified API. PumpProfiler tracks detected pumps and builds per-exchange duration statistics. huntrix-agent.ts replaces its single `this.ccxt` with `this.exchangeManager`. Shared capital pool across all exchanges.

**Tech Stack:** CCXT 4.x (already installed), ioredis, @iarna/toml, vitest

**Spec:** `docs/superpowers/specs/2026-03-22-huntrix-multi-exchange-design.md`

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `packages/agents/src/huntrix/exchange-manager.ts` | Multi-exchange CCXT management — init, scanAll, routeOrder, getBestExchange |
| `packages/agents/src/huntrix/pump-profiler.ts` | Log pumps, track peaks, aggregate statistics per exchange |
| `packages/agents/src/huntrix/__tests__/exchange-manager.test.ts` | Exchange manager unit tests |
| `packages/agents/src/huntrix/__tests__/pump-profiler.test.ts` | Pump profiler unit tests |

### Modified Files

| File | Change |
|------|--------|
| `packages/agents/src/huntrix/types.ts` | Add `ExchangeConfig`, `PumpProfile`, `PumpStats`; add `exchange` field to `HunterPosition` and `ManipulationSignal` |
| `packages/agents/src/huntrix/config.ts` | Parse `[[exchanges]]` TOML array, add defaults for 3 exchanges |
| `huntrix.toml` | Replace implicit single exchange with `[[exchanges]]` array |
| `packages/agents/src/huntrix/huntrix-agent.ts` | Replace `this.ccxt` with `this.exchangeManager`; integrate pump profiler |
| `packages/agents/src/huntrix/manipulation-scanner.ts` | Accept exchange map for orderbook scanning across all exchanges |
| `packages/agents/src/huntrix/entry-validator.ts` | Accept exchange instance parameter for per-exchange validation |
| `scripts/services/huntrix-brain.ts` | Read `pump_stats` in data collection and include in analysis prompt |
| `docker-compose.prod.yml` | Add MEXC/Bybit env vars to huntrix + huntrix-brain services |

---

### Task 1: Types — ExchangeConfig, PumpProfile, PumpStats + exchange field on position/signal

**Files:**
- Modify: `packages/agents/src/huntrix/types.ts`

- [ ] **Step 1: Add ExchangeConfig interface**

Add after the `HuntrixBrainConfig` interface at the bottom of `types.ts`:

```typescript
// ── Multi-Exchange ────────────────────────────────────────────────

export interface ExchangeConfig {
  id: string;                      // CCXT exchange id: 'binance', 'bybit', 'mexc'
  enabled: boolean;
  role: 'scan' | 'trade' | 'scan+trade';
  api_key_env: string;             // env var name, NOT the actual key
  secret_env: string;
  password_env?: string;           // OKX, KuCoin, Bitget require passphrase
  priority: number;                // 1 = highest (prefer for execution)
}

// ── Pump Profiling ────────────────────────────────────────────────

export interface PumpProfile {
  id: string;
  symbol: string;
  exchange: string;
  detected_at: number;
  detection_phase: PumpPhase;
  source: ManipulationSignal['source'];
  price_at_detection: number;
  peak_price: number;
  peak_minutes: number;
  dump_start_price: number;
  duration_minutes: number;
  dump_velocity_pct_per_min: number;
  volume_spike_ratio: number;
  was_traded: boolean;
  pnl_pct: number | null;
}

export interface PumpStats {
  exchange: string;
  median_peak_minutes: number;
  median_duration_minutes: number;
  median_dump_velocity: number;
  sample_count: number;
}
```

- [ ] **Step 2: Add `exchange` field to HunterPosition**

In the `HunterPosition` interface (line ~48), add after `symbol`:

```typescript
  exchange: string;              // which exchange this position is on
```

- [ ] **Step 3: Add `exchange` field to ManipulationSignal**

In the `ManipulationSignal` interface (line ~28), add after `symbol`:

```typescript
  exchange: string;              // which exchange detected this signal
```

- [ ] **Step 4: Add `exchanges` to HuntrixConfig**

In the `HuntrixConfig` interface, add after `brain: HuntrixBrainConfig;`:

```typescript
  exchanges: ExchangeConfig[];
```

- [ ] **Step 5: Verify types compile**

Run: `npx tsc --noEmit --pretty packages/agents/src/huntrix/types.ts 2>&1 || echo "Expected errors from missing exchange field in other files"`

- [ ] **Step 6: Commit**

```bash
git add packages/agents/src/huntrix/types.ts
git commit -m "feat(huntrix): add multi-exchange and pump profiling types"
```

---

### Task 2: Config — parse [[exchanges]] TOML array + defaults

**Files:**
- Modify: `packages/agents/src/huntrix/config.ts`
- Modify: `huntrix.toml`

- [ ] **Step 1: Add exchange defaults to HUNTRIX_DEFAULTS**

In `config.ts`, add `exchanges` array to `HUNTRIX_DEFAULTS` after the `brain` section:

```typescript
  exchanges: [
    {
      id: 'binance',
      enabled: true,
      role: 'scan+trade' as const,
      api_key_env: 'BINANCE_API_KEY',
      secret_env: 'BINANCE_API_SECRET',
      priority: 1,
    },
    {
      id: 'bybit',
      enabled: true,
      role: 'scan+trade' as const,
      api_key_env: 'BYBIT_API_KEY',
      secret_env: 'BYBIT_API_SECRET',
      priority: 2,
    },
    {
      id: 'mexc',
      enabled: true,
      role: 'scan+trade' as const,
      api_key_env: 'MEXC_API_KEY',
      secret_env: 'MEXC_API_SECRET',
      priority: 3,
    },
  ],
```

- [ ] **Step 2: Update loadHuntrixConfig to parse exchanges**

In `loadHuntrixConfig()`, add inside the `return { ... }` object, after the `brain` merge line:

```typescript
      exchanges: (parsed as any).exchanges?.length
        ? (parsed as any).exchanges.map((ex: any) => ({
            id: ex.id ?? 'unknown',
            enabled: ex.enabled ?? true,
            role: ex.role ?? 'scan+trade',
            api_key_env: ex.api_key_env ?? '',
            secret_env: ex.secret_env ?? '',
            password_env: ex.password_env,
            priority: ex.priority ?? 99,
          }))
        : HUNTRIX_DEFAULTS.exchanges,
```

- [ ] **Step 3: Add [[exchanges]] to huntrix.toml**

Add at the end of `huntrix.toml`:

```toml

[[exchanges]]
id = "binance"
enabled = true
role = "scan+trade"
api_key_env = "BINANCE_API_KEY"
secret_env = "BINANCE_API_SECRET"
priority = 1

[[exchanges]]
id = "bybit"
enabled = true
role = "scan+trade"
api_key_env = "BYBIT_API_KEY"
secret_env = "BYBIT_API_SECRET"
priority = 2

[[exchanges]]
id = "mexc"
enabled = true
role = "scan+trade"
api_key_env = "MEXC_API_KEY"
secret_env = "MEXC_API_SECRET"
priority = 3
```

- [ ] **Step 4: Verify config loads correctly**

Create a quick inline test:
```bash
npx tsx -e "
const { loadHuntrixConfig } = require('./packages/agents/src/huntrix/config');
const c = loadHuntrixConfig();
console.log('Exchanges:', c.exchanges.length);
c.exchanges.forEach(e => console.log(e.id, e.role, e.priority));
"
```
Expected: 3 exchanges listed with correct roles and priorities.

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/huntrix/config.ts huntrix.toml
git commit -m "feat(huntrix): add multi-exchange config defaults and TOML entries"
```

---

### Task 3: ExchangeManager — multi-exchange CCXT abstraction

**Files:**
- Create: `packages/agents/src/huntrix/exchange-manager.ts`
- Create: `packages/agents/src/huntrix/__tests__/exchange-manager.test.ts`

- [ ] **Step 1: Write exchange-manager tests**

Create `packages/agents/src/huntrix/__tests__/exchange-manager.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExchangeManager } from '../exchange-manager';
import type { ExchangeConfig } from '../types';

const CONFIGS: ExchangeConfig[] = [
  { id: 'binance', enabled: true, role: 'scan+trade', api_key_env: 'BIN_KEY', secret_env: 'BIN_SEC', priority: 1 },
  { id: 'mexc', enabled: true, role: 'scan', api_key_env: 'MEXC_KEY', secret_env: 'MEXC_SEC', priority: 3 },
  { id: 'bybit', enabled: false, role: 'scan+trade', api_key_env: 'BY_KEY', secret_env: 'BY_SEC', priority: 2 },
];

// Mock CCXT module
vi.mock('ccxt', () => ({
  binance: class { markets = {}; async loadMarkets() { return {}; } },
  mexc: class { markets = {}; async loadMarkets() { return {}; } },
  bybit: class { markets = {}; async loadMarkets() { return {}; } },
}));

describe('ExchangeManager', () => {
  it('should only initialize enabled exchanges', async () => {
    const mgr = new ExchangeManager(CONFIGS, 'paper');
    await mgr.initialize();
    expect(mgr.getScanExchangeIds()).toContain('binance');
    expect(mgr.getScanExchangeIds()).toContain('mexc');
    expect(mgr.getScanExchangeIds()).not.toContain('bybit');
  });

  it('should only return trade-enabled exchanges for getTradeExchangeIds', async () => {
    const mgr = new ExchangeManager(CONFIGS, 'paper');
    await mgr.initialize();
    expect(mgr.getTradeExchangeIds()).toContain('binance');
    expect(mgr.getTradeExchangeIds()).not.toContain('mexc'); // scan-only
  });

  it('should return exchanges sorted by priority for routing', async () => {
    const mgr = new ExchangeManager(CONFIGS, 'paper');
    await mgr.initialize();
    const tradeIds = mgr.getTradeExchangeIds();
    // Only binance is trade-enabled (bybit disabled, mexc scan-only)
    expect(tradeIds).toEqual(['binance']);
  });

  it('should get exchange instance by id', async () => {
    const mgr = new ExchangeManager(CONFIGS, 'paper');
    await mgr.initialize();
    expect(mgr.getExchange('binance')).toBeDefined();
    expect(mgr.getExchange('bybit')).toBeUndefined(); // disabled
  });

  it('should return all exchange instances as map', async () => {
    const mgr = new ExchangeManager(CONFIGS, 'paper');
    await mgr.initialize();
    const all = mgr.getAllExchanges();
    expect(all.size).toBe(2); // binance + mexc (bybit disabled)
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/agents/src/huntrix/__tests__/exchange-manager.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement ExchangeManager**

Create `packages/agents/src/huntrix/exchange-manager.ts`:

```typescript
import type { ExchangeConfig } from './types';

export class ExchangeManager {
  private exchanges: Map<string, any> = new Map();
  private configs: Map<string, ExchangeConfig> = new Map();
  private mode: 'paper' | 'live';

  constructor(exchangeConfigs: ExchangeConfig[], mode: 'paper' | 'live') {
    this.mode = mode;

    for (const cfg of exchangeConfigs) {
      if (!cfg.enabled) continue;
      this.configs.set(cfg.id, cfg);
    }
  }

  /** Must be called after constructor — loads CCXT dynamically */
  async initialize(): Promise<void> {
    const ccxt = await import('ccxt');

    for (const [id, cfg] of this.configs) {
      const ExchangeClass = (ccxt as any)[id];
      if (!ExchangeClass) {
        console.warn(`[ExchangeManager] Unknown exchange: ${id} — skipping`);
        continue;
      }

      const opts: any = { enableRateLimit: true };
      if (this.mode === 'live') {
        const apiKey = process.env[cfg.api_key_env];
        const secret = process.env[cfg.secret_env];
        if (apiKey) opts.apiKey = apiKey;
        if (secret) opts.secret = secret;
        if (cfg.password_env) {
          const pw = process.env[cfg.password_env];
          if (pw) opts.password = pw;
        }
      }

      const exchange = new ExchangeClass(opts);
      this.exchanges.set(id, exchange);
      console.log(`[ExchangeManager] Initialized ${id} (${cfg.role}, priority ${cfg.priority})`);
    }
  }

  /** Load markets on all exchanges (call once after initialize) */
  async loadMarkets(): Promise<void> {
    const promises = [...this.exchanges.entries()].map(async ([id, ex]) => {
      try {
        await ex.loadMarkets();
        console.log(`[ExchangeManager] ${id}: ${Object.keys(ex.markets).length} markets loaded`);
      } catch (err: any) {
        console.warn(`[ExchangeManager] ${id}: loadMarkets failed — ${err.message}`);
      }
    });
    await Promise.all(promises);
  }

  /** IDs of exchanges enabled for scanning, sorted by priority */
  getScanExchangeIds(): string[] {
    return [...this.configs.entries()]
      .filter(([id, cfg]) => (cfg.role === 'scan' || cfg.role === 'scan+trade') && this.exchanges.has(id))
      .sort((a, b) => a[1].priority - b[1].priority)
      .map(([id]) => id);
  }

  /** IDs of exchanges enabled for trading, sorted by priority */
  getTradeExchangeIds(): string[] {
    return [...this.configs.entries()]
      .filter(([id, cfg]) => (cfg.role === 'trade' || cfg.role === 'scan+trade') && this.exchanges.has(id))
      .sort((a, b) => a[1].priority - b[1].priority)
      .map(([id]) => id);
  }

  /** Get exchange instance by id */
  getExchange(id: string): any | undefined {
    return this.exchanges.get(id);
  }

  /** Get all exchange instances */
  getAllExchanges(): Map<string, any> {
    return this.exchanges;
  }

  /** Get config for an exchange */
  getConfig(id: string): ExchangeConfig | undefined {
    return this.configs.get(id);
  }

  /**
   * Find the best exchange to execute a trade for a given symbol.
   * Checks: pair exists, lowest spread, highest priority.
   * Returns null if no exchange can trade this symbol.
   */
  async getBestExchange(symbol: string): Promise<{ id: string; exchange: any; spread: number } | null> {
    const candidates: Array<{ id: string; exchange: any; spread: number; priority: number }> = [];

    for (const id of this.getTradeExchangeIds()) {
      const ex = this.exchanges.get(id)!;
      // Check if pair exists on this exchange
      if (!ex.markets?.[symbol]) continue;

      try {
        const ticker = await ex.fetchTicker(symbol);
        const bid = ticker.bid ?? 0;
        const ask = ticker.ask ?? 0;
        const spread = bid > 0 ? ((ask - bid) / bid) * 100 : 999;
        const priority = this.configs.get(id)!.priority;
        candidates.push({ id, exchange: ex, spread, priority });
      } catch {
        // Exchange doesn't have this pair or API error — skip
      }
    }

    if (candidates.length === 0) return null;

    // Sort: lowest spread first, then highest priority (lowest number)
    candidates.sort((a, b) => {
      const spreadDiff = a.spread - b.spread;
      if (Math.abs(spreadDiff) > 0.05) return spreadDiff; // significant spread difference
      return a.priority - b.priority; // tie-break by priority
    });

    return candidates[0];
  }

  /**
   * Scan a symbol across all scan-enabled exchanges.
   * Returns array of { exchange, ticker } results.
   */
  async scanSymbol(symbol: string): Promise<Array<{ exchange: string; ticker: any }>> {
    const results: Array<{ exchange: string; ticker: any }> = [];

    const promises = this.getScanExchangeIds().map(async (id) => {
      const ex = this.exchanges.get(id)!;
      if (!ex.markets?.[symbol]) return;
      try {
        const ticker = await ex.fetchTicker(symbol);
        results.push({ exchange: id, ticker });
      } catch {
        // Symbol not available on this exchange
      }
    });

    await Promise.all(promises);
    return results;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/agents/src/huntrix/__tests__/exchange-manager.test.ts`
Expected: 5/5 PASS

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/huntrix/exchange-manager.ts packages/agents/src/huntrix/__tests__/exchange-manager.test.ts
git commit -m "feat(huntrix): add ExchangeManager with multi-exchange CCXT abstraction"
```

---

### Task 4: PumpProfiler — pump duration tracking and statistics

**Files:**
- Create: `packages/agents/src/huntrix/pump-profiler.ts`
- Create: `packages/agents/src/huntrix/__tests__/pump-profiler.test.ts`

- [ ] **Step 1: Write pump-profiler tests**

Create `packages/agents/src/huntrix/__tests__/pump-profiler.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PumpProfiler } from '../pump-profiler';
import type { ManipulationSignal, PumpProfile } from '../types';

// Mock Redis
const redisMock = {
  lpush: vi.fn().mockResolvedValue(1),
  ltrim: vi.fn().mockResolvedValue('OK'),
  lrange: vi.fn().mockResolvedValue([]),
  set: vi.fn().mockResolvedValue('OK'),
  get: vi.fn().mockResolvedValue(null),
};

function makeSignal(overrides: Partial<ManipulationSignal> = {}): ManipulationSignal {
  return {
    id: 'test-1',
    type: 'pump_and_dump',
    symbol: 'TEST/USDC',
    exchange: 'mexc',
    confidence: 80,
    phase: 'early_pump',
    shill_activity: [],
    total_shill_accounts: 5,
    price_at_detection: 1.0,
    volume_24h: 100000,
    volume_spike_ratio: 5.0,
    price_velocity: 2.0,
    reasoning: 'test',
    estimated_peak_minutes: null,
    detected_at: new Date().toISOString(),
    source: 'x_scan',
    ...overrides,
  };
}

describe('PumpProfiler', () => {
  let profiler: PumpProfiler;

  beforeEach(() => {
    vi.clearAllMocks();
    profiler = new PumpProfiler(redisMock as any);
  });

  it('should start tracking a pump signal', () => {
    const signal = makeSignal();
    profiler.startTracking(signal);
    expect(profiler.getActiveCount()).toBe(1);
  });

  it('should not exceed max concurrent tracking (10)', () => {
    for (let i = 0; i < 12; i++) {
      profiler.startTracking(makeSignal({ id: `test-${i}`, symbol: `T${i}/USDC` }));
    }
    expect(profiler.getActiveCount()).toBe(10);
  });

  it('should finalize a profile and store to Redis', async () => {
    const signal = makeSignal();
    profiler.startTracking(signal);
    await profiler.finalize(signal.id, false);
    expect(redisMock.lpush).toHaveBeenCalledWith('huntrix:pump_history', expect.any(String));
    expect(redisMock.ltrim).toHaveBeenCalledWith('huntrix:pump_history', 0, 199);
    expect(profiler.getActiveCount()).toBe(0);
  });

  it('should compute median correctly', () => {
    // Access private method via any cast for testing
    const median = (PumpProfiler as any).median;
    expect(median([1, 3, 5, 7, 9])).toBe(5);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([42])).toBe(42);
    expect(median([])).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/agents/src/huntrix/__tests__/pump-profiler.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement PumpProfiler**

Create `packages/agents/src/huntrix/pump-profiler.ts`:

```typescript
import type Redis from 'ioredis';
import type { ManipulationSignal, PumpProfile, PumpStats } from './types';

const MAX_CONCURRENT = 10;
const MAX_HISTORY = 200;
const HISTORY_TTL = 7 * 24 * 3600; // 7 days
const STATS_TTL = 86400;           // 24 hours
const TRACKING_TIMEOUT_MS = 60 * 60 * 1000; // 60 min

interface ActivePump {
  profile: PumpProfile;
  startedAt: number;
}

export class PumpProfiler {
  private redis: Redis;
  private active: Map<string, ActivePump> = new Map();

  constructor(redis: Redis) {
    this.redis = redis;
  }

  /** Start tracking a detected pump signal */
  startTracking(signal: ManipulationSignal): void {
    if (this.active.size >= MAX_CONCURRENT) {
      console.log(`[PumpProfiler] Max concurrent tracking (${MAX_CONCURRENT}) — skipping ${signal.symbol}`);
      return;
    }

    if (this.active.has(signal.id)) return;

    const profile: PumpProfile = {
      id: signal.id,
      symbol: signal.symbol,
      exchange: signal.exchange,
      detected_at: Date.now(),
      detection_phase: signal.phase,
      source: signal.source,
      price_at_detection: signal.price_at_detection,
      peak_price: signal.price_at_detection,
      peak_minutes: 0,
      dump_start_price: 0,
      duration_minutes: 0,
      dump_velocity_pct_per_min: 0,
      volume_spike_ratio: signal.volume_spike_ratio,
      was_traded: false,
      pnl_pct: null,
    };

    this.active.set(signal.id, { profile, startedAt: Date.now() });
    console.log(`[PumpProfiler] Tracking ${signal.symbol} on ${signal.exchange} (${this.active.size} active)`);
  }

  /** Update price for all tracked pumps. Call from tick loop. */
  updatePrice(signalId: string, currentPrice: number): void {
    const entry = this.active.get(signalId);
    if (!entry) return;

    const { profile } = entry;

    // Update peak
    if (currentPrice > profile.peak_price) {
      profile.peak_price = currentPrice;
      profile.peak_minutes = (Date.now() - profile.detected_at) / 60_000;
    }

    // Detect dump start: price drops >2%/min from peak
    if (profile.dump_start_price === 0 && profile.peak_price > 0) {
      const dropFromPeak = ((profile.peak_price - currentPrice) / profile.peak_price) * 100;
      const minutesSincePeak = ((Date.now() - profile.detected_at) / 60_000) - profile.peak_minutes;
      if (minutesSincePeak > 0 && dropFromPeak / minutesSincePeak >= 2.0) {
        profile.dump_start_price = currentPrice;
        profile.dump_velocity_pct_per_min = dropFromPeak / minutesSincePeak;
      }
    }
  }

  /** Check for timed-out tracking entries. Call periodically. */
  async checkTimeouts(): Promise<void> {
    const now = Date.now();
    for (const [id, entry] of this.active) {
      if (now - entry.startedAt > TRACKING_TIMEOUT_MS) {
        console.log(`[PumpProfiler] Timeout for ${entry.profile.symbol} — finalizing`);
        await this.finalize(id, false);
      }

      // Also finalize if price dropped >50% from peak
      if (entry.profile.peak_price > 0 && entry.profile.dump_start_price > 0) {
        const dropFromPeak = ((entry.profile.peak_price - entry.profile.dump_start_price) / entry.profile.peak_price) * 100;
        if (dropFromPeak >= 50) {
          await this.finalize(id, false);
        }
      }
    }
  }

  /** Finalize a pump profile and store to Redis */
  async finalize(id: string, wasTraded: boolean, pnlPct?: number): Promise<void> {
    const entry = this.active.get(id);
    if (!entry) return;

    const { profile } = entry;
    profile.was_traded = wasTraded;
    profile.pnl_pct = pnlPct ?? null;
    profile.duration_minutes = (Date.now() - profile.detected_at) / 60_000;

    this.active.delete(id);

    // Store to Redis list
    try {
      await this.redis.lpush('huntrix:pump_history', JSON.stringify(profile));
      await this.redis.ltrim('huntrix:pump_history', 0, MAX_HISTORY - 1);
      // Set TTL on the list key
      await this.redis.expire('huntrix:pump_history', HISTORY_TTL);

      // Recalculate aggregated stats
      await this.refreshStats();

      console.log(`[PumpProfiler] Finalized ${profile.symbol} on ${profile.exchange} — peak at ${profile.peak_minutes.toFixed(1)}min, duration ${profile.duration_minutes.toFixed(1)}min`);
    } catch (err: any) {
      console.error(`[PumpProfiler] Failed to store profile: ${err.message}`);
    }
  }

  /** Recalculate aggregated stats from pump history */
  async refreshStats(): Promise<void> {
    try {
      const rawList = await this.redis.lrange('huntrix:pump_history', 0, -1);
      const profiles: PumpProfile[] = rawList.map(r => JSON.parse(r));

      // Group by exchange
      const byExchange = new Map<string, PumpProfile[]>();
      for (const p of profiles) {
        if (!byExchange.has(p.exchange)) byExchange.set(p.exchange, []);
        byExchange.get(p.exchange)!.push(p);
      }

      // Calculate per-exchange stats
      const statsObj: Record<string, any> = {};
      for (const [exchange, pumps] of byExchange) {
        const peakMinutes = pumps.map(p => p.peak_minutes).filter(v => v > 0);
        const durations = pumps.map(p => p.duration_minutes).filter(v => v > 0);
        const dumpVelocities = pumps.map(p => p.dump_velocity_pct_per_min).filter(v => v > 0);

        statsObj[`${exchange}:median_peak_minutes`] = PumpProfiler.median(peakMinutes);
        statsObj[`${exchange}:median_duration_minutes`] = PumpProfiler.median(durations);
        statsObj[`${exchange}:median_dump_velocity`] = PumpProfiler.median(dumpVelocities);
        statsObj[`${exchange}:sample_count`] = pumps.length;
      }

      await this.redis.set('huntrix:pump_stats', JSON.stringify(statsObj), 'EX', STATS_TTL);
    } catch (err: any) {
      console.error(`[PumpProfiler] Failed to refresh stats: ${err.message}`);
    }
  }

  /** Get pump stats from Redis */
  async getStats(): Promise<Record<string, any> | null> {
    try {
      const raw = await this.redis.get('huntrix:pump_stats');
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  /** Number of actively tracked pumps */
  getActiveCount(): number {
    return this.active.size;
  }

  /** Get active tracking entry for a signal */
  getActive(id: string): ActivePump | undefined {
    return this.active.get(id);
  }

  /** Calculate median of a number array */
  static median(arr: number[]): number {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/agents/src/huntrix/__tests__/pump-profiler.test.ts`
Expected: 4/4 PASS

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/huntrix/pump-profiler.ts packages/agents/src/huntrix/__tests__/pump-profiler.test.ts
git commit -m "feat(huntrix): add PumpProfiler with duration tracking and statistics"
```

---

### Task 5: Integrate ExchangeManager into huntrix-agent.ts

**Files:**
- Modify: `packages/agents/src/huntrix/huntrix-agent.ts`

This is the largest task — replaces `this.ccxt` (single Binance) with `this.exchangeManager` (multi-exchange).

- [ ] **Step 1: Update imports and class properties**

Replace the `ccxt` import and property:

Old (line 16):
```typescript
    private ccxt!: import('ccxt').binance;
```

New:
```typescript
    private exchangeManager!: ExchangeManager;
    private pumpProfiler!: PumpProfiler;
```

Add imports at top:
```typescript
import { ExchangeManager } from './exchange-manager';
import { PumpProfiler } from './pump-profiler';
```

- [ ] **Step 2: Update initialize() method**

Replace the CCXT Binance init block (lines 47-57) with:

```typescript
        // Multi-exchange initialization
        this.exchangeManager = new ExchangeManager(this.config.exchanges, this.config.general.mode);
        await this.exchangeManager.initialize();
        await this.exchangeManager.loadMarkets();

        this.pumpProfiler = new PumpProfiler(this.redis);
```

Update scanner and validator init (lines 59-60):
```typescript
        this.scanner = new ManipulationScanner(this.config, this.redis);
        // Pass primary scan exchange for default entry validation
        const primaryId = this.exchangeManager.getScanExchangeIds()[0] ?? 'binance';
        const primaryExchange = this.exchangeManager.getExchange(primaryId);
        if (!primaryExchange) {
            throw new Error(`[HUNTRIX] No exchange available — check [[exchanges]] config`);
        }
        this.validator = new EntryValidator(this.config, primaryExchange, this.redis);
```

- [ ] **Step 3: Update tick() — orderbook spoofing scan**

Replace the orderbook spoof scan (lines 162-167):

Old:
```typescript
        if (this.config.scanner.sources.orderbook_spoof_enabled) {
            const spoofSymbols = this.positions.map(p => p.symbol);
            const spoofSignals = await this.scanner.scanOrderBook(this.ccxt, spoofSymbols);
            signals.push(...spoofSignals);
        }
```

New:
```typescript
        if (this.config.scanner.sources.orderbook_spoof_enabled) {
            const spoofSymbols = this.positions.map(p => p.symbol);
            for (const [exId, exchange] of this.exchangeManager.getAllExchanges()) {
                const spoofSignals = await this.scanner.scanOrderBook(exchange, spoofSymbols, exId);
                signals.push(...spoofSignals);
            }
        }
```

- [ ] **Step 4: Update tick() — pump profiler integration**

Add after `this.activeSignals = signals;` (line 169):

```typescript
        // Start tracking detected pumps for profiling
        for (const signal of signals) {
            this.pumpProfiler.startTracking(signal);
        }
        await this.pumpProfiler.checkTimeouts();
```

- [ ] **Step 5: Update enterPosition() — exchange routing**

In `enterPosition()` (line 228), add exchange routing before the order:

Replace the current method signature and body up to the order execution:

```typescript
    private async enterPosition(signal: ManipulationSignal, price: number): Promise<void> {
        // Find best exchange for this trade
        let targetExchangeId = signal.exchange;
        let targetExchange: any;

        const best = await this.exchangeManager.getBestExchange(signal.symbol);
        if (best) {
            targetExchangeId = best.id;
            targetExchange = best.exchange;
        } else {
            targetExchange = this.exchangeManager.getExchange(targetExchangeId);
            if (!targetExchange) {
                console.log(`[HUNTRIX] No exchange available for ${signal.symbol} — skipping`);
                return;
            }
        }

        const positionSize = Math.min(
            this.config.capital.max_position_size_usd,
            this.virtualBalance * 0.25,
        );

        if (positionSize < 5) {
            console.log(`[HUNTRIX] Position size $${positionSize.toFixed(2)} too small — skipping`);
            return;
        }

        const quantity = positionSize / price;

        if (this.config.general.mode !== 'paper') {
            try {
                const order = await targetExchange.createMarketBuyOrder(signal.symbol, quantity);
                price = order.average || price;
                console.log(`[HUNTRIX] LIVE BUY ${signal.symbol} on ${targetExchangeId} — $${positionSize.toFixed(2)} @ $${price}`);
            } catch (err) {
                console.error(`[HUNTRIX] BUY failed for ${signal.symbol} on ${targetExchangeId}:`, err instanceof Error ? err.message : err);
                return;
            }
        } else {
            console.log(`[HUNTRIX] PAPER BUY ${signal.symbol} on ${targetExchangeId} — $${positionSize.toFixed(2)} @ $${price.toFixed(6)} (${signal.type}, conf: ${signal.confidence}%)`);
        }
```

And update the position object to include `exchange`:

```typescript
        const position: HunterPosition = {
            id: `htx-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            symbol: signal.symbol,
            exchange: targetExchangeId,
            entry_price: price,
            // ... rest stays the same
```

- [ ] **Step 6: Update monitorPositions() — use per-position exchange**

Replace the ticker fetch line (line 294). Use `?? 'binance'` fallback for legacy positions loaded from Redis that lack the `exchange` field:

Old:
```typescript
                const ticker = await this.ccxt.fetchTicker(position.symbol);
```

New:
```typescript
                const exchangeId = position.exchange ?? 'binance';
                const ex = this.exchangeManager.getExchange(exchangeId);
                if (!ex) continue;
                const ticker = await ex.fetchTicker(position.symbol);
```

Also update the pump profiler price tracking, add after `position.price_history.push(...)`:

```typescript
                // Update pump profiler with current price
                this.pumpProfiler.updatePrice(position.signal.id, currentPrice);
```

- [ ] **Step 7: Update closePosition() — use per-position exchange + finalize profiler**

Replace the sell order line (line 334). Use `?? 'binance'` fallback for legacy positions:

Old:
```typescript
                await this.ccxt.createMarketSellOrder(position.symbol, position.quantity);
```

New:
```typescript
                const sellExId = position.exchange ?? 'binance';
                const ex = this.exchangeManager.getExchange(sellExId);
                if (!ex) throw new Error(`Exchange ${sellExId} not available`);
                await ex.createMarketSellOrder(position.symbol, position.quantity);
```

Add pump profiler finalization after `this.dumpDetector.cleanup(position.id);` (line 385):

```typescript
        // Finalize pump profile with trade result
        await this.pumpProfiler.finalize(position.signal.id, true, pnlPct);
```

- [ ] **Step 8: Run all huntrix tests**

Run: `npx vitest run packages/agents/src/huntrix/`
Expected: All tests pass

- [ ] **Step 9: Commit**

```bash
git add packages/agents/src/huntrix/huntrix-agent.ts
git commit -m "feat(huntrix): integrate ExchangeManager + PumpProfiler into agent"
```

---

### Task 6: Update manipulation-scanner.ts — multi-exchange orderbook scanning

**Files:**
- Modify: `packages/agents/src/huntrix/manipulation-scanner.ts`

- [ ] **Step 1: Update scanOrderBook signature**

Change the `scanOrderBook` method signature (line 371) to accept an exchange ID:

Old:
```typescript
    async scanOrderBook(exchange: any, symbols: string[]): Promise<ManipulationSignal[]> {
```

New:
```typescript
    async scanOrderBook(exchange: any, symbols: string[], exchangeId: string = 'binance'): Promise<ManipulationSignal[]> {
```

- [ ] **Step 2: Add exchange field to generated signals**

In `scanOrderBook`, update the signal construction (line ~387-404) to include `exchange`:

Add `exchange: exchangeId,` after `symbol,` in the signal object.

- [ ] **Step 3: Add exchange field to all other signal generators**

In `campaignToSignal` (line ~514), add `exchange: 'unknown',` (X scan doesn't know the exchange).

In `scanTrendingAnomalies` (line ~267), add `exchange: 'unknown',` to the signal object.

In `fullScan` (line ~441), add `exchange: 'unknown',` to the Telegram cluster signal object.

- [ ] **Step 4: Run tests**

Run: `npx vitest run packages/agents/src/huntrix/`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/huntrix/manipulation-scanner.ts
git commit -m "feat(huntrix): add exchange field to manipulation signals"
```

---

### Task 7: Update entry-validator.ts — accept exchange parameter

**Files:**
- Modify: `packages/agents/src/huntrix/entry-validator.ts`

- [ ] **Step 1: Add exchange parameter to validate()**

Update the `validate` method signature to optionally accept an exchange override:

Old:
```typescript
    async validate(signal: ManipulationSignal): Promise<EntryValidation> {
```

New:
```typescript
    async validate(signal: ManipulationSignal, exchangeOverride?: any): Promise<EntryValidation> {
```

And at the start of `validate()`, add:
```typescript
        const exchange = exchangeOverride ?? this.exchange;
```

Then replace all `this.exchange.` calls within `validate()` with `exchange.`:
- Line 78: `ticker = await exchange.fetchTicker(signal.symbol);`
- Line 100: `const ohlcv = await exchange.fetchOHLCV(signal.symbol, '1m', undefined, 15);`

- [ ] **Step 2: Run tests**

Run: `npx vitest run packages/agents/src/huntrix/`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add packages/agents/src/huntrix/entry-validator.ts
git commit -m "feat(huntrix): add exchange override to entry validator"
```

---

### Task 8: Update Brain — add pump stats to analysis prompt

**Files:**
- Modify: `scripts/services/huntrix-brain.ts`

- [ ] **Step 1: Add pump_stats to data collection**

In `collectData()` function, add pump stats collection:

After `const prevRunRaw = ...` line, add:
```typescript
    const pumpStatsRaw = await redis.get('huntrix:pump_stats').catch(() => null);
```

Add `pumpStats` to the `BrainData` interface:
```typescript
interface BrainData {
    state: any | null;
    risk: any | null;
    previousRun: string | null;
    currentConfig: string | null;
    pumpStats: any | null;
}
```

Add to return object:
```typescript
        pumpStats: safeParse(pumpStatsRaw),
```

- [ ] **Step 2: Add pump stats section to prompt**

In `buildPrompt()`, add after the `## Previous Brain Run` section:

```typescript
    const pumpStatsSection = data.pumpStats
        ? JSON.stringify(data.pumpStats, null, 2)
        : '[no pump data yet — profiler needs more detected pumps]';

    // Add to the prompt string before "## Your Job":
```

Add this section to the prompt template string, before `## Your Job`:

```
## Pump Duration Statistics (per exchange)
\`\`\`json
${pumpStatsSection}
\`\`\`

Use these stats to inform \`exits.max_hold_minutes\` adjustments. If median peak is 8min on MEXC but max_hold is 30, consider lowering it. If no data exists yet, skip this analysis.
```

- [ ] **Step 3: Run brain script in dry mode to verify it parses**

```bash
npx tsx -e "
const { readFileSync } = require('fs');
// Just verify the brain script parses without syntax errors
require('./scripts/services/huntrix-brain.ts');
" 2>&1 | head -5
```
Expected: Script starts (will fail at Redis connect but that's fine — we're checking for syntax errors)

- [ ] **Step 4: Commit**

```bash
git add scripts/services/huntrix-brain.ts
git commit -m "feat(huntrix): add pump stats to brain analysis prompt"
```

---

### Task 9: Docker — add exchange env vars

**Files:**
- Modify: `docker-compose.prod.yml`

- [ ] **Step 1: Add MEXC and Bybit env vars to huntrix service**

Find the `huntrix:` service in `docker-compose.prod.yml` and add to its environment section:

```yaml
      - MEXC_API_KEY=${MEXC_API_KEY:-}
      - MEXC_API_SECRET=${MEXC_API_SECRET:-}
      - BYBIT_API_KEY=${BYBIT_API_KEY:-}
      - BYBIT_API_SECRET=${BYBIT_API_SECRET:-}
```

- [ ] **Step 2: Add same env vars to huntrix-brain service**

Add the same 4 env vars to the `huntrix-brain:` service environment section.

- [ ] **Step 3: Commit**

```bash
git add docker-compose.prod.yml
git commit -m "feat(huntrix): add MEXC/Bybit env vars to Docker compose"
```

---

### Task 10: Full verification + deploy

**Files:**
- All modified files

- [ ] **Step 1: Run all huntrix tests**

Run: `npx vitest run packages/agents/src/huntrix/`
Expected: All tests pass (including new exchange-manager and pump-profiler tests)

- [ ] **Step 2: Type check**

Run: `npx tsc --noEmit --pretty 2>&1 | head -30`
Expected: No errors in huntrix files

- [ ] **Step 3: Merge worktree branch to main**

From main repo:
```bash
cd /c/Projects/Code/Crypto/cryonix-agent-army
git merge worktree-huntrix-phase1-signals --no-edit
```

- [ ] **Step 4: Deploy to VM**

```bash
git archive --format=tar HEAD | ssh azureuser@openclaw-vm "cd ~/cryonix && tar xf -"
ssh azureuser@openclaw-vm "cd ~/cryonix && docker compose -f docker-compose.prod.yml up -d --build huntrix huntrix-brain"
```

- [ ] **Step 5: Verify logs**

```bash
ssh azureuser@openclaw-vm "docker logs huntrix --tail 20"
ssh azureuser@openclaw-vm "docker logs huntrix-brain --tail 20"
```

Expected: ExchangeManager initializes 3 exchanges (binance, bybit, mexc), loads markets, scan loop starts.
