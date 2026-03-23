import type { TradeProposal, RiskDecision, ExecutionResult } from '../types';
import type { MarketAdapter } from '../adapters/types';

const MAX_SPREAD_PCT = 0.003; // 0.3%

export class ExecutionAgent {
  private podId: string;

  constructor(podId: string) {
    this.podId = podId;
  }

  async execute(
    proposal: TradeProposal,
    decision: RiskDecision,
    adapter: MarketAdapter,
  ): Promise<ExecutionResult> {
    const emptyResult: ExecutionResult = {
      proposalId: proposal.id,
      orderId: '',
      adapter: proposal.adapter,
      fillPrice: 0,
      fillQty: 0,
      slippage: 0,
      fees: 0,
      timestamp: Date.now(),
    };

    if (decision.action !== 'approve') return emptyResult;

    // Spread check
    try {
      const book = await adapter.getOrderBook(proposal.symbol, 5);
      if (book.bids.length > 0 && book.asks.length > 0) {
        const bestBid = book.bids[0][0];
        const bestAsk = book.asks[0][0];
        const mid = (bestBid + bestAsk) / 2;
        const spreadPct = (bestAsk - bestBid) / mid;
        if (spreadPct > MAX_SPREAD_PCT) {
          console.warn(
            `[ExecutionAgent:${this.podId}] Spread too wide: ${(spreadPct * 100).toFixed(2)}%`,
          );
          return emptyResult;
        }
      }
    } catch {
      /* proceed without spread check */
    }

    const sizing = decision.adjustedSizing || proposal.sizing;
    const result = await adapter.submitOrder({
      symbol: proposal.symbol,
      side: proposal.side,
      type: 'MARKET',
      qty: sizing.qty,
    });

    return {
      proposalId: proposal.id,
      orderId: result.orderId || '',
      adapter: proposal.adapter,
      fillPrice: result.filledAvgPrice || 0,
      fillQty: result.filledQty || 0,
      slippage: 0,
      fees: (result.filledAvgPrice || 0) * (result.filledQty || 0) * 0.001,
      timestamp: Date.now(),
    };
  }
}
