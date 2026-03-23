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
  const agent = new QuantAgent('pod-btc', ['rsi', 'volume', 'dip']);

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

  it('should use default models when none provided', () => {
    const defaultAgent = new QuantAgent('pod-default');
    expect(defaultAgent.models).toEqual([
      'rsi',
      'volume',
      'macd',
      'bollinger',
      'ema',
      'deep_value',
      'dip',
    ]);
  });
});

describe('QuantAgent - MACD crossover', () => {
  it('should detect macd_bullish when MACD crosses above signal', () => {
    // 38 candles declining, then 2 sharp rally candles — cross lands on last candle
    const candles: Candle[] = Array.from({ length: 40 }, (_, i) => {
      const price = i < 38 ? 100 - i * 0.5 : 81 + (i - 38) * 4;
      return {
        timestamp: Date.now() - (40 - i) * 60000,
        open: price - 0.2,
        high: price + 0.5,
        low: price - 0.5,
        close: price,
        volume: 100,
      };
    });

    const agent = new QuantAgent('pod-macd', ['macd']);
    const proposals = agent.analyze('TEST/USDC', 'binance', candles);
    expect(proposals.length).toBe(1);
    expect(proposals[0].signals).toContain('macd_bullish');
    expect(proposals[0].confidence).toBe(80); // 50 base + 30
  });

  it('should detect macd_bearish when MACD crosses below signal', () => {
    // 38 candles rising, then 2 sharp drop candles — cross lands on last candle
    const candles: Candle[] = Array.from({ length: 40 }, (_, i) => {
      const price = i < 38 ? 100 + i * 0.5 : 119 - (i - 38) * 4;
      return {
        timestamp: Date.now() - (40 - i) * 60000,
        open: price + 0.2,
        high: price + 0.5,
        low: price - 0.5,
        close: price,
        volume: 100,
      };
    });

    const agent = new QuantAgent('pod-macd', ['macd']);
    const proposals = agent.analyze('TEST/USDC', 'binance', candles);
    expect(proposals.length).toBe(1);
    expect(proposals[0].signals).toContain('macd_bearish');
    expect(proposals[0].confidence).toBe(35); // 50 base - 15
  });
});

describe('QuantAgent - Bollinger Squeeze', () => {
  it('should detect bollinger_squeeze when price is below lower band', () => {
    // Stable price for 29 candles, then a sharp drop on last candle
    const candles: Candle[] = Array.from({ length: 30 }, (_, i) => {
      const isLast = i === 29;
      const price = isLast ? 90 : 100; // 10% drop, well below lower band of tight range
      return {
        timestamp: Date.now() - (30 - i) * 60000,
        open: price,
        high: price + 0.1,
        low: price - 0.1,
        close: price,
        volume: 100,
      };
    });

    const agent = new QuantAgent('pod-bb', ['bollinger']);
    const proposals = agent.analyze('TEST/USDC', 'binance', candles);
    expect(proposals.length).toBe(1);
    expect(proposals[0].signals).toContain('bollinger_squeeze');
    expect(proposals[0].confidence).toBe(85); // 50 + 35
  });
});

describe('QuantAgent - EMA Cross', () => {
  it('should detect ema_bullish when 9-EMA crosses above 21-EMA', () => {
    // 30 candles declining, then 6 sharp rally candles — 9-EMA crosses 21-EMA on last candle
    const candles: Candle[] = Array.from({ length: 36 }, (_, i) => {
      const price = i < 30 ? 100 - i * 0.5 : 85 + (i - 30) * 3;
      return {
        timestamp: Date.now() - (36 - i) * 60000,
        open: price - 0.1,
        high: price + 0.3,
        low: price - 0.3,
        close: price,
        volume: 100,
      };
    });

    const agent = new QuantAgent('pod-ema', ['ema']);
    const proposals = agent.analyze('TEST/USDC', 'binance', candles);
    expect(proposals.length).toBe(1);
    expect(proposals[0].signals).toContain('ema_bullish');
    expect(proposals[0].confidence).toBe(75); // 50 + 25
  });
});

describe('QuantAgent - Deep Value Crash', () => {
  it('should detect deep_value_crash when price drops >8% from 10-candle high', () => {
    // Stable high then crash on last candle (9% drop)
    const candles: Candle[] = Array.from({ length: 30 }, (_, i) => {
      const isLast = i === 29;
      const price = isLast ? 91 : 100;
      return {
        timestamp: Date.now() - (30 - i) * 60000,
        open: price,
        high: isLast ? 91 : 100.5,
        low: isLast ? 90.5 : 99.5,
        close: price,
        volume: 100,
      };
    });

    const agent = new QuantAgent('pod-dv', ['deep_value']);
    const proposals = agent.analyze('TEST/USDC', 'binance', candles);
    expect(proposals.length).toBe(1);
    expect(proposals[0].signals).toContain('deep_value_crash');
    expect(proposals[0].confidence).toBe(90); // 50 + 40
  });

  it('should not trigger deep_value_crash for small drops', () => {
    // Only 5% drop — below 8% threshold
    const candles: Candle[] = Array.from({ length: 30 }, (_, i) => {
      const isLast = i === 29;
      const price = isLast ? 95.5 : 100;
      return {
        timestamp: Date.now() - (30 - i) * 60000,
        open: price,
        high: isLast ? 95.5 : 100.5,
        low: isLast ? 95 : 99.5,
        close: price,
        volume: 100,
      };
    });

    const agent = new QuantAgent('pod-dv', ['deep_value']);
    const proposals = agent.analyze('TEST/USDC', 'binance', candles);
    expect(proposals).toEqual([]);
  });
});
