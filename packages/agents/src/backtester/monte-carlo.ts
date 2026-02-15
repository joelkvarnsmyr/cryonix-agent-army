/**
 * Monte Carlo Simulation for Backtest Robustness Analysis
 *
 * Monte Carlo simulation helps assess the robustness of a trading strategy by:
 * 1. Trade Shuffling - Randomize the order of trades to see how sequence affects results
 * 2. Bootstrap Resampling - Sample trades with replacement to generate distribution of outcomes
 * 3. Parameter Perturbation - Test strategy sensitivity to parameter changes
 *
 * This helps answer questions like:
 * - What's the probability of achieving X% return?
 * - What's the worst-case drawdown at 95% confidence?
 * - How stable is the strategy to random trade ordering?
 */

import type { BacktestTrade, PerformanceMetrics, EquityPoint } from './types';

// ============================================================================
// MONTE CARLO TYPES
// ============================================================================

export interface MonteCarloConfig {
  /** Number of simulations to run */
  numSimulations: number;
  /** Method for generating simulations */
  method: 'shuffle' | 'bootstrap' | 'both';
  /** Confidence levels to report (e.g., [0.95, 0.99]) */
  confidenceLevels: number[];
  /** Starting capital for simulations */
  initialCapital: number;
  /** Random seed for reproducibility (optional) */
  seed?: number;
}

export interface MonteCarloResult {
  /** Number of simulations performed */
  numSimulations: number;
  /** Method used */
  method: 'shuffle' | 'bootstrap' | 'both';

  /** Distribution statistics for total return */
  returnDistribution: DistributionStats;

  /** Distribution statistics for maximum drawdown */
  drawdownDistribution: DistributionStats;

  /** Distribution statistics for Sharpe ratio */
  sharpeDistribution: DistributionStats;

  /** Probability of profit */
  probabilityOfProfit: number;

  /** Probability of achieving various return levels */
  returnProbabilities: ReturnProbability[];

  /** Value at Risk (VaR) at different confidence levels */
  valueAtRisk: ValueAtRisk[];

  /** Confidence intervals for key metrics */
  confidenceIntervals: ConfidenceIntervals;

  /** Raw simulation results (for visualization) */
  simulations: SimulationSummary[];

  /** Histogram data for returns */
  returnHistogram: HistogramBin[];

  /** Histogram data for max drawdown */
  drawdownHistogram: HistogramBin[];
}

export interface DistributionStats {
  mean: number;
  median: number;
  stdDev: number;
  min: number;
  max: number;
  skewness: number;
  kurtosis: number;
  percentiles: Record<number, number>; // e.g., {5: -10, 25: 5, 50: 15, 75: 25, 95: 40}
}

export interface ReturnProbability {
  returnLevel: number; // e.g., 0, 10, 20 (percent)
  probability: number; // 0-1
}

export interface ValueAtRisk {
  confidenceLevel: number; // e.g., 0.95, 0.99
  var: number; // Value at Risk (potential loss)
  cvar: number; // Conditional VaR (expected loss beyond VaR)
}

export interface ConfidenceIntervals {
  totalReturn: { lower: number; upper: number; confidence: number }[];
  maxDrawdown: { lower: number; upper: number; confidence: number }[];
  sharpeRatio: { lower: number; upper: number; confidence: number }[];
  winRate: { lower: number; upper: number; confidence: number }[];
}

export interface SimulationSummary {
  index: number;
  totalReturn: number;
  totalReturnPercent: number;
  maxDrawdown: number;
  maxDrawdownPercent: number;
  finalEquity: number;
  sharpeRatio: number;
  winRate: number;
}

export interface HistogramBin {
  binStart: number;
  binEnd: number;
  count: number;
  frequency: number;
}

// ============================================================================
// MONTE CARLO ENGINE
// ============================================================================

/**
 * Run Monte Carlo simulation on backtest trades
 */
