import type { PatternType, SignalAction, TradingSignal } from '@cryonix/types';
import type { OhlcvData } from '../market-scout/pattern-detectors';

// ============================================================================
// BACKTEST CONFIGURATION
// ============================================================================

export interface BacktestConfig {
  /** Starting capital in USD */
  initialCapital: number;
  /** Trading symbols to backtest */
  symbols: string[];
  /** Start date for backtest period */
  startDate: Date;
  /** End date for backtest period */
  endDate: Date;
  /** Candle timeframe (e.g., '15m', '1h', '4h') */
  timeframe: string;
  /** Which pattern detectors to use */
  patterns: PatternType[];
  /** Position sizing method */
  positionSizing: 'fixed' | 'kelly' | 'atr';
  /** Fixed position size as % of capital (if positionSizing = 'fixed') */
  fixedPositionPercent?: number;
  /** Use half-Kelly for conservative sizing */
  useHalfKelly?: boolean;
  /** Maximum position size as % of capital */
  maxPositionPercent: number;
  /** Maximum portfolio risk per trade */
  maxRiskPercent: number;
  /** Slippage assumption in % */
  slippagePercent: number;
  /** Trading fee per trade in % */
  feePercent: number;
  /** Minimum confidence threshold for signals */
  minConfidence: number;
  /** Maximum concurrent positions */
  maxConcurrentPositions: number;
  /** Enable walk-forward optimization */
  walkForward?: WalkForwardConfig;
  /** Enable Monte Carlo simulation for robustness testing */
  monteCarlo?: MonteCarloConfig;
}

export interface WalkForwardConfig {
  /** Number of optimization windows */
  windows: number;
  /** In-sample period in days */
  inSampleDays: number;
  /** Out-of-sample period in days */
  outOfSampleDays: number;
  /** Parameters to optimize */
  optimizeParams: string[];
}

export interface MonteCarloConfig {
  /** Enable Monte Carlo simulation */
  enabled: boolean;
  /** Number of simulations to run (default: 1000) */
  numSimulations?: number;
  /** Simulation method: 'shuffle' | 'bootstrap' | 'both' */
  method?: 'shuffle' | 'bootstrap' | 'both';
  /** Confidence levels to report (default: [0.90, 0.95, 0.99]) */
  confidenceLevels?: number[];
}

// ============================================================================
// BACKTEST POSITION & TRADE
// ============================================================================

export interface BacktestPosition {
  id: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  entryTime: Date;
  quantity: number;
  stopLoss: number;
  takeProfit: number;
  confidence: number;
  pattern: PatternType;
  signalId: string;
}

export interface BacktestTrade {
  id: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  exitPrice: number;
  entryTime: Date;
  exitTime: Date;
  quantity: number;
  pnl: number;
  pnlPercent: number;
  fees: number;
  slippage: number;
  exitReason: 'stop_loss' | 'take_profit' | 'signal' | 'end_of_backtest';
  pattern: PatternType;
  confidence: number;
  holdingPeriodCandles: number;
}

// ============================================================================
// PERFORMANCE METRICS
// ============================================================================

export interface PerformanceMetrics {
  // Returns
  totalReturn: number;
  totalReturnPercent: number;
  annualizedReturn: number;

  // Risk-adjusted returns
  sharpeRatio: number;
  sortinoRatio: number;
  calmarRatio: number;

  // Drawdown
  maxDrawdown: number;
  maxDrawdownPercent: number;
  maxDrawdownDuration: number; // in days
  currentDrawdown: number;

  // Trade statistics
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;

  // Profit metrics
  averageWin: number;
  averageLoss: number;
  largestWin: number;
  largestLoss: number;
  profitFactor: number;
  expectancy: number;

  // Risk metrics
  averageRiskRewardRatio: number;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;

  // Time metrics
  averageHoldingPeriod: number; // in candles
  tradingDays: number;

  // Pattern breakdown
  patternPerformance: Record<string, PatternPerformance>;

  // Monthly returns
  monthlyReturns: MonthlyReturn[];

  // Equity curve
  equityCurve: EquityPoint[];
}

export interface PatternPerformance {
  pattern: string;
  trades: number;
  winRate: number;
  averageReturn: number;
  profitFactor: number;
  contribution: number; // % of total profit
}

export interface MonthlyReturn {
  year: number;
  month: number;
  return: number;
  returnPercent: number;
  trades: number;
}

export interface EquityPoint {
  timestamp: Date;
  equity: number;
  drawdown: number;
  drawdownPercent: number;
}

// ============================================================================
// BACKTEST RESULT
// ============================================================================

export interface BacktestResult {
  id: string;
  config: BacktestConfig;
  startedAt: Date;
  completedAt: Date;
  durationMs: number;

  // Final state
  finalEquity: number;

  // All metrics
  metrics: PerformanceMetrics;

  // All trades
  trades: BacktestTrade[];

  // Walk-forward results (if enabled)
  walkForwardResults?: WalkForwardResult[];

  // Monte Carlo simulation results (if enabled)
  // Note: MonteCarloResult type is defined in monte-carlo.ts and re-exported from index
  monteCarloResult?: any; // Type-safe reference added in index.ts

  // Signals generated but not traded (for analysis)
  skippedSignals: SkippedSignal[];
}

export interface WalkForwardResult {
  windowIndex: number;
  inSampleStart: Date;
  inSampleEnd: Date;
  outOfSampleStart: Date;
  outOfSampleEnd: Date;

  // Optimized parameters from in-sample
  optimizedParams: Record<string, number>;
  inSampleMetrics: PerformanceMetrics;

  // Out-of-sample results using optimized params
  outOfSampleMetrics: PerformanceMetrics;

  // Robustness check
  robustnessScore: number; // 0-1, how well in-sample predicted out-of-sample
}

export interface SkippedSignal {
  signal: TradingSignal;
  reason: 'low_confidence' | 'max_positions' | 'risk_exceeded' | 'already_in_position' | 'insufficient_capital';
  timestamp: Date;
}

// ============================================================================
// HISTORICAL DATA
// ============================================================================

export interface HistoricalDataRequest {
  symbol: string;
  timeframe: string;
  startDate: Date;
  endDate: Date;
}

export interface HistoricalDataResult {
  symbol: string;
  timeframe: string;
  candles: OhlcvData[];
  fetchedAt: Date;
}

// ============================================================================
// BACKTEST STATE (for engine internal use)
// ============================================================================

export interface BacktestState {
  currentTime: Date;
  currentCandle: number;
  equity: number;
  cash: number;
  positions: Map<string, BacktestPosition>;
  trades: BacktestTrade[];
  equityCurve: EquityPoint[];
  peakEquity: number;
  dailyPnL: number[];
  skippedSignals: SkippedSignal[];
}
