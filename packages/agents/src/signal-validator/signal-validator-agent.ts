import { BaseAgent } from '../base-agent';
import type { AgentMessage, TradingSignal, SignalAction } from '@cryonix/types';
import type { OhlcvData } from '../market-scout/pattern-detectors';
import { calculateTechnicalIndicators, analyzeMarketStructure } from './technical-indicators';
import { TechnicalValidator } from './validators/technical-validator';
import { SentimentValidator, type SentimentData } from './validators/sentiment-validator';
import { ConsensusEngine, type ConsensusScore } from './consensus-engine';
import type {
  ValidationResult,
  ValidationConfig,
  SourceVote,
  TechnicalIndicators,
  MarketStructure,
} from './types';

/**
 * Signal Validator Agent
 * Extends BaseAgent to provide multi-source signal validation
 *
 * Receives signals from MarketScout, validates against multiple sources,
 * and returns consensus score with recommendation
 */

export interface SignalValidatorAgentConfig {
  /** Validation configuration */
  validationConfig?: Partial<ValidationConfig>;

  /** Enable real-time validation (process incoming signals immediately) */
  enableRealTimeValidation: boolean;

  /** Maximum queue size for pending validations */
  maxQueueSize: number;

  /** Validation timeout in milliseconds */
  validationTimeout: number;

  /** Enable sentiment analysis (requires API integration) */
  enableSentiment: boolean;

  /** Auto-emit validated signals */
  autoEmitValidated: boolean;
}

const DEFAULT_AGENT_CONFIG: SignalValidatorAgentConfig = {
  enableRealTimeValidation: true,
  maxQueueSize: 100,
  validationTimeout: 30000,
  enableSentiment: false,
  autoEmitValidated: true,
};

interface ValidationQueueItem {
  signal: TradingSignal;
  candles: OhlcvData[];
  timestamp: Date;
  resolve: (result: ValidationResult) => void;
  reject: (error: Error) => void;
}

export class SignalValidatorAgent extends BaseAgent {
  private agentConfig: SignalValidatorAgentConfig;
  private technicalValidator: TechnicalValidator;
  private sentimentValidator: SentimentValidator;
  private consensusEngine: ConsensusEngine;
  private validationQueue: ValidationQueueItem[] = [];
  private isProcessing: boolean = false;
  private validatedCount: number = 0;
  private rejectedCount: number = 0;
  private reviewCount: number = 0;

  constructor(config?: Partial<SignalValidatorAgentConfig>) {
    super({
      id: 'signal_validator' as any, // Will be added to AgentId type
      name: 'Signal Validator Agent',
      description: 'Multi-source signal validation with consensus engine',
      enabled: true,
    });

    this.agentConfig = { ...DEFAULT_AGENT_CONFIG, ...config };
    this.technicalValidator = new TechnicalValidator();
    this.sentimentValidator = new SentimentValidator();
    this.consensusEngine = new ConsensusEngine();
  }

  async initialize(): Promise<void> {
    this.log('info', 'Initializing Signal Validator Agent...');
    this.setStatus('idle');
    this.log('info', 'Signal Validator Agent initialized');
  }

  async start(): Promise<void> {
    this.log('info', 'Starting Signal Validator Agent...');
    this.setStatus('running');

    if (this.agentConfig.enableRealTimeValidation) {
      this.startQueueProcessor();
    }

    this.log('info', 'Signal Validator Agent started');
  }

  async stop(): Promise<void> {
    this.log('info', 'Stopping Signal Validator Agent...');
    this.isProcessing = false;

    // Clear pending validations
    for (const item of this.validationQueue) {
      item.reject(new Error('Agent stopped'));
    }
    this.validationQueue = [];

    this.setStatus('idle');
    this.log('info', 'Signal Validator Agent stopped');
  }

  async handleMessage(message: AgentMessage): Promise<void> {
    this.log('info', 'Received message', { type: message.message_type });

    switch (message.message_type) {
      case 'VALIDATE_SIGNAL':
        await this.handleValidateSignal(message.data);
        break;

      case 'BATCH_VALIDATE':
        await this.handleBatchValidate(message.data);
        break;

      case 'GET_STATS':
        this.emitStats();
        break;

      case 'UPDATE_CONFIG':
        this.updateConfig(message.data);
        break;

      default:
        this.log('warn', `Unknown message type: ${message.message_type}`);
    }
  }

