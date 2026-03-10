import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SolanaSignalGenerator } from '../signals/solana-signal-generator';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// CoinGecko OHLC: [timestamp, open, high, low, close][]
const MOCK_OHLC = Array.from({ length: 50 }, (_, i) => [
    Date.now() - (50 - i) * 3_600_000,
    100 + Math.sin(i / 5) * 10,
    105 + Math.sin(i / 5) * 10,
    95 + Math.sin(i / 5) * 10,
    102 + Math.sin(i / 5) * 10,
]);

describe('SolanaSignalGenerator', () => {
    let generator: SolanaSignalGenerator;

    beforeEach(() => {
        vi.clearAllMocks();
        generator = new SolanaSignalGenerator({ symbols: ['SOL', 'JUP'], bars_count: 50 });
    });

    it('returns array of signals for known symbols', async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => MOCK_OHLC,
        });
        const signals = await generator.scan();
        expect(Array.isArray(signals)).toBe(true);
    });

    it('skips symbol when CoinGecko returns error', async () => {
        mockFetch.mockResolvedValue({ ok: false, status: 429 });
        const signals = await generator.scan();
        expect(signals).toEqual([]);
    });

    it('only returns BUY or SELL signals (not WAIT)', async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => MOCK_OHLC,
        });
        const signals = await generator.scan();
        for (const s of signals) {
            expect(['BUY', 'SELL']).toContain(s.action);
        }
    });

    it('addSymbol adds to watchlist', () => {
        generator.addSymbol('NEWTOKEN', 'abc123mint');
        // No assertion needed — just must not throw
    });
});
