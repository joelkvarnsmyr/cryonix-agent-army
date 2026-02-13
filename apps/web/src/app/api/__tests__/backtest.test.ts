import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET, POST } from '../backtest/route';
import { NextRequest } from 'next/server';

// Mock dependencies
vi.mock('@cryonix/agents', () => {
    const MockBacktesterAgent = vi.fn().mockImplementation(function() {
        return {
            initialize: vi.fn().mockResolvedValue(undefined),
            start: vi.fn().mockResolvedValue(undefined),
            runBacktest: vi.fn().mockResolvedValue({
                config: { symbols: ['BTC/USDT'] },
                metrics: {
                    totalTrades: 10,
                    winRate: 60,
                    winningTrades: 6,
                    losingTrades: 4,
                    sharpeRatio: 1.5,
                    sortinoRatio: 2.0,
                    calmarRatio: 1.0,
                    totalReturn: 1000,
                    totalReturnPercent: 10,
                    annualizedReturn: 120,
                    maxDrawdown: 500,
                    maxDrawdownPercent: 5,
                    profitFactor: 1.5,
                    expectancy: 100,
                    averageWin: 200,
                    averageLoss: 100,
                    patternPerformance: {},
                    monthlyReturns: {},
                },
                trades: [],
                walkForwardResults: [],
                equity: [],
                durationMs: 1000,
                skippedSignals: []
            })
        };
    });
    return { BacktesterAgent: MockBacktesterAgent };
});

vi.mock('@cryonix/database', () => ({
    saveBacktestResult: vi.fn().mockResolvedValue({ id: 123 }),
    getBacktestResults: vi.fn().mockResolvedValue([
        {
            id: 1,
            timestamp: new Date(),
            config: { symbols: ['BTC/USDT'], timeframe: '1h' },
            metrics: { totalTrades: 5, winRate: 50, sharpeRatio: 1.2, totalReturnPercent: 5 },
            status: 'COMPLETED'
        }
    ]),
    getBacktestResultById: vi.fn().mockResolvedValue({
        id: 1,
        status: 'COMPLETED',
        timestamp: new Date()
    }),
    deleteBacktestResult: vi.fn().mockResolvedValue(true),
    cleanupOldBacktests: vi.fn().mockResolvedValue(5)
}));

describe('Backtest API', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('GET /api/backtest?action=list returns results', async () => {
        const req = new NextRequest('http://localhost:3000/api/backtest?action=list');
        const res = await GET(req);

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.success).toBe(true);
        expect(data.results).toHaveLength(1);
        expect(data.results[0].id).toBe(1);
    });

    it('POST /api/backtest runs backtest and saves result', async () => {
        const body = {
            symbols: ['BTC/USDT'],
            timeframe: '1h',
            days: 30,
            initialCapital: 10000
        };

        const req = new NextRequest('http://localhost:3000/api/backtest', {
            method: 'POST',
            body: JSON.stringify(body)
        });

        const res = await POST(req);

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.success).toBe(true);
        expect(data.id).toBe(123); // Mocked save ID
        expect(data.metrics.winRate).toBe(60); // Mocked agent result
    });

    it('GET /api/backtest?action=status requires id', async () => {
        const req = new NextRequest('http://localhost:3000/api/backtest?action=status');
        const res = await GET(req);
        expect(res.status).toBe(400);
    });
});
