# Aktienix Backend Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the aktienix backend by implementing four missing modules (market-hours, position-sizer, exit-monitor, risk-manager) and refactoring the agent to use them.

**Architecture:** Each module is a focused, stateless or explicitly-stateful class that the thin `AktienixAgent` orchestrator delegates to. All modules read from the already-loaded `AktienixTomlConfig`. `StatePublisher` (already built) bridges state to Redis for the DB/API routes agent.

**Tech Stack:** TypeScript, Vitest (test runner at monorepo root), Alpaca SDK for market clock, no new dependencies required.

---

## Pre-flight

- [ ] Verify vitest runs from monorepo root: `pnpm vitest run packages/agents/src/aktienix --reporter=verbose`
- [ ] Verify existing tests pass: should see 4 passing tests in `__tests__/aktienix-agent.test.ts`

---

## Chunk 1: `market-hours.ts` + `position-sizer.ts`

These are stateless utilities — easiest to build and test first.

**Files:**
- Create: `packages/agents/src/aktienix/market-hours.ts`
- Create: `packages/agents/src/aktienix/position-sizer.ts`
- Create: `packages/agents/src/aktienix/__tests__/market-hours.test.ts`
- Create: `packages/agents/src/aktienix/__tests__/position-sizer.test.ts`

### Task 1: `market-hours.ts`

The Alpaca SDK has `alpaca.getClock()` which returns `{ is_open, next_open, next_close }`. We use this when an Alpaca instance is available, otherwise fall back to simple ET math (useful for tests and mock broker).

- [ ] **Write the failing test** at `packages/agents/src/aktienix/__tests__/market-hours.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { MarketHours } from '../market-hours';

describe('MarketHours', () => {
    const defaultConfig = {
        regular_hours_only: true,
        skip_first_minutes: 15,
        close_before_eod: false,
        no_new_orders_before_close_min: 30,
    };

    it('reports market closed outside trading hours (ET fallback)', () => {
        // Saturday UTC — always closed
        const saturday = new Date('2026-03-14T14:00:00Z'); // Saturday 10am ET
        const result = MarketHours.checkFromDate(saturday, defaultConfig);
        expect(result.isOpen).toBe(false);
        expect(result.canOpenNew).toBe(false);
    });

    it('reports market open during trading hours (ET fallback)', () => {
        // Tuesday 14:30 UTC = 10:30am ET (after skip_first_minutes)
        const tuesday = new Date('2026-03-10T15:45:00Z'); // 11:45am ET
        const result = MarketHours.checkFromDate(tuesday, defaultConfig);
        expect(result.isOpen).toBe(true);
        expect(result.skipSignalScan).toBe(false);
    });

    it('sets skipSignalScan within first 15 minutes of open', () => {
        // 9:35am ET = 13:35 UTC — within skip_first_minutes
        const earlyOpen = new Date('2026-03-10T13:35:00Z');
        const result = MarketHours.checkFromDate(earlyOpen, defaultConfig);
        expect(result.isOpen).toBe(true);
        expect(result.skipSignalScan).toBe(true);
    });

    it('blocks new orders within no_new_orders_before_close_min', () => {
        // 15:40 ET = 19:40 UTC — 20 min before close (< 30 min threshold)
        const nearClose = new Date('2026-03-10T19:40:00Z');
        const result = MarketHours.checkFromDate(nearClose, defaultConfig);
        expect(result.isOpen).toBe(true);
        expect(result.canOpenNew).toBe(false);
    });

    it('calculates minutesUntilClose correctly', () => {
        // 15:00 ET = 19:00 UTC — 60 min before 16:00 close
        const oneHourBefore = new Date('2026-03-10T19:00:00Z');
        const result = MarketHours.checkFromDate(oneHourBefore, defaultConfig);
        expect(result.minutesUntilClose).toBeCloseTo(60, 0);
    });
});
```

- [ ] **Run test to confirm failure**: `pnpm vitest run packages/agents/src/aktienix/__tests__/market-hours.test.ts`

- [ ] **Implement** `packages/agents/src/aktienix/market-hours.ts`:

```typescript
import type { AktienixTomlConfig } from './config';

export interface MarketHoursResult {
    isOpen: boolean;
    canOpenNew: boolean;
    skipSignalScan: boolean;
    minutesUntilClose: number;
}

type MarketHoursConfig = AktienixTomlConfig['market_hours'];

export class MarketHours {
    /**
     * Primary method: uses Alpaca clock API for accurate open/close times.
     * Falls back to ET math if alpaca is null (tests / mock broker).
     */
    static async check(
        alpaca: any | null,
        config: MarketHoursConfig,
    ): Promise<MarketHoursResult> {
        if (!config.regular_hours_only) {
            return { isOpen: true, canOpenNew: true, skipSignalScan: false, minutesUntilClose: 9999 };
        }

        if (alpaca) {
            try {
                const clock = await alpaca.getClock();
                const isOpen: boolean = clock.is_open;

                const nowMs = Date.now();
                const closeMs = new Date(clock.next_close).getTime();
                const openMs = new Date(clock.next_open).getTime();
                const minutesUntilClose = isOpen ? Math.max(0, (closeMs - nowMs) / 60_000) : 0;

                // Minutes since market opened (only meaningful when open)
                const lastOpenMs = isOpen ? (closeMs - 390 * 60_000) : 0; // 390 min = 6.5h trading day
                const minutesSinceOpen = isOpen ? Math.max(0, (nowMs - lastOpenMs) / 60_000) : 0;

                const skipSignalScan = isOpen && minutesSinceOpen < config.skip_first_minutes;
                const canOpenNew = isOpen && minutesUntilClose > config.no_new_orders_before_close_min;

                return { isOpen, canOpenNew, skipSignalScan, minutesUntilClose };
            } catch {
                // Fall through to ET math on API error
            }
        }

        return MarketHours.checkFromDate(new Date(), config);
    }

    /**
     * ET-based fallback. Usable in tests with a specific date injected.
     * NYSE regular hours: Mon–Fri 09:30–16:00 ET (UTC-5 / UTC-4 DST).
     * This uses a simple UTC-offset heuristic (UTC-5 all year; good enough for trading logic).
     */
    static checkFromDate(now: Date, config: MarketHoursConfig): MarketHoursResult {
        if (!config.regular_hours_only) {
            return { isOpen: true, canOpenNew: true, skipSignalScan: false, minutesUntilClose: 9999 };
        }

        const ET_OFFSET_HOURS = -5; // Approximate (ignores DST)
        const etMs = now.getTime() + ET_OFFSET_HOURS * 3_600_000;
        const et = new Date(etMs);

        const dayOfWeek = et.getUTCDay(); // 0=Sun, 6=Sat
        const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;

        const minutesSinceMidnight = et.getUTCHours() * 60 + et.getUTCMinutes();
        const marketOpen = 9 * 60 + 30;   // 09:30 ET
        const marketClose = 16 * 60;       // 16:00 ET

        const isOpen = isWeekday && minutesSinceMidnight >= marketOpen && minutesSinceMidnight < marketClose;
        const minutesUntilClose = isOpen ? marketClose - minutesSinceMidnight : 0;
        const minutesSinceOpen = isOpen ? minutesSinceMidnight - marketOpen : 0;

        const skipSignalScan = isOpen && minutesSinceOpen < config.skip_first_minutes;
        const canOpenNew = isOpen && minutesUntilClose > config.no_new_orders_before_close_min;

        return { isOpen, canOpenNew, skipSignalScan, minutesUntilClose };
    }
}
```

