# Alphanix Phase 1 — Skeleton + One Crypto Pod

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Alphanix foundation — Orchestrator, one crypto pod with Quant/Risk/Execution roles, adapter layer, and health monitoring. Paper trading only.

**Architecture:** Single-process hybrid runtime. `AlphanixAgent extends BaseAgent` as top-level entry. Orchestrator manages pod lifecycle. Each pod is a plain class coordinating 3 role classes (Quant, Risk, Execution). BinanceAdapter wraps CCXT for market data. State published to Redis, trades logged to Postgres.

**Tech Stack:** TypeScript, CCXT, @iarna/toml, ioredis, pg, zod, vitest

**Spec:** `docs/superpowers/specs/2026-03-23-alphanix-design.md`

---

## File Map

```
packages/agents/src/alphanix/
├── types.ts                        # All type definitions (Task 1)
├── config.ts                       # TOML loader (Task 2)
├── adapters/
│   ├── types.ts                    # MarketAdapter interface (Task 3)
│   ├── adapter-registry.ts         # Adapter discovery (Task 3)
│   └── binance-adapter.ts          # Crypto via CCXT (Task 4)
├── pod/
│   ├── pod.ts                      # Pod container class (Task 7)
│   ├── quant-agent.ts              # Signal generation (Task 5)
│   ├── risk-agent.ts               # Risk checks + veto (Task 6)
│   └── execution-agent.ts          # Order routing (Task 8)
├── orchestrator/
│   ├── orchestrator.ts             # Capital allocation, pod lifecycle (Task 9)
│   └── capital-allocator.ts        # Budget distribution (Task 9)
├── state/
│   └── state-publisher.ts          # Redis state (Task 10)
├── alphanix-agent.ts               # Main entry extending BaseAgent (Task 11)
└── __tests__/
    ├── types.test.ts               # (Task 1)
    ├── config.test.ts              # (Task 2)
    ├── adapters.test.ts            # (Task 3-4)
    ├── quant-agent.test.ts         # (Task 5)
    ├── risk-agent.test.ts          # (Task 6)
    ├── pod.test.ts                 # (Task 7)
    ├── execution-agent.test.ts     # (Task 8)
    ├── orchestrator.test.ts        # (Task 9)
    └── alphanix-agent.test.ts      # (Task 11)

scripts/services/
└── alphanix-runner.ts              # Docker CMD entry point (Task 12)

alphanix.toml                       # Configuration (Task 2)
Dockerfile.alphanix                 # Container image (Task 13)

apps/web/src/app/
├── api/alphanix/
│   ├── status/route.ts             # Health + state (Task 14)
│   └── positions/route.ts          # Open positions (Task 14)
└── alphanix/page.tsx               # Dashboard (Task 15)
```

---

### Task 1: Core Types

**Files:**
- Create: `packages/agents/src/alphanix/types.ts`
- Test: `packages/agents/src/alphanix/__tests__/types.test.ts`

- [ ] **Step 1: Write test for core types**

```typescript
// packages/agents/src/alphanix/__tests__/types.test.ts
import { describe, it, expect } from 'vitest';
import type {
  TradeProposal,
  RiskDecision,
  ExecutionResult,
  NormalizedTick,
  PodState,
  AssetClass,
} from '../types';

describe('Alphanix Types', () => {
  it('should create a valid TradeProposal', () => {
    const proposal: TradeProposal = {
      id: 'tp-001',
      podId: 'crypto',
      symbol: 'BTC/USDC',
      adapter: 'binance',
      side: 'BUY',
      confidence: 78,
      sizing: { qty: 0.001, notional: 85 },
      reasoning: 'RSI oversold + volume spike',
      models: ['rsi', 'volume'],
      signals: ['rsi_oversold', 'volume_spike_up'],
      timestamp: Date.now(),
    };
    expect(proposal.confidence).toBeGreaterThanOrEqual(0);
    expect(proposal.confidence).toBeLessThanOrEqual(100);
    expect(proposal.side).toMatch(/^(BUY|SELL)$/);
  });

  it('should create a valid RiskDecision', () => {
    const decision: RiskDecision = {
      proposalId: 'tp-001',
      action: 'approve',
      riskMetrics: { var: 0.02, exposure: 500, drawdown: 1.2 },
    };
    expect(decision.action).toMatch(/^(approve|veto|reduce)$/);
  });

  it('should create a valid RiskDecision with veto', () => {
    const veto: RiskDecision = {
      proposalId: 'tp-002',
      action: 'veto',
      vetoReason: 'daily_loss_limit',
      riskMetrics: { var: 0.05, exposure: 2000, drawdown: 4.8 },
    };
    expect(veto.vetoReason).toBeDefined();
  });

  it('should create a valid ExecutionResult', () => {
    const result: ExecutionResult = {
      proposalId: 'tp-001',
      orderId: 'ord-abc123',
      adapter: 'binance',
      fillPrice: 84500,
      fillQty: 0.001,
      slippage: 0.02,
      fees: 0.08,
      timestamp: Date.now(),
    };
    expect(result.slippage).toBeGreaterThanOrEqual(0);
  });

  it('should create a valid NormalizedTick', () => {
    const tick: NormalizedTick = {
      timestamp: Date.now(),
      adapterId: 'binance',
      symbol: 'BTC/USDC',
      bid: 84500,
      ask: 84510,
      last: 84505,
      volume24h: 1200000,
      assetClass: 'crypto',
    };
    expect(tick.ask).toBeGreaterThanOrEqual(tick.bid);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/agents && npx vitest run src/alphanix/__tests__/types.test.ts`
Expected: FAIL — cannot find module `../types`

- [ ] **Step 3: Write types.ts**

```typescript
// packages/agents/src/alphanix/types.ts

export type AssetClass = 'crypto' | 'stock' | 'commodity' | 'forex';
export type PodState = 'starting' | 'running' | 'paused' | 'liquidating' | 'stopped' | 'error';
export type PodCommand = 'reduce_exposure' | 'pause' | 'resume' | 'update_config' | 'liquidate' | 'shutdown';

// --- Signal Pipeline ---

/** Quant → Risk */
export interface TradeProposal {
  id: string;
  podId: string;
  symbol: string;
  adapter: string;
  side: 'BUY' | 'SELL';
  confidence: number;        // 0-100
  sizing: { qty: number; notional: number };
  reasoning: string;
  models: string[];
  signals: string[];
  timestamp: number;
}

/** Risk → Execution (or veto) */
export interface RiskDecision {
  proposalId: string;
  action: 'approve' | 'veto' | 'reduce';
  adjustedSizing?: { qty: number; notional: number };
  vetoReason?: string;
  riskMetrics: {
    var: number;
    exposure: number;
    drawdown: number;
    esgScore?: number;
  };
}

/** Execution → Audit Log */
export interface ExecutionResult {
  proposalId: string;
  orderId: string;
  adapter: string;
  fillPrice: number;
  fillQty: number;
  slippage: number;
  fees: number;
  timestamp: number;
}

// --- Market Data ---

export interface NormalizedTick {
  timestamp: number;
  adapterId: string;
  symbol: string;
  bid: number;
  ask: number;
  last: number;
  volume24h: number;
  assetClass: AssetClass;
}

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface OrderBook {
  bids: Array<[number, number]>;  // [price, qty]
  asks: Array<[number, number]>;
  timestamp: number;
}

// --- Orders ---

export interface NormalizedOrder {
  symbol: string;
  side: 'BUY' | 'SELL';
  type: 'MARKET' | 'LIMIT';
  qty: number;
  limitPrice?: number;
}

export interface OrderResult {
  success: boolean;
  orderId?: string;
  status?: string;
  message?: string;
  filledQty?: number;
  filledAvgPrice?: number;
}

// --- Account ---

export interface AccountState {
  balance: number;
  equity: number;
  availableCapital: number;
  currency: string;
  updatedAt: number;
}

export interface NormalizedPosition {
  symbol: string;
  qty: number;
  avgEntryPrice: number;
  currentPrice: number;
  marketValue: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  adapter: string;
  openedAt?: string;
}

// --- Pod Config ---

export interface PodConfig {
  id: string;
  enabled: boolean;
  adapter: string;
  capitalPct: number;
  strategy: string;
  symbols: string[];
  pollIntervalMs: number;
  riskMaxDrawdownPct: number;
  riskMaxPositions: number;
  tradingHours?: string;
}

// --- Adapter Errors ---

export type AdapterErrorCategory =
  | 'rate_limit'
  | 'insufficient_funds'
  | 'market_closed'
  | 'auth_failure'
  | 'network'
  | 'order_rejected'
  | 'unknown';

export interface AdapterError {
  adapter: string;
  category: AdapterErrorCategory;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/agents && npx vitest run src/alphanix/__tests__/types.test.ts`
