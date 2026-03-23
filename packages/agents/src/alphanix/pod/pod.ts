// packages/agents/src/alphanix/pod/pod.ts

import type { PodConfig, PodState, TradeProposal } from '../types.js';
import type { MarketAdapter } from '../adapters/types.js';
import { QuantAgent } from './quant-agent.js';
import { RiskAgent } from './risk-agent.js';

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

        for (const proposal of proposals) {
          const sized = this.sizeOrder(proposal);
          const decision = this.risk.evaluate(sized, {
            openPositions: this.positions.size,
            currentDrawdownPct: 0,
          });

          if (decision.action === 'veto') {
            result.vetoed++;
            continue;
          }

          if (decision.action === 'approve') {
            result.approved++;
            try {
              const orderResult = await this.adapter.submitOrder({
                symbol: sized.symbol,
                side: sized.side,
                type: 'MARKET',
                qty: sized.sizing.qty,
              });
              if (orderResult.success) {
                result.executed++;
                this.positions.set(symbol, {
                  ...orderResult,
                  entryPrice: orderResult.filledAvgPrice,
                  qty: orderResult.filledQty,
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

  private sizeOrder(proposal: TradeProposal): TradeProposal {
    const maxPerTrade = this.capitalBudget * 0.1;
    return {
      ...proposal,
      sizing: { notional: Math.min(maxPerTrade, this.capitalBudget * 0.2), qty: 0 },
    };
  }

  async stop(): Promise<void> {
    this.state = 'stopped';
  }
}
