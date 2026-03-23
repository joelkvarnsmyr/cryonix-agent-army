import { describe, it, expect } from 'vitest';
import { Backtester } from '../backtest/backtester';
import type { Candle } from '../types';

// Generate candles with a trending pattern (slight uptrend with periodic dips)
function generateTrendingCandles(count: number, startPrice: number): Candle[] {
  const candles: Candle[] = [];
  let price = startPrice;
  for (let i = 0; i < count; i++) {
    // Every 20 candles, add a 5% dip then recover
    if (i % 20 >= 15 && i % 20 <= 17) {
      price *= 0.98; // dip
    } else {
      price *= 1.002; // slight uptrend
    }
    candles.push({
      timestamp: Date.now() - (count - i) * 900000, // 15m candles
      open: price * 0.999,
      high: price * 1.005,
      low: price * 0.995,
      close: price,
      volume: 100 + Math.random() * 50,
    });
  }
  return candles;
}

describe('Backtester', () => {
  const bt = new Backtester();

  it('should run a backtest and return results', () => {
    const candles = generateTrendingCandles(100, 84000);
    const result = bt.run({
      symbol: 'BTC/USDC',
      adapter: 'binance',
      candles,
      initialCapital: 10000,
      models: ['rsi', 'volume'],
      riskConfig: { maxDrawdownPct: 5, maxPositions: 3, minConfidence: 50 },
      takeProfitPct: 3,
      stopLossPct: 2,
    });
    expect(result.symbol).toBe('BTC/USDC');
    expect(result.candlesAnalyzed).toBe(100);
    expect(result.totalTrades).toBeGreaterThanOrEqual(0);
    expect(result.models).toEqual(['rsi', 'volume']);
  });

  it('should calculate win rate correctly', () => {
    const candles = generateTrendingCandles(200, 84000);
    const result = bt.run({
      symbol: 'BTC/USDC',
      adapter: 'binance',
      candles,
      initialCapital: 10000,
      models: ['rsi', 'volume'],
      riskConfig: { maxDrawdownPct: 10, maxPositions: 5, minConfidence: 30 },
      takeProfitPct: 2,
      stopLossPct: 1.5,
    });
    if (result.totalTrades > 0) {
      expect(result.winRate).toBe((result.winningTrades / result.totalTrades) * 100);
      expect(result.winningTrades + result.losingTrades).toBe(result.totalTrades);
    }
  });

  it('should track max drawdown', () => {
    const candles = generateTrendingCandles(100, 84000);
    const result = bt.run({
      symbol: 'BTC/USDC',
      adapter: 'binance',
      candles,
      initialCapital: 10000,
      models: ['rsi', 'volume'],
      riskConfig: { maxDrawdownPct: 10, maxPositions: 5, minConfidence: 30 },
      takeProfitPct: 5,
      stopLossPct: 3,
    });
    expect(result.maxDrawdownPct).toBeGreaterThanOrEqual(0);
  });

  it('should return empty results for insufficient data', () => {
    const candles = generateTrendingCandles(10, 84000);
    const result = bt.run({
      symbol: 'BTC/USDC',
      adapter: 'binance',
      candles,
      initialCapital: 10000,
      models: ['rsi'],
      riskConfig: { maxDrawdownPct: 5, maxPositions: 3, minConfidence: 50 },
      takeProfitPct: 3,
      stopLossPct: 2,
    });
    expect(result.totalTrades).toBe(0);
  });
});
