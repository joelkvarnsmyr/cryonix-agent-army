import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SolanaClient } from '../brokers/solana-client';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const JUPITER_QUOTE_RESPONSE = {
    inAmount: '1000000',
    outAmount: '6500000',
    priceImpactPct: '0.01',
    routePlan: [],
};

describe('SolanaClient (paper mode)', () => {
    let client: SolanaClient;

    beforeEach(() => {
        vi.clearAllMocks();
        client = new SolanaClient({
            rpcUrl: 'https://mainnet.helius-rpc.com/?api-key=test',
            paperTrading: true,
            initialUsdcBalance: 500,
        });
    });

    it('connect() succeeds in paper mode without wallet', async () => {
        await expect(client.connect()).resolves.not.toThrow();
    });

    it('getAccountState() returns virtual balances in paper mode', async () => {
        await client.connect();
        const state = await client.getAccountState();
        expect(state.buyingPower).toBe(500);
        expect(state.portfolioValue).toBe(500);
        expect(state.settledCash).toBe(500);
    });

    it('getPositions() returns empty array initially', async () => {
        await client.connect();
        const positions = await client.getPositions();
        expect(positions).toEqual([]);
    });

    it('submitOrder() BUY simulates fill and deducts USDC', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => JUPITER_QUOTE_RESPONSE,
        });
        await client.connect();
        const result = await client.submitOrder({
            symbol: 'SOL',
            action: 'BUY',
            qty: 10,
            orderType: 'MARKET',
        });
        expect(result.success).toBe(true);
        expect(result.orderId).toBeDefined();
        const positions = await client.getPositions();
        expect(positions.length).toBe(1);
        expect(positions[0].symbol).toBe('SOL');
        const state = await client.getAccountState();
        expect(state.buyingPower).toBeLessThan(500);
    });

    it('submitOrder() SELL removes position and credits USDC', async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => JUPITER_QUOTE_RESPONSE,
        });
        await client.connect();
        await client.submitOrder({ symbol: 'SOL', action: 'BUY', qty: 10, orderType: 'MARKET' });
        const result = await client.submitOrder({ symbol: 'SOL', action: 'SELL', qty: 10, orderType: 'MARKET' });
        expect(result.success).toBe(true);
        const positions = await client.getPositions();
        expect(positions.length).toBe(0);
    });

    it('submitOrder() fails gracefully when Jupiter quote unavailable', async () => {
        mockFetch.mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({}) });
        await client.connect();
        const result = await client.submitOrder({ symbol: 'SOL', action: 'BUY', qty: 10, orderType: 'MARKET' });
        expect(result.success).toBe(false);
        expect(result.message).toContain('quote');
    });
});
