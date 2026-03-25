import type { TradingSignal, SignalAction } from '@cryonix/types';
import type { OhlcvData } from '../market-scout/pattern-detectors';
import { calculateTechnicalIndicators, analyzeMarketStructure } from './technical-indicators';
import type {
  ValidationResult,
  ValidationConfig,
  SourceVote,
  TechnicalIndicators,
  MarketStructure,
  SignalAccuracyRecord,
  AccuracyStats,
  DEFAULT_VALIDATION_CONFIG,
} from './types';

export class SignalValidator {
  private config: ValidationConfig;
  private accuracyRecords: Map<string, SignalAccuracyRecord> = new Map();

  constructor(config?: Partial<ValidationConfig>) {
    this.config = {
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
      ...config,
    };
  }

  /**
   * Validate a trading signal with multi-source consensus
   */
  async validate(signal: TradingSignal, candles: OhlcvData[]): Promise<ValidationResult> {
    const startTime = Date.now();

    // Calculate technical indicators
    const indicators = calculateTechnicalIndicators(candles);

    // Analyze market structure
    const marketStructure = analyzeMarketStructure(candles, indicators);

    // Collect votes from all sources
    const votes: SourceVote[] = [];

    // 1. Pattern detector vote (original signal)
    votes.push(this.createPatternVote(signal));

    // 2. Technical indicators vote
    votes.push(this.createTechnicalVote(indicators, signal.symbol));

    // 3. Market structure vote
    votes.push(this.createMarketStructureVote(marketStructure, indicators, signal.symbol));

    // 4. Volume analysis vote
    votes.push(this.createVolumeVote(indicators, signal.symbol));

    // 5. Momentum analysis vote
    votes.push(this.createMomentumVote(indicators, signal.symbol));

    // 6. AI analysis vote (optional, placeholder for GROK integration)
    if (this.config.enableAiAnalysis) {
      // In production, this would call the GROK API
      // For now, use a weighted average of other indicators
      votes.push(this.createAiVote(indicators, marketStructure, signal));
    }

    // Calculate consensus
    const { validatedAction, validatedConfidence, consensusLevel, bullishSentiment, bearishSentiment } =
      this.calculateConsensus(votes, signal);

    // Assess risk
    const { riskLevel, riskFactors } = this.assessRisk(indicators, marketStructure, signal);

    // Assess entry timing
    const { entryTiming, timingReasoning } = this.assessTiming(indicators, marketStructure, validatedAction);

    // Adjust price targets if enabled
    let adjustedEntry: number | undefined;
    let adjustedTarget: number | undefined;
    let adjustedStopLoss: number | undefined;

    if (this.config.adjustPriceTargets) {
      const adjusted = this.adjustPriceTargets(signal, indicators, marketStructure);
      adjustedEntry = adjusted.entry;
      adjustedTarget = adjusted.target;
      adjustedStopLoss = adjusted.stopLoss;
    }

    // Determine if signal is valid
    const isValid =
      consensusLevel >= this.config.minConsensusLevel && validatedConfidence >= this.config.minConfidence;

    const result: ValidationResult = {
      isValid,
      originalSignal: signal,
      validatedAction,
      validatedConfidence,
      votes,
      consensusLevel,
      bullishSentiment,
      bearishSentiment,
      technicalIndicators: indicators,
      marketStructure,
      riskLevel,
      riskFactors,
      entryTiming,
      timingReasoning,
      adjustedEntry,
      adjustedTarget,
      adjustedStopLoss,
      validatedAt: new Date(),
      processingTimeMs: Date.now() - startTime,
    };

    // Record for accuracy tracking
    this.recordSignal(signal, result);

    return result;
  }

  /**
   * Create vote from pattern detector (original signal)
   */
  private createPatternVote(signal: TradingSignal): SourceVote {
    return {
      source: 'pattern_detector',
      action: signal.action,
      confidence: signal.confidence,
      reasoning: signal.reasoning,
    };
  }