  /**
   * Validate a trading signal with multi-source consensus
   */
  async validateSignal(signal: TradingSignal, candles: OhlcvData[]): Promise<ValidationResult> {
    const startTime = Date.now();

    try {
      // Calculate technical indicators
      const indicators = calculateTechnicalIndicators(candles);

      // Analyze market structure
      const marketStructure = analyzeMarketStructure(candles, indicators);

      // Collect votes from all validators
      const votes: SourceVote[] = [];

      // 1. Pattern detector vote (original signal)
      votes.push(this.createPatternVote(signal));

      // 2. Technical validator vote
      const technicalVote = this.technicalValidator.validate(indicators, signal.action);
      votes.push(technicalVote);

      // 3. Market structure vote
      votes.push(this.createMarketStructureVote(marketStructure, indicators, signal));

      // 4. Volume analysis vote
      votes.push(this.createVolumeVote(indicators));

      // 5. Momentum analysis vote
      votes.push(this.createMomentumVote(indicators));

      // 6. Sentiment analysis vote (if enabled)
      if (this.agentConfig.enableSentiment) {
        const sentimentData = await this.sentimentValidator.fetchSentimentData(signal.symbol);
        const sentimentVote = this.sentimentValidator.validate(sentimentData ?? undefined, signal.symbol);
        votes.push(sentimentVote);
      }

      // Calculate consensus
      const consensus = this.consensusEngine.calculateConsensus(votes, signal);

      // Assess risk
      const { riskLevel, riskFactors } = this.assessRisk(indicators, marketStructure, signal);

      // Assess entry timing
      const { entryTiming, timingReasoning } = this.assessTiming(
        indicators,
        marketStructure,
        consensus.recommendedAction
      );

      // Adjust price targets if needed
      const { adjustedEntry, adjustedTarget, adjustedStopLoss } = this.adjustPriceTargets(
        signal,
        indicators,
        marketStructure
      );

      // Determine if signal is valid
      const isValid = consensus.recommendation === 'EXECUTE';

      const result: ValidationResult = {
        isValid,
        originalSignal: signal,
        validatedAction: consensus.recommendedAction,
        validatedConfidence: consensus.confidence,
        votes,
        consensusLevel: consensus.score / 100,
        bullishSentiment: consensus.sentiment.bullish,
        bearishSentiment: consensus.sentiment.bearish,
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

      // Update stats
      if (consensus.recommendation === 'EXECUTE') {
        this.validatedCount++;
      } else if (consensus.recommendation === 'REJECT') {
        this.rejectedCount++;
      } else {
        this.reviewCount++;
      }

      // Emit result if configured
      if (this.agentConfig.autoEmitValidated) {
        this.emit('signal_validated', {
          result,
          consensus,
        });
      }

      this.log('info', `Signal validated: ${signal.symbol} - ${consensus.recommendation}`, {
        score: consensus.score,
        recommendation: consensus.recommendation,
        processingTimeMs: result.processingTimeMs,
      });

      return result;
    } catch (error) {
      this.log('error', `Error validating signal for ${signal.symbol}`, error);
      throw error;
    }
  }

  /**
   * Queue a signal for validation
   */
  queueValidation(signal: TradingSignal, candles: OhlcvData[]): Promise<ValidationResult> {
    return new Promise((resolve, reject) => {
      if (this.validationQueue.length >= this.agentConfig.maxQueueSize) {
        reject(new Error('Validation queue full'));
        return;
      }

      this.validationQueue.push({
        signal,
        candles,
        timestamp: new Date(),
        resolve,
        reject,
      });
    });
  }

  /**
   * Get validation statistics
   */
  getStats(): {
    validated: number;
    rejected: number;
    review: number;
    queueLength: number;
    successRate: number;
  } {
    const total = this.validatedCount + this.rejectedCount + this.reviewCount;
    return {
      validated: this.validatedCount,
      rejected: this.rejectedCount,
      review: this.reviewCount,
      queueLength: this.validationQueue.length,
      successRate: total > 0 ? this.validatedCount / total : 0,
    };
  }

  // ============================================================================
  // PRIVATE METHODS
  // ============================================================================

  private async handleValidateSignal(data: { signal: TradingSignal; candles: OhlcvData[] }): Promise<void> {
    try {
      const result = await this.validateSignal(data.signal, data.candles);
      this.emit('validation_complete', result);
    } catch (error) {
      this.emit('validation_error', { signal: data.signal, error });
    }
  }

  private async handleBatchValidate(
    data: Array<{ signal: TradingSignal; candles: OhlcvData[] }>
  ): Promise<void> {
    const results: ValidationResult[] = [];
    const errors: Array<{ signal: TradingSignal; error: any }> = [];

    for (const item of data) {
      try {
        const result = await this.validateSignal(item.signal, item.candles);
        results.push(result);
      } catch (error) {
        errors.push({ signal: item.signal, error });
      }
    }

    this.emit('batch_validation_complete', { results, errors });
  }

  private startQueueProcessor(): void {
    this.isProcessing = true;

    const processQueue = async () => {
      while (this.isProcessing) {
        const item = this.validationQueue.shift();

        if (item) {
          try {
            const result = await this.validateSignal(item.signal, item.candles);
            item.resolve(result);
          } catch (error) {
            item.reject(error as Error);
          }
        } else {
          // Wait a bit before checking again
          await this.sleep(100);
        }
      }
    };

    processQueue().catch(err => {
      this.log('error', 'Queue processor error', err);
    });
  }

  private emitStats(): void {
    this.emit('stats', this.getStats());
  }

  private updateConfig(config: Partial<SignalValidatorAgentConfig>): void {
    this.agentConfig = { ...this.agentConfig, ...config };
    this.log('info', 'Configuration updated');
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
   * Create vote from market structure analysis
   */
  private createMarketStructureVote(
    structure: MarketStructure,
    indicators: TechnicalIndicators,
    signal: TradingSignal
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

    // Support/Resistance proximity adjustments
    if (structure.distanceToSupport < 1) {
      if (action === 'SELL') {
        confidence -= 0.15;
        reasoning.push('Warning: selling near support');
      } else {
        confidence += 0.1;
        reasoning.push('Near support level - potential bounce');
      }
    }

    if (structure.distanceToResistance < 1) {
      if (action === 'BUY') {
        confidence -= 0.15;
        reasoning.push('Warning: buying near resistance');
      } else {
        confidence += 0.1;
        reasoning.push('Near resistance level - watch for rejection');
      }
    }

    // Volatility impact
    if (structure.volatilityState === 'extreme') {
      confidence *= 0.8;
      reasoning.push('Extreme volatility - reduced confidence');
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
  private createVolumeVote(indicators: TechnicalIndicators): SourceVote {
    const reasoning: string[] = [];
    let bullishBias = 0;
    let bearishBias = 0;

    // Volume ratio analysis
    if (indicators.volumeRatio > 2) {
      reasoning.push(`High volume spike (${indicators.volumeRatio.toFixed(1)}x average)`);
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
  private createMomentumVote(indicators: TechnicalIndicators): SourceVote {
    const reasoning: string[] = [];
    let momentumScore = 0;

    // MACD momentum
    if (indicators.macdHistogram > 0) {
      momentumScore += 1;
      if (Math.abs(indicators.macdHistogram) > Math.abs(indicators.macd) * 0.1) {
        momentumScore += 0.5;
        reasoning.push('Strong bullish MACD momentum');
      }
    } else {
      momentumScore -= 1;
      if (Math.abs(indicators.macdHistogram) > Math.abs(indicators.macd) * 0.1) {
        momentumScore -= 0.5;
        reasoning.push('Strong bearish MACD momentum');
      }
    }

    // RSI momentum
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
   * Assess risk level
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
   * Assess entry timing
   */
  private assessTiming(
    indicators: TechnicalIndicators,
    structure: MarketStructure,
    action: SignalAction
  ): { entryTiming: 'excellent' | 'good' | 'fair' | 'poor'; timingReasoning: string } {
    let score = 0;
    const reasons: string[] = [];

    if (action === 'BUY') {
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
  ): { adjustedEntry?: number; adjustedTarget?: number; adjustedStopLoss?: number } {
    let entry = signal.entry_price;
    let target = signal.target_price;
    let stopLoss = signal.stop_loss;

    if (signal.action === 'BUY') {
      // Adjust target to resistance if closer
      if (structure.nearestResistance < target && structure.nearestResistance > entry) {
        target = structure.nearestResistance * 0.99;
      }

      // Adjust stop to below support if better
      if (structure.nearestSupport < stopLoss && structure.nearestSupport < entry) {
        stopLoss = structure.nearestSupport * 0.99;
      }
    } else if (signal.action === 'SELL') {
      // Adjust target to support if closer
      if (structure.nearestSupport > target && structure.nearestSupport < entry) {
        target = structure.nearestSupport * 1.01;
      }

      // Adjust stop to above resistance if better
      if (structure.nearestResistance > stopLoss && structure.nearestResistance > entry) {
        stopLoss = structure.nearestResistance * 1.01;
      }
    }

    return {
      adjustedEntry: entry,
      adjustedTarget: target,
      adjustedStopLoss: stopLoss,
    };
  }
}