export function runMonteCarloSimulation(
  trades: BacktestTrade[],
  config: MonteCarloConfig
): MonteCarloResult {
  if (trades.length === 0) {
    return createEmptyMonteCarloResult(config);
  }

  const simulations: SimulationSummary[] = [];

  // Initialize random number generator
  const rng = createSeededRNG(config.seed);

  for (let i = 0; i < config.numSimulations; i++) {
    let simulatedTrades: BacktestTrade[];

    if (config.method === 'shuffle') {
      simulatedTrades = shuffleTrades(trades, rng);
    } else if (config.method === 'bootstrap') {
      simulatedTrades = bootstrapTrades(trades, rng);
    } else {
      // 'both' - alternate between methods
      simulatedTrades = i % 2 === 0
        ? shuffleTrades(trades, rng)
        : bootstrapTrades(trades, rng);
    }

    const summary = simulateEquityCurve(simulatedTrades, config.initialCapital, i);
    simulations.push(summary);
  }

  return aggregateResults(simulations, config);
}

/**
 * Shuffle trades (preserves same trades, different order)
 */
function shuffleTrades(trades: BacktestTrade[], rng: () => number): BacktestTrade[] {
  const shuffled = [...trades];

  // Fisher-Yates shuffle
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  return shuffled;
}

/**
 * Bootstrap resampling (sample with replacement)
 */
function bootstrapTrades(trades: BacktestTrade[], rng: () => number): BacktestTrade[] {
  const sampled: BacktestTrade[] = [];

  for (let i = 0; i < trades.length; i++) {
    const randomIndex = Math.floor(rng() * trades.length);
    sampled.push(trades[randomIndex]);
  }

  return sampled;
}

/**
 * Simulate equity curve from trades
 */
function simulateEquityCurve(
  trades: BacktestTrade[],
  initialCapital: number,
  simulationIndex: number
): SimulationSummary {
  let equity = initialCapital;
  let peakEquity = initialCapital;
  let maxDrawdown = 0;
  let maxDrawdownPercent = 0;

  const dailyReturns: number[] = [];
  let previousEquity = initialCapital;
  let winCount = 0;

  for (const trade of trades) {
    equity += trade.pnl;

    if (trade.pnl > 0) {
      winCount++;
    }

    // Track daily returns (simplified - treat each trade as a "day")
    const dailyReturn = (equity - previousEquity) / previousEquity;
    dailyReturns.push(dailyReturn);
    previousEquity = equity;

    // Update peak and drawdown
    if (equity > peakEquity) {
      peakEquity = equity;
    }

    const drawdown = peakEquity - equity;
    const drawdownPct = peakEquity > 0 ? (drawdown / peakEquity) * 100 : 0;

    if (drawdownPct > maxDrawdownPercent) {
      maxDrawdown = drawdown;
      maxDrawdownPercent = drawdownPct;
    }
  }

  // Calculate Sharpe ratio
  const sharpeRatio = calculateSimulationSharpe(dailyReturns);
  const winRate = trades.length > 0 ? (winCount / trades.length) * 100 : 0;

  return {
    index: simulationIndex,
    totalReturn: equity - initialCapital,
    totalReturnPercent: ((equity - initialCapital) / initialCapital) * 100,
    maxDrawdown,
    maxDrawdownPercent,
    finalEquity: equity,
    sharpeRatio,
    winRate,
  };
}

/**
 * Calculate Sharpe ratio for simulation
 */
function calculateSimulationSharpe(returns: number[]): number {
  if (returns.length < 2) return 0;

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / (returns.length - 1);
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) return mean > 0 ? Infinity : 0;

  // Annualize assuming ~252 trading days
  return (mean / stdDev) * Math.sqrt(252);
}

/**
 * Aggregate simulation results into final report
 */