  /**
   * Create vote from technical indicators
   */
  private createTechnicalVote(indicators: TechnicalIndicators, symbol: string): SourceVote {
    let bullishPoints = 0;
    let bearishPoints = 0;
    const reasoning: string[] = [];
    const indicatorValues: Record<string, number> = {};

    // RSI analysis
    indicatorValues['rsi14'] = indicators.rsi14;
    if (indicators.rsi14 < 30) {
      bullishPoints += 2;
      reasoning.push('RSI oversold (< 30) - bullish');
    } else if (indicators.rsi14 > 70) {
      bearishPoints += 2;
      reasoning.push('RSI overbought (> 70) - bearish');
    } else if (indicators.rsi14 < 50) {
      bearishPoints += 0.5;
    } else {
      bullishPoints += 0.5;
    }

    // MACD analysis
    indicatorValues['macd'] = indicators.macd;
    indicatorValues['macdHistogram'] = indicators.macdHistogram;
    if (indicators.macdHistogram > 0 && indicators.macd > indicators.macdSignal) {
      bullishPoints += 1.5;
      reasoning.push('MACD bullish crossover');
    } else if (indicators.macdHistogram < 0 && indicators.macd < indicators.macdSignal) {
      bearishPoints += 1.5;
      reasoning.push('MACD bearish crossover');
    }

    // Moving average analysis
    const { currentPrice, sma20, sma50, sma200 } = indicators;
    indicatorValues['sma20'] = sma20;
    indicatorValues['sma50'] = sma50;
    indicatorValues['sma200'] = sma200;

    if (currentPrice > sma20 && currentPrice > sma50) {
      bullishPoints += 1;
      reasoning.push('Price above SMA20 and SMA50');
    } else if (currentPrice < sma20 && currentPrice < sma50) {
      bearishPoints += 1;
      reasoning.push('Price below SMA20 and SMA50');
    }

    if (sma20 > sma50 && sma50 > sma200) {
      bullishPoints += 1;
      reasoning.push('Bullish SMA alignment (20 > 50 > 200)');
    } else if (sma20 < sma50 && sma50 < sma200) {
      bearishPoints += 1;
      reasoning.push('Bearish SMA alignment (20 < 50 < 200)');
    }

    // Bollinger Band analysis
    indicatorValues['bollingerUpper'] = indicators.bollingerUpper;
    indicatorValues['bollingerLower'] = indicators.bollingerLower;
    if (currentPrice <= indicators.bollingerLower) {
      bullishPoints += 1;
      reasoning.push('Price at lower Bollinger Band - potential bounce');
    } else if (currentPrice >= indicators.bollingerUpper) {
      bearishPoints += 1;
      reasoning.push('Price at upper Bollinger Band - potential reversal');
    }

    // Stochastic analysis
    indicatorValues['stochK'] = indicators.stochK;
    indicatorValues['stochD'] = indicators.stochD;
    if (indicators.stochK < 20 && indicators.stochD < 20) {
      bullishPoints += 1;
      reasoning.push('Stochastic oversold');
    } else if (indicators.stochK > 80 && indicators.stochD > 80) {
      bearishPoints += 1;
      reasoning.push('Stochastic overbought');
    }

    const totalPoints = bullishPoints + bearishPoints;
    const action: SignalAction = bullishPoints > bearishPoints ? 'BUY' : bearishPoints > bullishPoints ? 'SELL' : 'WAIT';
    const confidence = totalPoints > 0 ? Math.abs(bullishPoints - bearishPoints) / totalPoints : 0;

    return {
      source: 'technical_indicators',
      action,
      confidence: Math.min(0.9, 0.5 + confidence * 0.4),
      reasoning,
      indicators: indicatorValues,
    };
  }

