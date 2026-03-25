import type { OhlcvData } from '../market-scout/pattern-detectors';
import type { TechnicalIndicators, MarketStructure } from './types';

/**
 * Calculate comprehensive technical indicators from OHLCV data
 */
export function calculateTechnicalIndicators(candles: OhlcvData[]): TechnicalIndicators {
  if (candles.length < 200) {
    throw new Error(`Insufficient data: need 200 candles, have ${candles.length}`);
  }

  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const volumes = candles.map((c) => c.volume);

  const currentPrice = closes[closes.length - 1];

  // Calculate SMAs
  const sma20 = calculateSMA(closes, 20);
  const sma50 = calculateSMA(closes, 50);
  const sma200 = calculateSMA(closes, 200);

  // Calculate EMAs
  const ema12 = calculateEMA(closes, 12);
  const ema26 = calculateEMA(closes, 26);

  // Calculate RSI
  const rsi14 = calculateRSI(closes, 14);

  // Calculate MACD
  const { macd, signal: macdSignal, histogram: macdHistogram } = calculateMACD(closes);

  // Calculate Stochastic
  const { k: stochK, d: stochD } = calculateStochastic(highs, lows, closes, 14, 3);

  // Calculate ATR
  const atr14 = calculateATR(highs, lows, closes, 14);

  // Calculate Bollinger Bands
  const { upper: bollingerUpper, middle: bollingerMiddle, lower: bollingerLower, bandwidth: bollingerBandwidth } =
    calculateBollingerBands(closes, 20, 2);

  // Calculate volume indicators
  const volumeSma20 = calculateSMA(volumes, 20);
  const volumeRatio = volumes[volumes.length - 1] / volumeSma20;
  const obv = calculateOBV(closes, volumes);
  const vwap = calculateVWAP(highs, lows, closes, volumes);

  // Price action
  const last24Candles = candles.slice(-24); // Assuming 1h candles
  const high24h = Math.max(...last24Candles.map((c) => c.high));
  const low24h = Math.min(...last24Candles.map((c) => c.low));
  const price24hAgo = closes[closes.length - 24] || closes[0];
  const priceChange24h = currentPrice - price24hAgo;
  const priceChangePercent24h = (priceChange24h / price24hAgo) * 100;

  return {
    sma20,
    sma50,
    sma200,
    ema12,
    ema26,
    rsi14,
    macd,
    macdSignal,
    macdHistogram,
    stochK,
    stochD,
    atr14,
    bollingerUpper,
    bollingerMiddle,
    bollingerLower,
    bollingerBandwidth,
    volumeSma20,
    volumeRatio,
    obv,
    vwap,
    currentPrice,
    priceChange24h,
    priceChangePercent24h,
    high24h,
    low24h,
  };
}

/**
 * Analyze market structure from price data
 */
export function analyzeMarketStructure(candles: OhlcvData[], indicators: TechnicalIndicators): MarketStructure {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const volumes = candles.map((c) => c.volume);

  const currentPrice = indicators.currentPrice;

  // Determine trend
  const { trend, trendStrength } = determineTrend(indicators);

  // Find support/resistance levels
  const { nearestSupport, nearestResistance, distanceToSupport, distanceToResistance } = findSupportResistance(
    highs,
    lows,
    closes,
    currentPrice
  );

  // Calculate pivot points
  const { pivot, r1, r2, r3, s1, s2, s3 } = calculatePivotPoints(
    candles[candles.length - 2].high,
    candles[candles.length - 2].low,
    candles[candles.length - 2].close
  );

  // Assess volatility state
  const volatilityState = assessVolatility(indicators.atr14, indicators.bollingerBandwidth, closes);

  // Assess volume state
  const volumeState = assessVolumeState(indicators.volumeRatio);

  return {
    trend,
    trendStrength,
    nearestSupport,
    nearestResistance,
    distanceToSupport,
    distanceToResistance,
    pivotPoint: pivot,
    r1,
    r2,
    r3,
    s1,
    s2,
    s3,
    volatilityState,
    volumeState,
  };
}

// ============================================================================
// INDICATOR CALCULATIONS
// ============================================================================