function aggregateResults(
  simulations: SimulationSummary[],
  config: MonteCarloConfig
): MonteCarloResult {
  const returns = simulations.map(s => s.totalReturnPercent);
  const drawdowns = simulations.map(s => s.maxDrawdownPercent);
  const sharpes = simulations.map(s => s.sharpeRatio).filter(s => isFinite(s));
  const winRates = simulations.map(s => s.winRate);

  // Calculate distribution statistics
  const returnDistribution = calculateDistributionStats(returns, config.confidenceLevels);
  const drawdownDistribution = calculateDistributionStats(drawdowns, config.confidenceLevels);
  const sharpeDistribution = sharpes.length > 0
    ? calculateDistributionStats(sharpes, config.confidenceLevels)
    : createEmptyDistributionStats();

  // Probability of profit
  const profitableCount = returns.filter(r => r > 0).length;
  const probabilityOfProfit = profitableCount / simulations.length;

  // Return probabilities at various levels
  const returnProbabilities = calculateReturnProbabilities(returns);

  // Value at Risk
  const valueAtRisk = calculateVaR(returns, config.confidenceLevels, config.initialCapital);

  // Confidence intervals
  const confidenceIntervals = calculateConfidenceIntervals(
    returns,
    drawdowns,
    sharpes,
    winRates,
    config.confidenceLevels
  );

  // Histograms
  const returnHistogram = createHistogram(returns, 20);
  const drawdownHistogram = createHistogram(drawdowns, 20);

  return {
    numSimulations: config.numSimulations,
    method: config.method,
    returnDistribution,
    drawdownDistribution,
    sharpeDistribution,
    probabilityOfProfit,
    returnProbabilities,
    valueAtRisk,
    confidenceIntervals,
    simulations,
    returnHistogram,
    drawdownHistogram,
  };
}

/**
 * Calculate distribution statistics
 */
function calculateDistributionStats(
  values: number[],
  confidenceLevels: number[]
): DistributionStats {
  if (values.length === 0) {
    return createEmptyDistributionStats();
  }

  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;

  // Mean
  const mean = values.reduce((a, b) => a + b, 0) / n;

  // Median
  const median = n % 2 === 0
    ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2
    : sorted[Math.floor(n / 2)];

  // Standard deviation
  const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / (n - 1);
  const stdDev = Math.sqrt(variance);

  // Min/Max
  const min = sorted[0];
  const max = sorted[n - 1];

  // Skewness
  const skewness = n > 2
    ? (values.reduce((sum, v) => sum + Math.pow((v - mean) / stdDev, 3), 0) * n) / ((n - 1) * (n - 2))
    : 0;

  // Kurtosis (excess kurtosis)
  const kurtosis = n > 3
    ? ((n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3))) *
      values.reduce((sum, v) => sum + Math.pow((v - mean) / stdDev, 4), 0) -
      (3 * Math.pow(n - 1, 2)) / ((n - 2) * (n - 3))
    : 0;

  // Percentiles
  const percentiles: Record<number, number> = {};
  const standardPercentiles = [1, 5, 10, 25, 50, 75, 90, 95, 99];

  for (const p of standardPercentiles) {
    percentiles[p] = getPercentile(sorted, p);
  }

  // Add confidence levels
  for (const level of confidenceLevels) {
    const lower = (1 - level) / 2 * 100;
    const upper = (1 - (1 - level) / 2) * 100;
    percentiles[lower] = getPercentile(sorted, lower);
    percentiles[upper] = getPercentile(sorted, upper);
  }

  return { mean, median, stdDev, min, max, skewness, kurtosis, percentiles };
}

/**
 * Get percentile value from sorted array
 */
