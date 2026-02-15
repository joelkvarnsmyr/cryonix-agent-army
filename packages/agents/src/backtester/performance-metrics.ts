import type {
  BacktestTrade,
  EquityPoint,
  PerformanceMetrics,
  PatternPerformance,
  MonthlyReturn,
} from './types';

/**
 * Calculate comprehensive performance metrics from backtest results
 */
export function calculatePerformanceMetrics(
  trades: BacktestTrade[],
  equityCurve: EquityPoint[],
  initialCapital: number,
  tradingDays: number
): PerformanceMetrics {
  if (trades.length === 0) {
    return createEmptyMetrics(initialCapital, equityCurve, tradingDays);
  }

  // Separate winning and losing trades
  const winningTrades = trades.filter((t) => t.pnl > 0);
  const losingTrades = trades.filter((t) => t.pnl <= 0);

  // Calculate returns
  const finalEquity = equityCurve.length > 0 ? equityCurve[equityCurve.length - 1].equity : initialCapital;
  const totalReturn = finalEquity - initialCapital;
  const totalReturnPercent = (totalReturn / initialCapital) * 100;
  const annualizedReturn = calculateAnnualizedReturn(totalReturnPercent, tradingDays);

  // Calculate daily returns for Sharpe/Sortino
  const dailyReturns = calculateDailyReturns(equityCurve);
  const sharpeRatio = calculateSharpeRatio(dailyReturns);
  const sortinoRatio = calculateSortinoRatio(dailyReturns);

  // Calculate drawdown metrics
  const { maxDrawdown, maxDrawdownPercent, maxDrawdownDuration, currentDrawdown } =
    calculateDrawdownMetrics(equityCurve, initialCapital);

  const calmarRatio = maxDrawdownPercent !== 0 ? annualizedReturn / Math.abs(maxDrawdownPercent) : 0;

  // Trade statistics
  const winRate = trades.length > 0 ? (winningTrades.length / trades.length) * 100 : 0;

  // Profit metrics
  const averageWin = winningTrades.length > 0
    ? winningTrades.reduce((sum, t) => sum + t.pnl, 0) / winningTrades.length
    : 0;
  const averageLoss = losingTrades.length > 0
    ? Math.abs(losingTrades.reduce((sum, t) => sum + t.pnl, 0) / losingTrades.length)
    : 0;

  const largestWin = winningTrades.length > 0
    ? Math.max(...winningTrades.map((t) => t.pnl))
    : 0;
  const largestLoss = losingTrades.length > 0
    ? Math.abs(Math.min(...losingTrades.map((t) => t.pnl)))
    : 0;

  const grossProfit = winningTrades.reduce((sum, t) => sum + t.pnl, 0);
  const grossLoss = Math.abs(losingTrades.reduce((sum, t) => sum + t.pnl, 0));
  const profitFactor = grossLoss !== 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  // Expectancy = (Win% × Average Win) - (Loss% × Average Loss)
  const expectancy = (winRate / 100) * averageWin - ((100 - winRate) / 100) * averageLoss;

  // Risk metrics
  const averageRiskRewardRatio = averageLoss !== 0 ? averageWin / averageLoss : 0;
  const { maxConsecutiveWins, maxConsecutiveLosses } = calculateConsecutiveStats(trades);

  // Time metrics
  const averageHoldingPeriod = trades.length > 0
    ? trades.reduce((sum, t) => sum + t.holdingPeriodCandles, 0) / trades.length
    : 0;

  // Pattern breakdown
  const patternPerformance = calculatePatternPerformance(trades, totalReturn);

  // Monthly returns
  const monthlyReturns = calculateMonthlyReturns(trades);

  return {
    totalReturn,
    totalReturnPercent,
    annualizedReturn,
    sharpeRatio,
    sortinoRatio,
    calmarRatio,
    maxDrawdown,
    maxDrawdownPercent,
    maxDrawdownDuration,
    currentDrawdown,
    totalTrades: trades.length,
    winningTrades: winningTrades.length,
    losingTrades: losingTrades.length,
    winRate,
    averageWin,
    averageLoss,
    largestWin,
    largestLoss,
    profitFactor,
    expectancy,
    averageRiskRewardRatio,
    maxConsecutiveWins,
    maxConsecutiveLosses,
    averageHoldingPeriod,
    tradingDays,
    patternPerformance,
    monthlyReturns,
    equityCurve,
  };
}

