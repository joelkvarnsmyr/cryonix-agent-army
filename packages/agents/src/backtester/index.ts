// Backtester module exports

export { BacktesterAgent, type BacktestRequest } from './backtester-agent';
export { BacktesterEngine } from './backtester-engine';
export { calculatePerformanceMetrics, formatMetricsReport } from './performance-metrics';
export type {
  BacktestConfig,
  BacktestResult,
  BacktestState,
  BacktestPosition,
  BacktestTrade,
  PerformanceMetrics,
  PatternPerformance,
  MonthlyReturn,
  EquityPoint,
  WalkForwardConfig,
  WalkForwardResult,
  SkippedSignal,
  HistoricalDataRequest,
  HistoricalDataResult,
} from './types';
