import { NextRequest, NextResponse } from 'next/server';
import { SignalValidator } from '@cryonix/agents';
import type { TradingSignal, PatternType } from '@cryonix/types';
import ccxt, { type Exchange } from 'ccxt';
import { saveValidation, getValidationHistory, getValidationStats } from '@cryonix/database';

// Singleton validator instance
let validatorInstance: SignalValidator | null = null;
let exchangeInstance: Exchange | null = null;

function getValidator(): SignalValidator {
  if (!validatorInstance) {
    validatorInstance = new SignalValidator({
      minConsensusLevel: 0.6,
      minConfidence: 0.5,
      enableAiAnalysis: true,
      allowActionOverride: false,
      adjustPriceTargets: true,
    });
  }
  return validatorInstance;
}

function getExchange(): Exchange {
  if (!exchangeInstance) {
    exchangeInstance = new ccxt.binance({
      apiKey: process.env.BINANCE_API_KEY,
      secret: process.env.BINANCE_API_SECRET,
      enableRateLimit: true,
    });
  }
  return exchangeInstance;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { signal, symbol, action, confidence, pattern, entryPrice, targetPrice, stopLoss, timeframe } = body;

    // Build or validate signal
    let tradingSignal: TradingSignal;

    if (signal) {
      // Full signal provided
      tradingSignal = {
        ...signal,
        timestamp: new Date(signal.timestamp),
      };
    } else {
      // Build signal from parameters
      if (!symbol || !action || !entryPrice) {
        return NextResponse.json(
          { error: 'Missing required parameters: symbol, action, entryPrice' },
          { status: 400 }
        );
      }

      tradingSignal = {
        id: crypto.randomUUID(),
        timestamp: new Date(),
        symbol,
        action,
        confidence: confidence ?? 0.7,
        pattern: pattern ?? 'custom',
        reasoning: ['Manual signal validation request'],
        entry_price: entryPrice,
        target_price: targetPrice ?? entryPrice * (action === 'BUY' ? 1.03 : 0.97),
        stop_loss: stopLoss ?? entryPrice * (action === 'BUY' ? 0.98 : 1.02),
        timeframe: timeframe ?? '15m',
        agent_id: 'api',
      };
    }

    // Fetch OHLCV data for the symbol
    const exchange = getExchange();
    const ohlcv = await exchange.fetchOHLCV(
      tradingSignal.symbol,
      tradingSignal.timeframe || '15m',
      undefined,
      200 // Need 200 candles for technical indicators
    );

    // Convert to OhlcvData format
    const candles = ohlcv.map((candle: (number | undefined)[]) => ({
      timestamp: candle[0] as number,
      open: candle[1] as number,
      high: candle[2] as number,
      low: candle[3] as number,
      close: candle[4] as number,
      volume: candle[5] as number,
    }));

    // Validate signal
    const validator = getValidator();
    const result = await validator.validate(tradingSignal, candles);

    // Determine consensus level string
    const getConsensusLevelString = (level: number): string => {
      if (level >= 0.8) return 'STRONG';
      if (level >= 0.6) return 'MODERATE';
      if (level >= 0.4) return 'WEAK';
      return 'CONFLICTING';
    };

    // Save validation to database
    try {
      await saveValidation({
        signalId: null, // Could link to signals table if signal was stored
        symbol: tradingSignal.symbol,
        action: result.validatedAction,
        originalConfidence: tradingSignal.confidence.toString(),
        adjustedConfidence: result.validatedConfidence.toString(),
        consensusLevel: getConsensusLevelString(result.consensusLevel),
        sourceVotes: result.votes,
        technicalIndicators: result.technicalIndicators,
        priceTargets: {
          original: {
            entry: tradingSignal.entry_price,
            target: tradingSignal.target_price,
            stopLoss: tradingSignal.stop_loss,
          },
          adjusted: {
            entry: result.adjustedEntry,
            target: result.adjustedTarget,
            stopLoss: result.adjustedStopLoss,
          },
        },
        entryTiming: result.entryTiming.toUpperCase(),
        riskLevel: result.riskLevel.toUpperCase(),
        approved: result.isValid,
        reasoning: result.riskFactors.join('; '),
        agentId: 'signal-validator',
      });
    } catch (dbError) {
      console.error('[API/ValidateSignal] Failed to save validation:', dbError);
      // Continue even if database save fails
    }

    return NextResponse.json({
      success: true,
      validation: {
        isValid: result.isValid,
        validatedAction: result.validatedAction,
        validatedConfidence: result.validatedConfidence,
        consensusLevel: result.consensusLevel,
        bullishSentiment: result.bullishSentiment,
        bearishSentiment: result.bearishSentiment,
        riskLevel: result.riskLevel,
        riskFactors: result.riskFactors,
        entryTiming: result.entryTiming,
        timingReasoning: result.timingReasoning,
        adjustedPrices: {
          entry: result.adjustedEntry,
          target: result.adjustedTarget,
          stopLoss: result.adjustedStopLoss,
        },
        processingTimeMs: result.processingTimeMs,
      },
      votes: result.votes.map((v) => ({
        source: v.source,
        action: v.action,
        confidence: v.confidence,
        reasoning: v.reasoning,
      })),
      technicalIndicators: {
        rsi14: result.technicalIndicators.rsi14,
        macd: result.technicalIndicators.macd,
        macdHistogram: result.technicalIndicators.macdHistogram,
        sma20: result.technicalIndicators.sma20,
        sma50: result.technicalIndicators.sma50,
        sma200: result.technicalIndicators.sma200,
        bollingerUpper: result.technicalIndicators.bollingerUpper,
        bollingerLower: result.technicalIndicators.bollingerLower,
        volumeRatio: result.technicalIndicators.volumeRatio,
        atr14: result.technicalIndicators.atr14,
      },
      marketStructure: {
        trend: result.marketStructure.trend,
        trendStrength: result.marketStructure.trendStrength,
        volatilityState: result.marketStructure.volatilityState,
        volumeState: result.marketStructure.volumeState,
        nearestSupport: result.marketStructure.nearestSupport,
        nearestResistance: result.marketStructure.nearestResistance,
      },
    });
  } catch (error) {
    console.error('[API/ValidateSignal] Error:', error);
    return NextResponse.json(
      { error: 'Signal validation failed', details: String(error) },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action') || 'stats';

  try {
    const validator = getValidator();

    switch (action) {
      case 'stats': {
        // Get both in-memory stats and database stats
        const inMemoryStats = validator.getAccuracyStats();
        const dbStats = await getValidationStats();
        return NextResponse.json({
          success: true,
          stats: {
            inMemory: inMemoryStats,
            database: dbStats,
          },
        });
      }

      case 'history': {
        // Get validation history from database
        const symbol = searchParams.get('symbol') || undefined;
        const approved = searchParams.get('approved');
        const consensusLevel = searchParams.get('consensusLevel') || undefined;
        const limit = parseInt(searchParams.get('limit') || '50');
        const since = searchParams.get('since') ? new Date(searchParams.get('since')!) : undefined;

        const history = await getValidationHistory({
          symbol,
          approved: approved !== null ? approved === 'true' : undefined,
          consensusLevel,
          limit,
          since,
        });

        return NextResponse.json({
          success: true,
          count: history.length,
          validations: history,
        });
      }

      case 'config': {
        return NextResponse.json({
          success: true,
          config: {
            minConsensusLevel: 0.6,
            minConfidence: 0.5,
            enableAiAnalysis: true,
            allowActionOverride: false,
            adjustPriceTargets: true,
            sources: [
              'pattern_detector',
              'technical_indicators',
              'ai_analysis',
              'market_structure',
              'volume_analysis',
              'momentum_analysis',
            ],
          },
        });
      }

      default:
        return NextResponse.json({ error: 'Invalid action. Use: stats, history, or config' }, { status: 400 });
    }
  } catch (error) {
    console.error('[API/ValidateSignal] GET Error:', error);
    return NextResponse.json(
      { error: 'Failed to get validation info', details: String(error) },
      { status: 500 }
    );
  }
}
