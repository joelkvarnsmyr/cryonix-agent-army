import { describe, it, expect } from 'vitest';
import { SyntheticSignalGenerator } from '../synthetic-signal-generator';
import { HUNTRIX_DEFAULTS } from '../config';
import type { OhlcvData } from '../../market-scout/pattern-detectors/pattern-detector.interface';
import { HuntrixBacktester, type HuntrixBTTrade } from '../backtester';
import type { ManipulationSignal } from '../types';

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

function makeSignal(overrides: Partial<ManipulationSignal> = {}): ManipulationSignal {
    return {
        id: 'test-1',
        type: 'wash_trading_pump',
        symbol: 'TEST/USDC',
        exchange: 'backtest',
        confidence: 75,
        phase: 'early_pump',
        shill_activity: [],
        total_shill_accounts: 0,
        price_at_detection: 100,
        volume_24h: 10000,
        volume_spike_ratio: 3,
        price_velocity: 2,
        reasoning: 'test',
        estimated_peak_minutes: null,
        detected_at: new Date().toISOString(),
        source: 'trending_anomaly',
        ...overrides,
    };
}

describe('HuntrixBacktester', () => {
    const bt = new HuntrixBacktester(HUNTRIX_DEFAULTS);

    it('should filter out peak/dump phase signals', () => {
        const signals = [
            makeSignal({ phase: 'early_pump', confidence: 75 }),
            makeSignal({ id: 'test-2', phase: 'peak', confidence: 80 }),
            makeSignal({ id: 'test-3', phase: 'dump', confidence: 90 }),
        ];
        const approved = bt.filterSignals(signals);
        expect(approved.length).toBe(1);
        expect(approved[0].phase).toBe('early_pump');
    });

    it('should filter out low confidence signals', () => {
        const signals = [
            makeSignal({ confidence: 75 }),  // pump_and_dump needs 70 — pass
            makeSignal({ id: 'test-2', confidence: 50 }),  // below 70 — fail
        ];
        const approved = bt.filterSignals(signals);
        expect(approved.length).toBe(1);
    });

    it('should simulate exits with stop loss', () => {
        const signal = makeSignal({ price_at_detection: 100 });
        // Price drops steadily — should trigger SL at 3%
        const candles: OhlcvData[] = Array.from({ length: 10 }, (_, i) => ({
            timestamp: Date.now() + i * 60_000,
            open: 100 - i * 0.5,
            high: 100 - i * 0.5 + 0.1,
            low: 100 - i * 0.5 - 0.1,
            close: 100 - i * 0.5,
            volume: 1000,
        }));

        const trades = bt.simulateExits([signal], candles, 0);
        expect(trades.length).toBe(1);
        expect(trades[0].exitReason).toBe('stop_loss');
        expect(trades[0].pnlPct).toBeLessThan(0);
    });

    it('should simulate exits with take profit', () => {
        const signal = makeSignal({ price_at_detection: 100 });
        // Price rises steadily — should trigger TP at 15%
        const candles: OhlcvData[] = Array.from({ length: 20 }, (_, i) => ({
            timestamp: Date.now() + i * 60_000,
            open: 100 + i * 1,
            high: 100 + i * 1 + 0.5,
            low: 100 + i * 1 - 0.5,
            close: 100 + i * 1,
            volume: 1000,
        }));

        const trades = bt.simulateExits([signal], candles, 0);
        expect(trades.length).toBe(1);
        expect(trades[0].exitReason).toBe('take_profit');
        expect(trades[0].pnlPct).toBeGreaterThan(0);
    });

    it('should compute metrics from trades', () => {
        const signal = makeSignal({ price_at_detection: 100 });
        const candles: OhlcvData[] = Array.from({ length: 10 }, (_, i) => ({
            timestamp: Date.now() + i * 60_000,
            open: 100 - i * 0.5,
            high: 100 - i * 0.5 + 0.1,
            low: 100 - i * 0.5 - 0.1,
            close: 100 - i * 0.5,
            volume: 1000,
        }));

        const trades = bt.simulateExits([signal], candles, 0);
        const result = bt.computeMetrics(trades, 1, 1);
        expect(result.trades.length).toBe(1);
        expect(result.winRate).toBeDefined();
        expect(result.totalPnl).toBeDefined();
        expect(result.equityCurve.length).toBeGreaterThan(0);
        expect(result.equityCurve[0]).toHaveProperty('equity');
        expect(result.equityCurve[0]).toHaveProperty('drawdown');
        expect(result.exitBreakdown).toBeDefined();
    });

    it('should calibrate against pump profiles', () => {
        const now = Date.now();
        const trades: HuntrixBTTrade[] = [{
            symbol: 'BTC/USDC', exchange: 'backtest',
            entryIdx: 0, exitIdx: 5, entryPrice: 100, exitPrice: 103,
            entryTimestamp: now, pnl: 3, pnlPct: 3,
            holdMinutes: 5, exitReason: 'take_profit',
            signalType: 'wash_trading_pump', signalConfidence: 75, phase: 'early_pump',
        }];
        const profiles = [
            { id: 'p1', symbol: 'BTC/USDC', detected_at: new Date(now + 60_000).toISOString() },
            { id: 'p2', symbol: 'ETH/USDC', detected_at: new Date(now).toISOString() },
        ] as any;

        const result = bt.computeMetrics(trades, 1, 1, profiles);
        expect(result.calibration).not.toBeNull();
        expect(result.calibration!.matchedProfiles).toBe(1);
        expect(result.calibration!.precision).toBe(1);
        expect(result.calibration!.recall).toBe(0.5);
        expect(result.calibration!.unmatchedProfiles).toBe(1);
    });
});