function getPercentile(sorted: number[], percentile: number): number {
  const index = (percentile / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const fraction = index - lower;

  if (lower === upper) {
    return sorted[lower];
  }

  return sorted[lower] * (1 - fraction) + sorted[upper] * fraction;
}

/**
 * Calculate probabilities of achieving various return levels
 */
function calculateReturnProbabilities(returns: number[]): ReturnProbability[] {
  const levels = [-20, -10, -5, 0, 5, 10, 15, 20, 30, 50, 100];
  const n = returns.length;

  return levels.map(level => ({
    returnLevel: level,
    probability: returns.filter(r => r >= level).length / n,
  }));
}

/**
 * Calculate Value at Risk and Conditional VaR
 */
function calculateVaR(
  returns: number[],
  confidenceLevels: number[],
  initialCapital: number
): ValueAtRisk[] {
  const sorted = [...returns].sort((a, b) => a - b);
  const n = sorted.length;

  return confidenceLevels.map(confidence => {
    // VaR is the loss at the (1 - confidence) percentile
    const varPercentile = (1 - confidence) * 100;
    const varReturn = getPercentile(sorted, varPercentile);

    // Convert to absolute value (loss)
    const var$ = -varReturn * initialCapital / 100;

    // CVaR (Expected Shortfall) - average of returns below VaR
    const varIndex = Math.floor((1 - confidence) * n);
    const belowVar = sorted.slice(0, varIndex + 1);
    const cvarReturn = belowVar.length > 0
      ? belowVar.reduce((a, b) => a + b, 0) / belowVar.length
      : varReturn;
    const cvar = -cvarReturn * initialCapital / 100;

    return {
      confidenceLevel: confidence,
      var: Math.max(0, var$),
      cvar: Math.max(0, cvar),
    };
  });
}

/**
 * Calculate confidence intervals for metrics
 */
function calculateConfidenceIntervals(
  returns: number[],
  drawdowns: number[],
  sharpes: number[],
  winRates: number[],
  confidenceLevels: number[]
): ConfidenceIntervals {
  const sortedReturns = [...returns].sort((a, b) => a - b);
  const sortedDrawdowns = [...drawdowns].sort((a, b) => a - b);
  const sortedSharpes = sharpes.length > 0 ? [...sharpes].sort((a, b) => a - b) : [];
  const sortedWinRates = [...winRates].sort((a, b) => a - b);

  const createIntervals = (sorted: number[], levels: number[]) => {
    if (sorted.length === 0) return [];

    return levels.map(confidence => ({
      lower: getPercentile(sorted, (1 - confidence) / 2 * 100),
      upper: getPercentile(sorted, (1 - (1 - confidence) / 2) * 100),
      confidence,
    }));
  };

  return {
    totalReturn: createIntervals(sortedReturns, confidenceLevels),
    maxDrawdown: createIntervals(sortedDrawdowns, confidenceLevels),
    sharpeRatio: createIntervals(sortedSharpes, confidenceLevels),
    winRate: createIntervals(sortedWinRates, confidenceLevels),
  };
}

/**
 * Create histogram from values
 */
function createHistogram(values: number[], numBins: number): HistogramBin[] {
  if (values.length === 0) return [];

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;
  const binSize = range / numBins || 1;

  const bins: HistogramBin[] = [];

  for (let i = 0; i < numBins; i++) {
    bins.push({
      binStart: min + i * binSize,
      binEnd: min + (i + 1) * binSize,
      count: 0,
      frequency: 0,
    });
  }

  // Count values in each bin
  for (const value of values) {
    const binIndex = Math.min(
      Math.floor((value - min) / binSize),
      numBins - 1
    );
    bins[binIndex].count++;
  }

  // Calculate frequencies
  const totalCount = values.length;
  for (const bin of bins) {
    bin.frequency = bin.count / totalCount;
  }

  return bins;
}

/**
 * Create seeded random number generator (Mulberry32)
 */
function createSeededRNG(seed?: number): () => number {
  let state = seed ?? Date.now();

  return () => {
    state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Create empty distribution stats
 */
function createEmptyDistributionStats(): DistributionStats {
  return {
    mean: 0,
    median: 0,
    stdDev: 0,
    min: 0,
    max: 0,
    skewness: 0,
    kurtosis: 0,
    percentiles: {},
  };
}

/**
 * Create empty Monte Carlo result
 */
function createEmptyMonteCarloResult(config: MonteCarloConfig): MonteCarloResult {
  return {
    numSimulations: 0,
    method: config.method,
    returnDistribution: createEmptyDistributionStats(),
    drawdownDistribution: createEmptyDistributionStats(),
    sharpeDistribution: createEmptyDistributionStats(),
    probabilityOfProfit: 0,
    returnProbabilities: [],
    valueAtRisk: [],
    confidenceIntervals: {
      totalReturn: [],
      maxDrawdown: [],
      sharpeRatio: [],
      winRate: [],
    },
    simulations: [],
    returnHistogram: [],
    drawdownHistogram: [],
  };
}

/**
 * Format Monte Carlo results as a report
 */
export function formatMonteCarloReport(result: MonteCarloResult): string {
  const lines = [
    '',
    '╔══════════════════════════════════════════════════════════════╗',
    '║                MONTE CARLO SIMULATION REPORT                 ║',
    '╠══════════════════════════════════════════════════════════════╣',
    '',
    `   Simulations: ${result.numSimulations}`,
    `   Method: ${result.method}`,
    '',
    '📊 RETURN DISTRIBUTION',
    `   Mean Return:     ${result.returnDistribution.mean.toFixed(2)}%`,
    `   Median Return:   ${result.returnDistribution.median.toFixed(2)}%`,
    `   Std Deviation:   ${result.returnDistribution.stdDev.toFixed(2)}%`,
    `   Min Return:      ${result.returnDistribution.min.toFixed(2)}%`,
    `   Max Return:      ${result.returnDistribution.max.toFixed(2)}%`,
    `   Skewness:        ${result.returnDistribution.skewness.toFixed(3)}`,
    '',
    '📉 DRAWDOWN DISTRIBUTION',
    `   Mean Drawdown:   ${result.drawdownDistribution.mean.toFixed(2)}%`,
    `   Worst Case:      ${result.drawdownDistribution.max.toFixed(2)}%`,
    `   5th Percentile:  ${(result.drawdownDistribution.percentiles[5] ?? 0).toFixed(2)}%`,
    `   95th Percentile: ${(result.drawdownDistribution.percentiles[95] ?? 0).toFixed(2)}%`,
    '',
    '🎯 PROBABILITY ANALYSIS',
    `   P(Profit > 0%):  ${(result.probabilityOfProfit * 100).toFixed(1)}%`,
  ];

  // Add return probabilities
  for (const prob of result.returnProbabilities.filter(p => p.returnLevel >= 0)) {
    lines.push(
      `   P(Return > ${prob.returnLevel}%): ${(prob.probability * 100).toFixed(1)}%`
    );
  }

  lines.push('');
  lines.push('⚠️  VALUE AT RISK');

  for (const var$ of result.valueAtRisk) {
    lines.push(
      `   VaR (${(var$.confidenceLevel * 100).toFixed(0)}%):  $${var$.var.toFixed(2)}`
    );
    lines.push(
      `   CVaR (${(var$.confidenceLevel * 100).toFixed(0)}%): $${var$.cvar.toFixed(2)}`
    );
  }

  lines.push('');
  lines.push('📈 CONFIDENCE INTERVALS (95%)');

  const ci95 = result.confidenceIntervals.totalReturn.find(ci => ci.confidence === 0.95);
  if (ci95) {
    lines.push(
      `   Return:    [${ci95.lower.toFixed(2)}%, ${ci95.upper.toFixed(2)}%]`
    );
  }

  const dd95 = result.confidenceIntervals.maxDrawdown.find(ci => ci.confidence === 0.95);
  if (dd95) {
    lines.push(
      `   Drawdown:  [${dd95.lower.toFixed(2)}%, ${dd95.upper.toFixed(2)}%]`
    );
  }

  lines.push('');
  lines.push('╚══════════════════════════════════════════════════════════════╝');

  return lines.join('\n');
}