  /**
   * Create vote from market structure analysis
   */
  private createMarketStructureVote(
    structure: MarketStructure,
    indicators: TechnicalIndicators,
    symbol: string
  ): SourceVote {
    const reasoning: string[] = [];
    let action: SignalAction;
    let confidence: number;

    // Trend-based vote
    if (structure.trend === 'uptrend') {
      action = 'BUY';
      confidence = 0.5 + structure.trendStrength * 0.3;
      reasoning.push(`Uptrend detected (strength: ${(structure.trendStrength * 100).toFixed(0)}%)`);
    } else if (structure.trend === 'downtrend') {
      action = 'SELL';
      confidence = 0.5 + structure.trendStrength * 0.3;
      reasoning.push(`Downtrend detected (strength: ${(structure.trendStrength * 100).toFixed(0)}%)`);
    } else {
      action = 'WAIT';
      confidence = 0.4;
      reasoning.push('Sideways market - reduced confidence');
    }

    // Support/Resistance proximity
    if (structure.distanceToSupport < 1) {
      confidence += 0.1;
      reasoning.push('Near support level - potential bounce');
      if (action === 'SELL') {
        confidence -= 0.15;
        reasoning.push('Warning: selling near support');
      }
    }

    if (structure.distanceToResistance < 1) {
      confidence += 0.1;
      reasoning.push('Near resistance level - watch for breakout/rejection');
      if (action === 'BUY') {
        confidence -= 0.15;
        reasoning.push('Warning: buying near resistance');
      }
    }

    // Volatility impact
    if (structure.volatilityState === 'extreme') {
      confidence *= 0.8;
      reasoning.push('Extreme volatility - reduced confidence');
    } else if (structure.volatilityState === 'low') {
      reasoning.push('Low volatility - potential breakout forming');
    }

    return {
      source: 'market_structure',
      action,
      confidence: Math.min(0.85, Math.max(0.3, confidence)),
      reasoning,
    };
  }

  /**
   * Create vote from volume analysis
   */
  private createVolumeVote(indicators: TechnicalIndicators, symbol: string): SourceVote {
    const reasoning: string[] = [];
    let bullishBias = 0;
    let bearishBias = 0;

    // Volume ratio analysis
    if (indicators.volumeRatio > 2) {
      reasoning.push(`High volume spike (${indicators.volumeRatio.toFixed(1)}x average)`);
      // High volume can confirm either direction - use price direction
      if (indicators.priceChange24h > 0) {
        bullishBias += 0.3;
        reasoning.push('Volume confirms upward move');
      } else {
        bearishBias += 0.3;
        reasoning.push('Volume confirms downward move');
      }
    } else if (indicators.volumeRatio < 0.5) {
      reasoning.push('Low volume - move may lack conviction');
    }

    // VWAP analysis
    if (indicators.currentPrice > indicators.vwap) {
      bullishBias += 0.2;
      reasoning.push('Price above VWAP - bullish');
    } else if (indicators.currentPrice < indicators.vwap) {
      bearishBias += 0.2;
      reasoning.push('Price below VWAP - bearish');
    }

    const action: SignalAction = bullishBias > bearishBias ? 'BUY' : bearishBias > bullishBias ? 'SELL' : 'WAIT';
    const confidence = 0.5 + Math.abs(bullishBias - bearishBias);

    return {
      source: 'volume_analysis',
      action,
      confidence: Math.min(0.75, confidence),
      reasoning,
    };
  }

  /**
   * Create vote from momentum analysis
   */
  private createMomentumVote(indicators: TechnicalIndicators, symbol: string): SourceVote {
    const reasoning: string[] = [];
    let momentumScore = 0;

    // MACD momentum
    if (indicators.macdHistogram > 0) {
      momentumScore += 1;
      if (indicators.macdHistogram > indicators.macd * 0.1) {
        momentumScore += 0.5;
        reasoning.push('Strong bullish MACD momentum');
      }
    } else {
      momentumScore -= 1;
      if (indicators.macdHistogram < indicators.macd * -0.1) {
        momentumScore -= 0.5;
        reasoning.push('Strong bearish MACD momentum');
      }
    }

    // RSI momentum (rate of change)
    if (indicators.rsi14 > 50 && indicators.rsi14 < 70) {
      momentumScore += 0.5;
      reasoning.push('RSI shows bullish momentum');
    } else if (indicators.rsi14 < 50 && indicators.rsi14 > 30) {
      momentumScore -= 0.5;
      reasoning.push('RSI shows bearish momentum');
    }

    // Stochastic momentum
    if (indicators.stochK > indicators.stochD && indicators.stochK < 80) {
      momentumScore += 0.5;
      reasoning.push('Stochastic bullish crossover');
    } else if (indicators.stochK < indicators.stochD && indicators.stochK > 20) {
      momentumScore -= 0.5;
      reasoning.push('Stochastic bearish crossover');
    }

    const action: SignalAction = momentumScore > 0.5 ? 'BUY' : momentumScore < -0.5 ? 'SELL' : 'WAIT';
    const confidence = 0.5 + Math.min(0.35, Math.abs(momentumScore) * 0.15);

    return {
      source: 'momentum_analysis',
      action,
      confidence,
      reasoning,
    };
  }

