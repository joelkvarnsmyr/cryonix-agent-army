export interface SourceVote {
    source: string;
    action: 'BUY' | 'SELL' | 'WAIT';
    confidence: number;
    reasoning: string[];
}

export interface TechnicalIndicators {
    rsi14: number;
    macd: number;
    macdHistogram: number;
    sma20: number;
    sma50: number;
    sma200: number;
    bollingerUpper: number;
    bollingerLower: number;
    volumeRatio: number;
    atr14: number;
}

export interface MarketStructure {
    trend: 'uptrend' | 'downtrend' | 'sideways';
    trendStrength: number;
    volatilityState: 'low' | 'normal' | 'high' | 'extreme';
    volumeState: 'low' | 'normal' | 'high';
    nearestSupport: number;
    nearestResistance: number;
}

export interface ValidationDetails {
    isValid: boolean;
    validatedAction: 'BUY' | 'SELL' | 'WAIT';
    validatedConfidence: number;
    consensusLevel: number;
    bullishSentiment: number;
    bearishSentiment: number;
    riskLevel: 'low' | 'medium' | 'high' | 'extreme';
    riskFactors: string[];
    entryTiming: 'excellent' | 'good' | 'fair' | 'poor';
    timingReasoning: string;
    adjustedPrices?: {
        entry?: number;
        target?: number;
        stopLoss?: number;
    };
    processingTimeMs: number;
}

export interface FullValidationResponse {
    validation: ValidationDetails;
    votes: SourceVote[];
    technicalIndicators: TechnicalIndicators;
    marketStructure: MarketStructure;
}
