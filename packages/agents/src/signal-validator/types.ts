import type { TradingSignal, SignalAction } from '@cryonix/types';

// ============================================================================
// VALIDATION SOURCES
// ============================================================================

export type ValidationSource =
  | 'pattern_detector'
  | 'technical_indicators'
  | 'ai_analysis'
  | 'market_structure'
  | 'volume_analysis'
  | 'momentum_analysis';

export interface SourceVote {
  source: ValidationSource;
  action: SignalAction;
  confidence: number;
  reasoning: string[];
  indicators?: Record<string, number>;
}

// ============================================================================
// TECHNICAL INDICATORS
// ============================================================================

export interface TechnicalIndicators {
  // Trend indicators
  sma20: number;
  sma50: number;
  sma200: number;
  ema12: number;
  ema26: number;

  // Momentum indicators
  rsi14: number;
  macd: number;
  macdSignal: number;
  macdHistogram: number;
  stochK: number;
  stochD: number;

  // Volatility indicators
  atr14: number;
  bollingerUpper: number;
  bollingerMiddle: number;
  bollingerLower: number;
  bollingerBandwidth: number;

  // Volume indicators
  volumeSma20: number;
  volumeRatio: number;
  obv: number;
  vwap: number;

  // Price action
  currentPrice: number;
  priceChange24h: number;
  priceChangePercent24h: number;
  high24h: number;
  low24h: number;
}

// ============================================================================
// MARKET STRUCTURE
// ============================================================================

export interface MarketStructure {
  trend: 'uptrend' | 'downtrend' | 'sideways';
  trendStrength: number; // 0-1

  // Support/Resistance
  nearestSupport: number;
  nearestResistance: number;
  distanceToSupport: number;
  distanceToResistance: number;

  // Key levels
  pivotPoint: number;
  r1: number;
  r2: number;
  r3: number;
  s1: number;
  s2: number;
  s3: number;

  // Market state
  volatilityState: 'low' | 'normal' | 'high' | 'extreme';
  volumeState: 'low' | 'normal' | 'high';
}

// ============================================================================
// VALIDATION RESULT
// ============================================================================

export interface ValidationResult {
  /** Is the signal validated (passed consensus threshold) */
  isValid: boolean;

  /** Original signal */
  originalSignal: TradingSignal;

  /** Validated action (may differ from original if overridden) */
  validatedAction: SignalAction;

  /** Validated confidence (weighted consensus) */
  validatedConfidence: number;

  /** Individual source votes */
  votes: SourceVote[];

  /** Consensus level (0-1, 1 = all sources agree) */
  consensusLevel: number;

  /** Overall sentiment (bullish/bearish strength) */
  bullishSentiment: number;
  bearishSentiment: number;

  /** Technical indicators snapshot */
  technicalIndicators: TechnicalIndicators;

  /** Market structure analysis */
  marketStructure: MarketStructure;

  /** Risk assessment */
  riskLevel: 'low' | 'medium' | 'high' | 'extreme';
  riskFactors: string[];

  /** Timing assessment */
  entryTiming: 'excellent' | 'good' | 'fair' | 'poor';
  timingReasoning: string;

  /** Adjusted price targets (if different from original) */
  adjustedEntry?: number;
  adjustedTarget?: number;
  adjustedStopLoss?: number;

  /** Validation timestamp */
  validatedAt: Date;

  /** Processing time in ms */
  processingTimeMs: number;
}

// ============================================================================
// SIGNAL ACCURACY TRACKING
// ============================================================================

export interface SignalAccuracyRecord {
  signalId: string;
  symbol: string;
  pattern: string;
  action: SignalAction;
  confidence: number;
  validatedConfidence: number;

  // Outcome tracking
  entryPrice: number;
  targetPrice: number;
  stopLossPrice: number;
  actualExitPrice?: number;
  exitReason?: 'target_hit' | 'stop_hit' | 'timeout' | 'manual';

  // Result
  wasSuccessful?: boolean;
  pnlPercent?: number;
  holdingPeriodHours?: number;

  // Timestamps
  signalTimestamp: Date;
  exitTimestamp?: Date;

  // Validation data
  consensusLevel: number;
  votesCount: number;
  agreeingVotes: number;
}

export interface AccuracyStats {
  totalSignals: number;
  resolvedSignals: number;

  // Overall accuracy
  overallAccuracy: number;

  // By action
  buyAccuracy: number;
  sellAccuracy: number;

  // By pattern
  patternAccuracy: Record<string, number>;

  // By confidence bucket
  highConfidenceAccuracy: number; // >= 0.8
  mediumConfidenceAccuracy: number; // 0.6-0.8
  lowConfidenceAccuracy: number; // < 0.6

  // By consensus level
  strongConsensusAccuracy: number; // >= 0.8
  moderateConsensusAccuracy: number; // 0.6-0.8
  weakConsensusAccuracy: number; // < 0.6

  // Average metrics
  averagePnl: number;
  averageHoldingPeriod: number;

  // Time-based
  last7DaysAccuracy: number;
  last30DaysAccuracy: number;
}

// ============================================================================
// VALIDATION CONFIG
// ============================================================================

export interface ValidationConfig {
  /** Minimum consensus level to validate (0-1) */
  minConsensusLevel: number;

  /** Minimum confidence to pass validation */
  minConfidence: number;

  /** Weights for each validation source */
  sourceWeights: Record<ValidationSource, number>;

  /** Enable AI analysis (requires API call) */
  enableAiAnalysis: boolean;

  /** Override original action if consensus disagrees */
  allowActionOverride: boolean;

  /** Adjust price targets based on market structure */
  adjustPriceTargets: boolean;
}

export const DEFAULT_VALIDATION_CONFIG: ValidationConfig = {
  minConsensusLevel: 0.6,
  minConfidence: 0.5,
  sourceWeights: {
    pattern_detector: 0.25,
    technical_indicators: 0.25,
    ai_analysis: 0.20,
    market_structure: 0.15,
    volume_analysis: 0.10,
    momentum_analysis: 0.05,
  },
  enableAiAnalysis: true,
  allowActionOverride: false,
  adjustPriceTargets: true,
};
