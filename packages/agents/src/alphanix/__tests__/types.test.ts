import { describe, it, expect } from 'vitest';
import type {
  TradeProposal,
  RiskDecision,
  ExecutionResult,
  NormalizedTick,
  AssetClass,
} from '../types';

describe('Alphanix Types', () => {
  it('should create a valid TradeProposal', () => {
    const proposal: TradeProposal = {
      id: 'tp-001',
      podId: 'crypto',
      symbol: 'BTC/USDC',
      adapter: 'binance',
      side: 'BUY',
      confidence: 78,
      sizing: { qty: 0.001, notional: 85 },
      reasoning: 'RSI oversold + volume spike',
      models: ['rsi', 'volume'],
      signals: ['rsi_oversold', 'volume_spike_up'],
      timestamp: Date.now(),
    };
    expect(proposal.confidence).toBeGreaterThanOrEqual(0);
    expect(proposal.confidence).toBeLessThanOrEqual(100);
    expect(proposal.side).toMatch(/^(BUY|SELL)$/);
  });

  it('should create a valid RiskDecision', () => {
    const decision: RiskDecision = {
      proposalId: 'tp-001',
      action: 'approve',
      riskMetrics: { var: 0.02, exposure: 500, drawdown: 1.2 },
    };
    expect(decision.action).toMatch(/^(approve|veto|reduce)$/);
  });

  it('should create a valid RiskDecision with veto', () => {
    const veto: RiskDecision = {
      proposalId: 'tp-002',
      action: 'veto',
      vetoReason: 'daily_loss_limit',
      riskMetrics: { var: 0.05, exposure: 2000, drawdown: 4.8 },
    };
    expect(veto.vetoReason).toBeDefined();
  });

  it('should create a valid ExecutionResult', () => {
    const result: ExecutionResult = {
      proposalId: 'tp-001',
      orderId: 'ord-abc123',
      adapter: 'binance',
      fillPrice: 84500,
      fillQty: 0.001,
      slippage: 0.02,
      fees: 0.08,
      timestamp: Date.now(),
    };
    expect(result.slippage).toBeGreaterThanOrEqual(0);
  });

  it('should create a valid NormalizedTick', () => {
    const tick: NormalizedTick = {
      timestamp: Date.now(),
      adapterId: 'binance',
      symbol: 'BTC/USDC',
      bid: 84500,
      ask: 84510,
      last: 84505,
      volume24h: 1200000,
      assetClass: 'crypto',
    };
    expect(tick.ask).toBeGreaterThanOrEqual(tick.bid);
  });
});
