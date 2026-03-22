import { describe, it, expect } from 'vitest';
import { SyntheticSignalGenerator } from '../synthetic-signal-generator';
import { HUNTRIX_DEFAULTS } from '../config';
import type { OhlcvData } from '../../market-scout/pattern-detectors/pattern-detector.interface';

function makeCandles(count: number, basePrice = 100, baseVolume = 1000): OhlcvData[] {
    return Array.from({ length: count }, (_, i) => ({
        timestamp: Date.now() - (count - i) * 60_000,
        open: basePrice,
        high: basePrice * 1.001,
        low: basePrice * 0.999,
        close: basePrice,
        volume: baseVolume,
    }));
}

describe('SyntheticSignalGenerator', () => {
    const gen = new SyntheticSignalGenerator(HUNTRIX_DEFAULTS.detection);

    it('should detect a volume spike with price velocity', () => {
        const candles15m = makeCandles(25, 100, 1000);
        // Inject spike: last candle has 5x volume and 2% price jump
        candles15m[candles15m.length - 1] = {
            ...candles15m[candles15m.length - 1],
            close: 102,
            high: 102.5,
            volume: 5000,
        };

        const candles1m = makeCandles(100, 100);
        // Inject price velocity in last few 1m candles (2%/min over 5 min window)
        for (let i = 95; i < 100; i++) {
            candles1m[i] = {
                ...candles1m[i],
                close: 100 + (i - 94) * 2,
                high: 100 + (i - 94) * 2 + 0.5,
                volume: 3000,
            };
        }

        const signals = gen.scan(candles15m, candles1m, 'BTC/USDC');
        expect(signals.length).toBeGreaterThan(0);
        expect(signals[0].type).toBe('wash_trading_pump');
        expect(signals[0].source).toBe('trending_anomaly');
        expect(signals[0].exchange).toBe('backtest');
        expect(signals[0].symbol).toBe('BTC/USDC');
    });

    it('should not generate signals from flat data', () => {
        const candles15m = makeCandles(25, 100, 1000);
        const candles1m = makeCandles(100, 100, 1000);
        const signals = gen.scan(candles15m, candles1m, 'TEST/USDC');
        expect(signals.length).toBe(0);
    });

    it('should reject already-pumped signals', () => {
        const candles15m = makeCandles(25, 100, 1000);
        // Price already up 25% from 24 candles ago
        candles15m[0] = { ...candles15m[0], close: 80 };
        candles15m[candles15m.length - 1] = {
            ...candles15m[candles15m.length - 1],
            close: 102,
            volume: 5000,
        };

        const candles1m = makeCandles(100, 100);
        for (let i = 95; i < 100; i++) {
            candles1m[i] = { ...candles1m[i], close: 100 + (i - 94) * 2, volume: 3000 };
        }

        const signals = gen.scan(candles15m, candles1m, 'TEST/USDC');
        // Should be filtered out because already pumped >20%
        expect(signals.length).toBe(0);
    });
});
