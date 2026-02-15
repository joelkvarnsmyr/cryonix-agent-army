import type { SignalAction, TradingSignal } from '@cryonix/types';
import type { SourceVote, ValidationSource } from './types';

/**
 * Consensus Engine
 * Implements weighted voting system for multi-source signal validation
 */

export interface ValidatorWeight {
  source: ValidationSource;
  weight: number;
  minConfidenceRequired: number;
}

export interface ConsensusScore {
  /** Overall consensus score (0-100) */
  score: number;

  /** Recommended action based on voting */
  recommendedAction: SignalAction;

  /** Final recommendation after applying thresholds */
  recommendation: 'EXECUTE' | 'REJECT' | 'REVIEW';

  /** Confidence in the recommendation (0-1) */
  confidence: number;

  /** Detailed reasoning */
  reasoning: string;

  /** Vote breakdown */
  voteBreakdown: {
    total: number;
    buy: number;
    sell: number;
    wait: number;
    agreeing: number;
  };

  /** Sentiment breakdown */
  sentiment: {
    bullish: number;
    bearish: number;
    neutral: number;
  };
}

export interface ConsensusConfig {
  /** Minimum votes required for consensus (e.g., 3 out of 5) */
  minVotesRequired: number;

  /** Minimum consensus score to execute (0-100) */
  executeThreshold: number;

  /** Minimum consensus score to review (below this = reject) */
  reviewThreshold: number;

  /** Minimum confidence required */
  minConfidence: number;

  /** Weight configuration for each validator */
  weights: ValidatorWeight[];

  /** Whether to require majority in same direction as original signal */
  requireSignalAlignment: boolean;

  /** Penalty for votes against original signal direction */
  contraSignalPenalty: number;
}

export const DEFAULT_CONSENSUS_CONFIG: ConsensusConfig = {
  minVotesRequired: 3,
  executeThreshold: 70,
  reviewThreshold: 50,
  minConfidence: 0.5,
  weights: [
    { source: 'pattern_detector', weight: 0.25, minConfidenceRequired: 0.6 },
    { source: 'technical_indicators', weight: 0.25, minConfidenceRequired: 0.5 },
    { source: 'ai_analysis', weight: 0.20, minConfidenceRequired: 0.5 },
    { source: 'market_structure', weight: 0.15, minConfidenceRequired: 0.4 },
    { source: 'volume_analysis', weight: 0.10, minConfidenceRequired: 0.4 },
    { source: 'momentum_analysis', weight: 0.05, minConfidenceRequired: 0.4 },
  ],
  requireSignalAlignment: true,
  contraSignalPenalty: 0.3,
};

export class ConsensusEngine {
  private config: ConsensusConfig;

  constructor(config?: Partial<ConsensusConfig>) {
    this.config = { ...DEFAULT_CONSENSUS_CONFIG, ...config };
  }

  /**
   * Calculate consensus from multiple validator votes
   */
  calculateConsensus(votes: SourceVote[], originalSignal: TradingSignal): ConsensusScore {
    // Filter valid votes (meeting minimum confidence)
    const validVotes = this.filterValidVotes(votes);

    if (validVotes.length < this.config.minVotesRequired) {
      return this.createRejectResult(
        `Insufficient valid votes: ${validVotes.length}/${this.config.minVotesRequired} required`,
        validVotes
      );
    }

    // Calculate weighted votes
    const weightedResults = this.calculateWeightedVotes(validVotes);

    // Determine recommended action
    const recommendedAction = this.determineAction(weightedResults);

    // Calculate consensus score
    const score = this.calculateScore(validVotes, weightedResults, originalSignal, recommendedAction);

    // Calculate confidence
    const confidence = this.calculateConfidence(validVotes, weightedResults);

    // Determine recommendation
    const recommendation = this.determineRecommendation(score, confidence, recommendedAction, originalSignal);

    // Generate reasoning
    const reasoning = this.generateReasoning(
      validVotes,
      weightedResults,
      score,
      recommendation,
      originalSignal
    );

    // Vote breakdown
    const voteBreakdown = {
      total: validVotes.length,
      buy: validVotes.filter(v => v.action === 'BUY').length,
      sell: validVotes.filter(v => v.action === 'SELL').length,
      wait: validVotes.filter(v => v.action === 'WAIT').length,
      agreeing: validVotes.filter(v => v.action === originalSignal.action).length,
    };

    return {
      score,
      recommendedAction,
      recommendation,
      confidence,
      reasoning,
      voteBreakdown,
      sentiment: {
        bullish: weightedResults.bullishWeight,
        bearish: weightedResults.bearishWeight,
        neutral: weightedResults.neutralWeight,
      },
    };
  }