function calculateSMA(data: number[], period: number): number {
  const slice = data.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function calculateEMA(data: number[], period: number): number {
  const multiplier = 2 / (period + 1);
  let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < data.length; i++) {
    ema = (data[i] - ema) * multiplier + ema;
  }

  return ema;
}

function calculateRSI(closes: number[], period: number): number {
  const changes = [];
  for (let i = 1; i < closes.length; i++) {
    changes.push(closes[i] - closes[i - 1]);
  }

  const recentChanges = changes.slice(-period);
  const gains = recentChanges.filter((c) => c > 0);
  const losses = recentChanges.filter((c) => c < 0).map((c) => Math.abs(c));

  const avgGain = gains.length > 0 ? gains.reduce((a, b) => a + b, 0) / period : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / period : 0;

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calculateMACD(closes: number[]): { macd: number; signal: number; histogram: number } {
  const ema12 = calculateEMA(closes, 12);
  const ema26 = calculateEMA(closes, 26);
  const macd = ema12 - ema26;

  // Calculate signal line (9-period EMA of MACD)
  const macdHistory: number[] = [];
  for (let i = 26; i < closes.length; i++) {
    const slice = closes.slice(0, i + 1);
    const e12 = calculateEMA(slice, 12);
    const e26 = calculateEMA(slice, 26);
    macdHistory.push(e12 - e26);
  }

  const signal = calculateEMA(macdHistory, 9);
  const histogram = macd - signal;

  return { macd, signal, histogram };
}

function calculateStochastic(
  highs: number[],
  lows: number[],
  closes: number[],
  kPeriod: number,
  dPeriod: number
): { k: number; d: number } {
  const recentHighs = highs.slice(-kPeriod);
  const recentLows = lows.slice(-kPeriod);
  const highestHigh = Math.max(...recentHighs);
  const lowestLow = Math.min(...recentLows);
  const currentClose = closes[closes.length - 1];

  const k = highestHigh !== lowestLow ? ((currentClose - lowestLow) / (highestHigh - lowestLow)) * 100 : 50;

  // Calculate %D (SMA of %K)
  const kHistory: number[] = [];
  for (let i = kPeriod; i <= closes.length; i++) {
    const sliceHighs = highs.slice(i - kPeriod, i);
    const sliceLows = lows.slice(i - kPeriod, i);
    const hh = Math.max(...sliceHighs);
    const ll = Math.min(...sliceLows);
    const c = closes[i - 1];
    kHistory.push(hh !== ll ? ((c - ll) / (hh - ll)) * 100 : 50);
  }

  const d = calculateSMA(kHistory, dPeriod);

  return { k, d };
}

function calculateATR(highs: number[], lows: number[], closes: number[], period: number): number {
  const trueRanges: number[] = [];

  for (let i = 1; i < highs.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trueRanges.push(tr);
  }

  return calculateSMA(trueRanges, period);
}

function calculateBollingerBands(
  closes: number[],
  period: number,
  stdDevMultiplier: number
): { upper: number; middle: number; lower: number; bandwidth: number } {
  const middle = calculateSMA(closes, period);

  const slice = closes.slice(-period);
  const squaredDiffs = slice.map((c) => Math.pow(c - middle, 2));
  const variance = squaredDiffs.reduce((a, b) => a + b, 0) / period;
  const stdDev = Math.sqrt(variance);

  const upper = middle + stdDev * stdDevMultiplier;
  const lower = middle - stdDev * stdDevMultiplier;
  const bandwidth = ((upper - lower) / middle) * 100;

  return { upper, middle, lower, bandwidth };
}

function calculateOBV(closes: number[], volumes: number[]): number {
  let obv = 0;

  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > closes[i - 1]) {
      obv += volumes[i];
    } else if (closes[i] < closes[i - 1]) {
      obv -= volumes[i];
    }
  }

  return obv;
}

function calculateVWAP(highs: number[], lows: number[], closes: number[], volumes: number[]): number {
  let cumulativeTPV = 0;
  let cumulativeVolume = 0;

  for (let i = 0; i < closes.length; i++) {
    const typicalPrice = (highs[i] + lows[i] + closes[i]) / 3;
    cumulativeTPV += typicalPrice * volumes[i];
    cumulativeVolume += volumes[i];
  }

  return cumulativeVolume > 0 ? cumulativeTPV / cumulativeVolume : closes[closes.length - 1];
}