  /**
   * Create AI-based vote (simplified without actual API call)
   */
  private createAiVote(
    indicators: TechnicalIndicators,
    structure: MarketStructure,
    signal: TradingSignal
  ): SourceVote {
    // Simplified AI vote based on weighted combination
    const reasoning: string[] = ['AI analysis based on technical confluence'];

    let score = 0;

    // Trend alignment
    if (structure.trend === 'uptrend' && signal.action === 'BUY') {
      score += 1;
      reasoning.push('Signal aligned with trend');
    } else if (structure.trend === 'downtrend' && signal.action === 'SELL') {
      score += 1;
      reasoning.push('Signal aligned with trend');
    } else if (structure.trend === 'sideways') {
      score -= 0.3;
      reasoning.push('Sideways market - higher risk');
    } else {
      score -= 0.5;
      reasoning.push('Signal against trend - counter-trend trade');
    }

    // Technical confirmation
    if (
      (signal.action === 'BUY' && indicators.rsi14 < 50) ||
      (signal.action === 'SELL' && indicators.rsi14 > 50)
    ) {
      score += 0.5;
      reasoning.push('RSI supports entry');
    }

    // Risk/reward assessment
    const riskReward = Math.abs(signal.target_price - signal.entry_price) / Math.abs(signal.entry_price - signal.stop_loss);
    if (riskReward >= 2) {
      score += 0.3;
      reasoning.push(`Good risk/reward ratio (${riskReward.toFixed(1)}:1)`);
    }

    const action: SignalAction = score > 0 ? signal.action : 'WAIT';
    const confidence = Math.min(0.85, Math.max(0.4, signal.confidence * (1 + score * 0.2)));

    return {
      source: 'ai_analysis',
      action,
      confidence,
      reasoning,
    };
  }

  /**
   * Calculate weighted consensus from all votes
   */
  private calculateConsensus(
    votes: SourceVote[],
    originalSignal: TradingSignal
  ): {
    validatedAction: SignalAction;
    validatedConfidence: number;
    consensusLevel: number;
    bullishSentiment: number;
    bearishSentiment: number;
  } {
    let bullishWeight = 0;
    let bearishWeight = 0;
    let waitWeight = 0;
    let totalWeight = 0;

    let bullishConfidenceSum = 0;
    let bearishConfidenceSum = 0;

    for (const vote of votes) {
      const weight = this.config.sourceWeights[vote.source];
      totalWeight += weight;

      const weightedConfidence = vote.confidence * weight;

      if (vote.action === 'BUY') {
        bullishWeight += weight;
        bullishConfidenceSum += weightedConfidence;
      } else if (vote.action === 'SELL') {
        bearishWeight += weight;
        bearishConfidenceSum += weightedConfidence;
      } else {
        waitWeight += weight;
      }
    }

    const bullishSentiment = bullishWeight / totalWeight;
    const bearishSentiment = bearishWeight / totalWeight;

    // Determine action based on weighted votes
    let validatedAction: SignalAction;
    let validatedConfidence: number;

    if (bullishWeight > bearishWeight && bullishWeight > waitWeight) {
      validatedAction = 'BUY';
      validatedConfidence = bullishConfidenceSum / bullishWeight;
    } else if (bearishWeight > bullishWeight && bearishWeight > waitWeight) {
      validatedAction = 'SELL';
      validatedConfidence = bearishConfidenceSum / bearishWeight;
    } else {
      validatedAction = 'WAIT';
      validatedConfidence = 0.5;
    }

    // If override is disabled, keep original action but adjust confidence
    if (!this.config.allowActionOverride && validatedAction !== originalSignal.action) {
      const consensusAction = validatedAction; // Save before override
      validatedAction = originalSignal.action;
      // Reduce confidence significantly when consensus disagrees, especially if opposite
      if (
        (consensusAction === 'BUY' && originalSignal.action === 'SELL') ||
        (consensusAction === 'SELL' && originalSignal.action === 'BUY')
      ) {
        validatedConfidence = originalSignal.confidence * 0.2; // Severe penalty for opposite signals
      } else {
        validatedConfidence = originalSignal.confidence * 0.5; // Moderate penalty for WAIT/Action mismatch
      }
    }

    // Calculate consensus level (how much sources agree)
    const dominantWeight = Math.max(bullishWeight, bearishWeight, waitWeight);
    const consensusLevel = dominantWeight / totalWeight;

    return {
      validatedAction,
      validatedConfidence: Math.min(0.95, validatedConfidence),
      consensusLevel,
      bullishSentiment,
      bearishSentiment,
    };
  }

