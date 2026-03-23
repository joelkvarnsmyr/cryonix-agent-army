import { describe, it, expect } from 'vitest';
import { RiskAgent } from '../pod/risk-agent';
import type { PortfolioContext } from '../pod/risk-agent';
import type { TradeProposal } from '../types';

const makeProposal = (overrides: Partial<TradeProposal> = {}): TradeProposal => ({
  id: 'tp-001',
  podId: 'crypto',
  symbol: 'BTC/USDC',
  adapter: 'binance',
  side: 'BUY',
  confidence: 75,
  sizing: { qty: 0.001, notional: 85 },
  reasoning: 'test',
  models: ['rsi'],
  signals: ['rsi_oversold'],
  timestamp: Date.now(),
  ...overrides,
});

const defaultCtx: PortfolioContext = {
  openPositions: 2,
  currentDrawdownPct: 1.0,
};

describe('RiskAgent', () => {
  const agent = new RiskAgent('crypto', {
    maxDrawdownPct: 3.0,
    maxPositions: 5,
    minConfidence: 60,
  });

  it('should approve a valid proposal', () => {
    const decision = agent.evaluate(makeProposal(), defaultCtx);
    expect(decision.action).toBe('approve');
    expect(decision.proposalId).toBe('tp-001');
    expect(decision.adjustedSizing).toEqual({ qty: 0.001, notional: 85 });
  });

  it('should veto when confidence too low', () => {
    const decision = agent.evaluate(makeProposal({ confidence: 30 }), defaultCtx);
    expect(decision.action).toBe('veto');
    expect(decision.vetoReason).toContain('Confidence 30');
    expect(decision.vetoReason).toContain('below minimum 60');
  });

  it('should veto when max positions reached', () => {
    const ctx: PortfolioContext = { openPositions: 5, currentDrawdownPct: 1.0 };
    const decision = agent.evaluate(makeProposal(), ctx);
    expect(decision.action).toBe('veto');
    expect(decision.vetoReason).toContain('Open positions 5');
  });

  it('should veto when drawdown exceeds limit', () => {
    const ctx: PortfolioContext = { openPositions: 2, currentDrawdownPct: 3.5 };
    const decision = agent.evaluate(makeProposal(), ctx);
    expect(decision.action).toBe('veto');
    expect(decision.vetoReason).toContain('Drawdown 3.5%');
  });

  it('should track consecutive losses via recordExit', () => {
    const a = new RiskAgent('crypto', { maxDrawdownPct: 3, maxPositions: 5, minConfidence: 60 });

    a.recordExit(-10);
    a.recordExit(-5);
    expect(a.getState().consecutiveLosses).toBe(2);
    expect(a.getState().dailyPnl).toBe(-15);
    expect(a.getState().tradesToday).toBe(2);

    // Win resets consecutive losses
    a.recordExit(20);
    expect(a.getState().consecutiveLosses).toBe(0);
    expect(a.getState().dailyPnl).toBe(5);
    expect(a.getState().tradesToday).toBe(3);
  });

  it('should reset daily counters', () => {
    const a = new RiskAgent('crypto', { maxDrawdownPct: 3, maxPositions: 5, minConfidence: 60 });
    a.recordExit(-10);
    a.recordExit(5);
    a.resetDaily();
    expect(a.getState().dailyPnl).toBe(0);
    expect(a.getState().tradesToday).toBe(0);
    // consecutiveLosses is NOT reset by resetDaily (persists across days)
    expect(a.getState().consecutiveLosses).toBe(0);
  });
});
