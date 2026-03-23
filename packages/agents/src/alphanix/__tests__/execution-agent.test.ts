import { describe, it, expect } from 'vitest';
import { ExecutionAgent } from '../pod/execution-agent';
import type { TradeProposal, RiskDecision, OrderBook } from '../types';
import type { MarketAdapter } from '../adapters/types';

const makeProposal = (overrides: Partial<TradeProposal> = {}): TradeProposal => ({
  id: 'tp-001',
  podId: 'crypto',
  symbol: 'BTC/USDC',
  adapter: 'binance',
  side: 'BUY',
  confidence: 80,
  sizing: { qty: 0.001, notional: 85 },
  reasoning: 'test signal',
  models: ['rsi'],
  signals: ['rsi_oversold'],
  timestamp: Date.now(),
  ...overrides,
});

const makeDecision = (overrides: Partial<RiskDecision> = {}): RiskDecision => ({
  proposalId: 'tp-001',
  action: 'approve',
  adjustedSizing: { qty: 0.001, notional: 85 },
  riskMetrics: { var: 0.02, exposure: 0.1, drawdown: 0.5 },
  ...overrides,
});

function createMockAdapter(orderBook?: OrderBook): Partial<MarketAdapter> {
  const defaultBook: OrderBook = {
    bids: [[84950, 1.5]],
    asks: [[84970, 1.2]],
    timestamp: Date.now(),
  };
  return {
    getOrderBook: async () => orderBook ?? defaultBook,
    submitOrder: async () => ({
      success: true,
      orderId: 'ord-123',
      status: 'FILLED',
      filledQty: 0.001,
      filledAvgPrice: 84960,
    }),
  };
}

describe('ExecutionAgent', () => {
  const agent = new ExecutionAgent('crypto');

  it('should execute an approved proposal', async () => {
    const adapter = createMockAdapter() as MarketAdapter;
    const result = await agent.execute(makeProposal(), makeDecision(), adapter);

    expect(result.orderId).toBe('ord-123');
    expect(result.fillPrice).toBe(84960);
    expect(result.fillQty).toBe(0.001);
    expect(result.proposalId).toBe('tp-001');
    expect(result.adapter).toBe('binance');
    expect(result.fees).toBeCloseTo(84960 * 0.001 * 0.001, 4);
  });

  it('should reject wide spread', async () => {
    const wideBook: OrderBook = {
      bids: [[80000, 1.0]],
      asks: [[85000, 1.0]],
      timestamp: Date.now(),
    };
    const adapter = createMockAdapter(wideBook) as MarketAdapter;
    const result = await agent.execute(makeProposal(), makeDecision(), adapter);

    expect(result.orderId).toBe('');
    expect(result.fillPrice).toBe(0);
    expect(result.fillQty).toBe(0);
  });

  it('should return empty result for vetoed decision', async () => {
    const adapter = createMockAdapter() as MarketAdapter;
    const decision = makeDecision({
      action: 'veto',
      vetoReason: 'Confidence too low',
    });
    const result = await agent.execute(makeProposal(), decision, adapter);

    expect(result.orderId).toBe('');
    expect(result.fillPrice).toBe(0);
    expect(result.fillQty).toBe(0);
    expect(result.proposalId).toBe('tp-001');
  });
});