  /**
   * Assess risk level and factors
   */
  private assessRisk(
    indicators: TechnicalIndicators,
    structure: MarketStructure,
    signal: TradingSignal
  ): { riskLevel: 'low' | 'medium' | 'high' | 'extreme'; riskFactors: string[] } {
    const riskFactors: string[] = [];
    let riskScore = 0;

    // Volatility risk
    if (structure.volatilityState === 'extreme') {
      riskScore += 3;
      riskFactors.push('Extreme market volatility');
    } else if (structure.volatilityState === 'high') {
      riskScore += 2;
      riskFactors.push('High market volatility');
    }

    // Counter-trend risk
    if (
      (structure.trend === 'uptrend' && signal.action === 'SELL') ||
      (structure.trend === 'downtrend' && signal.action === 'BUY')
    ) {
      riskScore += 2;
      riskFactors.push('Trading against the trend');
    }

    // RSI extremes
    if (indicators.rsi14 > 80 || indicators.rsi14 < 20) {
      riskScore += 1;
      riskFactors.push('RSI at extreme levels');
    }

    // Support/Resistance proximity
    if (signal.action === 'BUY' && structure.distanceToResistance < 1) {
      riskScore += 1;
      riskFactors.push('Buying near resistance');
    }
    if (signal.action === 'SELL' && structure.distanceToSupport < 1) {
      riskScore += 1;
      riskFactors.push('Selling near support');
    }

    // Volume confirmation
    if (indicators.volumeRatio < 0.5) {
      riskScore += 1;
      riskFactors.push('Low volume - weak conviction');
    }

    let riskLevel: 'low' | 'medium' | 'high' | 'extreme';
    if (riskScore <= 1) riskLevel = 'low';
    else if (riskScore <= 3) riskLevel = 'medium';
    else if (riskScore <= 5) riskLevel = 'high';
    else riskLevel = 'extreme';

    return { riskLevel, riskFactors };
  }

