import { describe, it, expect } from 'vitest';
import { EsgScorer } from '../pod/esg-scorer';
import { PositionTracker } from '../pod/position-tracker';

describe('EsgScorer', () => {
  it('should return stub score of 100 when disabled', async () => {
    const scorer = new EsgScorer({ enabled: false, minScore: 40 });
    const score = await scorer.score('AAPL');
    expect(score.overall).toBe(100);
    expect(score.source).toBe('stub');
  });

  it('should pass threshold check with stub score', () => {
    const scorer = new EsgScorer({ enabled: false, minScore: 40 });
    const score = { overall: 100, environmental: 100, social: 100, governance: 100,
      planetaryBoundaries: { climateChange: true, freshwaterUse: true, landSystemChange: true,
        biosphereIntegrity: true, biogeochemicalFlows: true, oceanAcidification: true, allWithinBoundaries: true },
      source: 'stub' as const, timestamp: Date.now() };
    expect(scorer.meetsThreshold(score)).toBe(true);
  });

  it('should detect planetary boundary violations', () => {
    const scorer = new EsgScorer({ enabled: true, minScore: 40 });
    const score = { overall: 30, environmental: 20, social: 50, governance: 50,
      planetaryBoundaries: { climateChange: false, freshwaterUse: false, landSystemChange: true,
        biosphereIntegrity: true, biogeochemicalFlows: true, oceanAcidification: true, allWithinBoundaries: false },
      source: 'computed' as const, timestamp: Date.now() };
    const result = scorer.checkPlanetaryBoundaries(score);
    expect(result.passed).toBe(false);
    expect(result.violations).toContain('climate_change');
    expect(result.violations).toContain('freshwater_use');
  });
});

describe('PositionTracker', () => {
  it('should track and update positions', () => {
    const tracker = new PositionTracker();
    tracker.open({
      symbol: 'BTC/USDC', qty: 0.001, avgEntryPrice: 84000, currentPrice: 84000,
      marketValue: 84, unrealizedPnl: 0, unrealizedPnlPct: 0, adapter: 'binance',
    });
    expect(tracker.getCount()).toBe(1);

    tracker.update('binance', 'BTC/USDC', 85000);
    const positions = tracker.getAll();
    expect(positions[0].unrealizedPnlPct).toBeCloseTo(1.19, 1);
    expect(positions[0].holdingHours).toBeGreaterThanOrEqual(0);
  });

  it('should close positions and return them', () => {
    const tracker = new PositionTracker();
    tracker.open({
      symbol: 'ETH/USDC', qty: 0.01, avgEntryPrice: 2000, currentPrice: 2000,
      marketValue: 20, unrealizedPnl: 0, unrealizedPnlPct: 0, adapter: 'binance',
    });
    const closed = tracker.close('binance', 'ETH/USDC');
    expect(closed).toBeDefined();
    expect(closed!.symbol).toBe('ETH/USDC');
    expect(tracker.getCount()).toBe(0);
  });

  it('should calculate total unrealized P&L', () => {
    const tracker = new PositionTracker();
    tracker.open({
      symbol: 'BTC/USDC', qty: 0.01, avgEntryPrice: 80000, currentPrice: 85000,
      marketValue: 850, unrealizedPnl: 50, unrealizedPnlPct: 6.25, adapter: 'binance',
    });
    expect(tracker.getTotalUnrealizedPnl()).toBe(50);
    expect(tracker.getTotalMarketValue()).toBe(850);
  });
});
