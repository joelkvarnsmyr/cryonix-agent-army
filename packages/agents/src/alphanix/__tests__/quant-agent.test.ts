import { describe, it, expect } from 'vitest';
import { QuantAgent } from '../pod/quant-agent.js';
import type { Candle } from '../types.js';

const mockCandles: Candle[] = Array.from({ length: 30 }, (_, i) => ({
  timestamp: Date.now() - (30 - i) * 60000,
  open: 84000 + i * 10,
  high: 84050 + i * 10,
  low: 83950 + i * 10,
  close: 84000 + i * 10 + (i > 25 ? -3000 : 5),
  volume: 100 + i * 5,
}));

describe('QuantAgent', () => {
  const agent = new QuantAgent('pod-btc', ['rsi', 'volume']);

  it('should generate proposals from candle data', () => {
    const proposals = agent.analyze('BTC/USDC', 'binance', mockCandles);
    expect(Array.isArray(proposals)).toBe(true);
    // With the dip in last candles, we expect at least a dip_buy signal
    expect(proposals.length).toBeGreaterThanOrEqual(1);
    for (const p of proposals) {
      expect(p.podId).toBe('pod-btc');
      expect(p.adapter).toBe('binance');
      expect(p.confidence).toBeGreaterThanOrEqual(0);
      expect(p.confidence).toBeLessThanOrEqual(100);
      expect(p.signals.length).toBeGreaterThan(0);
    }
  });

  it('should return empty array for insufficient data', () => {
    const shortCandles = mockCandles.slice(0, 10);
    const proposals = agent.analyze('BTC/USDC', 'binance', shortCandles);
    expect(proposals).toEqual([]);
  });

  it('should assign unique IDs to proposals', () => {
    const p1 = agent.analyze('BTC/USDC', 'binance', mockCandles);
    const p2 = agent.analyze('ETH/USDC', 'binance', mockCandles);
    if (p1.length > 0 && p2.length > 0) {
      expect(p1[0].id).not.toBe(p2[0].id);
    }
    // Each ID should be 8 chars
    for (const p of [...p1, ...p2]) {
      expect(p.id).toHaveLength(8);
    }
  });
});