/**
 * Calculate annualized return from period return
 */
function calculateAnnualizedReturn(periodReturnPercent: number, days: number): number {
  if (days <= 0) return 0;
  const periodsPerYear = 365 / days;
  const totalReturn = 1 + periodReturnPercent / 100;
  return (Math.pow(totalReturn, periodsPerYear) - 1) * 100;
}

/**
 * Calculate daily returns from equity curve
 */
function calculateDailyReturns(equityCurve: EquityPoint[]): number[] {
  if (equityCurve.length < 2) return [];

  const dailyReturns: number[] = [];
  let lastDate: string | null = null;
  let dayStartEquity = equityCurve[0].equity;

  for (const point of equityCurve) {
    const dateStr = point.timestamp.toISOString().split('T')[0];

    if (lastDate !== null && dateStr !== lastDate) {
      // New day - calculate previous day's return
      const previousDayEndEquity = equityCurve
        .filter((p) => p.timestamp.toISOString().split('T')[0] === lastDate)
        .pop()?.equity ?? dayStartEquity;

      const dailyReturn = ((previousDayEndEquity - dayStartEquity) / dayStartEquity) * 100;
      dailyReturns.push(dailyReturn);

      dayStartEquity = previousDayEndEquity;
    }

    lastDate = dateStr;
  }

  // Add final day's return
  if (equityCurve.length > 1) {
    const finalReturn = ((equityCurve[equityCurve.length - 1].equity - dayStartEquity) / dayStartEquity) * 100;
    dailyReturns.push(finalReturn);
  }

  return dailyReturns;
}

/**
 * Calculate Sharpe Ratio (assumes risk-free rate of 0)
 * Sharpe = Mean(Returns) / StdDev(Returns) × sqrt(252)
 */
function calculateSharpeRatio(dailyReturns: number[]): number {
  if (dailyReturns.length < 2) return 0;

  const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
  const variance = dailyReturns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / (dailyReturns.length - 1);
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) return mean > 0 ? Infinity : 0;

  // Annualize: multiply by sqrt(252) for daily data
  return (mean / stdDev) * Math.sqrt(252);
}

/**
 * Calculate Sortino Ratio (only penalizes downside volatility)
 * Sortino = Mean(Returns) / Downside StdDev × sqrt(252)
 */
function calculateSortinoRatio(dailyReturns: number[]): number {
  if (dailyReturns.length < 2) return 0;

  const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;

  // Only consider negative returns for downside deviation
  const negativeReturns = dailyReturns.filter((r) => r < 0);
  if (negativeReturns.length === 0) return mean > 0 ? Infinity : 0;

  const downsideVariance = negativeReturns.reduce((sum, r) => sum + Math.pow(r, 2), 0) / negativeReturns.length;
  const downsideStdDev = Math.sqrt(downsideVariance);

  if (downsideStdDev === 0) return mean > 0 ? Infinity : 0;

  return (mean / downsideStdDev) * Math.sqrt(252);
}

/**
 * Calculate drawdown metrics from equity curve
 */
function calculateDrawdownMetrics(
  equityCurve: EquityPoint[],
  initialCapital: number
): {
  maxDrawdown: number;
  maxDrawdownPercent: number;
  maxDrawdownDuration: number;
  currentDrawdown: number;
} {
  if (equityCurve.length === 0) {
    return { maxDrawdown: 0, maxDrawdownPercent: 0, maxDrawdownDuration: 0, currentDrawdown: 0 };
  }

  let peak = initialCapital;
  let maxDrawdown = 0;
  let maxDrawdownPercent = 0;

  // Track drawdown duration
  let currentDrawdownStart: Date | null = null;
  let maxDrawdownDuration = 0;

  for (const point of equityCurve) {
    if (point.equity > peak) {
      // New peak - reset drawdown tracking
      if (currentDrawdownStart !== null) {
        const duration = (point.timestamp.getTime() - currentDrawdownStart.getTime()) / (1000 * 60 * 60 * 24);
        maxDrawdownDuration = Math.max(maxDrawdownDuration, duration);
        currentDrawdownStart = null;
      }
      peak = point.equity;
    } else {
      // In drawdown
      if (currentDrawdownStart === null) {
        currentDrawdownStart = point.timestamp;
      }

      const drawdown = peak - point.equity;
      const drawdownPercent = (drawdown / peak) * 100;

      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
        maxDrawdownPercent = drawdownPercent;
      }
    }
  }

  // Check if still in drawdown at end
  const currentEquity = equityCurve[equityCurve.length - 1].equity;
  const currentDrawdown = currentEquity < peak ? ((peak - currentEquity) / peak) * 100 : 0;

  if (currentDrawdownStart !== null) {
    const duration =
      (equityCurve[equityCurve.length - 1].timestamp.getTime() - currentDrawdownStart.getTime()) /
      (1000 * 60 * 60 * 24);
    maxDrawdownDuration = Math.max(maxDrawdownDuration, duration);
  }

  return { maxDrawdown, maxDrawdownPercent, maxDrawdownDuration, currentDrawdown };
}

