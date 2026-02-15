import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BacktesterEngine } from '../backtester-engine';
import { createMockBacktestConfig, generateMockOHLCV, createMockSignal } from '../../__tests__/utils/mock-data';
import type { BacktestConfig } from '../types';
import type { TradingSignal } from '@cryonix/types';

describe('BacktesterEngine', () => {
    let config: BacktestConfig;
    let engine: BacktesterEngine;

    beforeEach(() => {
        config = createMockBacktestConfig();
        engine = new BacktesterEngine(config);
    });

    it('should initialize with correct config', () => {
        expect(engine).toBeDefined();
    });

    it('should load historical data correctly', () => {
        const candles = generateMockOHLCV(10);
        engine.loadHistoricalData([{
            symbol: 'BTC/USDT',
            timeframe: '1h',
            candles,
            fetchedAt: new Date()
        }]);

        // Access private property via casting to verification
        const historicalData = (engine as any).historicalData;
        expect(historicalData.get('BTC/USDT:1h')).toHaveLength(240); // 10 days * 24 hours
    });

    it('should process signals and open positions', async () => {
        const candles = generateMockOHLCV(20, 'BTC/USDT', 50000, 0.01, '1h');

        // Mock loadHistoricalData
        engine.loadHistoricalData([{
            symbol: 'BTC/USDT',
            timeframe: '1h',
            candles,
            fetchedAt: new Date()
        }]);

        // Mock detectPatterns to return a signal on the 105th candle (index 104)
        // The engine loops from index 100
        const mockSignal = createMockSignal({
            symbol: 'BTC/USDT',
            action: 'BUY',
            entry_price: 50000,
            confidence: 0.9
        });

        // Spy on private method detectPatterns
        const detectSpy = vi.spyOn(engine as any, 'detectPatterns');
        detectSpy.mockReturnValue([mockSignal]);
        // Note: this will return signal on EVERY candle, so we might get 'already_in_position' later, which is fine

        const result = await engine.run();

        expect(result.trades.length).toBeGreaterThan(0);
        expect(result.metrics.totalTrades).toBeGreaterThan(0);

        // cleanup
        detectSpy.mockRestore();
    });

    it('should respect max concurrent positions', async () => {
        config.maxConcurrentPositions = 1;
        engine = new BacktesterEngine(config);

        const candles = generateMockOHLCV(10);
        engine.loadHistoricalData([{
            symbol: 'BTC/USDT',
            timeframe: '1h',
            candles,
            fetchedAt: new Date()
        }]);

        const signal1 = createMockSignal({ symbol: 'BTC/USDT', action: 'BUY', id: 'sig1' });
        const signal2 = createMockSignal({ symbol: 'ETH/USDT', action: 'BUY', id: 'sig2' }); // Different symbol if we had data

        // Mock processSignal to simulate logic? No, better to inspect state
        // Let's use internal methods to test logic directly
        const state = (engine as any).createFreshState();

        // Force a position
        (engine as any).processSignal(state, signal1, candles[0]);
        expect(state.positions.size).toBe(1);

        // Try another position (same symbol would be rejected anyway, but max concurrency check is generic)
        // To test concurrency we need different symbols
        state.positions.set('ETH/USDT', {} as any); // Hack in a position

        // Now size is 2 (if map works)
        // Wait, processSignal checks config.maxConcurrentPositions

        // Reset state
        const state2 = (engine as any).createFreshState();
        (engine as any).processSignal(state2, signal1, candles[0]); // Position 1

        // Now try to add another symbol
        const signalETH = createMockSignal({ symbol: 'ETH/USDT', action: 'BUY' });
        (engine as any).processSignal(state2, signalETH, candles[0]);

        // Should be skipped due to max positions
        expect(state2.skippedSignals.length).toBe(1);
        expect(state2.skippedSignals[0].reason).toBe('max_positions');
    });

    it('should trigger stop loss', () => {
        const state = (engine as any).createFreshState();
        const symbol = 'BTC/USDT';

        // Create a LONG position
        const position = {
            id: 'pos1',
            symbol,
            side: 'LONG',
            entryPrice: 50000,
            entryTime: new Date(),
            quantity: 1,
            stopLoss: 49000,
            takeProfit: 55000,
            confidence: 1,
            pattern: 'test',
        };
        state.positions.set(symbol, position);

        // Candle that hits Stop Loss (Low 48000)
        const candle = {
            timestamp: new Date(),
            open: 49500,
            high: 50000,
            low: 48000, // Hits 49000 SL
            close: 48500,
            volume: 100,
            symbol
        };

        (engine as any).checkExits(state, symbol, candle);

        expect(state.positions.has(symbol)).toBe(false); // Should be closed
        expect(state.trades.length).toBe(1);
        expect(state.trades[0].exitReason).toBe('stop_loss');
        expect(state.trades[0].exitPrice).toBeCloseTo(49000 * 0.999); // 49000 minus slippage (0.1%)
    });

    it('should trigger take profit', () => {
        const state = (engine as any).createFreshState();
        const symbol = 'BTC/USDT';

        const position = {
            id: 'pos1',
            symbol,
            side: 'LONG',
            entryPrice: 50000,
            entryTime: new Date(),
            quantity: 1,
            stopLoss: 45000,
            takeProfit: 55000,
        };
        state.positions.set(symbol, position);

        // Candle that hits Take Profit (High 56000)
        const candle = {
            timestamp: new Date(),
            open: 51000,
            high: 56000, // Hits 55000 TP
            low: 51000,
            close: 54000,
            volume: 100,
            symbol
        };

        (engine as any).checkExits(state, symbol, candle);

        expect(state.positions.has(symbol)).toBe(false);
        expect(state.trades.length).toBe(1);
        expect(state.trades[0].exitReason).toBe('take_profit');
        expect(state.trades[0].exitPrice).toBeCloseTo(55000 * 0.999); // Slippage also affects TP exits?
        // check code: exitPrice * (1 - slippage) for LONG. Yes.
    });
});
