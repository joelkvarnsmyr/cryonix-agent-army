// packages/agents/src/alphanix/pod/pod.ts

import type { PodConfig, PodState, TradeProposal } from '../types.js';
import type { MarketAdapter } from '../adapters/types.js';
import { QuantAgent } from './quant-agent.js';
import { RiskAgent } from './risk-agent.js';
import { ExecutionAgent } from './execution-agent.js';

export interface CycleResult {
  scannedSymbols: number;
  proposalsGenerated: number;
  approved: number;
  vetoed: number;
  executed: number;
  errors: string[];
}

export class Pod {
  private config: PodConfig;
  private adapter: MarketAdapter;
  private capitalBudget: number;
  private state: PodState = 'starting';
  private quant: QuantAgent;
  private risk: RiskAgent;
  private execution: ExecutionAgent;
  private positions = new Map<string, any>();

  constructor(config: PodConfig, adapter: MarketAdapter, capitalBudget: number) {
    this.config = config;
    this.adapter = adapter;
    this.capitalBudget = capitalBudget;
    this.quant = new QuantAgent(config.id, ['rsi', 'volume']);
    this.risk = new RiskAgent(config.id, {
      maxDrawdownPct: config.riskMaxDrawdownPct,
      maxPositions: config.riskMaxPositions,
      minConfidence: 60,
    });
    this.execution = new ExecutionAgent(config.id);
  }

  getId(): string {
    return this.config.id;
  }

  getState(): PodState {
    return this.state;
  }

  getCapitalBudget(): number {
    return this.capitalBudget;
  }

  updateCapitalBudget(amount: number): void {
    this.capitalBudget = amount;
  }

  async runCycle(): Promise<CycleResult> {
    this.state = 'running';
    const result: CycleResult = {
      scannedSymbols: 0,
      proposalsGenerated: 0,
      approved: 0,
      vetoed: 0,
      executed: 0,
      errors: [],
    };

    for (const symbol of this.config.symbols) {
      result.scannedSymbols++;
      try {
        const candles = await this.adapter.getOHLCV(symbol, '15m', 30);
        const proposals = this.quant.analyze(symbol, this.adapter.id, candles);
        result.proposalsGenerated += proposals.length;

        const lastPrice = candles[candles.length - 1].close;

        for (const proposal of proposals) {
          const sized = this.sizeOrder(proposal, lastPrice);
          const decision = this.risk.evaluate(sized, {
            openPositions: this.positions.size,
            currentDrawdownPct: this.computeDrawdownPct(),
          });

          if (decision.action === 'veto') {
            result.vetoed++;
            continue;
          }

          if (decision.action === 'approve' || decision.action === 'reduce') {
            result.approved++;
            try {
              const execResult = await this.execution.execute(sized, decision, this.adapter);
              if (execResult.orderId) {
                result.executed++;
                this.positions.set(symbol, {
                  orderId: execResult.orderId,
                  entryPrice: execResult.fillPrice,
                  qty: execResult.fillQty,
                });
              }
            } catch (err: any) {
              result.errors.push(`Execution failed for ${symbol}: ${err.message}`);
            }
          }
        }
      } catch (err: any) {
        result.errors.push(`Scan failed for ${symbol}: ${err.message}`);
      }
    }
    return result;
  }

  private sizeOrder(proposal: TradeProposal, lastPrice: number): TradeProposal {
    const maxPerTrade = this.capitalBudget * 0.1;
    const notional = Math.min(maxPerTrade, this.capitalBudget * 0.2);
    const qty = lastPrice > 0 ? notional / lastPrice : 0;
    return {
      ...proposal,
      sizing: { notional, qty },
    };
  }

  private computeDrawdownPct(): number {
    if (this.positions.size === 0) return 0;
    let totalPnl = 0;
    for (const [, pos] of this.positions) {
      if (pos.entryPrice && pos.currentPrice) {
        totalPnl += ((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
      }
    }
    return totalPnl < 0 ? Math.abs(totalPnl) : 0;
  }

  async stop(): Promise<void> {
    this.state = 'stopped';
  }
}
