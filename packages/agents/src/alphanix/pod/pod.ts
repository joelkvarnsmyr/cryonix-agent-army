// packages/agents/src/alphanix/pod/pod.ts

import type { PodConfig, PodState, TradeProposal } from '../types.js';
import type { MarketAdapter } from '../adapters/types.js';
import { QuantAgent } from './quant-agent.js';
import { RiskAgent } from './risk-agent.js';
import { ExecutionAgent } from './execution-agent.js';
import { ExitMonitor, type ExitConfig } from './exit-monitor.js';
import { PositionTracker } from './position-tracker.js';

export interface CycleResult {
  scannedSymbols: number;
  proposalsGenerated: number;
  approved: number;
  vetoed: number;
  executed: number;
  exited: number;
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
  private exitMonitor: ExitMonitor;
  private positionTracker: PositionTracker;
  private positions = new Map<string, any>();

  constructor(config: PodConfig, adapter: MarketAdapter, capitalBudget: number) {
    this.config = config;
    this.adapter = adapter;
    this.capitalBudget = capitalBudget;
    this.quant = new QuantAgent(config.id, ['rsi', 'volume']);
    this.risk = new RiskAgent(config.id, {
      maxDrawdownPct: config.riskMaxDrawdownPct,
      maxPositions: config.riskMaxPositions,
      minConfidence: 25,
    });
    this.execution = new ExecutionAgent(config.id);
    this.exitMonitor = new ExitMonitor({
      takeProfitPct: 5.0,
      stopLossPct: 3.0,
      trailingStopActivation: 2.0,
      trailingStopDistance: 1.0,
      stagnationHours: 48,
    });
    this.positionTracker = new PositionTracker();
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

  /** Get adapter-appropriate timeframe string */
  private getTimeframe(): string {
    // Alpaca uses '15Min', '1Hour', '1Day'; Binance/CCXT uses '15m', '1h', '1d'
    const assetClass = this.adapter.assetClass;
    if (assetClass === 'stock') return '15Min';
    return '15m';
  }

  async runCycle(): Promise<CycleResult> {
    this.state = 'running';
    const result: CycleResult = {
      scannedSymbols: 0,
      proposalsGenerated: 0,
      approved: 0,
      vetoed: 0,
      executed: 0,
      exited: 0,
      errors: [],
    };

    for (const symbol of this.config.symbols) {
      result.scannedSymbols++;
      try {
        const candles = await this.adapter.getOHLCV(symbol, this.getTimeframe(), 30);
        if (candles.length === 0) continue;  // No data (market closed, etc.)

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
            console.log(`[Pod:${this.config.id}] VETO ${symbol}: ${decision.vetoReason} (conf=${sized.confidence}, signals=${sized.signals})`);
            continue;
          }

          if (decision.action === 'approve' || decision.action === 'reduce') {
            result.approved++;
            try {
              const execResult = await this.execution.execute(sized, decision, this.adapter);
              if (execResult.orderId) {
                result.executed++;
                this.positionTracker.open({
                  symbol,
                  qty: execResult.fillQty,
                  avgEntryPrice: execResult.fillPrice,
                  currentPrice: execResult.fillPrice,
                  marketValue: execResult.fillQty * execResult.fillPrice,
                  unrealizedPnl: 0,
                  unrealizedPnlPct: 0,
                  adapter: this.adapter.id,
                });
                this.exitMonitor.track(symbol, execResult.fillPrice);
                this.positions.set(symbol, {
                  orderId: execResult.orderId,
                  entryPrice: execResult.fillPrice,
                  qty: execResult.fillQty,
                });
              } else {
                result.errors.push(`Order not filled for ${symbol} (adapter returned empty orderId)`);
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

    // Check exits for tracked positions
    for (const sym of this.exitMonitor.getTrackedSymbols()) {
      try {
        const candles = await this.adapter.getOHLCV(sym, this.getTimeframe(), 5);
        if (candles.length === 0) continue;
        const currentPrice = candles[candles.length - 1].close;
        this.positionTracker.update(this.adapter.id, sym, currentPrice);

        const exitSignal = this.exitMonitor.check(sym, currentPrice);
        if (exitSignal) {
          try {
            const exitResult = await this.adapter.submitOrder({
              symbol: sym,
              side: 'SELL',
              type: 'MARKET',
              qty: this.positions.get(sym)?.qty || 0,
            });
            if (exitResult.success) {
              const pos = this.positions.get(sym);
              const pnlDollar = pos ? (currentPrice - pos.entryPrice) * pos.qty : 0;
              this.risk.recordExit(pnlDollar);
              this.positionTracker.close(this.adapter.id, sym);
              this.exitMonitor.untrack(sym);
              this.positions.delete(sym);
              result.exited++;
              console.log(`[Pod:${this.config.id}] EXIT ${sym}: ${exitSignal.reason} (${exitSignal.pnlPct.toFixed(2)}%)`);
            }
          } catch (err: any) {
            result.errors.push(`Exit failed for ${sym}: ${err.message}`);
          }
        }
      } catch { /* skip failed exit check */ }
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

  getPositions() {
    return this.positionTracker.getAll();
  }

  getRiskState() {
    return this.risk.getState();
  }

  async stop(): Promise<void> {
    this.state = 'stopped';
  }
}
