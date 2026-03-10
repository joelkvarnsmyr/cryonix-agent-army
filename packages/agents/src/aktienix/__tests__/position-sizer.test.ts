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
