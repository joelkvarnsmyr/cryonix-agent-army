import type { SignalAction } from '@cryonix/types';
import type { TechnicalIndicators, SourceVote, ValidationSource } from '../types';

/**
 * Technical Analysis Validator
 * Validates signals against RSI, MACD, Moving Averages, and Volume indicators
 */

export interface TechnicalValidationConfig {
  rsiOversold: number;
  rsiOverbought: number;
  macdWeight: number;
  rsiWeight: number;
  maWeight: number;
  volumeWeight: number;
}

export const DEFAULT_TECHNICAL_CONFIG: TechnicalValidationConfig = {
  rsiOversold: 30,
  rsiOverbought: 70,
  macdWeight: 0.3,
  rsiWeight: 0.3,
  maWeight: 0.25,
  volumeWeight: 0.15,
};

export class TechnicalValidator {
  private config: TechnicalValidationConfig;

  constructor(config?: Partial<TechnicalValidationConfig>) {
    this.config = { ...DEFAULT_TECHNICAL_CONFIG, ...config };
  }

  /**
   * Validate signal using technical indicators
   */
  validate(indicators: TechnicalIndicators, proposedAction: SignalAction): SourceVote {
    const rsiResult = this.validateRSI(indicators);
    const macdResult = this.validateMACD(indicators);
    const maResult = this.validateMovingAverages(indicators);
    const volumeResult = this.validateVolume(indicators);

    // Weighted scoring
    const bullishScore =
      rsiResult.bullishScore * this.config.rsiWeight +
      macdResult.bullishScore * this.config.macdWeight +
      maResult.bullishScore * this.config.maWeight +
      volumeResult.bullishScore * this.config.volumeWeight;

    const bearishScore =
      rsiResult.bearishScore * this.config.rsiWeight +
      macdResult.bearishScore * this.config.macdWeight +
      maResult.bearishScore * this.config.maWeight +
      volumeResult.bearishScore * this.config.volumeWeight;

    // Collect reasoning
    const reasoning: string[] = [
      ...rsiResult.reasoning,
      ...macdResult.reasoning,
      ...maResult.reasoning,
      ...volumeResult.reasoning,
    ];

    // Determine action
    let action: SignalAction;
    let confidence: number;

    const totalScore = bullishScore + bearishScore;
    if (totalScore === 0) {
      action = 'WAIT';
      confidence = 0.5;
    } else if (bullishScore > bearishScore * 1.2) {
      action = 'BUY';
      confidence = Math.min(0.9, 0.5 + (bullishScore - bearishScore) / totalScore * 0.4);
    } else if (bearishScore > bullishScore * 1.2) {
      action = 'SELL';
      confidence = Math.min(0.9, 0.5 + (bearishScore - bullishScore) / totalScore * 0.4);
    } else {
      action = 'WAIT';
      confidence = 0.5;
    }

    return {
      source: 'technical_indicators' as ValidationSource,
      action,
      confidence,
      reasoning,
      indicators: {
        rsi14: indicators.rsi14,
        macd: indicators.macd,
        macdHistogram: indicators.macdHistogram,
        sma20: indicators.sma20,
        sma50: indicators.sma50,
        sma200: indicators.sma200,
        volumeRatio: indicators.volumeRatio,
      },
    };
  }

  /**
   * RSI Confirmation
   * Validates oversold/overbought conditions
   */
  private validateRSI(indicators: TechnicalIndicators): {
    bullishScore: number;
    bearishScore: number;
    reasoning: string[];
  } {
    const { rsi14 } = indicators;
    const reasoning: string[] = [];
    let bullishScore = 0;
    let bearishScore = 0;

    // Strong oversold - bullish
    if (rsi14 < 20) {
      bullishScore += 1.0;
      reasoning.push(`RSI extremely oversold (${rsi14.toFixed(1)}) - strong bullish signal`);
    } else if (rsi14 < this.config.rsiOversold) {
      bullishScore += 0.7;
      reasoning.push(`RSI oversold (${rsi14.toFixed(1)}) - bullish signal`);
    } else if (rsi14 < 40) {
      bullishScore += 0.3;
      reasoning.push(`RSI approaching oversold (${rsi14.toFixed(1)})`);
    }

    // Strong overbought - bearish
    if (rsi14 > 80) {
      bearishScore += 1.0;
      reasoning.push(`RSI extremely overbought (${rsi14.toFixed(1)}) - strong bearish signal`);
    } else if (rsi14 > this.config.rsiOverbought) {
      bearishScore += 0.7;
      reasoning.push(`RSI overbought (${rsi14.toFixed(1)}) - bearish signal`);
    } else if (rsi14 > 60) {
      bearishScore += 0.3;
      reasoning.push(`RSI approaching overbought (${rsi14.toFixed(1)})`);
    }

    // Neutral zone
    if (rsi14 >= 40 && rsi14 <= 60) {
      reasoning.push(`RSI neutral zone (${rsi14.toFixed(1)})`);
    }

    return { bullishScore, bearishScore, reasoning };
  }

