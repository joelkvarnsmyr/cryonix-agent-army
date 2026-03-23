// packages/agents/src/alphanix/pod/risk-agent.ts

import type { TradeProposal, RiskDecision } from '../types';

export interface RiskConfig {
  maxDrawdownPct: number;
  maxPositions: number;
  minConfidence: number;
}

export interface PortfolioContext {
  openPositions: number;
  currentDrawdownPct: number;
}

export interface RiskState {
  canTrade: boolean;
  dailyPnl: number;
  consecutiveLosses: number;
  tradesToday: number;
}

export class RiskAgent {
  private podId: string;
  private config: RiskConfig;
  private dailyPnl = 0;
  private consecutiveLosses = 0;
  private tradesToday = 0;

  constructor(podId: string, config: RiskConfig) {
    this.podId = podId;
    this.config = config;
  }

  evaluate(proposal: TradeProposal, ctx: PortfolioContext): RiskDecision {
    // Veto: confidence below minimum
    if (proposal.confidence < this.config.minConfidence) {
      return this.veto(proposal.id, ctx, `Confidence ${proposal.confidence} below minimum ${this.config.minConfidence}`);
    }

    // Veto: max positions reached
    if (ctx.openPositions >= this.config.maxPositions) {
      return this.veto(proposal.id, ctx, `Open positions ${ctx.openPositions} >= max ${this.config.maxPositions}`);
    }

    // Veto: drawdown exceeds limit
    if (ctx.currentDrawdownPct >= this.config.maxDrawdownPct) {
      return this.veto(proposal.id, ctx, `Drawdown ${ctx.currentDrawdownPct}% >= max ${this.config.maxDrawdownPct}%`);
    }

    // Approve
    return {
      proposalId: proposal.id,
      action: 'approve',
      adjustedSizing: proposal.sizing,
      riskMetrics: {
        var: 0,
        exposure: proposal.sizing.notional,
        drawdown: ctx.currentDrawdownPct,
      },
    };
  }

  recordExit(pnlDollar: number): void {
    this.dailyPnl += pnlDollar;
    this.tradesToday += 1;

    if (pnlDollar < 0) {
      this.consecutiveLosses += 1;
    } else {
      this.consecutiveLosses = 0;
    }
  }

  resetDaily(): void {
    this.dailyPnl = 0;
    this.tradesToday = 0;
    this.consecutiveLosses = 0;
  }

  getState(): RiskState {
    return {
      canTrade: this.consecutiveLosses < 3 && this.tradesToday < 20,
      dailyPnl: this.dailyPnl,
      consecutiveLosses: this.consecutiveLosses,
      tradesToday: this.tradesToday,
    };
  }

  private veto(proposalId: string, ctx: PortfolioContext, reason: string): RiskDecision {
    return {
      proposalId,
      action: 'veto',
      vetoReason: reason,
      riskMetrics: {
        var: 0,
        exposure: 0,
        drawdown: ctx.currentDrawdownPct,
      },
    };
  }
}
