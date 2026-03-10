// packages/agents/src/aktienix/intelligence/ticker-universe.test.ts
import { describe, it, expect } from 'vitest';
import { isValidTicker, VALID_TICKERS } from './ticker-universe';

describe('ticker-universe', () => {
    it('accepts known S&P 500 tickers', () => {
        expect(isValidTicker('AAPL')).toBe(true);
        expect(isValidTicker('MSFT')).toBe(true);
        expect(isValidTicker('GOOGL')).toBe(true);
        expect(isValidTicker('XOM')).toBe(true);
        expect(isValidTicker('JPM')).toBe(true);
    });

    it('accepts energy and transport tickers in aktienix watchlist', () => {
        const watchlist = ['XOM', 'CVX', 'XLE', 'USO', 'UAL', 'DAL', 'AAL', 'FDX', 'UPS'];
        for (const ticker of watchlist) {
            expect(isValidTicker(ticker), `${ticker} should be valid`).toBe(true);
        }
    });

    it('rejects hallucinated or non-US tickers', () => {
        expect(isValidTicker('FAKE_CORP')).toBe(false);
        expect(isValidTicker('')).toBe(false);
        expect(isValidTicker('TSMC')).toBe(false); // Taiwan-listed, not NYSE/NASDAQ primary
        expect(isValidTicker('BITCOIN')).toBe(false);
    });

    it('is case-sensitive — only uppercase', () => {
        expect(isValidTicker('aapl')).toBe(false);
    });

    it('has at least 400 tickers', () => {
        expect(VALID_TICKERS.size).toBeGreaterThan(400);
    });
});
