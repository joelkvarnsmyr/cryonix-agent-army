import { describe, it, expect, vi } from 'vitest';
import { WatchlistCurator } from '../watchlist-curator';
import type { MacroSignal } from '../intelligence/news-scanner';

describe('WatchlistCurator', () => {
    it('returns true on first call (cold start)', () => {
        const curator = new WatchlistCurator(null, null, []);
        expect(curator.needsRefresh()).toBe(true);
    });

    it('returns false after a successful curate() on the same day', async () => {
        const curator = new WatchlistCurator(null, null, ['SPY', 'QQQ']);
        await curator.curate([]);
        expect(curator.needsRefresh()).toBe(false);
    });

    it('returns true the next calendar day', async () => {
        vi.useFakeTimers();
        const curator = new WatchlistCurator(null, null, ['SPY']);
        // Simulate yesterday's refresh
        vi.setSystemTime(new Date('2026-03-10T10:00:00Z'));
        await curator.curate([]);
        // Advance to next day
        vi.setSystemTime(new Date('2026-03-11T10:00:00Z'));
        expect(curator.needsRefresh()).toBe(true);
        vi.useRealTimers();
    });

    it('returns fallbackSymbols from the stub', async () => {
        const symbols = ['SPY', 'QQQ'];
        const curator = new WatchlistCurator(null, null, symbols);
        await expect(curator.curate([])).resolves.toEqual(symbols);
    });
});

describe('WatchlistCurator — macro tickers', () => {
    const macroSignals: MacroSignal[] = [
        {
            event: 'oil_supply_shock',
            impact: 'bearish',
            sectors: ['energy', 'transport'],
            tickers: ['UAL', 'DAL', 'XOM', 'CVX'],
            confidence: 0.82,
            reasoning: 'OPEC cut',
        },
        {
            event: 'ai_chip_export_ban',
            impact: 'bullish',
            sectors: ['tech'],
            tickers: ['AMD', 'NVDA'],
            confidence: 0.75,
            reasoning: 'Export ban lifted',
        },
    ];

    it('extracts all tickers from active macro signals', async () => {
        const curator = new WatchlistCurator(null, null, []);
        const symbols = await curator.curate(macroSignals);
        expect(symbols).toContain('UAL');
        expect(symbols).toContain('DAL');
        expect(symbols).toContain('XOM');
        expect(symbols).toContain('AMD');
        expect(symbols).toContain('NVDA');
    });

    it('deduplicates tickers that appear in multiple signals', async () => {
        const signals: MacroSignal[] = [
            { event: 'a', impact: 'bearish', sectors: [], tickers: ['AAPL', 'MSFT'], confidence: 0.7, reasoning: '' },
            { event: 'b', impact: 'bullish', sectors: [], tickers: ['AAPL', 'GOOGL'], confidence: 0.7, reasoning: '' },
        ];
        const curator = new WatchlistCurator(null, null, []);
        const symbols = await curator.curate(signals);
        const aaplCount = symbols.filter(s => s === 'AAPL').length;
        expect(aaplCount).toBe(1);
    });
});

describe('WatchlistCurator — Alpaca movers', () => {
    it('includes top-volume symbols from Alpaca when available', async () => {
        const mockAlpaca = {
            data: {
                getMostActiveStocks: vi.fn().mockResolvedValue([
                    { symbol: 'PLTR', volume: 90_000_000 },
                    { symbol: 'RIVN', volume: 75_000_000 },
                    { symbol: 'HOOD', volume: 60_000_000 },
                ]),
            },
        };
        const curator = new WatchlistCurator(mockAlpaca, null, []);
        const symbols = await curator.curate([]);
        expect(symbols).toContain('PLTR');
        expect(symbols).toContain('RIVN');
        expect(symbols).toContain('HOOD');
    });

    it('falls back gracefully when Alpaca movers call fails', async () => {
        const mockAlpaca = {
            data: {
                getMostActiveStocks: vi.fn().mockRejectedValue(new Error('API unavailable')),
            },
        };
        const curator = new WatchlistCurator(mockAlpaca, null, ['SPY']);
        const symbols = await curator.curate([]);
        // Should not throw, should return fallback
        expect(symbols).toContain('SPY');
    });

    it('falls back gracefully when alpacaInstance is null', async () => {
        const curator = new WatchlistCurator(null, null, ['QQQ']);
        const symbols = await curator.curate([]);
        expect(symbols).toContain('QQQ');
    });
});