/**
 * Calculate max consecutive wins/losses
 */
function calculateConsecutiveStats(trades: BacktestTrade[]): {
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
} {
  let currentWins = 0;
  let currentLosses = 0;
  let maxConsecutiveWins = 0;
  let maxConsecutiveLosses = 0;

  for (const trade of trades) {
    if (trade.pnl > 0) {
      currentWins++;
      currentLosses = 0;
      maxConsecutiveWins = Math.max(maxConsecutiveWins, currentWins);
    } else {
      currentLosses++;
      currentWins = 0;
      maxConsecutiveLosses = Math.max(maxConsecutiveLosses, currentLosses);
    }
  }

  return { maxConsecutiveWins, maxConsecutiveLosses };
}

/**
 * Calculate performance breakdown by pattern type
 */
function calculatePatternPerformance(
  trades: BacktestTrade[],
  totalPnl: number
): Record<string, PatternPerformance> {
  const byPattern = new Map<string, BacktestTrade[]>();

  for (const trade of trades) {
    const pattern = trade.pattern;
    if (!byPattern.has(pattern)) {
      byPattern.set(pattern, []);
    }
    byPattern.get(pattern)!.push(trade);
  }

  const result: Record<string, PatternPerformance> = {};

  for (const [pattern, patternTrades] of byPattern) {
    const wins = patternTrades.filter((t) => t.pnl > 0);
    const patternPnl = patternTrades.reduce((sum, t) => sum + t.pnl, 0);
    const grossProfit = wins.reduce((sum, t) => sum + t.pnl, 0);
    const grossLoss = Math.abs(
      patternTrades.filter((t) => t.pnl <= 0).reduce((sum, t) => sum + t.pnl, 0)
    );

    result[pattern] = {
      pattern,
      trades: patternTrades.length,
      winRate: patternTrades.length > 0 ? (wins.length / patternTrades.length) * 100 : 0,
      averageReturn:
        patternTrades.length > 0
          ? patternTrades.reduce((sum, t) => sum + t.pnlPercent, 0) / patternTrades.length
          : 0,
      profitFactor: grossLoss !== 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
      contribution: totalPnl !== 0 ? (patternPnl / Math.abs(totalPnl)) * 100 : 0,
    };
  }

  return result;
}

/**
 * Calculate monthly returns
 */
function calculateMonthlyReturns(trades: BacktestTrade[]): MonthlyReturn[] {
  const byMonth = new Map<string, BacktestTrade[]>();

  for (const trade of trades) {
    const year = trade.exitTime.getFullYear();
    const month = trade.exitTime.getMonth() + 1;
    const key = `${year}-${month.toString().padStart(2, '0')}`;

    if (!byMonth.has(key)) {
      byMonth.set(key, []);
    }
    byMonth.get(key)!.push(trade);
  }

  const result: MonthlyReturn[] = [];

  for (const [key, monthTrades] of byMonth) {
    const [yearStr, monthStr] = key.split('-');
    const pnl = monthTrades.reduce((sum, t) => sum + t.pnl, 0);
    const pnlPercent = monthTrades.reduce((sum, t) => sum + t.pnlPercent, 0);

    result.push({
      year: parseInt(yearStr),
      month: parseInt(monthStr),
      return: pnl,
      returnPercent: pnlPercent,
      trades: monthTrades.length,
    });
  }

  // Sort by date
  result.sort((a, b) => a.year * 12 + a.month - (b.year * 12 + b.month));

  return result;
}