- [ ] **Run test**: `pnpm vitest run packages/agents/src/aktienix/__tests__/market-hours.test.ts`
- [ ] Expected: **5 passing**

- [ ] **Commit**:
```bash
git add packages/agents/src/aktienix/market-hours.ts packages/agents/src/aktienix/__tests__/market-hours.test.ts
git commit -m "feat(aktienix): add MarketHours module with ET fallback"
```

---

### Task 2: `position-sizer.ts`

Dollar-based fractional share calculation. Replaces the hardcoded `qty: 1` in `aktienix-agent.ts`.

- [ ] **Write failing test** at `packages/agents/src/aktienix/__tests__/position-sizer.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { PositionSizer } from '../position-sizer';

describe('PositionSizer', () => {
    const config = {
        max_position_size_usd: 1000,
        max_capital_per_trade_pct: 0.95,
        min_order_value: 5,
    };

    it('calculates fractional qty for a high-priced stock', () => {
        // $500 stock, $1000 max position, $2000 settled cash
        const qty = PositionSizer.calc(500, 2000, config);
        // min(1000, 2000 * 0.95) = min(1000, 1900) = 1000 → 1000/500 = 2.0 shares
        expect(qty).toBeCloseTo(2.0, 4);
    });

    it('respects max_capital_per_trade_pct when cash is limiting', () => {
        // $100 stock, $200 settled cash, $1000 max position
        const qty = PositionSizer.calc(100, 200, config);
        // min(1000, 200 * 0.95) = min(1000, 190) = 190 → 190/100 = 1.9 shares
        expect(qty).toBeCloseTo(1.9, 4);
    });

    it('returns 0 when position value would be below min_order_value', () => {
        // $100 stock, $3 settled cash
        const qty = PositionSizer.calc(100, 3, config);
        expect(qty).toBe(0);
    });

    it('returns 0 for zero or negative price', () => {
        expect(PositionSizer.calc(0, 1000, config)).toBe(0);
        expect(PositionSizer.calc(-50, 1000, config)).toBe(0);
    });

    it('rounds to 6 decimal places for fractional shares', () => {
        // $173.33 stock, $500 settled cash
        const qty = PositionSizer.calc(173.33, 500, config);
        const expected = Math.min(1000, 500 * 0.95) / 173.33;
        expect(qty).toBeCloseTo(expected, 4);
    });
});
```

- [ ] **Run test to confirm failure**: `pnpm vitest run packages/agents/src/aktienix/__tests__/position-sizer.test.ts`

- [ ] **Implement** `packages/agents/src/aktienix/position-sizer.ts`:

```typescript
import type { AktienixTomlConfig } from './config';

type CapitalConfig = AktienixTomlConfig['capital'];

export class PositionSizer {
    /**
     * Calculate fractional share quantity for a market order.
     *
     * @param price         Current price of the asset
     * @param settledCash   Available settled cash in the account
     * @param config        Capital config section from aktienix.toml
     * @returns             Fractional share quantity, 0 if below min_order_value
     */
    static calc(price: number, settledCash: number, config: CapitalConfig): number {
        if (price <= 0) return 0;

        const maxDollar = Math.min(
            config.max_position_size_usd,
            settledCash * config.max_capital_per_trade_pct,
        );

        if (maxDollar < config.min_order_value) return 0;

        // Round to 6 decimal places (Alpaca supports fractional shares)
        return Math.round((maxDollar / price) * 1_000_000) / 1_000_000;
    }
}
```

- [ ] **Run test**: `pnpm vitest run packages/agents/src/aktienix/__tests__/position-sizer.test.ts`
- [ ] Expected: **5 passing**

- [ ] **Commit**:
```bash
git add packages/agents/src/aktienix/position-sizer.ts packages/agents/src/aktienix/__tests__/position-sizer.test.ts
git commit -m "feat(aktienix): add PositionSizer for dollar-based fractional sizing"
```

---

## Chunk 2: `exit-monitor.ts`

Stateful: tracks high-water marks and entry dates per symbol to implement trailing stop and stagnation exit.

**Files:**
- Create: `packages/agents/src/aktienix/exit-monitor.ts`
- Create: `packages/agents/src/aktienix/__tests__/exit-monitor.test.ts`

