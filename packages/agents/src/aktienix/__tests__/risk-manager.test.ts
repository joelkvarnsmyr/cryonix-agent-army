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
