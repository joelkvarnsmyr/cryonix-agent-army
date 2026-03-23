import type { Candle, TradeProposal } from '../types.js';
import { QuantAgent } from '../pod/quant-agent.js';

export interface BacktestConfig {
  symbol: string;
  adapter: string;
  candles: Candle[];
  initialCapital: number;
  models: string[];
  riskConfig: { maxDrawdownPct: number; maxPositions: number; minConfidence: number };
  takeProfitPct: number;
  stopLossPct: number;
}

export interface BacktestTrade {
  entryIndex: number;
  exitIndex: number;
  entryPrice: number;
  exitPrice: number;
  side: 'BUY' | 'SELL';
  pnlPct: number;
  pnlDollar: number;
  exitReason: 'take_profit' | 'stop_loss' | 'end_of_data';
  confidence: number;
  signals: string[];
}

export interface BacktestResult {
  symbol: string;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  totalPnlPct: number;
  totalPnlDollar: number;
  maxDrawdownPct: number;
  sharpeRatio: number;
  avgHoldingBars: number;
  trades: BacktestTrade[];
  candlesAnalyzed: number;
  models: string[];
}

export class Backtester {
  run(config: BacktestConfig): BacktestResult {
    const quant = new QuantAgent('backtest', config.models);
    const trades: BacktestTrade[] = [];
    let capital = config.initialCapital;
    let maxCapital = capital;
    let maxDrawdown = 0;
    const returns: number[] = [];

    let i = 14; // Need minimum candles for indicators
    while (i < config.candles.length) {
      const slice = config.candles.slice(0, i + 1);
      const proposals = quant.analyze(config.symbol, config.adapter, slice);

      if (proposals.length === 0) {
        i++;
        continue;
      }

      const proposal = proposals[0]; // Take first signal
      const entryPrice = config.candles[i].close;
      const positionSize = capital * 0.1; // 10% per trade
      const qty = positionSize / entryPrice;

      // Simulate forward to find exit
      let exitIndex = i + 1;
      let exitPrice = entryPrice;
      let exitReason: BacktestTrade['exitReason'] = 'end_of_data';

      while (exitIndex < config.candles.length) {
        const currentPrice = config.candles[exitIndex].close;
        const pnlPct = ((currentPrice - entryPrice) / entryPrice) * 100;

        if (pnlPct >= config.takeProfitPct) {
          exitPrice = currentPrice;
          exitReason = 'take_profit';
          break;
        }
        if (pnlPct <= -config.stopLossPct) {
          exitPrice = currentPrice;
          exitReason = 'stop_loss';
          break;
        }
        exitIndex++;
      }

      if (exitReason === 'end_of_data') {
        exitPrice = config.candles[config.candles.length - 1].close;
        exitIndex = config.candles.length - 1;
      }

      const pnlPct = ((exitPrice - entryPrice) / entryPrice) * 100;
      const pnlDollar = qty * (exitPrice - entryPrice);
      capital += pnlDollar;
      returns.push(pnlPct);

      if (capital > maxCapital) maxCapital = capital;
      const dd = ((maxCapital - capital) / maxCapital) * 100;
      if (dd > maxDrawdown) maxDrawdown = dd;

      trades.push({
        entryIndex: i,
        exitIndex,
        entryPrice,
        exitPrice,
        side: proposal.side,
        pnlPct,
        pnlDollar,
        exitReason,
        confidence: proposal.confidence,
        signals: proposal.signals,
      });

      i = exitIndex + 1; // Skip to after exit
    }

    const wins = trades.filter((t) => t.pnlPct > 0).length;
    const avgReturn =
      returns.length > 0 ? returns.reduce((s, r) => s + r, 0) / returns.length : 0;
    const stdReturn =
      returns.length > 1
        ? Math.sqrt(returns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / (returns.length - 1))
        : 1;
    const sharpe = stdReturn > 0 ? (avgReturn / stdReturn) * Math.sqrt(252) : 0; // Annualized

    return {
      symbol: config.symbol,
      totalTrades: trades.length,
      winningTrades: wins,
      losingTrades: trades.length - wins,
      winRate: trades.length > 0 ? (wins / trades.length) * 100 : 0,
      totalPnlPct:
        capital > 0 ? ((capital - config.initialCapital) / config.initialCapital) * 100 : 0,
      totalPnlDollar: capital - config.initialCapital,
      maxDrawdownPct: maxDrawdown,
      sharpeRatio: sharpe,
      avgHoldingBars:
        trades.length > 0
          ? trades.reduce((s, t) => s + (t.exitIndex - t.entryIndex), 0) / trades.length
          : 0,
      trades,
      candlesAnalyzed: config.candles.length,
      models: config.models,
    };
  }
}