### Task 3: `exit-monitor.ts`

- [ ] **Write failing test** at `packages/agents/src/aktienix/__tests__/exit-monitor.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { ExitMonitor } from '../exit-monitor';
import type { StockPosition } from '../types';

describe('ExitMonitor', () => {
    const config = {
        take_profit_pct: 5.0,
        stop_loss_pct: 3.0,
        trailing_stop_pct: 4.0,
        trailing_activation_pct: 2.0,
        stagnation_timeout_days: 10,
        stagnation_min_pnl_pct: 0.5,
    };

    let monitor: ExitMonitor;

    const makePosition = (symbol: string, avgEntry: number, unrealizedPl: number, marketValue: number): StockPosition => ({
        symbol,
        qty: 1,
        avgEntryPrice: avgEntry,
        marketValue,
        unrealizedPl,
    });

    beforeEach(() => {
        monitor = new ExitMonitor();
    });

    it('returns no exits for a healthy position', () => {
        monitor.recordEntry('AAPL', 150, new Date());
        const position = makePosition('AAPL', 150, 3, 153); // +2% — not yet TP
        const exits = monitor.check([position], config);
        expect(exits).toHaveLength(0);
    });

    it('triggers take_profit at +5%', () => {
        monitor.recordEntry('AAPL', 100, new Date());
        const position = makePosition('AAPL', 100, 5, 105); // +5%
        const exits = monitor.check([position], config);
        expect(exits).toHaveLength(1);
        expect(exits[0].reason).toBe('take_profit');
        expect(exits[0].symbol).toBe('AAPL');
    });

    it('triggers stop_loss at -3%', () => {
        monitor.recordEntry('AAPL', 100, new Date());
        const position = makePosition('AAPL', 100, -3, 97); // -3%
        const exits = monitor.check([position], config);
        expect(exits).toHaveLength(1);
        expect(exits[0].reason).toBe('stop_loss');
    });

    it('triggers trailing_stop after activation and pullback', () => {
        monitor.recordEntry('AAPL', 100, new Date());

        // First check: price rose +3% (above trailing_activation_pct of 2%) — sets high water mark
        monitor.check([makePosition('AAPL', 100, 3, 103)], config);

        // Second check: price pulled back to +0% from high of 103 (pullback > trailing_stop_pct 4%)
        const position = makePosition('AAPL', 100, -0.5, 99.5);
        const exits = monitor.check([position], config);
        expect(exits).toHaveLength(1);
        expect(exits[0].reason).toBe('trailing_stop');
    });

    it('does NOT trigger trailing_stop before activation threshold', () => {
        monitor.recordEntry('AAPL', 100, new Date());

        // Price only rose +1% (below activation_pct 2%) — trailing not yet active
        monitor.check([makePosition('AAPL', 100, 1, 101)], config);

        // Price drops to -2% — below activation, trailing irrelevant, stop_loss not hit
        const position = makePosition('AAPL', 100, -2, 98);
        const exits = monitor.check([position], config);
        // stop_loss triggers at -3%, not -2%, so no exit yet
        expect(exits).toHaveLength(0);
    });

    it('triggers stagnation after timeout_days with insufficient P/L', () => {
        // Entry date 15 days ago (> stagnation_timeout_days = 10)
        const oldDate = new Date(Date.now() - 15 * 24 * 3_600_000);
        monitor.recordEntry('MSFT', 200, oldDate);

        // P/L only +0.2% (< stagnation_min_pnl_pct 0.5%)
        const position = makePosition('MSFT', 200, 0.4, 200.4);
        const exits = monitor.check([position], config);
        expect(exits).toHaveLength(1);
        expect(exits[0].reason).toBe('stagnation');
    });

    it('clearPosition removes tracking state', () => {
        monitor.recordEntry('AAPL', 100, new Date());
        monitor.clearPosition('AAPL');

        // After clearing, trailing stop check has no high water mark → no trailing exit
        monitor.check([makePosition('AAPL', 100, 3, 103)], config);
        const position = makePosition('AAPL', 100, -1, 99);
        const exits = monitor.check([position], config);
        expect(exits).toHaveLength(0);
    });
});
```

- [ ] **Run test to confirm failure**: `pnpm vitest run packages/agents/src/aktienix/__tests__/exit-monitor.test.ts`

- [ ] **Implement** `packages/agents/src/aktienix/exit-monitor.ts`:

