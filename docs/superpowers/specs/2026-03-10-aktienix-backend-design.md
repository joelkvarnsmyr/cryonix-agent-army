# Aktienix Backend Design — 2026-03-10

## Context

Three parallel agents build aktienix together:
- **Backend** (this agent): `packages/agents/src/aktienix/`
- **Frontend**: Dashboard UI
- **DB + API routes**: Drizzle schema + Next.js API routes

The existing scaffolding (`aktienix-agent.ts`, `AlpacaClient`, `IbkrClient`, `StockSignalGenerator`, `StockNewsScanner`, `config.ts`, `aktienix.toml`) is kept intact. This design fills four critical gaps that prevent production use.

## Critical Gaps Being Fixed

1. **No exit management** — TP/SL/trailing/stagnation config exists but the loop never sells
2. **No market hours guard** — agent trades even when NYSE is closed
3. **No risk circuit breakers** — daily/weekly loss limits and consecutive loss counter are configured but unused
4. **Wrong position sizing** — `qty` hardcoded to `1` instead of dollar-based fractional

## Architecture: Modular Split (Approach B)

```
packages/agents/src/aktienix/
├── aktienix-agent.ts          ← refactored: thin orchestrator
├── types.ts                   ← unchanged
├── config.ts                  ← unchanged
├── index.ts                   ← updated exports
├── brokers/                   ← unchanged
├── signals/                   ← unchanged
├── intelligence/              ← unchanged
├── market-hours.ts            ← NEW
├── position-sizer.ts          ← NEW
├── exit-monitor.ts            ← NEW
├── risk-manager.ts            ← NEW
└── state-publisher.ts         ← NEW
```

## Module Contracts

### `market-hours.ts`
Uses Alpaca clock API or ET-time math to gate trading.
```typescript
interface MarketHoursResult {
  isOpen: boolean;
  canOpenNew: boolean;     // false if < no_new_orders_before_close_min
  skipSignalScan: boolean; // true if within skip_first_minutes of open
  minutesUntilClose: number;
}
MarketHours.check(alpaca, config.market_hours): Promise<MarketHoursResult>
```

### `position-sizer.ts`
Dollar-based fractional share calculation.
```typescript
PositionSizer.calc(price: number, settledCash: number, config.capital): number
// Returns fractional qty, 0 if below min_order_value
```

### `exit-monitor.ts`
Stateful: tracks high-water marks and entry dates per symbol.
```typescript
interface ExitDecision {
  symbol: string;
  reason: 'take_profit' | 'stop_loss' | 'trailing_stop' | 'stagnation';
  pnlPct: number;
}
ExitMonitor.check(positions: StockPosition[], config.exits): ExitDecision[]
ExitMonitor.recordEntry(symbol, price, entryDate): void
ExitMonitor.clearPosition(symbol): void
```

### `risk-manager.ts`
Stateful: tracks daily P&L, weekly P&L, consecutive losses, day trade count.
```typescript
interface RiskDecision {
  canTrade: boolean;
  reason?: 'daily_loss_limit' | 'weekly_loss_limit' | 'consecutive_losses' | 'pdt_limit';
}
RiskManager.canTrade(portfolioValue: number, config.risk, config.limits): RiskDecision
RiskManager.recordTrade(isDayTrade: boolean): void
RiskManager.recordExit(pnlPct: number): void
RiskManager.resetDaily(): void  // called at market open
```

### `state-publisher.ts`
Writes aktienix state to Redis for the DB/API routes agent.
```typescript
StatePublisher.publishAccount(account: AccountState): Promise<void>
StatePublisher.publishPositions(positions: StockPosition[]): Promise<void>
StatePublisher.publishRisk(state: RiskState): Promise<void>
StatePublisher.publishSignal(signal: StockSignal | ExitDecision): Promise<void>
StatePublisher.publishStatus(status: string): Promise<void>
```

**Redis keys (TTL 5min unless noted):**
```
aktienix:account       — AccountState JSON
aktienix:positions     — StockPosition[] JSON
aktienix:risk          — RiskState JSON
aktienix:signals       — list, last 50 signals (no TTL, capped)
aktienix:status        — "running" | "paused" | "stopped" (no TTL)
```

## Refactored Agent Loop

```
AktienixAgent.start() — every poll_interval_ms:

1. MarketHours.check()
   → closed? sleep, skip
   → canOpenNew? store flag

2. broker.getAccountState() + getPositions()
   → StatePublisher.publishAccount/publishPositions()

3. ExitMonitor.check(positions)
   → for each ExitDecision:
        broker.submitOrder(SELL)
        RiskManager.recordExit(pnlPct)
        ExitMonitor.clearPosition(symbol)
        StatePublisher.publishSignal(exitEvent)

4. RiskManager.canTrade()
   → blocked? StatePublisher.publishRisk(), skip to step 6

5. [gated by signal_scan_interval_ms] SignalGenerator.scan()
   → for each signal (confidence >= min_confidence):
        a. MacroIntelligence overlay (existing)
        b. canOpenNew check
        c. PositionSizer.calc() → fractional qty
        d. broker.submitOrder(BUY, qty)
        e. ExitMonitor.recordEntry(symbol, price, now)
        f. RiskManager.recordTrade()
        g. StatePublisher.publishSignal(signal)

6. StatePublisher.publishRisk(riskManager.getState())
```

## What Is NOT Changed

- `AlpacaClient`, `IbkrClient` — broker abstraction stays as-is
- `StockSignalGenerator` — technical analysis stays as-is
- `StockNewsScanner`, `MacroSectorMap` — intelligence stays as-is
- `config.ts`, `types.ts` — types and TOML loading stay as-is
- `aktienix.toml` — no config changes needed; all new modules read existing sections

## Interface with Other Agents

The DB/API routes agent reads from Redis keys above. It does NOT need to call into this package directly. The frontend agent reads from the API routes, not from Redis.

The backend makes no assumptions about what tables exist — it only writes to Redis. The DB agent decides what to persist.
