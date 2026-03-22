import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExchangeManager } from '../exchange-manager';
import type { ExchangeConfig } from '../types';

const CONFIGS: ExchangeConfig[] = [
  { id: 'binance', enabled: true, role: 'scan+trade', api_key_env: 'BIN_KEY', secret_env: 'BIN_SEC', priority: 1 },
  { id: 'mexc', enabled: true, role: 'scan', api_key_env: 'MEXC_KEY', secret_env: 'MEXC_SEC', priority: 3 },
  { id: 'bybit', enabled: false, role: 'scan+trade', api_key_env: 'BY_KEY', secret_env: 'BY_SEC', priority: 2 },
];

// Mock CCXT module
vi.mock('ccxt', () => ({
  binance: class { markets = {}; async loadMarkets() { return {}; } },
  mexc: class { markets = {}; async loadMarkets() { return {}; } },
  bybit: class { markets = {}; async loadMarkets() { return {}; } },
}));

describe('ExchangeManager', () => {
  it('should only initialize enabled exchanges', async () => {
    const mgr = new ExchangeManager(CONFIGS, 'paper');
    await mgr.initialize();
    expect(mgr.getScanExchangeIds()).toContain('binance');
    expect(mgr.getScanExchangeIds()).toContain('mexc');
    expect(mgr.getScanExchangeIds()).not.toContain('bybit');
  });

  it('should only return trade-enabled exchanges for getTradeExchangeIds', async () => {
    const mgr = new ExchangeManager(CONFIGS, 'paper');
    await mgr.initialize();
    expect(mgr.getTradeExchangeIds()).toContain('binance');
    expect(mgr.getTradeExchangeIds()).not.toContain('mexc'); // scan-only
  });

  it('should return exchanges sorted by priority for routing', async () => {
    const mgr = new ExchangeManager(CONFIGS, 'paper');
    await mgr.initialize();
    const tradeIds = mgr.getTradeExchangeIds();
    expect(tradeIds).toEqual(['binance']);
  });

  it('should get exchange instance by id', async () => {
    const mgr = new ExchangeManager(CONFIGS, 'paper');
    await mgr.initialize();
    expect(mgr.getExchange('binance')).toBeDefined();
    expect(mgr.getExchange('bybit')).toBeUndefined(); // disabled
  });

  it('should return all exchange instances as map', async () => {
    const mgr = new ExchangeManager(CONFIGS, 'paper');
    await mgr.initialize();
    const all = mgr.getAllExchanges();
    expect(all.size).toBe(2); // binance + mexc (bybit disabled)
  });
});
