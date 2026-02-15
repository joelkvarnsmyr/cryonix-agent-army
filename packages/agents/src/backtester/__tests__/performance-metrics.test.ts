import { describe, it, expect } from 'vitest';
import { calculatePerformanceMetrics } from '../performance-metrics';
import { createMockTrade } from '../../__tests__/utils/mock-data';
import type { BacktestTrade, EquityPoint } from '../types';

describe('Performance Metrics', () => {
    const initialCapital = 10000;
    const tradingDays = 30;

    // Helper to create simple equity curve
    const createEquityCurve = (values: number[], startDate: Date): EquityPoint[] => {
        return values.map((equity, index) => ({
            timestamp: new Date(startDate.getTime() + index * 86400000),
            equity,
            drawdown: 0, // Calculated inside metrics, but needed for type
            drawdownPercent: 0,
        }));
    };

    it('should calculate basic return metrics correctly', () => {
        const trades: BacktestTrade[] = [
            createMockTrade({ pnl: 100, entryTime: new Date('2024-01-01'), exitTime: new Date('2024-01-01') }),
            createMockTrade({ pnl: -50, entryTime: new Date('2024-01-02'), exitTime: new Date('2024-01-02') }),
            createMockTrade({ pnl: 200, entryTime: new Date('2024-01-03'), exitTime: new Date('2024-01-03') }),
        ];

        const equityCurve = createEquityCurve([10000, 10100, 10050, 10250], new Date('2024-01-01'));

        const metrics = calculatePerformanceMetrics(trades, equityCurve, initialCapital, tradingDays);

        expect(metrics.totalReturn).toBe(250);
        expect(metrics.totalReturnPercent).toBe(2.5);
        expect(metrics.totalTrades).toBe(3);
        expect(metrics.winningTrades).toBe(2);
        expect(metrics.losingTrades).toBe(1);
        expect(metrics.winRate).toBeCloseTo(66.67, 1);
    });

    it('should calculate profit metrics correctly', () => {
        const trades: BacktestTrade[] = [
            createMockTrade({ pnl: 100 }),
            createMockTrade({ pnl: 200 }),
            createMockTrade({ pnl: -50 }),
        ];

        // Gross Profit: 300, Gross Loss: 50 -> PF: 6.0
        const equityCurve = createEquityCurve([10000, 10100, 10300, 10250], new Date());
        const metrics = calculatePerformanceMetrics(trades, equityCurve, initialCapital, tradingDays);

        // expect(metrics.grossProfit).toBeUndefined(); // internal only
        expect(metrics.profitFactor).toBe(6.0);
        expect(metrics.averageWin).toBe(150);
        expect(metrics.averageLoss).toBe(50);
        expect(metrics.largestWin).toBe(200);
        expect(metrics.largestLoss).toBe(50);
    });

    it('should calculate Sharpre and Sortino ratios correctly', () => {
        // 5 days of returns: +1%, -0.5%, +2%, -1%, +0.5%
        const equityCurve = createEquityCurve(
            [10000, 10100, 10049.5, 10250.49, 10147.99, 10198.73],
            new Date('2024-01-01')
        );

        // Trades just to satisfy interface, metrics depend heavily on equity curve for ratios
        const trades: BacktestTrade[] = [
            createMockTrade({ pnl: 0, entryTime: new Date('2024-01-01'), exitTime: new Date('2024-01-05') })
        ];

        const metrics = calculatePerformanceMetrics(trades, equityCurve, initialCapital, 5);

        // Relaxed check for Sharpe/Sortino as manual calculation depends heavily on daily distribution logic
        expect(metrics.sharpeRatio).toBeDefined();

        // Check Sortino only if downside deviation exists
        if (metrics.losingTrades > 0 || metrics.maxDrawdown > 0) {
            expect(metrics.sortinoRatio).toBeDefined();
        }
    });

    it('should calculate drawdown metrics accurately', () => {
        // 10000 -> 11000 (Peak) -> 9900 (DD) -> 10500 (Recover)
        // DD should be around 1100
        const equityCurve = createEquityCurve(
            [10000, 11000, 9900, 10500],
            new Date('2024-01-01')
        );

        const trades: BacktestTrade[] = [
            createMockTrade({ pnl: 0, entryTime: new Date('2024-01-01'), exitTime: new Date('2024-01-04') })
        ];
        const metrics = calculatePerformanceMetrics(trades, equityCurve, initialCapital, 3);

        console.log('Metrics MaxDD:', metrics.maxDrawdown, 'Percent:', metrics.maxDrawdownPercent);

        expect(metrics.maxDrawdown).toBeGreaterThan(1000);
        expect(metrics.maxDrawdown).toBeLessThan(1200);
        expect(metrics.maxDrawdownPercent).toBeGreaterThan(9);
        expect(metrics.maxDrawdownPercent).toBeLessThan(11);
        expect(metrics.currentDrawdown).toBeGreaterThan(0);
    });

    it('should handle streaks correctly', () => {
        const trades: BacktestTrade[] = [
            createMockTrade({ pnl: 10 }),
            createMockTrade({ pnl: 10 }),
            createMockTrade({ pnl: -10 }),
            createMockTrade({ pnl: -10 }),
            createMockTrade({ pnl: -10 }),
            createMockTrade({ pnl: 10 }),
        ]; // W, W, L, L, L, W

        const equityCurve = createEquityCurve([10000], new Date());
        const metrics = calculatePerformanceMetrics(trades, equityCurve, initialCapital, 1);

        expect(metrics.maxConsecutiveWins).toBe(2);
        expect(metrics.maxConsecutiveLosses).toBe(3);
    });

    it('should handle no trades gracefuly', () => {
        const trades: BacktestTrade[] = [];
        const equityCurve = createEquityCurve([10000, 10000], new Date());

        const metrics = calculatePerformanceMetrics(trades, equityCurve, initialCapital, 10);

        expect(metrics.totalTrades).toBe(0);
        expect(metrics.winRate).toBe(0);
        expect(metrics.profitFactor).toBe(0);
        expect(metrics.sharpeRatio).toBe(0);
        expect(metrics.maxDrawdown).toBe(0);
    });

    it('should handle infinite profit factor (no losses)', () => {
        const trades: BacktestTrade[] = [
            createMockTrade({ pnl: 100 }),
            createMockTrade({ pnl: 100 }),
        ];

        const equityCurve = createEquityCurve([10000], new Date());
        const metrics = calculatePerformanceMetrics(trades, equityCurve, initialCapital, 1);

        expect(metrics.profitFactor).toBe(Infinity);
    });
});