```typescript
import type { StockPosition } from './types';
import type { AktienixTomlConfig } from './config';

type ExitsConfig = AktienixTomlConfig['exits'];

export type ExitReason = 'take_profit' | 'stop_loss' | 'trailing_stop' | 'stagnation';

export interface ExitDecision {
    symbol: string;
    reason: ExitReason;
    pnlPct: number;
}

interface PositionState {
    entryPrice: number;
    entryDate: Date;
    highWaterMark: number;   // highest market price seen since entry
    trailingActive: boolean; // whether trailing stop has been activated
}

export class ExitMonitor {
    private state = new Map<string, PositionState>();

    recordEntry(symbol: string, price: number, entryDate: Date): void {
        this.state.set(symbol, {
            entryPrice: price,
            entryDate,
            highWaterMark: price,
            trailingActive: false,
        });
    }

    clearPosition(symbol: string): void {
        this.state.delete(symbol);
    }

    /**
     * Check all positions and return exit decisions.
     * Also updates internal high-water marks as a side effect.
     */
    check(positions: StockPosition[], config: ExitsConfig): ExitDecision[] {
        const exits: ExitDecision[] = [];

        for (const pos of positions) {
            const decision = this.checkOne(pos, config);
            if (decision) exits.push(decision);
        }

        return exits;
    }

    private checkOne(pos: StockPosition, config: ExitsConfig): ExitDecision | null {
        const positionCost = pos.avgEntryPrice * pos.qty;
        if (positionCost <= 0) return null;

        const pnlPct = (pos.unrealizedPl / positionCost) * 100;
        const currentPrice = pos.marketValue / pos.qty;

        // --- Take Profit ---
        if (pnlPct >= config.take_profit_pct) {
            return { symbol: pos.symbol, reason: 'take_profit', pnlPct };
        }

        // --- Stop Loss ---
        if (pnlPct <= -config.stop_loss_pct) {
            return { symbol: pos.symbol, reason: 'stop_loss', pnlPct };
        }

        // --- Trailing Stop (uses persisted state) ---
        const ps = this.state.get(pos.symbol);
        if (ps) {
            // Update high water mark
            if (currentPrice > ps.highWaterMark) {
                ps.highWaterMark = currentPrice;
            }

            // Activate trailing once profit exceeds trailing_activation_pct
            const highWaterPnlPct = ((ps.highWaterMark - ps.entryPrice) / ps.entryPrice) * 100;
            if (highWaterPnlPct >= config.trailing_activation_pct) {
                ps.trailingActive = true;
            }

            if (ps.trailingActive) {
                const pullbackFromHighPct = ((ps.highWaterMark - currentPrice) / ps.highWaterMark) * 100;
                if (pullbackFromHighPct >= config.trailing_stop_pct) {
                    return { symbol: pos.symbol, reason: 'trailing_stop', pnlPct };
                }
            }

            // --- Stagnation ---
            const daysHeld = (Date.now() - ps.entryDate.getTime()) / (24 * 3_600_000);
            if (daysHeld >= config.stagnation_timeout_days && Math.abs(pnlPct) < config.stagnation_min_pnl_pct) {
                return { symbol: pos.symbol, reason: 'stagnation', pnlPct };
            }
        }

        return null;
    }
}
```

- [ ] **Run test**: `pnpm vitest run packages/agents/src/aktienix/__tests__/exit-monitor.test.ts`
- [ ] Expected: **7 passing**

- [ ] **Commit**:
```bash
git add packages/agents/src/aktienix/exit-monitor.ts packages/agents/src/aktienix/__tests__/exit-monitor.test.ts
git commit -m "feat(aktienix): add ExitMonitor with TP/SL/trailing/stagnation logic"
```

---

## Chunk 3: `risk-manager.ts`

Stateful circuit breakers: daily P&L, weekly P&L, consecutive losses, PDT day trade counter.

**Files:**
- Create: `packages/agents/src/aktienix/risk-manager.ts`
- Create: `packages/agents/src/aktienix/__tests__/risk-manager.test.ts`

### Task 4: `risk-manager.ts`

- [ ] **Write failing test** at `packages/agents/src/aktienix/__tests__/risk-manager.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { RiskManager } from '../risk-manager';

describe('RiskManager', () => {
    const config = {
        risk: {
            min_confidence: 0.60,
            min_settled_cash: 1.0,
            max_daily_loss_pct: 0.02,
            max_weekly_loss_pct: 0.05,
            max_consecutive_losses: 3,
        },
        limits: {
            max_open_positions: 5,
            max_trades_per_day: 5,
            max_day_trades_per_5d: 2,
        },
    };

    let manager: RiskManager;

    beforeEach(() => {
        manager = new RiskManager();
    });

    it('allows trading with a clean slate', () => {
        const result = manager.canTrade(10_000, config.risk, config.limits);
        expect(result.canTrade).toBe(true);
    });

    it('blocks after max_consecutive_losses', () => {
        manager.recordExit(-2.0);   // $2 loss (dollar amount)
        manager.recordExit(-1.5);   // $1.50 loss
        manager.recordExit(-3.0);   // $3 loss — 3 consecutive losses hit max_consecutive_losses
        const result = manager.canTrade(10_000, config.risk, config.limits);
        expect(result.canTrade).toBe(false);
        expect(result.reason).toBe('consecutive_losses');
    });

    it('resets consecutive losses after a winning trade', () => {
        manager.recordExit(-2.0);  // $2 loss
        manager.recordExit(-1.5);  // $1.50 loss
        manager.recordExit(+4.0);  // $4 gain — positive pnlDollar resets streak
        const result = manager.canTrade(10_000, config.risk, config.limits);
        expect(result.canTrade).toBe(true);
    });

    it('blocks after max_daily_loss_pct is breached', () => {
        // Portfolio $10,000. 2% max daily loss = $200.
        // recordExit takes DOLLAR amounts (absolute P&L), NOT percentages.
        // Callers compute: pnlDollar = (pnlPct / 100) * positionValue
        manager.updatePortfolioValue(10_000);
        // Simulate losses: $80 + $50 + $75 = $205 > 2% of $10,000 ($200)
        manager.recordExit(-80); // $80 loss
        manager.recordExit(-50); // $50 loss
        manager.recordExit(-75); // $75 loss — total $205, exceeds $200 threshold
        // Total realized: -$205. 205/10000 = 2.05% > 2% threshold
        const result = manager.canTrade(10_000, config.risk, config.limits);
        expect(result.canTrade).toBe(false);
        expect(result.reason).toBe('daily_loss_limit');
    });

    it('blocks after max_day_trades_per_5d (PDT)', () => {
        manager.recordTrade(true); // day trade 1
        manager.recordTrade(true); // day trade 2
        const result = manager.canTrade(10_000, config.risk, config.limits);
        expect(result.canTrade).toBe(false);
        expect(result.reason).toBe('pdt_limit');
    });

    it('blocks after max_trades_per_day', () => {
        for (let i = 0; i < 5; i++) {
            manager.recordTrade(false);
        }
        const result = manager.canTrade(10_000, config.risk, config.limits);
        expect(result.canTrade).toBe(false);
        expect(result.reason).toBe('daily_trade_limit');
    });

    it('getState returns current risk state', () => {
        manager.recordExit(-50); // $50 loss (dollar amount)
        const state = manager.getState();
        expect(state.consecutiveLosses).toBe(1);
        expect(state.tradesToday).toBe(0);
    });

    it('resetDaily clears daily counters', () => {
        manager.recordTrade(false);
        manager.recordTrade(false);
        manager.resetDaily();
        const state = manager.getState();
        expect(state.tradesToday).toBe(0);
        expect(state.dailyPnlDollar).toBe(0);
    });
});
```

