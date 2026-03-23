import { describe, it, expect } from 'vitest';
import { Pod } from '../pod/pod.js';
import type { PodConfig } from '../types.js';
import type { MarketAdapter } from '../adapters/types.js';

const mockCandles = Array.from({ length: 30 }, (_, i) => ({
  timestamp: Date.now() - (30 - i) * 60000,
  open: 84000,
  high: 84050,
  low: 83950,
  close: 84000 - (i > 25 ? 200 : 0),
  volume: 100 + i * 5,
}));

const mockAdapter: MarketAdapter = {
  id: 'binance',
  assetClass: 'crypto',
  connect: async () => {},
  disconnect: async () => {},
  healthCheck: async () => ({ connected: true, latencyMs: 5 }),
  getOHLCV: async () => mockCandles,
  getOrderBook: async () => ({
    bids: [[84000, 1]],
    asks: [[84010, 1]],
    timestamp: Date.now(),
  }),
  getSymbols: async () => [],
  submitOrder: async () => ({
    success: true,
    orderId: 'test-1',
    filledQty: 0.001,
    filledAvgPrice: 84000,
  }),
  cancelOrder: async () => {},
  getPositions: async () => [],
  getOpenOrders: async () => [],
  getAccountState: async () => ({
    balance: 10000,
    equity: 10000,
    availableCapital: 10000,
    currency: 'USDC',
    updatedAt: Date.now(),
  }),
  getTradingHours: () => ({ alwaysOpen: true }),
  getFees: () => ({ maker: 0.001, taker: 0.001 }),
};

const podConfig: PodConfig = {
  id: 'pod-btc',
  enabled: true,
  adapter: 'binance',
  capitalPct: 0.5,
  strategy: 'momentum',
  symbols: ['BTC/USDC'],
  pollIntervalMs: 30000,
  riskMaxDrawdownPct: 10,
  riskMaxPositions: 3,
};

describe('Pod', () => {
  it('should initialize with starting state and correct ID', () => {
    const pod = new Pod(podConfig, mockAdapter, 5000);
    expect(pod.getId()).toBe('pod-btc');
    expect(pod.getState()).toBe('starting');
  });

  it('should run one scan cycle', async () => {
    const pod = new Pod(podConfig, mockAdapter, 5000);
    const result = await pod.runCycle();
    expect(result.scannedSymbols).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(pod.getState()).toBe('running');
  });

  it('should return correct capital budget', () => {
    const pod = new Pod(podConfig, mockAdapter, 5000);
    expect(pod.getCapitalBudget()).toBe(5000);
    pod.updateCapitalBudget(7500);
    expect(pod.getCapitalBudget()).toBe(7500);
  });

  it('should transition to stopped state', async () => {
    const pod = new Pod(podConfig, mockAdapter, 5000);
    await pod.stop();
    expect(pod.getState()).toBe('stopped');
  });
});
