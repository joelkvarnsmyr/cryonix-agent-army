import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ExitMonitor, ExitConfig } from '../pod/exit-monitor';

const defaultConfig: ExitConfig = {
  takeProfitPct: 5.0,
  stopLossPct: 3.0,
  trailingStopActivation: 2.0,
  trailingStopDistance: 1.0,
  stagnationHours: 48,
};

describe('ExitMonitor', () => {
  let monitor: ExitMonitor;

  beforeEach(() => {
    vi.useFakeTimers();
    monitor = new ExitMonitor(defaultConfig);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should trigger take_profit at threshold', () => {
    monitor.track('BTC/USDC', 100);
    const signal = monitor.check('BTC/USDC', 105); // +5%
    expect(signal).not.toBeNull();
    expect(signal!.reason).toBe('take_profit');
    expect(signal!.pnlPct).toBeCloseTo(5.0);
  });

  it('should trigger stop_loss at threshold', () => {
    monitor.track('ETH/USDC', 100);
    const signal = monitor.check('ETH/USDC', 97); // -3%
    expect(signal).not.toBeNull();
    expect(signal!.reason).toBe('stop_loss');
    expect(signal!.pnlPct).toBeCloseTo(-3.0);
  });

  it('should trigger trailing_stop after activation then pullback', () => {
    monitor.track('SOL/USDC', 100);

    // Price rises to 103 (3% gain, above 2% activation)
    const noExit = monitor.check('SOL/USDC', 103);
    expect(noExit).toBeNull();

    // Price drops from 103 high water mark by >= 1%
    // 103 * 0.99 = 101.97, so 101.96 should trigger
    const signal = monitor.check('SOL/USDC', 101.96);
    expect(signal).not.toBeNull();
    expect(signal!.reason).toBe('trailing_stop');
    expect(signal!.highWaterMark).toBe(103);
  });

  it('should NOT trigger trailing_stop before activation threshold', () => {
    monitor.track('BNB/USDC', 100);

    // Price rises to 101.5 (1.5% gain, below 2% activation)
    monitor.check('BNB/USDC', 101.5);

    // Price drops back — trailing should not activate
    const signal = monitor.check('BNB/USDC', 100.2);
    expect(signal).toBeNull();
  });

  it('should trigger stagnation after timeout with no movement', () => {
    monitor.track('DOGE/USDC', 100);

    // Advance time by 49 hours (past 48h threshold)
    vi.advanceTimersByTime(49 * 60 * 60 * 1000);

    // Price barely moved (0.5% gain, under 1.0% threshold)
    const signal = monitor.check('DOGE/USDC', 100.5);
    expect(signal).not.toBeNull();
    expect(signal!.reason).toBe('stagnation');
  });

  it('should NOT trigger stagnation before timeout', () => {
    monitor.track('DOGE/USDC', 100);

    // Only 24 hours
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);

    const signal = monitor.check('DOGE/USDC', 100.5);
    expect(signal).toBeNull();
  });

  it('should NOT trigger stagnation if price moved significantly', () => {
    monitor.track('DOGE/USDC', 100);

    vi.advanceTimersByTime(49 * 60 * 60 * 1000);

    // Price moved 1.5% — above 1.0% threshold, not stagnant
    const signal = monitor.check('DOGE/USDC', 101.5);
    expect(signal).toBeNull();
  });

  it('should update high water mark on price increase', () => {
    monitor.track('BTC/USDC', 100);

    monitor.check('BTC/USDC', 101);
    monitor.check('BTC/USDC', 103);
    monitor.check('BTC/USDC', 102);

    // Trailing stop should fire since HWM=103, drop to 101.96 is > 1%
    const signal = monitor.check('BTC/USDC', 101.96);
    expect(signal).not.toBeNull();
    expect(signal!.highWaterMark).toBe(103);
  });

  it('should track and untrack positions', () => {
    monitor.track('BTC/USDC', 100);
    monitor.track('ETH/USDC', 200);

    expect(monitor.getTrackedSymbols()).toContain('BTC/USDC');
    expect(monitor.getTrackedSymbols()).toContain('ETH/USDC');
    expect(monitor.getTrackedSymbols()).toHaveLength(2);

    monitor.untrack('BTC/USDC');
    expect(monitor.getTrackedSymbols()).not.toContain('BTC/USDC');
    expect(monitor.getTrackedSymbols()).toHaveLength(1);
  });

  it('should return null for untracked symbol', () => {
    const signal = monitor.check('UNKNOWN/USDC', 100);
    expect(signal).toBeNull();
  });
});