- [ ] **Run test to confirm failure**: `pnpm vitest run packages/agents/src/aktienix/__tests__/risk-manager.test.ts`

- [ ] **Implement** `packages/agents/src/aktienix/risk-manager.ts`:

```typescript
import type { AktienixTomlConfig } from './config';

type RiskConfig = AktienixTomlConfig['risk'];
type LimitsConfig = AktienixTomlConfig['limits'];

export type BlockReason =
    | 'daily_loss_limit'
    | 'weekly_loss_limit'
    | 'consecutive_losses'
    | 'pdt_limit'
    | 'daily_trade_limit';

export interface RiskDecision {
    canTrade: boolean;
    reason?: BlockReason;
}

export interface RiskState {
    canTrade: boolean;
    dailyPnlDollar: number;
    weeklyPnlDollar: number;
    consecutiveLosses: number;
    tradesToday: number;
    dayTradesThisWeek: number;
}

export class RiskManager {
    private dailyPnlDollar = 0;
    private weeklyPnlDollar = 0;
    private consecutiveLosses = 0;
    private tradesToday = 0;
    private dayTradesThisWeek = 0;
    private lastPortfolioValue = 0;

    /**
     * Call whenever you have a fresh portfolio value (e.g., after getAccountState).
     * Used to convert percentage losses to dollar losses for circuit breakers.
     */
    updatePortfolioValue(value: number): void {
        if (value > 0) this.lastPortfolioValue = value;
    }

    /**
     * Returns whether a new trade is permitted under all active circuit breakers.
     */
    canTrade(portfolioValue: number, risk: RiskConfig, limits: LimitsConfig): RiskDecision {
        this.updatePortfolioValue(portfolioValue);

        if (this.consecutiveLosses >= risk.max_consecutive_losses) {
            return { canTrade: false, reason: 'consecutive_losses' };
        }

        if (portfolioValue > 0) {
            const dailyLossPct = Math.abs(this.dailyPnlDollar) / portfolioValue;
            if (this.dailyPnlDollar < 0 && dailyLossPct >= risk.max_daily_loss_pct) {
                return { canTrade: false, reason: 'daily_loss_limit' };
            }

            const weeklyLossPct = Math.abs(this.weeklyPnlDollar) / portfolioValue;
            if (this.weeklyPnlDollar < 0 && weeklyLossPct >= risk.max_weekly_loss_pct) {
                return { canTrade: false, reason: 'weekly_loss_limit' };
            }
        }

        if (this.dayTradesThisWeek >= limits.max_day_trades_per_5d) {
            return { canTrade: false, reason: 'pdt_limit' };
        }

        if (this.tradesToday >= limits.max_trades_per_day) {
            return { canTrade: false, reason: 'daily_trade_limit' };
        }

        return { canTrade: true };
    }

    /**
     * Call when a BUY order is submitted.
     * @param isDayTrade true if this position will be opened AND closed same day
     */
    recordTrade(isDayTrade: boolean): void {
        this.tradesToday++;
        if (isDayTrade) this.dayTradesThisWeek++;
    }

    /**
     * Call when a position is closed (SELL executed).
     * @param pnlDollar Realized P&L in dollars (negative = loss)
     */
    recordExit(pnlDollar: number): void {
        this.dailyPnlDollar += pnlDollar;
        this.weeklyPnlDollar += pnlDollar;

        if (pnlDollar < 0) {
            this.consecutiveLosses++;
        } else {
            this.consecutiveLosses = 0;
        }
    }

    /** Reset daily counters at market open. Call from agent on each new trading day. */
    resetDaily(): void {
        this.dailyPnlDollar = 0;
        this.tradesToday = 0;
    }

    /** Reset weekly counters on Monday. */
    resetWeekly(): void {
        this.weeklyPnlDollar = 0;
        this.dayTradesThisWeek = 0;
    }

    getState(): RiskState {
        const { canTrade } = this.canTrade(
            this.lastPortfolioValue,
            // Use safe defaults — getState is for reporting, not enforcement
            { min_confidence: 0, min_settled_cash: 0, max_daily_loss_pct: 1, max_weekly_loss_pct: 1, max_consecutive_losses: 999 },
            { max_open_positions: 999, max_trades_per_day: 999, max_day_trades_per_5d: 999 },
        );
        return {
            canTrade,
            dailyPnlDollar: this.dailyPnlDollar,
            weeklyPnlDollar: this.weeklyPnlDollar,
            consecutiveLosses: this.consecutiveLosses,
            tradesToday: this.tradesToday,
            dayTradesThisWeek: this.dayTradesThisWeek,
        };
    }
}
```

- [ ] **Run test**: `pnpm vitest run packages/agents/src/aktienix/__tests__/risk-manager.test.ts`
- [ ] Expected: **8 passing**

- [ ] **Commit**:
```bash
git add packages/agents/src/aktienix/risk-manager.ts packages/agents/src/aktienix/__tests__/risk-manager.test.ts
git commit -m "feat(aktienix): add RiskManager circuit breakers (daily P&L, PDT, consecutive losses)"
```

---

## Chunk 4: Refactor `aktienix-agent.ts` + wire modules + update `index.ts`

All modules are built. Now wire them into the agent and remove the old inline logic.

**Files:**
- Modify: `packages/agents/src/aktienix/aktienix-agent.ts`
- Modify: `packages/agents/src/aktienix/index.ts`
- Modify: `packages/agents/src/aktienix/__tests__/aktienix-agent.test.ts` (fix T+1 test)

