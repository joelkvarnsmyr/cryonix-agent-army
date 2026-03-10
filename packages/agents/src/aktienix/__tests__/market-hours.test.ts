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

    it('sets shouldClosePositions when close_before_eod is true and near close', () => {
        const eodConfig = {
            regular_hours_only: true,
            skip_first_minutes: 15,
            close_before_eod: true,
            no_new_orders_before_close_min: 30,
        };
        // 15:40 ET = 19:40 UTC — 20 min before close (within the 30-min gate)
        const nearClose = new Date('2026-03-10T19:40:00Z');
        const result = MarketHours.checkFromDate(nearClose, eodConfig);
        expect(result.shouldClosePositions).toBe(true);
    });
});
