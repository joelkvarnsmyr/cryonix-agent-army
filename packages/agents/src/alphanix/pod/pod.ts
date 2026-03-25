// packages/agents/src/alphanix/pod/pod.ts

import type { PodConfig, PodState, TradeProposal } from '../types.js';
import type { MarketAdapter } from '../adapters/types.js';
import type { AlphanixDB } from '../data/postgres.js';
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
  private db: AlphanixDB | null;

  constructor(config: PodConfig, adapter: MarketAdapter, capitalBudget: number, db?: AlphanixDB | null) {
    this.config = config;
    this.adapter = adapter;
    this.capitalBudget = capitalBudget;
    this.db = db ?? null;
    this.quant = new QuantAgent(config.id, this.getModelsForStrategy(config.strategy));
    this.risk = new RiskAgent(config.id, {
      maxDrawdownPct: config.riskMaxDrawdownPct,
      maxPositions: config.riskMaxPositions,
      minConfidence: 25,
    });
    this.execution = new ExecutionAgent(config.id);
    this.exitMonitor = new ExitMonitor(this.getExitConfig(adapter, config.id));
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

  /** Check if the market for this pod's asset class is currently open */
  private isMarketOpen(): boolean {
    const assetClass = this.adapter.assetClass;
    if (assetClass === 'crypto') return true; // 24/7

    const now = new Date();
    const day = now.getUTCDay();
    if (day === 0 || day === 6) return false; // Weekend

    const utcHour = now.getUTCHours() + now.getUTCMinutes() / 60;
    if (assetClass === 'stock') {
      // Check adapter ID for market detection
      const id = this.adapter.id.toLowerCase();
      if (id.includes('ibkr') || id.includes('nordic') || id.includes('eu')) {
        return utcHour >= 7.0 && utcHour < 15.5; // EU: 08:00-16:30 CET
      }
      return utcHour >= 14.5 && utcHour < 21.0; // US: 09:30-16:00 ET
    }
    return true;
  }

  async runCycle(): Promise<CycleResult> {
    const result: CycleResult = {
      scannedSymbols: 0,
      proposalsGenerated: 0,
      approved: 0,
      vetoed: 0,
      executed: 0,
      exited: 0,
      errors: [],
    };

    // Kill-switch paused: skip all new entries (exits still monitored by orchestrator)
    if (this.state === 'paused') {
      return result;
    }

    this.state = 'running';

    // Skip scanning if market is closed — prevents stale data trading
    if (!this.isMarketOpen()) {
      this.state = 'idle';
      return result;
    }

    for (const symbol of this.config.symbols) {
      result.scannedSymbols++;

      // Skip symbols we already hold a position in
      if (this.positions.has(symbol)) continue;

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
            // Log vetoed signal to Postgres
            await this.db?.logSignal({
              podId: this.config.id, symbol, adapter: this.adapter.id,
              side: sized.side, confidence: sized.confidence,
              signals: sized.signals, models: sized.models,
              reasoning: sized.reasoning,
              riskAction: 'veto', riskReason: decision.vetoReason,
              proposalId: sized.id,
            });
            continue;
          }

          if (decision.action === 'approve' || decision.action === 'reduce') {
            result.approved++;
            try {
              const execResult = await this.execution.execute(sized, decision, this.adapter);
              if (execResult.orderId) {
                result.executed++;

                // Guard: reject tracking positions with $0 entry price (would break PnL calc)
                if (execResult.fillPrice <= 0) {
                  console.error(`[Pod:${this.config.id}] BUG: fillPrice=${execResult.fillPrice} for ${symbol} (orderId=${execResult.orderId}) — skipping position tracking`);
                  result.errors.push(`fillPrice=0 for ${symbol}, position not tracked`);
                  continue;
                }

                console.log(`[Pod:${this.config.id}] OPEN ${symbol}: qty=${execResult.fillQty} avgEntryPrice=$${execResult.fillPrice} adapter=${this.adapter.id}`);

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
                  enteredAt: Date.now(),
                });
                // Count the trade in risk tracking
                this.risk.recordTrade();
                // Log approved signal
                await this.db?.logSignal({
                  podId: this.config.id, symbol, adapter: this.adapter.id,
                  side: sized.side, confidence: sized.confidence,
                  signals: sized.signals, models: sized.models,
                  reasoning: sized.reasoning,
                  riskAction: decision.action,
                  proposalId: sized.id,
                });
                // Log executed trade
                await this.db?.logTrade({
                  podId: this.config.id, symbol, adapter: this.adapter.id,
                  side: sized.side, qty: execResult.fillQty,
                  fillPrice: execResult.fillPrice,
                  notional: execResult.fillQty * execResult.fillPrice,
                  slippage: execResult.slippage, fees: execResult.fees,
                  confidence: sized.confidence, reasoning: sized.reasoning,
                  signals: sized.signals, models: sized.models,
                  orderId: execResult.orderId, proposalId: sized.id,
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
          // Enforce minimum holding time (skip TP/trailing exits if < 5 minutes old)
          const pos = this.positions.get(sym);
          const holdingMs = pos?.enteredAt ? Date.now() - pos.enteredAt : Infinity;
          if (holdingMs < 5 * 60 * 1000 && exitSignal.reason !== 'stop_loss') {
            continue;  // Too soon for non-SL exits
          }
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
              // Log sell trade to Postgres
              if (pos) {
                await this.db?.logTrade({
                  podId: this.config.id, symbol: sym, adapter: this.adapter.id,
                  side: 'SELL', qty: pos.qty, fillPrice: currentPrice,
                  notional: pos.qty * currentPrice, slippage: 0, fees: 0,
                  confidence: 0, reasoning: `exit: ${exitSignal.reason} (${exitSignal.pnlPct.toFixed(2)}%)`,
                  signals: [exitSignal.reason], models: [],
                  orderId: exitResult.orderId ?? `exit-${Date.now()}`,
                  proposalId: pos.orderId,
                });
              }
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

  getSymbols(): string[] {
    return this.config.symbols;
  }

  getQuant(): QuantAgent {
    return this.quant;
  }

  setSentimentBoost(score: number): void {
    this.quant.setSentimentBoost(score);
  }

  setMacroBoost(boost: number): void {
    this.quant.setMacroBoost(boost);
  }

  getAdapterType(): string {
    return this.config.adapter;
  }

  private getModelsForStrategy(strategy: string): string[] {
    const strategies: Record<string, string[]> = {
      'momentum': ['rsi', 'macd', 'ema', 'volume'],
      'dip_hunter': ['rsi', 'bollinger', 'deep_value', 'dip', 'volume'],
      'tech_momentum': ['macd', 'ema', 'volume', 'rsi'],
      'defense_value': ['rsi', 'bollinger', 'deep_value', 'dip'],
      'energy_momentum': ['macd', 'ema', 'volume', 'rsi'],
      'healthcare_value': ['rsi', 'bollinger', 'deep_value'],
      'finance_momentum': ['macd', 'ema', 'rsi', 'volume'],
      'nordic_value': ['rsi', 'bollinger', 'deep_value', 'dip'],
      'nordic_growth': ['macd', 'ema', 'volume'],
      'altcoin_momentum': ['rsi', 'macd', 'volume', 'ema', 'dip'],
      'value_momentum': ['rsi', 'macd', 'bollinger', 'volume'],
    };
    return strategies[strategy] || ['rsi', 'volume', 'macd', 'bollinger', 'ema', 'deep_value', 'dip'];
  }

  /** Asset-class-aware exit thresholds.
   *  Nordic large-caps (2-5% daily vol) need wider SL/TP than crypto. */
  private getExitConfig(adapter: MarketAdapter, podId: string): ExitConfig {
    const id = podId.toLowerCase();
    const isNordic = id.includes('nordic') || adapter.id.toLowerCase().includes('ibkr');
    const isUsStock = adapter.assetClass === 'stock' && !isNordic;

    if (isNordic) {
      return {
        takeProfitPct: 8.0,
        stopLossPct: 5.0,
        trailingStopActivation: 4.0,
        trailingStopDistance: 3.0,
        stagnationHours: 120,
      };
    }
    if (isUsStock) {
      return {
        takeProfitPct: 6.0,
        stopLossPct: 4.0,
        trailingStopActivation: 3.0,
        trailingStopDistance: 2.0,
        stagnationHours: 72,
      };
    }
    // Crypto (default)
    return {
      takeProfitPct: 5.0,
      stopLossPct: 3.0,
      trailingStopActivation: 2.0,
      trailingStopDistance: 1.0,
      stagnationHours: 48,
    };
  }

  pause(): void {
    this.state = 'paused';
    console.log(`[Pod:${this.config.id}] PAUSED — no new trades`);
  }

  resume(): void {
    this.state = 'running';
    console.log(`[Pod:${this.config.id}] RESUMED`);
  }

  reduceExposure(factor: number): void {
    this.capitalBudget = Math.round(this.capitalBudget * factor);
    console.log(`[Pod:${this.config.id}] Exposure reduced by ${(1 - factor) * 100}%, new budget=$${this.capitalBudget}`);
  }

  restoreExposure(originalBudget: number): void {
    this.capitalBudget = originalBudget;
    console.log(`[Pod:${this.config.id}] Exposure restored to $${this.capitalBudget}`);
  }

  async stop(): Promise<void> {
    this.state = 'stopped';
  }
}