  /**
   * MACD Crossover Validation
   * Validates MACD line crossovers and histogram direction
   */
  private validateMACD(indicators: TechnicalIndicators): {
    bullishScore: number;
    bearishScore: number;
    reasoning: string[];
  } {
    const { macd, macdSignal, macdHistogram } = indicators;
    const reasoning: string[] = [];
    let bullishScore = 0;
    let bearishScore = 0;

    // MACD line above signal line - bullish
    if (macd > macdSignal) {
      bullishScore += 0.5;
      reasoning.push('MACD above signal line - bullish');

      // Histogram positive and increasing
      if (macdHistogram > 0) {
        bullishScore += 0.3;
        reasoning.push(`MACD histogram positive (${macdHistogram.toFixed(4)})`);
      }
    }

    // MACD line below signal line - bearish
    if (macd < macdSignal) {
      bearishScore += 0.5;
      reasoning.push('MACD below signal line - bearish');

      // Histogram negative
      if (macdHistogram < 0) {
        bearishScore += 0.3;
        reasoning.push(`MACD histogram negative (${macdHistogram.toFixed(4)})`);
      }
    }

    // Zero line crossover (stronger signal)
    if (macd > 0 && macdSignal > 0) {
      bullishScore += 0.2;
      reasoning.push('MACD and signal both above zero line');
    } else if (macd < 0 && macdSignal < 0) {
      bearishScore += 0.2;
      reasoning.push('MACD and signal both below zero line');
    }

    return { bullishScore, bearishScore, reasoning };
  }

  /**
   * Moving Average Alignment Validation
   * Validates price position relative to SMAs and SMA alignment
   */
  private validateMovingAverages(indicators: TechnicalIndicators): {
    bullishScore: number;
    bearishScore: number;
    reasoning: string[];
  } {
    const { currentPrice, sma20, sma50, sma200, ema12, ema26 } = indicators;
    const reasoning: string[] = [];
    let bullishScore = 0;
    let bearishScore = 0;

    // Price above all major MAs - strongly bullish
    if (currentPrice > sma20 && currentPrice > sma50 && currentPrice > sma200) {
      bullishScore += 0.6;
      reasoning.push('Price above all major MAs (20/50/200) - bullish');
    } else if (currentPrice < sma20 && currentPrice < sma50 && currentPrice < sma200) {
      bearishScore += 0.6;
      reasoning.push('Price below all major MAs (20/50/200) - bearish');
    }

    // Golden Cross / Death Cross (SMA 50 vs 200)
    if (sma50 > sma200) {
      bullishScore += 0.3;
      reasoning.push('Golden cross setup (SMA50 > SMA200)');
    } else if (sma50 < sma200) {
      bearishScore += 0.3;
      reasoning.push('Death cross setup (SMA50 < SMA200)');
    }

    // Perfect SMA alignment
    if (sma20 > sma50 && sma50 > sma200) {
      bullishScore += 0.4;
      reasoning.push('Bullish SMA alignment (20 > 50 > 200)');
    } else if (sma20 < sma50 && sma50 < sma200) {
      bearishScore += 0.4;
      reasoning.push('Bearish SMA alignment (20 < 50 < 200)');
    }

    // EMA 12/26 crossover (short-term momentum)
    if (ema12 > ema26) {
      bullishScore += 0.2;
      reasoning.push('EMA12 above EMA26 - short-term bullish');
    } else if (ema12 < ema26) {
      bearishScore += 0.2;
      reasoning.push('EMA12 below EMA26 - short-term bearish');
    }

    // Price distance from 200 SMA (mean reversion potential)
    const distanceFrom200 = ((currentPrice - sma200) / sma200) * 100;
    if (distanceFrom200 > 20) {
      bearishScore += 0.2;
      reasoning.push(`Price ${distanceFrom200.toFixed(1)}% above 200 SMA - extended`);
    } else if (distanceFrom200 < -20) {
      bullishScore += 0.2;
      reasoning.push(`Price ${Math.abs(distanceFrom200).toFixed(1)}% below 200 SMA - potentially oversold`);
    }

    return { bullishScore, bearishScore, reasoning };
  }

  /**
   * Volume Confirmation
   * Validates if volume supports the price movement
   */
  private validateVolume(indicators: TechnicalIndicators): {
    bullishScore: number;
    bearishScore: number;
    reasoning: string[];
  } {
    const { volumeRatio, currentPrice, vwap, priceChangePercent24h } = indicators;
    const reasoning: string[] = [];
    let bullishScore = 0;
    let bearishScore = 0;

    // High volume confirmation
    if (volumeRatio > 2.0) {
      // High volume - direction matters
      if (priceChangePercent24h > 0) {
        bullishScore += 0.6;
        reasoning.push(`High volume (${volumeRatio.toFixed(1)}x) confirming upward move`);
      } else {
        bearishScore += 0.6;
        reasoning.push(`High volume (${volumeRatio.toFixed(1)}x) confirming downward move`);
      }
    } else if (volumeRatio > 1.5) {
      if (priceChangePercent24h > 0) {
        bullishScore += 0.3;
        reasoning.push(`Above average volume (${volumeRatio.toFixed(1)}x) on up move`);
      } else {
        bearishScore += 0.3;
        reasoning.push(`Above average volume (${volumeRatio.toFixed(1)}x) on down move`);
      }
    } else if (volumeRatio < 0.5) {
      reasoning.push(`Low volume (${volumeRatio.toFixed(1)}x) - move lacks conviction`);
    }

    // VWAP analysis
    if (currentPrice > vwap) {
      bullishScore += 0.3;
      reasoning.push('Price above VWAP - institutional buying');
    } else if (currentPrice < vwap) {
      bearishScore += 0.3;
      reasoning.push('Price below VWAP - institutional selling');
    }

    return { bullishScore, bearishScore, reasoning };
  }
}
