import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PumpProfiler } from '../pump-profiler';
import type { ManipulationSignal } from '../types';

const redisMock = {
  lpush: vi.fn().mockResolvedValue(1),
  ltrim: vi.fn().mockResolvedValue('OK'),
  lrange: vi.fn().mockResolvedValue([]),
  set: vi.fn().mockResolvedValue('OK'),
  get: vi.fn().mockResolvedValue(null),
  expire: vi.fn().mockResolvedValue(1),
};

function makeSignal(overrides: Partial<ManipulationSignal> = {}): ManipulationSignal {
  return {
    id: 'test-1',
    type: 'pump_and_dump',
    symbol: 'TEST/USDC',
    exchange: 'mexc',
    confidence: 80,
    phase: 'early_pump',
    shill_activity: [],
    total_shill_accounts: 5,
    price_at_detection: 1.0,
    volume_24h: 100000,
    volume_spike_ratio: 5.0,
    price_velocity: 2.0,
    reasoning: 'test',
    estimated_peak_minutes: null,
    detected_at: new Date().toISOString(),
    source: 'x_scan',
    ...overrides,
  };
}

describe('PumpProfiler', () => {
  let profiler: PumpProfiler;

  beforeEach(() => {
    vi.clearAllMocks();
    profiler = new PumpProfiler(redisMock as any);
  });

  it('should start tracking a pump signal', () => {
    profiler.startTracking(makeSignal());
    expect(profiler.getActiveCount()).toBe(1);
  });

  it('should not exceed max concurrent tracking (10)', () => {
    for (let i = 0; i < 12; i++) {
      profiler.startTracking(makeSignal({ id: `test-${i}`, symbol: `T${i}/USDC` }));
    }
    expect(profiler.getActiveCount()).toBe(10);
  });

  it('should finalize a profile and store to Redis', async () => {
    profiler.startTracking(makeSignal());
    await profiler.finalize('test-1', false);
    expect(redisMock.lpush).toHaveBeenCalledWith('huntrix:pump_history', expect.any(String));
    expect(redisMock.ltrim).toHaveBeenCalledWith('huntrix:pump_history', 0, 199);
    expect(profiler.getActiveCount()).toBe(0);
  });

  it('should compute median correctly', () => {
    expect(PumpProfiler.median([1, 3, 5, 7, 9])).toBe(5);
    expect(PumpProfiler.median([1, 2, 3, 4])).toBe(2.5);
    expect(PumpProfiler.median([42])).toBe(42);
    expect(PumpProfiler.median([])).toBe(0);
  });
});
