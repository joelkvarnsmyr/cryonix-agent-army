import { describe, it, expect, vi } from 'vitest';
import { WatchlistCurator } from '../watchlist-curator';

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