  /**
   * Filter votes that meet minimum confidence requirements
   */
  private filterValidVotes(votes: SourceVote[]): SourceVote[] {
    return votes.filter(vote => {
      const weightConfig = this.config.weights.find(w => w.source === vote.source);
      if (!weightConfig) return false;
      return vote.confidence >= weightConfig.minConfidenceRequired;
    });
  }

  /**
   * Calculate weighted vote totals
   */
  private calculateWeightedVotes(votes: SourceVote[]): {
    bullishWeight: number;
    bearishWeight: number;
    neutralWeight: number;
    totalWeight: number;
    bullishConfidenceSum: number;
    bearishConfidenceSum: number;
  } {
    let bullishWeight = 0;
    let bearishWeight = 0;
    let neutralWeight = 0;
    let totalWeight = 0;
    let bullishConfidenceSum = 0;
    let bearishConfidenceSum = 0;

    for (const vote of votes) {
      const weightConfig = this.config.weights.find(w => w.source === vote.source);
      const weight = weightConfig?.weight ?? 0.1;
      const weightedConfidence = vote.confidence * weight;

      totalWeight += weight;

      if (vote.action === 'BUY') {
        bullishWeight += weight;
        bullishConfidenceSum += weightedConfidence;
      } else if (vote.action === 'SELL') {
        bearishWeight += weight;
        bearishConfidenceSum += weightedConfidence;
      } else {
        neutralWeight += weight;
      }
    }

    // Normalize to percentages
    if (totalWeight > 0) {
      bullishWeight = bullishWeight / totalWeight;
      bearishWeight = bearishWeight / totalWeight;
      neutralWeight = neutralWeight / totalWeight;
    }

    return {
      bullishWeight,
      bearishWeight,
      neutralWeight,
      totalWeight,
      bullishConfidenceSum,
      bearishConfidenceSum,
    };
  }

  /**
   * Determine recommended action based on weighted votes
   */
  private determineAction(weightedResults: {
    bullishWeight: number;
    bearishWeight: number;
    neutralWeight: number;
  }): SignalAction {
    const { bullishWeight, bearishWeight, neutralWeight } = weightedResults;

    if (bullishWeight > bearishWeight && bullishWeight > neutralWeight) {
      return 'BUY';
    } else if (bearishWeight > bullishWeight && bearishWeight > neutralWeight) {
      return 'SELL';
    }
    return 'WAIT';
  }

  /**
   * Calculate consensus score (0-100)
   */
  private calculateScore(
    votes: SourceVote[],
    weightedResults: {
      bullishWeight: number;
      bearishWeight: number;
      neutralWeight: number;
      totalWeight: number;
    },
    originalSignal: TradingSignal,
    recommendedAction: SignalAction
  ): number {
    // Base score from dominant direction strength
    const dominantWeight = Math.max(
      weightedResults.bullishWeight,
      weightedResults.bearishWeight,
      weightedResults.neutralWeight
    );

    let score = dominantWeight * 100;

    // Average confidence bonus (up to +20 points)
    const avgConfidence = votes.reduce((sum, v) => sum + v.confidence, 0) / votes.length;
    score += avgConfidence * 20;

    // Agreement bonus (up to +15 points)
    const agreeingVotes = votes.filter(v => v.action === recommendedAction).length;
    const agreementRatio = agreeingVotes / votes.length;
    score += agreementRatio * 15;

    // Signal alignment bonus/penalty
    if (this.config.requireSignalAlignment) {
      if (recommendedAction === originalSignal.action) {
        score += 10; // Bonus for alignment
      } else if (
        (recommendedAction === 'BUY' && originalSignal.action === 'SELL') ||
        (recommendedAction === 'SELL' && originalSignal.action === 'BUY')
      ) {
        score -= this.config.contraSignalPenalty * 100; // Penalty for opposite direction
      }
    }

    // Clamp to 0-100
    return Math.max(0, Math.min(100, score));
  }