  /**
   * Assess entry timing quality
   */
  private assessTiming(
    indicators: TechnicalIndicators,
    structure: MarketStructure,
    action: SignalAction
  ): { entryTiming: 'excellent' | 'good' | 'fair' | 'poor'; timingReasoning: string } {
    let score = 0;
    const reasons: string[] = [];

    if (action === 'BUY') {
      // Good buy timing
      if (indicators.rsi14 < 40) {
        score += 2;
        reasons.push('RSI favorable');
      }
      if (indicators.currentPrice <= indicators.bollingerLower * 1.01) {
        score += 2;
        reasons.push('At Bollinger support');
      }
      if (structure.distanceToSupport < 1) {
        score += 1;
        reasons.push('Near support');
      }
      if (indicators.stochK < 30) {
        score += 1;
        reasons.push('Stochastic oversold');
      }
    } else if (action === 'SELL') {
      // Good sell timing
      if (indicators.rsi14 > 60) {
        score += 2;
        reasons.push('RSI favorable');
      }
      if (indicators.currentPrice >= indicators.bollingerUpper * 0.99) {
        score += 2;
        reasons.push('At Bollinger resistance');
      }
      if (structure.distanceToResistance < 1) {
        score += 1;
        reasons.push('Near resistance');
      }
      if (indicators.stochK > 70) {
        score += 1;
        reasons.push('Stochastic overbought');
      }
    }

    let entryTiming: 'excellent' | 'good' | 'fair' | 'poor';
    if (score >= 4) entryTiming = 'excellent';
    else if (score >= 2) entryTiming = 'good';
    else if (score >= 1) entryTiming = 'fair';
    else entryTiming = 'poor';

    return {
      entryTiming,
      timingReasoning: reasons.length > 0 ? reasons.join(', ') : 'No specific timing factors',
    };
  }

  /**
   * Adjust price targets based on market structure
   */
  private adjustPriceTargets(
    signal: TradingSignal,
    indicators: TechnicalIndicators,
    structure: MarketStructure
  ): { entry: number; target: number; stopLoss: number } {
    let entry = signal.entry_price;
    let target = signal.target_price;
    let stopLoss = signal.stop_loss;

    if (signal.action === 'BUY') {
      // Adjust target to resistance if closer
      if (structure.nearestResistance < target && structure.nearestResistance > entry) {
        target = structure.nearestResistance * 0.99; // Just below resistance
      }

      // Adjust stop to below support if better
      if (structure.nearestSupport < stopLoss && structure.nearestSupport < entry) {
        stopLoss = structure.nearestSupport * 0.99; // Just below support
      }
    } else if (signal.action === 'SELL') {
      // Adjust target to support if closer
      if (structure.nearestSupport > target && structure.nearestSupport < entry) {
        target = structure.nearestSupport * 1.01; // Just above support
      }

      // Adjust stop to above resistance if better
      if (structure.nearestResistance > stopLoss && structure.nearestResistance > entry) {
        stopLoss = structure.nearestResistance * 1.01; // Just above resistance
      }
    }

    return { entry, target, stopLoss };
  }

  /**
   * Record signal for accuracy tracking
   */
  private recordSignal(signal: TradingSignal, validation: ValidationResult): void {
    const record: SignalAccuracyRecord = {
      signalId: signal.id,
      symbol: signal.symbol,
      pattern: signal.pattern,
      action: signal.action,
      confidence: signal.confidence,
      validatedConfidence: validation.validatedConfidence,
      entryPrice: validation.adjustedEntry ?? signal.entry_price,
      targetPrice: validation.adjustedTarget ?? signal.target_price,
      stopLossPrice: validation.adjustedStopLoss ?? signal.stop_loss,
      signalTimestamp: signal.timestamp,
      consensusLevel: validation.consensusLevel,
      votesCount: validation.votes.length,
      agreeingVotes: validation.votes.filter((v) => v.action === signal.action).length,
    };

    this.accuracyRecords.set(signal.id, record);
  }

  /**
   * Update signal outcome for accuracy tracking
   */
  updateOutcome(
    signalId: string,
    exitPrice: number,
    exitReason: 'target_hit' | 'stop_hit' | 'timeout' | 'manual'
  ): void {
    const record = this.accuracyRecords.get(signalId);
    if (!record) return;

    record.actualExitPrice = exitPrice;
    record.exitReason = exitReason;
    record.exitTimestamp = new Date();

    // Calculate result
    const pnl = record.action === 'BUY'
      ? exitPrice - record.entryPrice
      : record.entryPrice - exitPrice;

    record.pnlPercent = (pnl / record.entryPrice) * 100;
    record.wasSuccessful = exitReason === 'target_hit' || (exitReason !== 'stop_hit' && pnl > 0);
    record.holdingPeriodHours =
      (record.exitTimestamp.getTime() - record.signalTimestamp.getTime()) / (1000 * 60 * 60);

    this.accuracyRecords.set(signalId, record);
  }