### Task 5: Refactor `aktienix-agent.ts`

The agent becomes a thin orchestrator. Replace `aktienix-agent.ts` entirely:

- [ ] **Replace `packages/agents/src/aktienix/aktienix-agent.ts`** with the following:

```typescript
import { BaseAgent, type AgentConfig } from '../base-agent';
import type { AgentMessage } from '@cryonix/types';
import type { AktienixConfig, AccountState, StockPosition } from './types';
import type { BrokerClient } from './brokers/types';
import { IbkrClient } from './brokers/ibkr/ibkr-client';
import { AlpacaClient } from './brokers/alpaca/alpaca-client';
import { StockSignalGenerator } from './signals/stock-signal-generator';
import { StockNewsScanner, type MacroSignal } from './intelligence/news-scanner';
import { loadAktienixConfig } from './config';
import { MarketHours } from './market-hours';
import { PositionSizer } from './position-sizer';
import { ExitMonitor } from './exit-monitor';
import { RiskManager } from './risk-manager';
import { StatePublisher } from './state-publisher';

export interface AktienixAgentConfig extends AgentConfig {
    tradingConfig: AktienixConfig;
}

export class AktienixAgent extends BaseAgent {
    private tradingConfig: AktienixConfig;
    private brokerClient: BrokerClient | null = null;
    private alpacaInstance: any = null;
    private accountState: AccountState | null = null;
    private positions: StockPosition[] = [];
    private isTrading = false;

    private signalGenerator: StockSignalGenerator | null = null;
    private newsScanner: StockNewsScanner | null = null;
    private activeMacroSignals: MacroSignal[] = [];
    private lastNewsScanTime = 0;
    private lastSignalScanTime = 0;

    private exitMonitor = new ExitMonitor();
    private riskManager = new RiskManager();
    private statePublisher: StatePublisher | null = null;

    private tomlConfig = loadAktienixConfig();

    constructor(config: AktienixAgentConfig) {
        super(config);
        this.tradingConfig = config.tradingConfig;
    }

    async initialize(): Promise<void> {
        this.log('info', 'Initializing Aktienix Agent (Stock Trading)...');

        const loggerAdapter = {
            info: (msg: string) => this.log('info', msg),
            warn: (msg: string) => this.log('warn', msg),
            error: (msg: string) => this.log('error', msg),
            debug: (msg: string) => this.log('info', msg),
        } as any;

        if (this.tradingConfig.broker === 'ibkr') {
            this.log('info', 'Connecting to IBKR CP Gateway...');
            this.brokerClient = new IbkrClient(this.tradingConfig, loggerAdapter);
            await this.brokerClient.connect();
            this.accountState = await this.brokerClient.getAccountState();
            this.positions = await this.brokerClient.getPositions();
            this.log('info', `IBKR Connected. Settled Cash: ${this.accountState?.settledCash}`);

        } else if (this.tradingConfig.broker === 'alpaca') {
            this.log('info', 'Connecting to Alpaca...');
            this.brokerClient = new AlpacaClient(this.tradingConfig, loggerAdapter);
            await this.brokerClient.connect();
            this.accountState = await this.brokerClient.getAccountState();
            this.positions = await this.brokerClient.getPositions();
            this.log('info', `Alpaca Connected. Portfolio Value: ${this.accountState?.portfolioValue}`);

            this.alpacaInstance = (this.brokerClient as AlpacaClient).getAlpacaInstance();
            this.signalGenerator = new StockSignalGenerator(
                this.alpacaInstance,
                loggerAdapter,
                {
                    symbols: this.tomlConfig.watchlist.symbols,
                    timeframe: this.tomlConfig.watchlist.timeframe,
                    barsCount: this.tomlConfig.watchlist.bars_count,
                },
            );

        } else if (this.tradingConfig.broker === 'mock') {
            this.log('info', 'Using MOCK broker for testing.');
            this.accountState = { buyingPower: 500, settledCash: 500, portfolioValue: 500, isPatternDayTrader: false };

        } else {
            this.log('warn', `Unknown broker "${this.tradingConfig.broker}". Using zeroed mock state.`);
            this.accountState = { buyingPower: 0, settledCash: 0, portfolioValue: 0, isPatternDayTrader: false };
        }

        if (this.tradingConfig.intelligence?.enabled) {
            this.newsScanner = new StockNewsScanner();
            if (this.newsScanner.isInitialized()) {
                this.log('info', 'StockNewsScanner connected to xAI.');
            } else {
                this.log('warn', 'StockNewsScanner failed to initialize (check XAI_API_KEY).');
            }
        }

        const kvUrl = process.env.KV_URL;
        if (kvUrl) {
            this.statePublisher = new StatePublisher(kvUrl);
            this.log('info', 'StatePublisher initialized.');
        } else {
            this.log('warn', 'KV_URL not set — state will not be published to Redis.');
        }

        this.setStatus('idle');
        this.log('info', 'Aktienix initialization complete.');
    }

    async start(): Promise<void> {
        this.log('info', 'Starting Aktienix Agent trading loop...');
        this.setStatus('running');
        this.isTrading = true;

        let lastDayOfWeek = -1;

        while (this.isTrading) {
            try {
                // --- 1. Market hours gate ---
                const hours = await MarketHours.check(this.alpacaInstance, this.tomlConfig.market_hours);

                if (!hours.isOpen) {
                    this.log('info', '🔔 Market closed. Waiting...');
                    await this.statePublisher?.publishStatus('paused');
                    await this.sleep(this.tomlConfig.timing.poll_interval_ms);
                    continue;
                }

                // Reset daily/weekly counters on new trading day/week
                const now = new Date();
                const currentDay = now.getDay();
                if (currentDay !== lastDayOfWeek) {
                    this.riskManager.resetDaily();
                    if (currentDay === 1) this.riskManager.resetWeekly(); // Monday
                    lastDayOfWeek = currentDay;
                }

                // --- 2. Refresh account + positions ---
                if (this.brokerClient) {
                    this.accountState = await this.brokerClient.getAccountState();
                    this.positions = await this.brokerClient.getPositions();
                }

                if (this.accountState) {
                    this.riskManager.updatePortfolioValue(this.accountState.portfolioValue);
                    await this.statePublisher?.publishAccount(this.accountState);
                }
                await this.statePublisher?.publishPositions(this.positions);

                this.log('info', [
                    `📊 Portfolio: $${this.accountState?.portfolioValue?.toFixed(2)} | ` +
                    `Cash: $${this.accountState?.settledCash?.toFixed(2)} | ` +
                    `Positions: ${this.positions.length}`,
                ].join(''));

                // --- 3. Exit monitoring ---
                const exitDecisions = this.exitMonitor.check(this.positions, this.tomlConfig.exits);
                for (const exit of exitDecisions) {
                    this.log('info', `🚪 Exit: ${exit.symbol} — ${exit.reason} (${exit.pnlPct.toFixed(2)}%)`);

                    if (this.brokerClient) {
                        const positionValue = this.positions.find(p => p.symbol === exit.symbol)?.marketValue ?? 0;
                        const result = await this.brokerClient.submitOrder({
                            symbol: exit.symbol,
                            action: 'SELL',
                            qty: this.positions.find(p => p.symbol === exit.symbol)?.qty ?? 1,
                            orderType: 'MARKET',
                        });

                        if (result.success) {
                            this.log('info', `✅ SELL ${exit.symbol} submitted: ${result.orderId}`);
                            const pnlDollar = (exit.pnlPct / 100) * positionValue;
                            this.riskManager.recordExit(pnlDollar);
                            this.exitMonitor.clearPosition(exit.symbol);
                            await this.statePublisher?.addSignal({
                                symbol: exit.symbol,
                                action: 'SELL',
                                confidence: 1.0,
                                reasoning: exit.reason,
                                timestamp: Date.now(),
                            });
                        } else {
                            this.log('error', `❌ SELL ${exit.symbol} failed: ${result.message}`);
                        }
                    }
                }

                // --- 4. Risk circuit breaker ---
                const riskCheck = this.riskManager.canTrade(
                    this.accountState?.portfolioValue ?? 0,
                    this.tomlConfig.risk,
                    this.tomlConfig.limits,
                );
                await this.statePublisher?.publishRisk({
                    canTrade: riskCheck.canTrade,
                    dailyPnl: this.riskManager.getState().dailyPnlDollar,
                    consecutiveLosses: this.riskManager.getState().consecutiveLosses,
                    tradesToday: this.riskManager.getState().tradesToday,
                });

                if (!riskCheck.canTrade) {
                    this.log('warn', `⛔ Risk circuit breaker: ${riskCheck.reason}. Skipping new trades.`);
                    await this.sleep(this.tomlConfig.timing.poll_interval_ms);
                    continue;
                }

                // --- 5. Macro intelligence scan (time-gated) ---
                const nowMs = Date.now();
                const intelConfig = this.tradingConfig.intelligence;
                if (this.newsScanner?.isInitialized() && nowMs - this.lastNewsScanTime >= (intelConfig?.news_scan_interval_ms ?? 900_000)) {
                    this.log('info', '🌍 Running macro intelligence scan...');
                    try {
                        this.activeMacroSignals = await this.newsScanner.scanMacroEvents();
                        this.lastNewsScanTime = nowMs;
                        if (this.activeMacroSignals.length > 0) {
                            this.log('info', `🌍 ${this.activeMacroSignals.length} active macro event(s) detected.`);
                        }
                    } catch (e: any) {
                        this.log('error', `🌍 Macro scan failed: ${e.message}`);
                    }
                }

                // --- 6. Signal scan (time-gated + market hours guard) ---
                if (!hours.skipSignalScan && nowMs - this.lastSignalScanTime >= this.tomlConfig.timing.signal_scan_interval_ms) {
                    this.lastSignalScanTime = nowMs;

                    if (this.signalGenerator) {
                        const signals = await this.signalGenerator.scan();

                        for (const signal of signals) {
                            if (signal.confidence < this.tomlConfig.risk.min_confidence) continue;
                            if (!hours.canOpenNew) {
                                this.log('info', `🕐 Too close to market close — skipping ${signal.symbol}`);
                                continue;
                            }
                            if (this.positions.length >= this.tomlConfig.limits.max_open_positions) {
                                this.log('info', `📊 Max positions (${this.tomlConfig.limits.max_open_positions}) reached.`);
                                break;
                            }

                            await this.evaluateAndTrade(signal);
                        }
                    }
                }

                // --- 7. Process message queue ---
                while (this.messageQueue.length > 0) {
                    const msg = this.messageQueue.shift()!;
                    await this.handleMessage(msg);
                }

            } catch (error: any) {
                this.log('error', `Trading loop error: ${error.message}`);
            }

            await this.sleep(this.tomlConfig.timing.poll_interval_ms);
        }

        this.log('info', 'Trading loop exited.');
    }

    async stop(): Promise<void> {
        this.log('info', 'Stopping Aktienix Agent...');
        this.isTrading = false;
        if (this.brokerClient) await this.brokerClient.disconnect();
        await this.statePublisher?.publishStatus('stopped');
        await this.statePublisher?.disconnect();
        this.setStatus('paused');
    }

    async handleMessage(message: AgentMessage): Promise<void> {
        this.log('info', `Received message: ${message.message_type}`);
        if (message.message_type === 'TRADE_SIGNAL') {
            await this.evaluateSignalFromMessage(message.data);
        }
    }

    // -----------------------------------------------------------------------
    // Private helpers
    // -----------------------------------------------------------------------

    private async evaluateAndTrade(signal: any): Promise<void> {
        if (!this.accountState || !this.brokerClient) return;

        let confidence = signal.confidence;

        // Macro intelligence overlay
        if (this.tradingConfig.intelligence?.enabled && this.activeMacroSignals.length > 0) {
            for (const macro of this.activeMacroSignals) {
                if (signal.action === 'BUY' && this.tradingConfig.intelligence.macro_bearish_block && macro.impact === 'bearish' && macro.tickers.includes(signal.symbol)) {
                    this.log('warn', `🌍 MACRO BLOCK: ${signal.symbol} in bearish event (${macro.event}). Cancelling BUY.`);
                    return;
                }
                if (signal.action === 'BUY' && macro.impact === 'bullish' && macro.tickers.includes(signal.symbol)) {
                    confidence += this.tradingConfig.intelligence.macro_confidence_boost;
                    this.log('info', `🌍 MACRO BOOST: ${signal.symbol} confidence → ${confidence.toFixed(2)}`);
                }
            }
        }

        if (confidence < this.tomlConfig.risk.min_confidence) {
            this.log('info', `Signal confidence ${confidence.toFixed(2)} below threshold. Skipping ${signal.symbol}.`);
            return;
        }

        if (this.accountState.settledCash < this.tomlConfig.risk.min_settled_cash) {
            this.log('warn', `Insufficient settled cash ($${this.accountState.settledCash.toFixed(2)}). Skipping ${signal.symbol}.`);
            return;
        }

        const qty = PositionSizer.calc(signal.currentPrice, this.accountState.settledCash, this.tomlConfig.capital);
        if (qty <= 0) {
            this.log('warn', `Position size too small for ${signal.symbol}. Skipping.`);
            return;
        }

        this.log('info', `📥 ${signal.action} ${signal.symbol}: qty=${qty} @ $${signal.currentPrice?.toFixed(2)} (confidence=${confidence.toFixed(2)})`);

        const result = await this.brokerClient.submitOrder({ symbol: signal.symbol, action: signal.action, qty, orderType: 'MARKET' });

        if (result.success) {
            this.log('info', `✅ Order ${result.orderId} — ${result.status}`);
            this.exitMonitor.recordEntry(signal.symbol, signal.currentPrice, new Date());
            this.riskManager.recordTrade(false);
            await this.statePublisher?.addSignal({
                symbol: signal.symbol,
                action: signal.action,
                confidence,
                reasoning: Array.isArray(signal.reasoning) ? signal.reasoning[0] : signal.reasoning,
                timestamp: Date.now(),
            });
        } else {
            this.log('error', `❌ Order failed: ${result.message}`);
        }
    }

    private async evaluateSignalFromMessage(payload: any): Promise<void> {
        if (!this.accountState) {
            this.log('error', 'Cannot evaluate signal: account state not initialized.');
            return;
        }

        const { symbol, action, confidence } = payload;
        this.log('info', `Evaluating signal to ${action} ${symbol} (Base Confidence: ${confidence})`);

        if (confidence < this.tomlConfig.risk.min_confidence) {
            this.log('info', `Signal confidence ${confidence} is below threshold (${this.tomlConfig.risk.min_confidence}). Skipping.`);
            return;
        }

        if (action === 'BUY' && this.tradingConfig.accountType === 'cash' && this.accountState.settledCash < this.tomlConfig.risk.min_settled_cash) {
            this.log('warn', `Insufficient settled cash for ${symbol}. Wait for T+1 settlement.`);
            return;
        }

        if (!this.brokerClient) {
            this.log('warn', 'No broker client connected. Cannot submit order.');
            return;
        }

        const qty = PositionSizer.calc(payload.currentPrice ?? 100, this.accountState.settledCash, this.tomlConfig.capital);
        if (qty <= 0) {
            this.log('warn', `Position size too small for ${symbol}. Skipping.`);
            return;
        }

        const result = await this.brokerClient.submitOrder({ symbol, action, qty, orderType: 'MARKET' });

        if (result.success) {
            this.log('info', `✅ Order submitted: ${result.orderId} — ${result.status}`);
        } else {
            this.log('error', `❌ Order failed: ${result.message}`);
        }
    }
}
```