/**
 * Create empty metrics for backtests with no trades
 */
function createEmptyMetrics(
  initialCapital: number,
  equityCurve: EquityPoint[],
  tradingDays: number
): PerformanceMetrics {
  return {
    totalReturn: 0,
    totalReturnPercent: 0,
    annualizedReturn: 0,
    sharpeRatio: 0,
    sortinoRatio: 0,
    calmarRatio: 0,
    maxDrawdown: 0,
    maxDrawdownPercent: 0,
    maxDrawdownDuration: 0,
    currentDrawdown: 0,
    totalTrades: 0,
    winningTrades: 0,
    losingTrades: 0,
    winRate: 0,
    averageWin: 0,
    averageLoss: 0,
    largestWin: 0,
    largestLoss: 0,
    profitFactor: 0,
    expectancy: 0,
    averageRiskRewardRatio: 0,
    maxConsecutiveWins: 0,
    maxConsecutiveLosses: 0,
    averageHoldingPeriod: 0,
    tradingDays,
    patternPerformance: {},
    monthlyReturns: [],
    equityCurve,
  };
}

/**
 * Format metrics for display
 */
export function formatMetricsReport(metrics: PerformanceMetrics): string {
  const lines = [
    '╔══════════════════════════════════════════════════════════════╗',
    '║                    BACKTEST PERFORMANCE REPORT               ║',
    '╠══════════════════════════════════════════════════════════════╣',
    '',
    '📈 RETURNS',
    `   Total Return:        $${metrics.totalReturn.toFixed(2)} (${metrics.totalReturnPercent.toFixed(2)}%)`,
    `   Annualized Return:   ${metrics.annualizedReturn.toFixed(2)}%`,
    '',
    '📊 RISK-ADJUSTED RETURNS',
    `   Sharpe Ratio:        ${metrics.sharpeRatio.toFixed(2)}`,
    `   Sortino Ratio:       ${metrics.sortinoRatio.toFixed(2)}`,
    `   Calmar Ratio:        ${metrics.calmarRatio.toFixed(2)}`,
    '',
    '📉 DRAWDOWN',
    `   Max Drawdown:        $${metrics.maxDrawdown.toFixed(2)} (${metrics.maxDrawdownPercent.toFixed(2)}%)`,
    `   Max DD Duration:     ${metrics.maxDrawdownDuration.toFixed(0)} days`,
    `   Current Drawdown:    ${metrics.currentDrawdown.toFixed(2)}%`,
    '',
    '🎯 TRADE STATISTICS',
    `   Total Trades:        ${metrics.totalTrades}`,
    `   Win Rate:            ${metrics.winRate.toFixed(1)}%`,
    `   Winning Trades:      ${metrics.winningTrades}`,
    `   Losing Trades:       ${metrics.losingTrades}`,
    '',
    '💰 PROFIT METRICS',
    `   Average Win:         $${metrics.averageWin.toFixed(2)}`,
    `   Average Loss:        $${metrics.averageLoss.toFixed(2)}`,
    `   Largest Win:         $${metrics.largestWin.toFixed(2)}`,
    `   Largest Loss:        $${metrics.largestLoss.toFixed(2)}`,
    `   Profit Factor:       ${metrics.profitFactor === Infinity ? '∞' : metrics.profitFactor.toFixed(2)}`,
    `   Expectancy:          $${metrics.expectancy.toFixed(2)}`,
    '',
    '⚡ STREAKS',
    `   Max Consecutive Wins:   ${metrics.maxConsecutiveWins}`,
    `   Max Consecutive Losses: ${metrics.maxConsecutiveLosses}`,
    `   Avg Holding Period:     ${metrics.averageHoldingPeriod.toFixed(1)} candles`,
    '',
    '📋 PATTERN BREAKDOWN',
  ];

  for (const [pattern, perf] of Object.entries(metrics.patternPerformance)) {
    lines.push(
      `   ${pattern}:`,
      `     Trades: ${perf.trades} | Win Rate: ${perf.winRate.toFixed(1)}% | PF: ${perf.profitFactor === Infinity ? '∞' : perf.profitFactor.toFixed(2)}`
    );
  }

  lines.push(
    '',
    '╚══════════════════════════════════════════════════════════════╝'
  );

  return lines.join('\n');
}