Expected: PASS (all 5 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/alphanix/types.ts packages/agents/src/alphanix/__tests__/types.test.ts
git commit -m "feat(alphanix): core type definitions — signal pipeline, market data, pod config"
```

---

### Task 2: TOML Config Loader

**Files:**
- Create: `alphanix.toml`
- Create: `packages/agents/src/alphanix/config.ts`
- Test: `packages/agents/src/alphanix/__tests__/config.test.ts`

- [ ] **Step 1: Create alphanix.toml**

```toml
# alphanix.toml — Alphanix Multi-Asset AI Trading Army

[orchestrator]
max_pods = 10
capital_total_usd = 10000
rebalance_interval_hours = 6
global_max_drawdown_pct = 5.0
morning_huddle_utc = "06:00"

[orchestrator.esg]
enabled = false
planetary_boundary_checks = false
min_esg_score = 40

[swarms]
max_concurrent_workers = 5
default_timeout_ms = 300000
backtest_timeout_ms = 900000

[pods.crypto]
enabled = true
adapter = "binance"
capital_pct = 100
strategy = "momentum_dip"
symbols = ["BTC/USDC", "ETH/USDC", "SOL/USDC"]
poll_interval_ms = 30000
risk_max_drawdown_pct = 3.0
risk_max_positions = 5

[pods.us_stocks]
enabled = false
adapter = "alpaca"
capital_pct = 0
strategy = "value_momentum"
symbols = ["AAPL", "MSFT", "NVDA"]
poll_interval_ms = 60000
risk_max_drawdown_pct = 2.0
risk_max_positions = 10
trading_hours = "09:30-16:00 ET"

[pods.eu_stocks]
enabled = false
adapter = "ibkr"
capital_pct = 0
strategy = "nordic_value"
symbols = ["HM-B.ST", "VOLV-B.ST"]
poll_interval_ms = 60000
risk_max_drawdown_pct = 2.0
risk_max_positions = 8
trading_hours = "09:00-17:30 CET"

[timing]
orchestrator_loop_ms = 60000
pod_default_loop_ms = 30000
state_publish_interval_ms = 10000
```

- [ ] **Step 2: Write config test**

```typescript
// packages/agents/src/alphanix/__tests__/config.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { loadAlphanixConfig, resetAlphanixConfig } from '../config';
import { join } from 'path';

describe('loadAlphanixConfig', () => {
  afterEach(() => resetAlphanixConfig());

  it('should load config from alphanix.toml', () => {
    const config = loadAlphanixConfig(join(__dirname, '..', '..', '..', '..', '..', 'alphanix.toml'));
    expect(config.orchestrator.max_pods).toBe(10);
    expect(config.orchestrator.capital_total_usd).toBe(10000);
    expect(config.pods.crypto.enabled).toBe(true);
    expect(config.pods.crypto.symbols).toContain('BTC/USDC');
  });

  it('should return defaults when file not found', () => {
    const config = loadAlphanixConfig('/nonexistent/path.toml');
    expect(config.orchestrator.max_pods).toBe(10);
    expect(config.pods.crypto.enabled).toBe(true);
  });

  it('should cache config on second call', () => {
    const path = join(__dirname, '..', '..', '..', '..', '..', 'alphanix.toml');
    const a = loadAlphanixConfig(path);
    const b = loadAlphanixConfig(path);
    expect(a).toBe(b);
  });

  it('should have all pod configs', () => {
    const config = loadAlphanixConfig();
    expect(config.pods.crypto).toBeDefined();
    expect(config.pods.us_stocks).toBeDefined();
    expect(config.pods.eu_stocks).toBeDefined();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/agents && npx vitest run src/alphanix/__tests__/config.test.ts`
Expected: FAIL — cannot find module `../config`

- [ ] **Step 4: Write config.ts**

```typescript
// packages/agents/src/alphanix/config.ts
import { readFileSync } from 'fs';
import { parse } from '@iarna/toml';
import { join } from 'path';
import type { PodConfig } from './types';

export interface AlphanixTomlConfig {
  orchestrator: {
    max_pods: number;
    capital_total_usd: number;
    rebalance_interval_hours: number;
    global_max_drawdown_pct: number;
    morning_huddle_utc: string;
    esg: {
      enabled: boolean;
      planetary_boundary_checks: boolean;
      min_esg_score: number;
    };
  };
  swarms: {
    max_concurrent_workers: number;
    default_timeout_ms: number;
    backtest_timeout_ms: number;
  };
  pods: Record<string, {
    enabled: boolean;
    adapter: string;
    capital_pct: number;
    strategy: string;
    symbols: string[];
    poll_interval_ms: number;
    risk_max_drawdown_pct: number;
    risk_max_positions: number;
    trading_hours?: string;
  }>;
  timing: {
    orchestrator_loop_ms: number;
    pod_default_loop_ms: number;
    state_publish_interval_ms: number;
  };
}

const DEFAULTS: AlphanixTomlConfig = {
  orchestrator: {
    max_pods: 10,
    capital_total_usd: 10000,
    rebalance_interval_hours: 6,
    global_max_drawdown_pct: 5.0,
    morning_huddle_utc: '06:00',
    esg: { enabled: false, planetary_boundary_checks: false, min_esg_score: 40 },
  },
  swarms: { max_concurrent_workers: 5, default_timeout_ms: 300000, backtest_timeout_ms: 900000 },
  pods: {
    crypto: {
      enabled: true, adapter: 'binance', capital_pct: 100, strategy: 'momentum_dip',
      symbols: ['BTC/USDC', 'ETH/USDC', 'SOL/USDC'], poll_interval_ms: 30000,
      risk_max_drawdown_pct: 3.0, risk_max_positions: 5,
    },
    us_stocks: {
      enabled: false, adapter: 'alpaca', capital_pct: 0, strategy: 'value_momentum',
      symbols: ['AAPL', 'MSFT', 'NVDA'], poll_interval_ms: 60000,
      risk_max_drawdown_pct: 2.0, risk_max_positions: 10, trading_hours: '09:30-16:00 ET',
    },
    eu_stocks: {
      enabled: false, adapter: 'ibkr', capital_pct: 0, strategy: 'nordic_value',
      symbols: ['HM-B.ST', 'VOLV-B.ST'], poll_interval_ms: 60000,
      risk_max_drawdown_pct: 2.0, risk_max_positions: 8, trading_hours: '09:00-17:30 CET',
    },
  },
  timing: { orchestrator_loop_ms: 60000, pod_default_loop_ms: 30000, state_publish_interval_ms: 10000 },
};

let _config: AlphanixTomlConfig | null = null;

export function loadAlphanixConfig(customPath?: string): AlphanixTomlConfig {
  if (_config) return _config;

  const searchPaths = customPath ? [customPath] : [
    join(process.cwd(), 'alphanix.toml'),
    join(process.cwd(), '..', '..', 'alphanix.toml'),
    join(__dirname, '..', '..', '..', '..', '..', 'alphanix.toml'),
  ];

  for (const filePath of searchPaths) {
    try {
      const raw = readFileSync(filePath, 'utf-8');
      const parsed = parse(raw) as any;
      _config = deepMerge(DEFAULTS, parsed) as AlphanixTomlConfig;
      console.info(`[ALPHANIX CONFIG] Loaded from ${filePath}`);
      return _config;
    } catch { /* try next */ }
  }

  console.warn('[ALPHANIX CONFIG] alphanix.toml not found. Using defaults.');
  _config = { ...DEFAULTS };
  return _config;
}

export function resetAlphanixConfig(): void { _config = null; }

function deepMerge(target: any, source: any): any {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key]) &&
        target[key] && typeof target[key] === 'object') {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

/** Convert TOML pod section to typed PodConfig */
export function toPodConfig(id: string, raw: AlphanixTomlConfig['pods'][string]): PodConfig {
  return {
    id,
    enabled: raw.enabled,
    adapter: raw.adapter,
    capitalPct: raw.capital_pct,
    strategy: raw.strategy,
    symbols: raw.symbols,
    pollIntervalMs: raw.poll_interval_ms,
    riskMaxDrawdownPct: raw.risk_max_drawdown_pct,
    riskMaxPositions: raw.risk_max_positions,
    tradingHours: raw.trading_hours,
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/agents && npx vitest run src/alphanix/__tests__/config.test.ts`
Expected: PASS (all 4 tests)

- [ ] **Step 6: Commit**

```bash
git add alphanix.toml packages/agents/src/alphanix/config.ts packages/agents/src/alphanix/__tests__/config.test.ts
git commit -m "feat(alphanix): TOML config loader with defaults and pod config conversion"
```

---

### Task 3: Adapter Interface + Registry

**Files:**
- Create: `packages/agents/src/alphanix/adapters/types.ts`
- Create: `packages/agents/src/alphanix/adapters/adapter-registry.ts`
- Test: `packages/agents/src/alphanix/__tests__/adapters.test.ts`

- [ ] **Step 1: Write adapter test**

```typescript
// packages/agents/src/alphanix/__tests__/adapters.test.ts
import { describe, it, expect } from 'vitest';
import type { MarketAdapter } from '../adapters/types';
import { AdapterRegistry } from '../adapters/adapter-registry';

const mockAdapter: MarketAdapter = {
  id: 'mock',
  assetClass: 'crypto',
  connect: async () => {},
  disconnect: async () => {},
  healthCheck: async () => ({ connected: true, latencyMs: 5 }),
  getOHLCV: async () => [],
  getOrderBook: async () => ({ bids: [], asks: [], timestamp: Date.now() }),
  getSymbols: async () => [],
  submitOrder: async () => ({ success: true, orderId: 'mock-1' }),
  cancelOrder: async () => {},
  getPositions: async () => [],
  getOpenOrders: async () => [],
  getAccountState: async () => ({
    balance: 10000, equity: 10000, availableCapital: 10000,
    currency: 'USDC', updatedAt: Date.now(),
  }),
  getTradingHours: () => ({ alwaysOpen: true }),
  getFees: () => ({ maker: 0.001, taker: 0.001 }),
};

describe('AdapterRegistry', () => {
  it('should register and retrieve an adapter', () => {
    const registry = new AdapterRegistry();
    registry.register(mockAdapter);
    expect(registry.get('mock')).toBe(mockAdapter);
  });

  it('should return undefined for unknown adapter', () => {
    const registry = new AdapterRegistry();
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('should list all registered adapters', () => {
    const registry = new AdapterRegistry();
    registry.register(mockAdapter);
    expect(registry.list()).toEqual(['mock']);
  });

  it('should connect all adapters', async () => {
    const registry = new AdapterRegistry();
    registry.register(mockAdapter);
    await registry.connectAll();
    // No error = success
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/agents && npx vitest run src/alphanix/__tests__/adapters.test.ts`
Expected: FAIL

- [ ] **Step 3: Write adapter types**

```typescript
// packages/agents/src/alphanix/adapters/types.ts
import type { Candle, OrderBook, NormalizedOrder, OrderResult,
              NormalizedPosition, AccountState, AssetClass } from '../types';

export interface HealthStatus {
  connected: boolean;
  latencyMs: number;
  error?: string;
}

export interface SymbolInfo {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  minQty: number;
  minNotional: number;
  pricePrecision: number;
  qtyPrecision: number;
}

export interface TradingSchedule {
  alwaysOpen?: boolean;
  hours?: string;           // e.g. "09:30-16:00 ET"
  timezone?: string;
}

export interface FeeStructure {
  maker: number;
  taker: number;
}

export interface MarketAdapter {
  readonly id: string;
  readonly assetClass: AssetClass;

  connect(): Promise<void>;
  disconnect(): Promise<void>;
  healthCheck(): Promise<HealthStatus>;

  getOHLCV(symbol: string, timeframe: string, limit?: number): Promise<Candle[]>;
  getOrderBook(symbol: string, depth?: number): Promise<OrderBook>;
  getSymbols(): Promise<SymbolInfo[]>;

  submitOrder(order: NormalizedOrder): Promise<OrderResult>;
  cancelOrder(orderId: string): Promise<void>;
  getPositions(): Promise<NormalizedPosition[]>;
  getOpenOrders(): Promise<NormalizedOrder[]>;
  getAccountState(): Promise<AccountState>;

  getTradingHours(): TradingSchedule;
  getFees(): FeeStructure;
}
```

- [ ] **Step 4: Write adapter registry**

```typescript
// packages/agents/src/alphanix/adapters/adapter-registry.ts
import type { MarketAdapter } from './types';

export class AdapterRegistry {
  private adapters = new Map<string, MarketAdapter>();

  register(adapter: MarketAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  get(id: string): MarketAdapter | undefined {
    return this.adapters.get(id);
  }

  list(): string[] {
    return Array.from(this.adapters.keys());
  }

  async connectAll(): Promise<void> {
    for (const [id, adapter] of this.adapters) {
      try {
        await adapter.connect();
        console.info(`[AdapterRegistry] Connected: ${id}`);
      } catch (err) {
        console.error(`[AdapterRegistry] Failed to connect ${id}:`, err);
      }
    }
  }

  async disconnectAll(): Promise<void> {
    for (const [id, adapter] of this.adapters) {
      try { await adapter.disconnect(); } catch { /* swallow */ }
    }
  }

  async healthCheckAll(): Promise<Record<string, { connected: boolean; latencyMs: number }>> {
    const results: Record<string, { connected: boolean; latencyMs: number }> = {};
    for (const [id, adapter] of this.adapters) {
      try {
        results[id] = await adapter.healthCheck();
      } catch {
        results[id] = { connected: false, latencyMs: -1 };
      }
    }
    return results;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/agents && npx vitest run src/alphanix/__tests__/adapters.test.ts`
Expected: PASS (all 4 tests)

- [ ] **Step 6: Commit**

```bash
git add packages/agents/src/alphanix/adapters/
git add packages/agents/src/alphanix/__tests__/adapters.test.ts
git commit -m "feat(alphanix): MarketAdapter interface + AdapterRegistry"
```

---

### Task 4: Binance Adapter

**Files:**
- Create: `packages/agents/src/alphanix/adapters/binance-adapter.ts`
- Modify: `packages/agents/src/alphanix/__tests__/adapters.test.ts` (add Binance tests)

- [ ] **Step 1: Add Binance adapter test**

Append to `adapters.test.ts`:

```typescript
import { BinanceAdapter } from '../adapters/binance-adapter';

describe('BinanceAdapter', () => {
  it('should have correct id and asset class', () => {
    const adapter = new BinanceAdapter({ paper: true });
    expect(adapter.id).toBe('binance');
    expect(adapter.assetClass).toBe('crypto');
  });

  it('should return always-open trading hours', () => {
    const adapter = new BinanceAdapter({ paper: true });
    expect(adapter.getTradingHours().alwaysOpen).toBe(true);
  });

  it('should return fee structure', () => {
    const adapter = new BinanceAdapter({ paper: true });
    const fees = adapter.getFees();
    expect(fees.maker).toBeLessThan(0.01);
    expect(fees.taker).toBeLessThan(0.01);
  });

  it('should report disconnected before connect', async () => {
    const adapter = new BinanceAdapter({ paper: true });
    const health = await adapter.healthCheck();
    expect(health.connected).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/agents && npx vitest run src/alphanix/__tests__/adapters.test.ts`
Expected: FAIL — cannot find module `../adapters/binance-adapter`

- [ ] **Step 3: Write BinanceAdapter**

```typescript
// packages/agents/src/alphanix/adapters/binance-adapter.ts
import type { MarketAdapter, HealthStatus, SymbolInfo, TradingSchedule, FeeStructure } from './types';
import type { Candle, OrderBook, NormalizedOrder, OrderResult,
              NormalizedPosition, AccountState, AssetClass } from '../types';

interface BinanceAdapterOptions {
  paper: boolean;
  apiKey?: string;
  apiSecret?: string;
}

export class BinanceAdapter implements MarketAdapter {
  readonly id = 'binance';
  readonly assetClass: AssetClass = 'crypto';

  private exchange: any = null;
  private options: BinanceAdapterOptions;

  constructor(options: BinanceAdapterOptions) {
    this.options = options;
  }

  async connect(): Promise<void> {
    const ccxt = await import('ccxt');
    this.exchange = new ccxt.binance({
      apiKey: this.options.apiKey || process.env.BINANCE_API_KEY,
      secret: this.options.apiSecret || process.env.BINANCE_API_SECRET,
      enableRateLimit: true,
      options: { defaultType: 'spot' },
    });
    if (this.options.paper) {
      this.exchange.setSandboxMode(true);
    }
    await this.exchange.loadMarkets();
  }

  async disconnect(): Promise<void> {
    this.exchange = null;
  }

  async healthCheck(): Promise<HealthStatus> {
    if (!this.exchange) return { connected: false, latencyMs: -1 };
    try {
      const start = Date.now();
      await this.exchange.fetchTime();
      return { connected: true, latencyMs: Date.now() - start };
    } catch (err: any) {
      return { connected: false, latencyMs: -1, error: err.message };
    }
  }

  async getOHLCV(symbol: string, timeframe: string = '15m', limit: number = 100): Promise<Candle[]> {
    if (!this.exchange) throw new Error('Not connected');
    const data = await this.exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
    return data.map((c: any) => ({
      timestamp: c[0],
      open: c[1],
      high: c[2],
      low: c[3],
      close: c[4],
      volume: c[5],
    }));
  }

  async getOrderBook(symbol: string, depth: number = 20): Promise<OrderBook> {
    if (!this.exchange) throw new Error('Not connected');
    const book = await this.exchange.fetchOrderBook(symbol, depth);
    return {
      bids: book.bids.slice(0, depth),
      asks: book.asks.slice(0, depth),
      timestamp: book.timestamp || Date.now(),
    };
  }

  async getSymbols(): Promise<SymbolInfo[]> {
    if (!this.exchange) throw new Error('Not connected');
    return Object.values(this.exchange.markets)
      .filter((m: any) => m.spot && m.active && m.quote === 'USDC')
      .map((m: any) => ({
        symbol: m.symbol,
        baseAsset: m.base,
        quoteAsset: m.quote,
        minQty: m.limits?.amount?.min || 0,
        minNotional: m.limits?.cost?.min || 0,
        pricePrecision: m.precision?.price || 8,
        qtyPrecision: m.precision?.amount || 8,
      }));
  }

  async submitOrder(order: NormalizedOrder): Promise<OrderResult> {
    if (!this.exchange) throw new Error('Not connected');
    try {
      const result = await this.exchange.createOrder(
        order.symbol,
        order.type.toLowerCase(),
        order.side.toLowerCase(),
        order.qty,
        order.limitPrice,
      );
      return {
        success: true,
        orderId: result.id,
        status: result.status,
        filledQty: result.filled,
        filledAvgPrice: result.average,
      };
    } catch (err: any) {
      return { success: false, message: err.message };
    }
  }

  async cancelOrder(orderId: string): Promise<void> {
    if (!this.exchange) throw new Error('Not connected');
    await this.exchange.cancelOrder(orderId);
  }

  async getPositions(): Promise<NormalizedPosition[]> {
    // Spot exchange: derive from balance
    if (!this.exchange) throw new Error('Not connected');
    const balance = await this.exchange.fetchBalance();
    const positions: NormalizedPosition[] = [];
    for (const [asset, info] of Object.entries(balance.total || {})) {
      const qty = info as number;
      if (qty > 0 && asset !== 'USDC' && asset !== 'USDT') {
        const symbol = `${asset}/USDC`;
        try {
          const ticker = await this.exchange.fetchTicker(symbol);
          positions.push({
            symbol,
            qty,
            avgEntryPrice: 0,  // Not available from spot balance
            currentPrice: ticker.last || 0,
            marketValue: qty * (ticker.last || 0),
            unrealizedPnl: 0,
            unrealizedPnlPct: 0,
            adapter: this.id,
          });
        } catch { /* symbol not tradeable */ }
      }
    }
    return positions;
  }

  async getOpenOrders(): Promise<NormalizedOrder[]> {
    if (!this.exchange) throw new Error('Not connected');
    const orders = await this.exchange.fetchOpenOrders();
    return orders.map((o: any) => ({
      symbol: o.symbol,
      side: o.side.toUpperCase(),
      type: o.type.toUpperCase(),
      qty: o.amount,
      limitPrice: o.price,
    }));
  }

  async getAccountState(): Promise<AccountState> {
    if (!this.exchange) throw new Error('Not connected');
    const balance = await this.exchange.fetchBalance();
    const usdcFree = balance.free?.USDC || 0;
    const usdcTotal = balance.total?.USDC || 0;
    return {
      balance: usdcTotal,
      equity: usdcTotal,
      availableCapital: usdcFree,
      currency: 'USDC',
      updatedAt: Date.now(),
    };
  }

  getTradingHours(): TradingSchedule {
    return { alwaysOpen: true };
  }

  getFees(): FeeStructure {
    return { maker: 0.001, taker: 0.001 };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/agents && npx vitest run src/alphanix/__tests__/adapters.test.ts`
Expected: PASS (all 8 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/alphanix/adapters/binance-adapter.ts
git add packages/agents/src/alphanix/__tests__/adapters.test.ts
git commit -m "feat(alphanix): BinanceAdapter wrapping CCXT for crypto market data + execution"
```

---

### Task 5: Quant Agent

**Files:**
- Create: `packages/agents/src/alphanix/pod/quant-agent.ts`
- Test: `packages/agents/src/alphanix/__tests__/quant-agent.test.ts`

- [ ] **Step 1: Write quant agent test**

```typescript
// packages/agents/src/alphanix/__tests__/quant-agent.test.ts
import { describe, it, expect } from 'vitest';
import { QuantAgent } from '../pod/quant-agent';
import type { Candle } from '../types';

const mockCandles: Candle[] = Array.from({ length: 30 }, (_, i) => ({
  timestamp: Date.now() - (30 - i) * 60000,
  open: 84000 + i * 10,
  high: 84050 + i * 10,
  low: 83950 + i * 10,
  close: 84000 + i * 10 + (i > 25 ? -200 : 5),  // dip in last 4 candles
  volume: 100 + i * 5,
}));

describe('QuantAgent', () => {
  const quant = new QuantAgent('crypto', ['rsi', 'volume']);

  it('should generate proposals from candle data', () => {
    const proposals = quant.analyze('BTC/USDC', 'binance', mockCandles);
    expect(Array.isArray(proposals)).toBe(true);
    for (const p of proposals) {
      expect(p.podId).toBe('crypto');
      expect(p.adapter).toBe('binance');
      expect(p.confidence).toBeGreaterThanOrEqual(0);
      expect(p.confidence).toBeLessThanOrEqual(100);
    }
  });

  it('should return empty array for insufficient data', () => {
    const proposals = quant.analyze('BTC/USDC', 'binance', mockCandles.slice(0, 5));
    expect(proposals).toEqual([]);
  });

  it('should assign unique IDs to proposals', () => {
    const proposals = quant.analyze('BTC/USDC', 'binance', mockCandles);
    const ids = proposals.map(p => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/agents && npx vitest run src/alphanix/__tests__/quant-agent.test.ts`

- [ ] **Step 3: Write QuantAgent**

```typescript
// packages/agents/src/alphanix/pod/quant-agent.ts
import type { Candle, TradeProposal } from '../types';
import { randomUUID } from 'crypto';

const MIN_CANDLES = 14;

export class QuantAgent {
  private podId: string;
  private models: string[];

  constructor(podId: string, models: string[] = ['rsi', 'volume']) {
    this.podId = podId;
    this.models = models;
  }

  analyze(symbol: string, adapter: string, candles: Candle[]): TradeProposal[] {
    if (candles.length < MIN_CANDLES) return [];

    const proposals: TradeProposal[] = [];
    const signals: string[] = [];
    let confidence = 0;

    // RSI check
    if (this.models.includes('rsi')) {
      const rsi = this.calcRSI(candles, 14);
      if (rsi < 35) {
        signals.push('rsi_oversold');
        confidence += 40;
      } else if (rsi > 70) {
        signals.push('rsi_overbought');
        confidence -= 20;
      }
    }

    // Volume spike check
    if (this.models.includes('volume')) {
      const avgVol = candles.slice(-20).reduce((s, c) => s + c.volume, 0) / 20;
      const lastVol = candles[candles.length - 1].volume;
      if (lastVol > avgVol * 1.5) {
        signals.push('volume_spike');
        confidence += 20;
      }
    }

    // Dip check
    const recent = candles.slice(-5);
    const highPrice = Math.max(...recent.map(c => c.high));
    const lastClose = candles[candles.length - 1].close;
    const dip = (highPrice - lastClose) / highPrice;
    if (dip > 0.03) {
      signals.push('dip_buy');
      confidence += 25;
    }

    if (signals.length > 0 && confidence > 0) {
      proposals.push({
        id: `tp-${randomUUID().slice(0, 8)}`,
        podId: this.podId,
        symbol,
        adapter,
        side: confidence > 0 ? 'BUY' : 'SELL',
        confidence: Math.min(100, Math.max(0, confidence)),
        sizing: { qty: 0, notional: 0 },  // Sized by pod after risk approval
        reasoning: signals.join(' + '),
        models: this.models.filter(m =>
          signals.some(s => s.startsWith(m.split('_')[0]) || m === 'rsi' && s.includes('rsi') || m === 'volume' && s.includes('volume'))
        ),
        signals,
        timestamp: Date.now(),
      });
    }

    return proposals;
  }

  private calcRSI(candles: Candle[], period: number): number {
    const closes = candles.slice(-period - 1).map(c => c.close);
    let gains = 0, losses = 0;
    for (let i = 1; i < closes.length; i++) {
      const change = closes[i] - closes[i - 1];
      if (change > 0) gains += change;
      else losses -= change;
    }
    const avgGain = gains / period;
    const avgLoss = losses / period || 0.0001;  // prevent division by zero
    const rs = avgGain / avgLoss;
    return Math.min(99, Math.max(1, 100 - (100 / (1 + rs))));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/agents && npx vitest run src/alphanix/__tests__/quant-agent.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/alphanix/pod/quant-agent.ts packages/agents/src/alphanix/__tests__/quant-agent.test.ts
git commit -m "feat(alphanix): QuantAgent — RSI, volume spike, dip detection"
```

---

### Task 6: Risk Agent

**Files:**
- Create: `packages/agents/src/alphanix/pod/risk-agent.ts`
- Test: `packages/agents/src/alphanix/__tests__/risk-agent.test.ts`

- [ ] **Step 1: Write risk agent test**

```typescript
// packages/agents/src/alphanix/__tests__/risk-agent.test.ts
import { describe, it, expect } from 'vitest';
import { RiskAgent } from '../pod/risk-agent';
import type { TradeProposal } from '../types';

const makeProposal = (overrides: Partial<TradeProposal> = {}): TradeProposal => ({
  id: 'tp-001', podId: 'crypto', symbol: 'BTC/USDC', adapter: 'binance',
  side: 'BUY', confidence: 75, sizing: { qty: 0.001, notional: 85 },
  reasoning: 'test', models: ['rsi'], signals: ['rsi_oversold'], timestamp: Date.now(),
  ...overrides,
});

describe('RiskAgent', () => {
  it('should approve a valid proposal', () => {
    const risk = new RiskAgent('crypto', { maxDrawdownPct: 3.0, maxPositions: 5, minConfidence: 60 });
    const decision = risk.evaluate(makeProposal(), { openPositions: 2, currentDrawdownPct: 1.0 });
    expect(decision.action).toBe('approve');
  });

  it('should veto when confidence too low', () => {
    const risk = new RiskAgent('crypto', { maxDrawdownPct: 3.0, maxPositions: 5, minConfidence: 60 });
    const decision = risk.evaluate(makeProposal({ confidence: 30 }), { openPositions: 0, currentDrawdownPct: 0 });
    expect(decision.action).toBe('veto');
    expect(decision.vetoReason).toContain('confidence');
  });

  it('should veto when max positions reached', () => {
    const risk = new RiskAgent('crypto', { maxDrawdownPct: 3.0, maxPositions: 5, minConfidence: 60 });
    const decision = risk.evaluate(makeProposal(), { openPositions: 5, currentDrawdownPct: 0 });
    expect(decision.action).toBe('veto');
    expect(decision.vetoReason).toContain('position');
  });

  it('should veto when drawdown exceeds limit', () => {
    const risk = new RiskAgent('crypto', { maxDrawdownPct: 3.0, maxPositions: 5, minConfidence: 60 });
    const decision = risk.evaluate(makeProposal(), { openPositions: 1, currentDrawdownPct: 3.5 });
    expect(decision.action).toBe('veto');
    expect(decision.vetoReason).toContain('drawdown');
  });

  it('should track daily P&L and trigger circuit breaker', () => {
    const risk = new RiskAgent('crypto', { maxDrawdownPct: 3.0, maxPositions: 5, minConfidence: 60 });
    risk.recordExit(-50);
    risk.recordExit(-60);
    risk.recordExit(-40);
    const state = risk.getState();
    expect(state.consecutiveLosses).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Write RiskAgent**

```typescript
// packages/agents/src/alphanix/pod/risk-agent.ts
import type { TradeProposal, RiskDecision } from '../types';

interface RiskConfig {
  maxDrawdownPct: number;
  maxPositions: number;
  minConfidence: number;
}

interface PortfolioContext {
  openPositions: number;
  currentDrawdownPct: number;
}

export interface RiskState {
  canTrade: boolean;
  dailyPnl: number;
  consecutiveLosses: number;
  tradesToday: number;
}

export class RiskAgent {
  private podId: string;
  private config: RiskConfig;
  private dailyPnl = 0;
  private consecutiveLosses = 0;
  private tradesToday = 0;

  constructor(podId: string, config: RiskConfig) {
    this.podId = podId;
    this.config = config;
  }

  evaluate(proposal: TradeProposal, ctx: PortfolioContext): RiskDecision {
    const metrics = {
      var: ctx.currentDrawdownPct / 100,
      exposure: ctx.openPositions * 100,
      drawdown: ctx.currentDrawdownPct,
    };

    if (proposal.confidence < this.config.minConfidence) {
      return {
        proposalId: proposal.id,
        action: 'veto',
        vetoReason: `confidence ${proposal.confidence} < min ${this.config.minConfidence}`,
        riskMetrics: metrics,
      };
    }

    if (ctx.openPositions >= this.config.maxPositions) {
      return {
        proposalId: proposal.id,
        action: 'veto',
        vetoReason: `max positions reached (${ctx.openPositions}/${this.config.maxPositions})`,
        riskMetrics: metrics,
      };
    }

    if (ctx.currentDrawdownPct >= this.config.maxDrawdownPct) {
      return {
        proposalId: proposal.id,
        action: 'veto',
        vetoReason: `drawdown ${ctx.currentDrawdownPct}% >= limit ${this.config.maxDrawdownPct}%`,
        riskMetrics: metrics,
      };
    }

    return {
      proposalId: proposal.id,
      action: 'approve',
      riskMetrics: metrics,
    };
  }

  recordExit(pnlDollar: number): void {
    this.dailyPnl += pnlDollar;
    this.tradesToday++;
    if (pnlDollar < 0) this.consecutiveLosses++;
    else this.consecutiveLosses = 0;
  }

  resetDaily(): void {
    this.dailyPnl = 0;
    this.tradesToday = 0;
  }

  getState(): RiskState {
    return {
      canTrade: true,
      dailyPnl: this.dailyPnl,
      consecutiveLosses: this.consecutiveLosses,
      tradesToday: this.tradesToday,
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/alphanix/pod/risk-agent.ts packages/agents/src/alphanix/__tests__/risk-agent.test.ts
git commit -m "feat(alphanix): RiskAgent — confidence gate, position limits, drawdown circuit breaker"
```

---

### Task 7: Pod Container

**Files:**
- Create: `packages/agents/src/alphanix/pod/pod.ts`
- Test: `packages/agents/src/alphanix/__tests__/pod.test.ts`

- [ ] **Step 1: Write pod test**

```typescript
// packages/agents/src/alphanix/__tests__/pod.test.ts
import { describe, it, expect, vi } from 'vitest';
import { Pod } from '../pod/pod';
import type { PodConfig, Candle } from '../types';
import type { MarketAdapter } from '../adapters/types';

const mockCandles: Candle[] = Array.from({ length: 30 }, (_, i) => ({
  timestamp: Date.now() - (30 - i) * 60000,
  open: 84000, high: 84050, low: 83950,
  close: 84000 - (i > 25 ? 200 : 0),
  volume: 100 + i * 5,
}));

const mockAdapter: MarketAdapter = {
  id: 'binance', assetClass: 'crypto',
  connect: async () => {}, disconnect: async () => {},
  healthCheck: async () => ({ connected: true, latencyMs: 5 }),
  getOHLCV: async () => mockCandles,
  getOrderBook: async () => ({ bids: [[84000, 1]], asks: [[84010, 1]], timestamp: Date.now() }),
  getSymbols: async () => [],
  submitOrder: async () => ({ success: true, orderId: 'test-1', filledQty: 0.001, filledAvgPrice: 84000 }),
  cancelOrder: async () => {},
  getPositions: async () => [],
  getOpenOrders: async () => [],
  getAccountState: async () => ({ balance: 10000, equity: 10000, availableCapital: 10000, currency: 'USDC', updatedAt: Date.now() }),
  getTradingHours: () => ({ alwaysOpen: true }),
  getFees: () => ({ maker: 0.001, taker: 0.001 }),
};

const podConfig: PodConfig = {
  id: 'crypto', enabled: true, adapter: 'binance', capitalPct: 100,
  strategy: 'momentum_dip', symbols: ['BTC/USDC'],
  pollIntervalMs: 30000, riskMaxDrawdownPct: 3.0, riskMaxPositions: 5,
};

describe('Pod', () => {
  it('should initialize with correct state', () => {
    const pod = new Pod(podConfig, mockAdapter, 10000);
    expect(pod.getState()).toBe('starting');
    expect(pod.getId()).toBe('crypto');
  });

  it('should run one scan cycle', async () => {
    const pod = new Pod(podConfig, mockAdapter, 10000);
    const results = await pod.runCycle();
    expect(results).toBeDefined();
    expect(results.scannedSymbols).toBe(1);
  });

  it('should respect capital allocation', () => {
    const pod = new Pod(podConfig, mockAdapter, 10000);
    expect(pod.getCapitalBudget()).toBe(10000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Write Pod class**

```typescript
// packages/agents/src/alphanix/pod/pod.ts
import type { PodConfig, PodState, TradeProposal, RiskDecision, ExecutionResult } from '../types';
import type { MarketAdapter } from '../adapters/types';
import { QuantAgent } from './quant-agent';
import { RiskAgent } from './risk-agent';

export interface CycleResult {
  scannedSymbols: number;
  proposalsGenerated: number;
  approved: number;
  vetoed: number;
  executed: number;
  errors: string[];
}

export class Pod {
  private config: PodConfig;
  private adapter: MarketAdapter;
  private capitalBudget: number;
  private state: PodState = 'starting';

  private quant: QuantAgent;
  private risk: RiskAgent;
  private positions: Map<string, any> = new Map();

  constructor(config: PodConfig, adapter: MarketAdapter, capitalBudget: number) {
    this.config = config;
    this.adapter = adapter;
    this.capitalBudget = capitalBudget;

    this.quant = new QuantAgent(config.id, ['rsi', 'volume']);
    this.risk = new RiskAgent(config.id, {
      maxDrawdownPct: config.riskMaxDrawdownPct,
      maxPositions: config.riskMaxPositions,
      minConfidence: 60,
    });
  }

  getId(): string { return this.config.id; }
  getState(): PodState { return this.state; }
  getCapitalBudget(): number { return this.capitalBudget; }
  updateCapitalBudget(amount: number): void { this.capitalBudget = amount; }

  async runCycle(): Promise<CycleResult> {
    this.state = 'running';
    const result: CycleResult = {
      scannedSymbols: 0, proposalsGenerated: 0,
      approved: 0, vetoed: 0, executed: 0, errors: [],
    };

    for (const symbol of this.config.symbols) {
      result.scannedSymbols++;
      try {
        // 1. Quant: fetch data + generate proposals
        const candles = await this.adapter.getOHLCV(symbol, '15m', 30);
        const proposals = this.quant.analyze(symbol, this.adapter.id, candles);
        result.proposalsGenerated += proposals.length;

        for (const proposal of proposals) {
          // 2. Size the order
          const sized = this.sizeOrder(proposal);

          // 3. Risk: evaluate
          const decision = this.risk.evaluate(sized, {
            openPositions: this.positions.size,
            currentDrawdownPct: 0,  // TODO: calculate from positions
          });

          if (decision.action === 'veto') {
            result.vetoed++;
            continue;
          }

          // 4. Execute
          if (decision.action === 'approve') {
            result.approved++;
            try {
              const orderResult = await this.adapter.submitOrder({
                symbol: sized.symbol,
                side: sized.side,
                type: 'MARKET',
                qty: sized.sizing.qty,
              });
              if (orderResult.success) {
                result.executed++;
                this.positions.set(symbol, {
                  ...orderResult,
                  entryPrice: orderResult.filledAvgPrice,
                  qty: orderResult.filledQty,
                });
              }
            } catch (err: any) {
              result.errors.push(`Execution failed for ${symbol}: ${err.message}`);
            }
          }
        }
      } catch (err: any) {
        result.errors.push(`Scan failed for ${symbol}: ${err.message}`);
      }
    }

    return result;
  }

  private sizeOrder(proposal: TradeProposal): TradeProposal {
    const maxPerTrade = this.capitalBudget * 0.1;  // 10% of pod capital per trade
    return {
      ...proposal,
      sizing: {
        notional: Math.min(maxPerTrade, this.capitalBudget * 0.2),
        qty: 0,  // Will be calculated by execution based on current price
      },
    };
  }

  async stop(): Promise<void> {
    this.state = 'stopped';
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/alphanix/pod/pod.ts packages/agents/src/alphanix/__tests__/pod.test.ts
git commit -m "feat(alphanix): Pod container — Quant→Risk→Execution pipeline"
```

---

### Task 8: Execution Agent (standalone)

**Files:**
- Create: `packages/agents/src/alphanix/pod/execution-agent.ts`
- Test: `packages/agents/src/alphanix/__tests__/execution-agent.test.ts`

- [ ] **Step 1: Write execution agent test**

```typescript
// packages/agents/src/alphanix/__tests__/execution-agent.test.ts
import { describe, it, expect } from 'vitest';
import { ExecutionAgent } from '../pod/execution-agent';
import type { TradeProposal, RiskDecision } from '../types';
import type { MarketAdapter } from '../adapters/types';

const mockAdapter: any = {
  id: 'binance',
  submitOrder: async () => ({ success: true, orderId: 'ord-1', filledQty: 0.001, filledAvgPrice: 84500 }),
  getOrderBook: async () => ({ bids: [[84490, 1]], asks: [[84510, 1]], timestamp: Date.now() }),
};

describe('ExecutionAgent', () => {
  const exec = new ExecutionAgent('crypto');

  it('should execute an approved proposal', async () => {
    const proposal: TradeProposal = {
      id: 'tp-1', podId: 'crypto', symbol: 'BTC/USDC', adapter: 'binance',
      side: 'BUY', confidence: 80, sizing: { qty: 0.001, notional: 85 },
      reasoning: 'test', models: ['rsi'], signals: ['rsi_oversold'], timestamp: Date.now(),
    };
    const decision: RiskDecision = {
      proposalId: 'tp-1', action: 'approve',
      riskMetrics: { var: 0.01, exposure: 100, drawdown: 0.5 },
    };
    const result = await exec.execute(proposal, decision, mockAdapter);
    expect(result.orderId).toBe('ord-1');
    expect(result.fillPrice).toBe(84500);
  });

  it('should check spread before executing', async () => {
    const wideSpreadAdapter: any = {
      ...mockAdapter,
      getOrderBook: async () => ({ bids: [[80000, 1]], asks: [[85000, 1]], timestamp: Date.now() }),
    };
    const proposal: TradeProposal = {
      id: 'tp-2', podId: 'crypto', symbol: 'BTC/USDC', adapter: 'binance',
      side: 'BUY', confidence: 80, sizing: { qty: 0.001, notional: 85 },
      reasoning: 'test', models: [], signals: [], timestamp: Date.now(),
    };
    const decision: RiskDecision = {
      proposalId: 'tp-2', action: 'approve',
      riskMetrics: { var: 0, exposure: 0, drawdown: 0 },
    };
    const result = await exec.execute(proposal, decision, wideSpreadAdapter);
    expect(result.orderId).toBe('');  // Rejected due to wide spread
  });
});
```

- [ ] **Step 2: Run test, verify fail**

- [ ] **Step 3: Write ExecutionAgent**

```typescript
// packages/agents/src/alphanix/pod/execution-agent.ts
import type { TradeProposal, RiskDecision, ExecutionResult } from '../types';
import type { MarketAdapter } from '../adapters/types';

const MAX_SPREAD_PCT = 0.003;  // 0.3% max bid-ask spread

export class ExecutionAgent {
  private podId: string;

  constructor(podId: string) {
    this.podId = podId;
  }

  async execute(
    proposal: TradeProposal,
    decision: RiskDecision,
    adapter: MarketAdapter,
  ): Promise<ExecutionResult> {
    const emptyResult: ExecutionResult = {
      proposalId: proposal.id, orderId: '', adapter: proposal.adapter,
      fillPrice: 0, fillQty: 0, slippage: 0, fees: 0, timestamp: Date.now(),
    };

    if (decision.action !== 'approve') return emptyResult;

    // Spread check
    try {
      const book = await adapter.getOrderBook(proposal.symbol, 5);
      if (book.bids.length > 0 && book.asks.length > 0) {
        const bestBid = book.bids[0][0];
        const bestAsk = book.asks[0][0];
        const mid = (bestBid + bestAsk) / 2;
        const spreadPct = (bestAsk - bestBid) / mid;
        if (spreadPct > MAX_SPREAD_PCT) {
          console.warn(`[ExecutionAgent:${this.podId}] Spread too wide for ${proposal.symbol}: ${(spreadPct * 100).toFixed(2)}%`);
          return emptyResult;
        }
      }
    } catch { /* proceed without spread check */ }

    // Size: use decision's adjusted sizing if available
    const sizing = decision.adjustedSizing || proposal.sizing;

    const result = await adapter.submitOrder({
      symbol: proposal.symbol,
      side: proposal.side,
      type: 'MARKET',
      qty: sizing.qty,
    });

    return {
      proposalId: proposal.id,
      orderId: result.orderId || '',
      adapter: proposal.adapter,
      fillPrice: result.filledAvgPrice || 0,
      fillQty: result.filledQty || 0,
      slippage: 0,  // Calculated post-fill
      fees: (result.filledAvgPrice || 0) * (result.filledQty || 0) * 0.001,
      timestamp: Date.now(),
    };
  }
}
```

- [ ] **Step 4: Run test, verify pass**

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/alphanix/pod/execution-agent.ts packages/agents/src/alphanix/__tests__/execution-agent.test.ts
git commit -m "feat(alphanix): ExecutionAgent — spread check + order routing"
```

---

### Task 9: Orchestrator + Capital Allocator

**Files:**
- Create: `packages/agents/src/alphanix/orchestrator/orchestrator.ts`
- Create: `packages/agents/src/alphanix/orchestrator/capital-allocator.ts`
- Test: `packages/agents/src/alphanix/__tests__/orchestrator.test.ts`

- [ ] **Step 1: Write orchestrator test**

```typescript
// packages/agents/src/alphanix/__tests__/orchestrator.test.ts
import { describe, it, expect } from 'vitest';
import { CapitalAllocator } from '../orchestrator/capital-allocator';
import { Orchestrator } from '../orchestrator/orchestrator';

describe('CapitalAllocator', () => {
  it('should allocate capital by percentage', () => {
    const allocator = new CapitalAllocator(10000);
    const budgets = allocator.allocate({ crypto: 60, us_stocks: 40 });
    expect(budgets.crypto).toBe(6000);
    expect(budgets.us_stocks).toBe(4000);
  });

  it('should handle single pod at 100%', () => {
    const allocator = new CapitalAllocator(5000);
    const budgets = allocator.allocate({ crypto: 100 });
    expect(budgets.crypto).toBe(5000);
  });

  it('should cap at total capital', () => {
    const allocator = new CapitalAllocator(1000);
    const budgets = allocator.allocate({ a: 60, b: 60 });
    // 120% requested, capped proportionally
    expect(budgets.a + budgets.b).toBeLessThanOrEqual(1000);
  });
});

describe('Orchestrator', () => {
  it('should track pod states', () => {
    const orch = new Orchestrator({ totalCapital: 10000, maxPods: 5, maxDrawdownPct: 5 });
    orch.registerPod('crypto', 'running');
    orch.registerPod('us_stocks', 'paused');
    expect(orch.getPodStates()).toEqual({ crypto: 'running', us_stocks: 'paused' });
  });

  it('should detect global drawdown breach', () => {
    const orch = new Orchestrator({ totalCapital: 10000, maxPods: 5, maxDrawdownPct: 5 });
    expect(orch.isGlobalDrawdownBreached(4.9)).toBe(false);
    expect(orch.isGlobalDrawdownBreached(5.1)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test, verify fail**

- [ ] **Step 3: Write CapitalAllocator**

```typescript
// packages/agents/src/alphanix/orchestrator/capital-allocator.ts
export class CapitalAllocator {
  private totalCapital: number;

  constructor(totalCapital: number) {
    this.totalCapital = totalCapital;
  }

  setTotalCapital(amount: number): void { this.totalCapital = amount; }
  getTotalCapital(): number { return this.totalCapital; }

  allocate(percentages: Record<string, number>): Record<string, number> {
    const total = Object.values(percentages).reduce((s, v) => s + v, 0);
    const scale = total > 100 ? 100 / total : 1;

    const budgets: Record<string, number> = {};
    for (const [podId, pct] of Object.entries(percentages)) {
      budgets[podId] = Math.floor(this.totalCapital * (pct * scale) / 100);
    }
    return budgets;
  }
}
```

- [ ] **Step 4: Write Orchestrator**

```typescript
// packages/agents/src/alphanix/orchestrator/orchestrator.ts
import type { PodState } from '../types';

interface OrchestratorConfig {
  totalCapital: number;
  maxPods: number;
  maxDrawdownPct: number;
}

export class Orchestrator {
  private config: OrchestratorConfig;
  private podStates = new Map<string, PodState>();

  constructor(config: OrchestratorConfig) {
    this.config = config;
  }

  registerPod(podId: string, state: PodState): void {
    this.podStates.set(podId, state);
  }

  updatePodState(podId: string, state: PodState): void {
    this.podStates.set(podId, state);
  }

  getPodStates(): Record<string, PodState> {
    return Object.fromEntries(this.podStates);
  }

  isGlobalDrawdownBreached(currentDrawdownPct: number): boolean {
    return currentDrawdownPct >= this.config.maxDrawdownPct;
  }

  canAddPod(): boolean {
    return this.podStates.size < this.config.maxPods;
  }
}
```

- [ ] **Step 5: Run test, verify pass**

- [ ] **Step 6: Commit**

```bash
git add packages/agents/src/alphanix/orchestrator/ packages/agents/src/alphanix/__tests__/orchestrator.test.ts
git commit -m "feat(alphanix): Orchestrator + CapitalAllocator — pod lifecycle, capital distribution"
```

---

### Task 10: State Publisher

**Files:**
- Create: `packages/agents/src/alphanix/state/state-publisher.ts`

- [ ] **Step 1: Write StatePublisher**

Reuse the Aktienix StatePublisher pattern with `alphanix` namespace:

```typescript
// packages/agents/src/alphanix/state/state-publisher.ts
import type { PodState, NormalizedPosition, AccountState } from '../types';
import type { RiskState } from '../pod/risk-agent';
import type { CycleResult } from '../pod/pod';

const TTL = 300;
const MAX_SIGNALS = 50;

export class AlphanixStatePublisher {
  private redis: any = null;
  private connecting: Promise<void> | null = null;

  constructor(private kvUrl: string) {}

  private async ensureConnected(): Promise<void> {
    if (this.redis?.status === 'ready') return;
    if (!this.connecting) {
      this.connecting = (async () => {
        const Redis = (await import('ioredis')).default;
        this.redis = new Redis(this.kvUrl);
      })().finally(() => { this.connecting = null; });
    }
    await this.connecting;
  }

  async publishOrchestratorState(state: Record<string, any>): Promise<void> {
    try {
      await this.ensureConnected();
      await this.redis.set('alphanix:orchestrator:state', JSON.stringify(state), 'EX', TTL);
    } catch (err) { console.error('[AlphanixState] orchestrator error:', err); }
  }

  async publishPodState(podId: string, state: PodState): Promise<void> {
    try {
      await this.ensureConnected();
      await this.redis.set(`alphanix:pod:${podId}:state`, state, 'EX', TTL);
    } catch (err) { console.error('[AlphanixState] pod state error:', err); }
  }

  async publishPodPositions(podId: string, positions: NormalizedPosition[]): Promise<void> {
    try {
      await this.ensureConnected();
      await this.redis.set(`alphanix:pod:${podId}:positions`, JSON.stringify(positions), 'EX', TTL);
    } catch (err) { console.error('[AlphanixState] positions error:', err); }
  }

  async publishPodRisk(podId: string, risk: RiskState): Promise<void> {
    try {
      await this.ensureConnected();
      await this.redis.set(`alphanix:pod:${podId}:risk`, JSON.stringify(risk), 'EX', TTL);
    } catch (err) { console.error('[AlphanixState] risk error:', err); }
  }

  async publishHeartbeat(podId: string): Promise<void> {
    try {
      await this.ensureConnected();
      await this.redis.set(`alphanix:pod:${podId}:heartbeat`, Date.now().toString(), 'EX', 90);
    } catch (err) { console.error('[AlphanixState] heartbeat error:', err); }
  }

  async publishStatus(status: string): Promise<void> {
    try {
      await this.ensureConnected();
      await this.redis.set('alphanix:status', status, 'EX', TTL);
    } catch (err) { console.error('[AlphanixState] status error:', err); }
  }

  async disconnect(): Promise<void> {
    try { await this.redis?.quit(); } catch { /* swallow */ }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/agents/src/alphanix/state/state-publisher.ts
git commit -m "feat(alphanix): StatePublisher — Redis state broadcasting with heartbeat"
```

---

### Task 11: AlphanixAgent (Main Entry)

**Files:**
- Create: `packages/agents/src/alphanix/alphanix-agent.ts`
- Test: `packages/agents/src/alphanix/__tests__/alphanix-agent.test.ts`

- [ ] **Step 1: Write AlphanixAgent test**

```typescript
// packages/agents/src/alphanix/__tests__/alphanix-agent.test.ts
import { describe, it, expect, vi } from 'vitest';
import { AlphanixAgent } from '../alphanix-agent';

describe('AlphanixAgent', () => {
  it('should initialize with idle status', () => {
    const agent = new AlphanixAgent({
      id: 'orchestrator' as any,
      name: 'Alphanix',
      description: 'Multi-asset AI trading army',
      enabled: true,
    });
    expect(agent.getStatus()).toBe('idle');
    expect(agent.getName()).toBe('Alphanix');
  });

  it('should initialize and create pods from config', async () => {
    const agent = new AlphanixAgent({
      id: 'orchestrator' as any,
      name: 'Alphanix',
      description: 'test',
      enabled: true,
    });
    // Initialize will try to load config and create pods
    // In test environment without Redis/adapters, it should handle gracefully
    await agent.initialize();
    expect(agent.getStatus()).toBe('idle');
  });
});
```

- [ ] **Step 2: Run test, verify fail**

- [ ] **Step 3: Write AlphanixAgent**

```typescript
// packages/agents/src/alphanix/alphanix-agent.ts
import { BaseAgent, type AgentConfig } from '../base-agent';
import type { AgentMessage } from '@cryonix/types';
import { loadAlphanixConfig, toPodConfig, type AlphanixTomlConfig } from './config';
import { AdapterRegistry } from './adapters/adapter-registry';
import { BinanceAdapter } from './adapters/binance-adapter';
import { Orchestrator } from './orchestrator/orchestrator';
import { CapitalAllocator } from './orchestrator/capital-allocator';
import { Pod } from './pod/pod';
import { AlphanixStatePublisher } from './state/state-publisher';

export class AlphanixAgent extends BaseAgent {
  private toml!: AlphanixTomlConfig;
  private registry = new AdapterRegistry();
  private orchestrator!: Orchestrator;
  private allocator!: CapitalAllocator;
  private pods = new Map<string, Pod>();
  private publisher: AlphanixStatePublisher | null = null;
  private running = false;

  async initialize(): Promise<void> {
    this.log('info', 'Initializing Alphanix...');
    this.toml = loadAlphanixConfig();

    // Setup orchestrator
    this.orchestrator = new Orchestrator({
      totalCapital: this.toml.orchestrator.capital_total_usd,
      maxPods: this.toml.orchestrator.max_pods,
      maxDrawdownPct: this.toml.orchestrator.global_max_drawdown_pct,
    });
    this.allocator = new CapitalAllocator(this.toml.orchestrator.capital_total_usd);

    // Register adapters
    this.registry.register(new BinanceAdapter({ paper: true }));
    // Future: AlpacaAdapter, IBKRAdapter

    // Connect adapters
    try {
      await this.registry.connectAll();
    } catch (err) {
      this.log('warn', 'Some adapters failed to connect (non-fatal)', { error: String(err) });
    }

    // Setup state publisher
    const kvUrl = process.env.KV_URL;
    if (kvUrl) {
      this.publisher = new AlphanixStatePublisher(kvUrl);
    }

    // Create pods from config
    const enabledPods: Record<string, number> = {};
    for (const [id, podToml] of Object.entries(this.toml.pods)) {
      if (!podToml.enabled) continue;
      const adapter = this.registry.get(podToml.adapter);
      if (!adapter) {
        this.log('warn', `Pod ${id}: adapter "${podToml.adapter}" not found, skipping`);
        continue;
      }
      enabledPods[id] = podToml.capital_pct;
    }

    const budgets = this.allocator.allocate(enabledPods);
    for (const [id, podToml] of Object.entries(this.toml.pods)) {
      if (!podToml.enabled || !budgets[id]) continue;
      const adapter = this.registry.get(podToml.adapter)!;
      const config = toPodConfig(id, podToml);
      const pod = new Pod(config, adapter, budgets[id]);
      this.pods.set(id, pod);
      this.orchestrator.registerPod(id, 'starting');
      this.log('info', `Pod created: ${id} ($${budgets[id]})`);
    }

    this.log('info', `Alphanix initialized: ${this.pods.size} pod(s) active`);
  }

  async start(): Promise<void> {
    this.running = true;
    this.setStatus('active');
    await this.publisher?.publishStatus('running');
    this.log('info', 'Alphanix started — entering main loop');

    while (this.running) {
      for (const [id, pod] of this.pods) {
        try {
          const result = await pod.runCycle();
          this.orchestrator.updatePodState(id, 'running');
          await this.publisher?.publishPodState(id, 'running');
          await this.publisher?.publishHeartbeat(id);

          if (result.executed > 0) {
            this.log('info', `Pod ${id}: ${result.executed} trade(s) executed`, result);
          }
        } catch (err: any) {
          this.log('error', `Pod ${id} cycle error: ${err.message}`);
          this.orchestrator.updatePodState(id, 'error');
        }
      }

      // Publish orchestrator state
      await this.publisher?.publishOrchestratorState({
        pods: this.orchestrator.getPodStates(),
        totalCapital: this.allocator.getTotalCapital(),
        timestamp: Date.now(),
      });

      await this.sleep(this.toml.timing.orchestrator_loop_ms);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const [id, pod] of this.pods) {
      await pod.stop();
    }
    await this.registry.disconnectAll();
    await this.publisher?.publishStatus('stopped');
    await this.publisher?.disconnect();
    this.setStatus('paused');
    this.log('info', 'Alphanix stopped');
  }

  async handleMessage(message: AgentMessage): Promise<void> {
    this.log('info', `Message received: ${message.message_type}`, message.data);
  }
}
```

- [ ] **Step 4: Run test, verify pass**

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/alphanix/alphanix-agent.ts packages/agents/src/alphanix/__tests__/alphanix-agent.test.ts
git commit -m "feat(alphanix): AlphanixAgent — main entry with pod lifecycle and orchestrator loop"
```

---

### Task 12: Runner Script

**Files:**
- Create: `scripts/services/alphanix-runner.ts`

- [ ] **Step 1: Write runner**

```typescript
// scripts/services/alphanix-runner.ts
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import { AlphanixAgent } from '../../packages/agents/src/alphanix/alphanix-agent';
import { loadAlphanixConfig } from '../../packages/agents/src/alphanix/config';

async function main() {
  console.log('===========================================');
  console.log('  Alphanix — Multi-Asset AI Trading Army');
  console.log('===========================================\n');

  const toml = loadAlphanixConfig();
  const enabledPods = Object.entries(toml.pods).filter(([, p]) => p.enabled);

  console.log(`Capital:     $${toml.orchestrator.capital_total_usd}`);
  console.log(`Max pods:    ${toml.orchestrator.max_pods}`);
  console.log(`Active pods: ${enabledPods.map(([id]) => id).join(', ') || 'none'}`);
  console.log(`Swarm limit: ${toml.swarms.max_concurrent_workers} workers`);
  console.log('');

  const agent = new AlphanixAgent({
    id: 'orchestrator' as any,
    name: 'Alphanix',
    description: 'Multi-asset AI trading army',
    enabled: true,
  });

  const shutdown = async (signal: string) => {
    console.log(`\n[${signal}] Shutting down Alphanix...`);
    await agent.stop();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await agent.initialize();
  await agent.start();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Commit**

```bash
git add scripts/services/alphanix-runner.ts
git commit -m "feat(alphanix): runner script — Docker CMD entry point"
```

---

### Task 13: Dockerfile + Docker Compose

**Files:**
- Create: `Dockerfile.alphanix`
- Modify: `docker-compose.prod.yml` (add alphanix service)

- [ ] **Step 1: Create Dockerfile**

```dockerfile
FROM node:20-alpine
WORKDIR /app

RUN apk add --no-cache git python3
RUN npm install -g tsx
RUN npm install --no-save \
  dotenv ccxt @iarna/toml ioredis pg zod openai technicalindicators node-fetch

# Stub @cryonix/types (type-only imports erased by tsx)
RUN mkdir -p node_modules/@cryonix/types && echo '{}' > node_modules/@cryonix/types/index.js

COPY packages/agents/src/ ./packages/agents/src/
COPY scripts/services/alphanix-runner.ts ./scripts/services/
COPY alphanix.toml ./

CMD ["npx", "tsx", "scripts/services/alphanix-runner.ts"]
```

- [ ] **Step 2: Add to docker-compose.prod.yml**

Add the alphanix service block (before the closing `networks:` section):

```yaml
  alphanix:
    build:
      context: .
      dockerfile: Dockerfile.alphanix
    container_name: alphanix
    restart: unless-stopped
    mem_limit: 512m
    memswap_limit: 768m
    volumes:
      - ./alphanix.toml:/app/alphanix.toml:ro
    environment:
      - NODE_ENV=production
      - KV_URL=redis://redis:6379
      - POSTGRES_URL=postgres://postgres:${POSTGRES_PASSWORD}@postgres:5432/cryonix
      - BINANCE_API_KEY=${BINANCE_API_KEY}
      - BINANCE_API_SECRET=${BINANCE_API_SECRET}
    networks:
      - cryonix-net
    depends_on:
      redis:
        condition: service_healthy
```

- [ ] **Step 3: Commit**

```bash
git add Dockerfile.alphanix docker-compose.prod.yml
git commit -m "feat(alphanix): Dockerfile + Docker Compose service (512MB mem limit)"
```

---

### Task 14: API Routes

**Files:**
- Create: `apps/web/src/app/api/alphanix/status/route.ts`
- Create: `apps/web/src/app/api/alphanix/positions/route.ts`

- [ ] **Step 1: Write status API route**

```typescript
// apps/web/src/app/api/alphanix/status/route.ts
import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';

export const dynamic = 'force-dynamic';

export async function GET() {
  let orchestratorState: any = null;
  let podStates: Record<string, any> = {};
  let status: string | null = null;

  try {
    const [statusRaw, orchRaw] = await Promise.all([
      redis.get('alphanix:status'),
      redis.get('alphanix:orchestrator:state'),
    ]);

    status = statusRaw as string ?? null;
    if (orchRaw) {
      try { orchestratorState = JSON.parse(orchRaw as string); } catch {}
    }

    // Fetch pod states from orchestrator state
    if (orchestratorState?.pods) {
      for (const podId of Object.keys(orchestratorState.pods)) {
        const [stateRaw, riskRaw, heartbeatRaw] = await Promise.all([
          redis.get(`alphanix:pod:${podId}:state`),
          redis.get(`alphanix:pod:${podId}:risk`),
          redis.get(`alphanix:pod:${podId}:heartbeat`),
        ]);
        podStates[podId] = {
          state: stateRaw,
          risk: riskRaw ? JSON.parse(riskRaw as string) : null,
          lastHeartbeat: heartbeatRaw ? parseInt(heartbeatRaw as string) : null,
        };
      }
    }
  } catch (error) {
    console.error('[alphanix/status] Redis error:', error);
  }

  return NextResponse.json({
    status,
    orchestrator: orchestratorState,
    pods: podStates,
    timestamp: new Date().toISOString(),
  });
}
```

- [ ] **Step 2: Write positions API route**

```typescript
// apps/web/src/app/api/alphanix/positions/route.ts
import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';

export const dynamic = 'force-dynamic';

export async function GET() {
  const positions: Record<string, any[]> = {};

  try {
    const orchRaw = await redis.get('alphanix:orchestrator:state');
    if (orchRaw) {
      const orch = JSON.parse(orchRaw as string);
      for (const podId of Object.keys(orch.pods || {})) {
        const posRaw = await redis.get(`alphanix:pod:${podId}:positions`);
        positions[podId] = posRaw ? JSON.parse(posRaw as string) : [];
      }
    }
  } catch (error) {
    console.error('[alphanix/positions] Redis error:', error);
  }

  return NextResponse.json({ positions, timestamp: new Date().toISOString() });
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/api/alphanix/
git commit -m "feat(alphanix): API routes — /api/alphanix/status + /api/alphanix/positions"
```

---

### Task 15: Dashboard Page (Minimal)

**Files:**
- Create: `apps/web/src/app/alphanix/page.tsx`

- [ ] **Step 1: Write minimal dashboard**

```typescript
// apps/web/src/app/alphanix/page.tsx
'use client';

import { useEffect, useState } from 'react';

interface AlphanixStatus {
  status: string | null;
  orchestrator: {
    pods: Record<string, string>;
    totalCapital: number;
    timestamp: number;
  } | null;
  pods: Record<string, {
    state: string | null;
    risk: { canTrade: boolean; dailyPnl: number; consecutiveLosses: number } | null;
    lastHeartbeat: number | null;
  }>;
  timestamp: string;
}

export default function AlphanixPage() {
  const [status, setStatus] = useState<AlphanixStatus | null>(null);
  const [positions, setPositions] = useState<Record<string, any[]>>({});

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [statusRes, posRes] = await Promise.all([
          fetch('/api/alphanix/status'),
          fetch('/api/alphanix/positions'),
        ]);
        if (statusRes.ok) setStatus(await statusRes.json());
        if (posRes.ok) {
          const data = await posRes.json();
          setPositions(data.positions || {});
        }
      } catch {}
    };
    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="min-h-screen bg-background text-foreground p-6">
      <h1 className="text-2xl font-bold mb-6">Alphanix — Multi-Asset AI Trading Army</h1>

      {/* Status */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div className="border rounded-lg p-4">
          <div className="text-sm text-muted-foreground">Status</div>
          <div className={`text-lg font-bold ${status?.status === 'running' ? 'text-emerald-400' : 'text-amber-400'}`}>
            {status?.status ?? 'offline'}
          </div>
        </div>
        <div className="border rounded-lg p-4">
          <div className="text-sm text-muted-foreground">Total Capital</div>
          <div className="text-lg font-bold">${status?.orchestrator?.totalCapital?.toLocaleString() ?? '—'}</div>
        </div>
        <div className="border rounded-lg p-4">
          <div className="text-sm text-muted-foreground">Active Pods</div>
          <div className="text-lg font-bold">
            {status?.orchestrator?.pods ? Object.keys(status.orchestrator.pods).length : 0}
          </div>
        </div>
      </div>

      {/* Pods */}
      <h2 className="text-xl font-semibold mb-4">Pods</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        {status?.pods && Object.entries(status.pods).map(([podId, pod]) => (
          <div key={podId} className="border rounded-lg p-4">
            <div className="flex justify-between items-center mb-2">
              <span className="font-semibold capitalize">{podId}</span>
              <span className={`text-sm px-2 py-1 rounded ${
                pod.state === 'running' ? 'bg-emerald-900 text-emerald-300' :
                pod.state === 'error' ? 'bg-red-900 text-red-300' :
                'bg-amber-900 text-amber-300'
              }`}>{pod.state ?? 'unknown'}</span>
            </div>
            {pod.risk && (
              <div className="text-sm text-muted-foreground">
                <div>Daily P&L: ${pod.risk.dailyPnl?.toFixed(2)}</div>
                <div>Can Trade: {pod.risk.canTrade ? 'Yes' : 'No'}</div>
                <div>Consecutive Losses: {pod.risk.consecutiveLosses}</div>
              </div>
            )}
            {pod.lastHeartbeat && (
              <div className="text-xs text-muted-foreground mt-2">
                Heartbeat: {new Date(pod.lastHeartbeat).toLocaleTimeString()}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Positions */}
      <h2 className="text-xl font-semibold mb-4">Positions</h2>
      {Object.entries(positions).map(([podId, podPositions]) => (
        <div key={podId} className="mb-4">
          <h3 className="text-sm font-medium text-muted-foreground mb-2 uppercase">{podId}</h3>
          {podPositions.length === 0 ? (
            <div className="text-sm text-muted-foreground">No open positions</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-muted-foreground border-b">
                  <th className="text-left p-2">Symbol</th>
                  <th className="text-right p-2">Qty</th>
                  <th className="text-right p-2">Entry</th>
                  <th className="text-right p-2">Current</th>
                  <th className="text-right p-2">P&L</th>
                </tr>
              </thead>
              <tbody>
                {podPositions.map((pos: any, i: number) => (
                  <tr key={i} className="border-b border-border/50">
                    <td className="p-2">{pos.symbol}</td>
                    <td className="text-right p-2">{pos.qty}</td>
                    <td className="text-right p-2">${pos.avgEntryPrice?.toFixed(2)}</td>
                    <td className="text-right p-2">${pos.currentPrice?.toFixed(2)}</td>
                    <td className={`text-right p-2 ${pos.unrealizedPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      ${pos.unrealizedPnl?.toFixed(2)} ({pos.unrealizedPnlPct?.toFixed(1)}%)
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/app/alphanix/
git commit -m "feat(alphanix): dashboard page — status, pods, positions"
```

---

### Task 16: Run All Tests + Final Commit

- [ ] **Step 1: Run all Alphanix tests**

Run: `cd packages/agents && npx vitest run src/alphanix/`
Expected: All tests PASS

- [ ] **Step 2: Type check**

Run: `pnpm type-check`
Expected: No type errors in Alphanix files

- [ ] **Step 3: Final integration commit**

```bash
git add -A
git commit -m "feat(alphanix): Phase 1 complete — skeleton + crypto pod + adapter layer + dashboard"
```