- [ ] **Run existing tests BEFORE replacing the file** to record baseline: `pnpm vitest run packages/agents/src/aktienix/__tests__/aktienix-agent.test.ts`
- [ ] Record the number of passing tests (should be **8 passing**) — this is your baseline to verify after the rewrite

- [ ] **Replace `packages/agents/src/aktienix/index.ts`** with the following (full file replacement — the existing file only has 2 lines):

```typescript
export * from './types';
export * from './aktienix-agent';
export * from './market-hours';
export * from './position-sizer';
export * from './exit-monitor';
export * from './risk-manager';
export * from './state-publisher';
```

**Note:** `StatePublisher.publishRisk()` accepts `{ canTrade, dailyPnl, consecutiveLosses, tradesToday }` (field is `dailyPnl`, not `dailyPnlDollar`). The agent maps manually from `riskManager.getState()` — this is intentional; do not pass `getState()` directly to `publishRisk`.

**Note:** `StatePublisher.addSignal()` is the actual method name (the spec document listed it as `publishSignal` — that is outdated; the built implementation uses `addSignal`).

- [ ] **Run all aktienix tests**: `pnpm vitest run packages/agents/src/aktienix`
- [ ] Expected: **24+ passing**, 0 failing

- [ ] **Type check**: `pnpm type-check`
- [ ] Expected: no errors in `packages/agents`

- [ ] **Commit**:
```bash
git add packages/agents/src/aktienix/aktienix-agent.ts packages/agents/src/aktienix/index.ts
git commit -m "feat(aktienix): wire market-hours, exit-monitor, risk-manager, position-sizer into agent loop"
```

---

## Final: Full test run

- [ ] `pnpm vitest run packages/agents/src/aktienix --reporter=verbose`
- [ ] All tests pass, no type errors
- [ ] `pnpm type-check` — clean