  /**
   * Get accuracy statistics
   */
  getAccuracyStats(): AccuracyStats {
    const records = Array.from(this.accuracyRecords.values());
    const resolved = records.filter((r) => r.wasSuccessful !== undefined);

    if (resolved.length === 0) {
      return {
        totalSignals: records.length,
        resolvedSignals: 0,
        overallAccuracy: 0,
        buyAccuracy: 0,
        sellAccuracy: 0,
        patternAccuracy: {},
        highConfidenceAccuracy: 0,
        mediumConfidenceAccuracy: 0,
        lowConfidenceAccuracy: 0,
        strongConsensusAccuracy: 0,
        moderateConsensusAccuracy: 0,
        weakConsensusAccuracy: 0,
        averagePnl: 0,
        averageHoldingPeriod: 0,
        last7DaysAccuracy: 0,
        last30DaysAccuracy: 0,
      };
    }

    const successful = resolved.filter((r) => r.wasSuccessful);

    // By action
    const buys = resolved.filter((r) => r.action === 'BUY');
    const sells = resolved.filter((r) => r.action === 'SELL');

    // By confidence
    const highConf = resolved.filter((r) => r.confidence >= 0.8);
    const medConf = resolved.filter((r) => r.confidence >= 0.6 && r.confidence < 0.8);
    const lowConf = resolved.filter((r) => r.confidence < 0.6);

    // By consensus
    const strongCons = resolved.filter((r) => r.consensusLevel >= 0.8);
    const modCons = resolved.filter((r) => r.consensusLevel >= 0.6 && r.consensusLevel < 0.8);
    const weakCons = resolved.filter((r) => r.consensusLevel < 0.6);

    // By pattern
    const patterns = new Set(resolved.map((r) => r.pattern));
    const patternAccuracy: Record<string, number> = {};
    for (const pattern of patterns) {
      const patternRecords = resolved.filter((r) => r.pattern === pattern);
      const patternSuccessful = patternRecords.filter((r) => r.wasSuccessful);
      patternAccuracy[pattern] = patternSuccessful.length / patternRecords.length;
    }

    // Time-based
    const now = Date.now();
    const last7Days = resolved.filter(
      (r) => now - r.signalTimestamp.getTime() < 7 * 24 * 60 * 60 * 1000
    );
    const last30Days = resolved.filter(
      (r) => now - r.signalTimestamp.getTime() < 30 * 24 * 60 * 60 * 1000
    );

    const calcAccuracy = (arr: SignalAccuracyRecord[]) =>
      arr.length > 0 ? arr.filter((r) => r.wasSuccessful).length / arr.length : 0;

    return {
      totalSignals: records.length,
      resolvedSignals: resolved.length,
      overallAccuracy: successful.length / resolved.length,
      buyAccuracy: calcAccuracy(buys),
      sellAccuracy: calcAccuracy(sells),
      patternAccuracy,
      highConfidenceAccuracy: calcAccuracy(highConf),
      mediumConfidenceAccuracy: calcAccuracy(medConf),
      lowConfidenceAccuracy: calcAccuracy(lowConf),
      strongConsensusAccuracy: calcAccuracy(strongCons),
      moderateConsensusAccuracy: calcAccuracy(modCons),
      weakConsensusAccuracy: calcAccuracy(weakCons),
      averagePnl: resolved.reduce((sum, r) => sum + (r.pnlPercent ?? 0), 0) / resolved.length,
      averageHoldingPeriod:
        resolved.reduce((sum, r) => sum + (r.holdingPeriodHours ?? 0), 0) / resolved.length,
      last7DaysAccuracy: calcAccuracy(last7Days),
      last30DaysAccuracy: calcAccuracy(last30Days),
    };
  }

  /**
   * Clear accuracy records
   */
  clearAccuracyRecords(): void {
    this.accuracyRecords.clear();
  }
}
