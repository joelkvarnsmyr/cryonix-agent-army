import { describe, it, expect, vi } from 'vitest';
import { AdapterRegistry } from '../adapters/adapter-registry';
import type { MarketAdapter } from '../adapters/types';
import type { AssetClass } from '../types';

function createMockAdapter(id: string, assetClass: AssetClass = 'crypto'): MarketAdapter {
  return {
    id,
    assetClass,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi.fn().mockResolvedValue({ connected: true, latencyMs: 5 }),
    getOHLCV: vi.fn().mockResolvedValue([]),
    getOrderBook: vi.fn().mockResolvedValue({ bids: [], asks: [], timestamp: Date.now() }),
    getSymbols: vi.fn().mockResolvedValue([]),
    submitOrder: vi.fn().mockResolvedValue({ success: true, orderId: 'mock-1' }),
    cancelOrder: vi.fn().mockResolvedValue(undefined),
    getPositions: vi.fn().mockResolvedValue([]),
    getOpenOrders: vi.fn().mockResolvedValue([]),
    getAccountState: vi.fn().mockResolvedValue({
      balance: 1000, equity: 1000, availableCapital: 1000,
      currency: 'USD', updatedAt: Date.now(),
    }),
    getTradingHours: () => ({ alwaysOpen: true }),
    getFees: () => ({ maker: 0.001, taker: 0.001 }),
  };
}

describe('AdapterRegistry', () => {
  it('should register and retrieve an adapter', () => {
    const registry = new AdapterRegistry();
    const adapter = createMockAdapter('binance');
    registry.register(adapter);
    expect(registry.get('binance')).toBe(adapter);
  });

  it('should return undefined for unknown adapter', () => {
    const registry = new AdapterRegistry();
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('should list all registered adapters', () => {
    const registry = new AdapterRegistry();
    registry.register(createMockAdapter('binance'));
    registry.register(createMockAdapter('alpaca', 'stock'));
    expect(registry.list()).toEqual(['binance', 'alpaca']);
  });

  it('should connect all adapters without error', async () => {
    const registry = new AdapterRegistry();
    const a1 = createMockAdapter('binance');
    const a2 = createMockAdapter('alpaca', 'stock');
    registry.register(a1);
    registry.register(a2);

    await registry.connectAll();

    expect(a1.connect).toHaveBeenCalledOnce();
    expect(a2.connect).toHaveBeenCalledOnce();
  });

  it('should handle connect failure gracefully', async () => {
    const registry = new AdapterRegistry();
    const failing = createMockAdapter('broken');
    (failing.connect as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('conn refused'));
    registry.register(failing);

    // Should not throw
    await registry.connectAll();
  });

  it('should health check all adapters', async () => {
    const registry = new AdapterRegistry();
    registry.register(createMockAdapter('binance'));
    registry.register(createMockAdapter('alpaca', 'stock'));

    const results = await registry.healthCheckAll();

    expect(results['binance']).toEqual({ connected: true, latencyMs: 5 });
    expect(results['alpaca']).toEqual({ connected: true, latencyMs: 5 });
  });

  it('should disconnect all adapters', async () => {
    const registry = new AdapterRegistry();
    const a1 = createMockAdapter('binance');
    registry.register(a1);

    await registry.disconnectAll();

    expect(a1.disconnect).toHaveBeenCalledOnce();
  });
});