  /**
   * Calculate overall confidence
   */
  private calculateConfidence(
    votes: SourceVote[],
    weightedResults: { bullishWeight: number; bearishWeight: number; totalWeight: number }
  ): number {
    // Weighted average confidence
    let weightedConfSum = 0;
    let totalWeight = 0;

    for (const vote of votes) {
      const weightConfig = this.config.weights.find(w => w.source === vote.source);
      const weight = weightConfig?.weight ?? 0.1;
      weightedConfSum += vote.confidence * weight;
      totalWeight += weight;
    }

    const avgConfidence = totalWeight > 0 ? weightedConfSum / totalWeight : 0.5;

    // Adjust by how decisive the vote is
    const directionStrength = Math.abs(weightedResults.bullishWeight - weightedResults.bearishWeight);
    const confidenceMultiplier = 0.7 + directionStrength * 0.3;

    return Math.min(0.95, avgConfidence * confidenceMultiplier);
  }

  /**
   * Determine final recommendation
   */
  private determineRecommendation(
    score: number,
    confidence: number,
    recommendedAction: SignalAction,
    originalSignal: TradingSignal
  ): 'EXECUTE' | 'REJECT' | 'REVIEW' {
    // WAIT action always goes to review
    if (recommendedAction === 'WAIT') {
      return 'REVIEW';
    }

    // Check confidence threshold
    if (confidence < this.config.minConfidence) {
      return 'REVIEW';
    }

    // Check score thresholds
    if (score >= this.config.executeThreshold) {
      // If action differs from original signal, recommend review instead
      if (recommendedAction !== originalSignal.action && this.config.requireSignalAlignment) {
        return 'REVIEW';
      }
      return 'EXECUTE';
    } else if (score >= this.config.reviewThreshold) {
      return 'REVIEW';
    }

    return 'REJECT';
  }

  /**
   * Generate human-readable reasoning
   */
  private generateReasoning(
    votes: SourceVote[],
    weightedResults: {
      bullishWeight: number;
      bearishWeight: number;
      neutralWeight: number;
    },
    score: number,
    recommendation: 'EXECUTE' | 'REJECT' | 'REVIEW',
    originalSignal: TradingSignal
  ): string {
    const parts: string[] = [];

    // Vote summary
    const buyVotes = votes.filter(v => v.action === 'BUY').length;
    const sellVotes = votes.filter(v => v.action === 'SELL').length;
    const waitVotes = votes.filter(v => v.action === 'WAIT').length;
    parts.push(`Votes: ${buyVotes} BUY, ${sellVotes} SELL, ${waitVotes} WAIT`);

    // Sentiment summary
    const bullPct = (weightedResults.bullishWeight * 100).toFixed(0);
    const bearPct = (weightedResults.bearishWeight * 100).toFixed(0);
    parts.push(`Weighted sentiment: ${bullPct}% bullish, ${bearPct}% bearish`);

    // Score and recommendation
    parts.push(`Consensus score: ${score.toFixed(0)}/100`);

    // Alignment check
    const agreedVotes = votes.filter(v => v.action === originalSignal.action).length;
    parts.push(`Signal agreement: ${agreedVotes}/${votes.length} validators agree with ${originalSignal.action}`);

    // Recommendation explanation
    switch (recommendation) {
      case 'EXECUTE':
        parts.push('Strong consensus reached - recommended to execute');
        break;
      case 'REVIEW':
        parts.push('Mixed signals - manual review recommended');
        break;
      case 'REJECT':
        parts.push('Consensus not reached - signal rejected');
        break;
    }

    return parts.join('. ') + '.';
  }

  /**
   * Create a reject result with given reason
   */
  private createRejectResult(reason: string, votes: SourceVote[]): ConsensusScore {
    return {
      score: 0,
      recommendedAction: 'WAIT',
      recommendation: 'REJECT',
      confidence: 0,
      reasoning: reason,
      voteBreakdown: {
        total: votes.length,
        buy: votes.filter(v => v.action === 'BUY').length,
        sell: votes.filter(v => v.action === 'SELL').length,
        wait: votes.filter(v => v.action === 'WAIT').length,
        agreeing: 0,
      },
      sentiment: {
        bullish: 0,
        bearish: 0,
        neutral: 1,
      },
    };
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<ConsensusConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration
   */
  getConfig(): ConsensusConfig {
    return { ...this.config };
  }
}
