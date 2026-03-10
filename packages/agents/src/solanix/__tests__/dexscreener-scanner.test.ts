import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DexScreenerScanner } from '../signals/dexscreener-scanner';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const MOCK_DEXSCREENER_RESPONSE = {
    pairs: [
        {
            baseToken: { symbol: 'NEWTOKEN', address: 'abc123mint' },
            priceUsd: '0.0025',
            volume: { h24: 500_000, h1: 200_000 },
            liquidity: { usd: 80_000 },
            pairCreatedAt: Date.now() - 48 * 3_600_000,
        },
        {
            // Low liquidity — should be filtered out
            baseToken: { symbol: 'SCAM', address: 'scam123' },
            priceUsd: '0.001',
            volume: { h24: 10_000, h1: 5_000 },
            liquidity: { usd: 5_000 },
            pairCreatedAt: Date.now() - 24 * 3_600_000,
        },
    ],
};

describe('DexScreenerScanner', () => {
    let scanner: DexScreenerScanner;

    beforeEach(() => {
        vi.clearAllMocks();
        scanner = new DexScreenerScanner({
            minLiquidityUsd: 50_000,
            volumeSpikeMultiplier: 1.5,
            dynamicTtlMs: 7_200_000,
        });
    });

    it('returns tokens passing liquidity filter', async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => MOCK_DEXSCREENER_RESPONSE,
        });
        const tokens = await scanner.scan();
        expect(tokens.some(t => t.symbol === 'NEWTOKEN')).toBe(true);
        expect(tokens.some(t => t.symbol === 'SCAM')).toBe(false);
    });

    it('returns empty array on API failure', async () => {
        mockFetch.mockResolvedValue({ ok: false, status: 500 });
        const tokens = await scanner.scan();
        expect(tokens).toEqual([]);
    });

    it('tracks dynamic tokens with TTL', () => {
        scanner.addToken('NEWTOKEN', 'abc123', 0.0025);
        expect(scanner.getDynamicSymbols()).toContain('NEWTOKEN');
    });

    it('evicts expired dynamic tokens', () => {
        vi.useFakeTimers();
        scanner.addToken('EXPIRING', 'xyz123', 0.001);
        vi.advanceTimersByTime(8_000_000);
        scanner.evictExpired();
        expect(scanner.getDynamicSymbols()).not.toContain('EXPIRING');
        vi.useRealTimers();
    });
});
