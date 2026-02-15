import type { TradingSignal } from '@cryonix/types';

/**
 * OHLCV data structure for candlestick analysis
 */
export interface OhlcvData {
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

/**
 * Extended signal interface with pattern-specific metadata
 */
export interface PatternSignal extends Omit<TradingSignal, 'id' | 'timestamp' | 'agent_id'> {
    metadata?: {
        // Bollinger Squeeze specific
        bandwidth?: number;
        avgBandwidth?: number;
        compressionRatio?: number;

        // Volume Spike specific
        volumeRatio?: number;
        priceChange?: number;

        // Triangle Breakout specific
        triangleType?: 'ascending' | 'descending' | 'symmetric';
        triangleHeight?: number;
        trendlineR2?: number;

        // RSI Divergence specific
        divergenceType?: 'bullish' | 'bearish';
        rsiSwingLow?: number;
        rsiSwingHigh?: number;
        priceSwingLow?: number;
        priceSwingHigh?: number;
    };
}

/**
 * Base interface for all pattern detectors
 */
export interface PatternDetector {
    /**
     * Unique name of the pattern
     */
    name: string;

    /**
     * Detect pattern in OHLCV data and return signal if found
     * @param data - Array of OHLCV candlestick data (should be at least 100 candles)
     * @param symbol - Trading pair symbol (e.g., 'BTC/USDT')
     * @returns PatternSignal if pattern detected, null otherwise
     */
    detect(data: OhlcvData[], symbol: string): PatternSignal | null;
}

/**
 * Calculate Simple Moving Average
 */
export function calculateSMA(values: number[], period: number): number {
    if (values.length < period) {
        throw new Error(`Insufficient data: need ${period} values, got ${values.length}`);
    }
    const slice = values.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
}

/**
 * Calculate Standard Deviation
 */
export function calculateStdDev(values: number[], period: number): number {
    if (values.length < period) {
        throw new Error(`Insufficient data: need ${period} values, got ${values.length}`);
    }
    const slice = values.slice(-period);
    const mean = calculateSMA(values, period);
    const squareDiffs = slice.map(value => Math.pow(value - mean, 2));
    const avgSquareDiff = squareDiffs.reduce((a, b) => a + b, 0) / slice.length;
    return Math.sqrt(avgSquareDiff);
}

/**
 * Find local peaks (swing highs) in data
 */
export function findSwingHighs(data: number[], lookback: number = 5): Array<{ index: number; value: number }> {
    const swings: Array<{ index: number; value: number }> = [];

    for (let i = lookback; i < data.length - lookback; i++) {
        let isHigh = true;

        // Check if current point is higher than surrounding points
        for (let j = i - lookback; j <= i + lookback; j++) {
            if (j !== i && data[j] >= data[i]) {
                isHigh = false;
                break;
            }
        }

        if (isHigh) {
            swings.push({ index: i, value: data[i] });
        }
    }

    return swings;
}

/**
 * Find local troughs (swing lows) in data
 */
export function findSwingLows(data: number[], lookback: number = 5): Array<{ index: number; value: number }> {
    const swings: Array<{ index: number; value: number }> = [];

    for (let i = lookback; i < data.length - lookback; i++) {
        let isLow = true;

        // Check if current point is lower than surrounding points
        for (let j = i - lookback; j <= i + lookback; j++) {
            if (j !== i && data[j] <= data[i]) {
                isLow = false;
                break;
            }
        }

        if (isLow) {
            swings.push({ index: i, value: data[i] });
        }
    }

    return swings;
}

/**
 * Calculate linear regression for trendline fitting
 * Returns { slope, intercept, r2 }
 */
export function linearRegression(x: number[], y: number[]): { slope: number; intercept: number; r2: number } {
    const n = x.length;
    const sumX = x.reduce((a, b) => a + b, 0);
    const sumY = y.reduce((a, b) => a + b, 0);
    const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
    const sumX2 = x.reduce((sum, xi) => sum + xi * xi, 0);
    const sumY2 = y.reduce((sum, yi) => sum + yi * yi, 0);

    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;

    // Calculate R-squared
    const yMean = sumY / n;
    const ssTotal = y.reduce((sum, yi) => sum + Math.pow(yi - yMean, 2), 0);
    const ssResidual = y.reduce((sum, yi, i) => {
        const predicted = slope * x[i] + intercept;
        return sum + Math.pow(yi - predicted, 2);
    }, 0);
    const r2 = 1 - (ssResidual / ssTotal);

    return { slope, intercept, r2 };
}
