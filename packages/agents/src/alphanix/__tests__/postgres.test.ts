import { describe, it, expect } from 'vitest';
import { AlphanixDB } from '../data/postgres';

describe('AlphanixDB', () => {
  it('should construct without error', () => {
    const db = new AlphanixDB();
    expect(db).toBeDefined();
  });

  it('should handle connect without POSTGRES_URL gracefully', async () => {
    const originalUrl = process.env.POSTGRES_URL;
    delete process.env.POSTGRES_URL;
    const db = new AlphanixDB();
    await db.connect();  // Should not throw
    delete process.env.POSTGRES_URL;
    if (originalUrl) process.env.POSTGRES_URL = originalUrl;
  });

  it('should return empty trades without connection', async () => {
    const db = new AlphanixDB();
    const trades = await db.getRecentTrades('crypto');
    expect(trades).toEqual([]);
  });

  it('should handle logTrade without connection gracefully', async () => {
    const db = new AlphanixDB();
    // Should not throw
    await db.logTrade({
      podId: 'crypto', symbol: 'BTC/USDC', adapter: 'binance', side: 'BUY',
      qty: 0.001, fillPrice: 85000, notional: 85, slippage: 0, fees: 0.08,
      confidence: 78, reasoning: 'test', signals: ['rsi_oversold'], models: ['rsi'],
      orderId: 'test-1', proposalId: 'tp-1',
    });
  });
});
