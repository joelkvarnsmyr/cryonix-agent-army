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
        min_holding_minutes: 0,
    };

    let monitor: ExitMonitor;

    const makePosition = (symbol: string, avgEntry: number, unrealizedPl: number, marketValue: number): StockPosition => ({
        symbol,
        qty: 1,
        avgEntryPrice: avgEntry,
        currentPrice: marketValue,
        marketValue,
        unrealizedPl,
        unrealizedPlPct: avgEntry > 0 ? (unrealizedPl / avgEntry) * 100 : 0,
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

    it('triggers trailing_stop via pullback-from-peak (position still profitable)', () => {
        monitor.recordEntry('AAPL', 100, new Date());
        // Price rises to 104.5 (+4.5%) — activates trailing (> 2% activation), stays below TP (< 5%)
        monitor.check([makePosition('AAPL', 100, 4.5, 104.5)], config);
        // Price pulls back to 100.20: (104.5 - 100.20) / 104.5 = 4.11% >= trailing_stop_pct 4%
        // pnlPct = +0.2% so position is still profitable — exercises the pullbackFromHighPct branch
        const position = makePosition('AAPL', 100, 0.20, 100.20);
        const exits = monitor.check([position], config);
        expect(exits).toHaveLength(1);
        expect(exits[0].reason).toBe('trailing_stop');
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