// ============================================================================
// MARKET STRUCTURE ANALYSIS
// ============================================================================

function determineTrend(indicators: TechnicalIndicators): { trend: 'uptrend' | 'downtrend' | 'sideways'; trendStrength: number } {
  const { currentPrice, sma20, sma50, sma200, macdHistogram, rsi14 } = indicators;

  let bullishPoints = 0;
  let bearishPoints = 0;
  const totalPoints = 6;

  // Price above/below SMAs
  if (currentPrice > sma20) bullishPoints++;
  else bearishPoints++;

  if (currentPrice > sma50) bullishPoints++;
  else bearishPoints++;

  if (currentPrice > sma200) bullishPoints++;
  else bearishPoints++;

  // SMA alignment
  if (sma20 > sma50 && sma50 > sma200) bullishPoints++;
  else if (sma20 < sma50 && sma50 < sma200) bearishPoints++;

  // MACD
  if (macdHistogram > 0) bullishPoints++;
  else bearishPoints++;

  // RSI
  if (rsi14 > 50) bullishPoints++;
  else bearishPoints++;

  const bullishRatio = bullishPoints / totalPoints;
  const bearishRatio = bearishPoints / totalPoints;

  if (bullishRatio >= 0.65) {
    return { trend: 'uptrend', trendStrength: bullishRatio };
  } else if (bearishRatio >= 0.65) {
    return { trend: 'downtrend', trendStrength: bearishRatio };
  } else {
    return { trend: 'sideways', trendStrength: Math.max(bullishRatio, bearishRatio) };
  }
}

function findSupportResistance(
  highs: number[],
  lows: number[],
  closes: number[],
  currentPrice: number
): {
  nearestSupport: number;
  nearestResistance: number;
  distanceToSupport: number;
  distanceToResistance: number;
} {
  // Find swing highs and lows
  const swingHighs: number[] = [];
  const swingLows: number[] = [];

  for (let i = 5; i < highs.length - 5; i++) {
    const isSwingHigh = highs[i] === Math.max(...highs.slice(i - 5, i + 6));
    const isSwingLow = lows[i] === Math.min(...lows.slice(i - 5, i + 6));

    if (isSwingHigh) swingHighs.push(highs[i]);
    if (isSwingLow) swingLows.push(lows[i]);
  }

  // Find nearest support (below current price)
  const supports = swingLows.filter((l) => l < currentPrice).sort((a, b) => b - a);
  const nearestSupport = supports[0] || currentPrice * 0.95;

  // Find nearest resistance (above current price)
  const resistances = swingHighs.filter((h) => h > currentPrice).sort((a, b) => a - b);
  const nearestResistance = resistances[0] || currentPrice * 1.05;

  return {
    nearestSupport,
    nearestResistance,
    distanceToSupport: ((currentPrice - nearestSupport) / currentPrice) * 100,
    distanceToResistance: ((nearestResistance - currentPrice) / currentPrice) * 100,
  };
}

function calculatePivotPoints(
  high: number,
  low: number,
  close: number
): { pivot: number; r1: number; r2: number; r3: number; s1: number; s2: number; s3: number } {
  const pivot = (high + low + close) / 3;
  const r1 = 2 * pivot - low;
  const r2 = pivot + (high - low);
  const r3 = high + 2 * (pivot - low);
  const s1 = 2 * pivot - high;
  const s2 = pivot - (high - low);
  const s3 = low - 2 * (high - pivot);

  return { pivot, r1, r2, r3, s1, s2, s3 };
}

function assessVolatility(
  atr: number,
  bandwidth: number,
  closes: number[]
): 'low' | 'normal' | 'high' | 'extreme' {
  const currentPrice = closes[closes.length - 1];
  const atrPercent = (atr / currentPrice) * 100;

  // Combine ATR and Bollinger Bandwidth
  const volatilityScore = (atrPercent * 2 + bandwidth) / 3;

  if (volatilityScore < 1) return 'low';
  if (volatilityScore < 3) return 'normal';
  if (volatilityScore < 6) return 'high';
  return 'extreme';
}

function assessVolumeState(volumeRatio: number): 'low' | 'normal' | 'high' {
  if (volumeRatio < 0.7) return 'low';
  if (volumeRatio < 1.5) return 'normal';
  return 'high';
}
