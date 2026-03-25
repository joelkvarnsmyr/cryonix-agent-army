// packages/agents/src/alphanix/pod/quant-agent.ts

import { randomUUID } from 'crypto';
import type { Candle, TradeProposal } from '../types.js';

const MIN_CANDLES = 26; // need 26 candles for MACD (26-EMA)
const RSI_PERIOD = 14;
const VOLUME_AVG_PERIOD = 20;
const VOLUME_SPIKE_MULT = 1.5;
const DIP_LOOKBACK = 5;
const DIP_THRESHOLD = 0.015; // 1.5% — more sensitive for paper testing
const BOLLINGER_PERIOD = 20;
const BOLLINGER_STD = 2;
const DEEP_VALUE_LOOKBACK = 10;
const DEEP_VALUE_THRESHOLD = 0.08; // 8%
const DEFAULT_MODELS = ['rsi', 'volume', 'macd', 'bollinger', 'ema', 'deep_value', 'dip'];

export class QuantAgent {
  readonly podId: string;
  readonly models: string[];
  private sentimentBoost: number = 0;
  private macroBoost: number = 0;

  constructor(podId: string, models: string[] = DEFAULT_MODELS) {
    this.podId = podId;
    this.models = models;
  }

  setSentimentBoost(score: number): void {
    // score: -100 to 100 from sentiment feed
    // Convert to confidence modifier: -20 to +20
    this.sentimentBoost = Math.round(score * 0.2);
  }

  setMacroBoost(boost: number): void {
    // Clamp -30 to +20 — VIX/Fed-rate driven confidence modifier
    this.macroBoost = Math.max(-30, Math.min(20, boost));
  }

  analyze(symbol: string, adapter: string, candles: Candle[]): TradeProposal[] {
    if (candles.length < MIN_CANDLES) return [];

    const signals: string[] = [];
    let confidence = 50; // base confidence

    // --- RSI ---
    if (this.models.includes('rsi')) {
      const rsi = this.calcRSI(candles);
      if (rsi < 40) {
        signals.push('rsi_oversold');
        confidence += 35;
      } else if (rsi > 65) {
        signals.push('rsi_overbought');
        confidence -= 20;
      }
    }

    // --- Volume spike ---
    if (this.models.includes('volume')) {
      const volumes = candles.map((c) => c.volume);
      const lastVolume = volumes[volumes.length - 1];
      const avgWindow = volumes.slice(-VOLUME_AVG_PERIOD);
      const avgVolume = avgWindow.reduce((s, v) => s + v, 0) / avgWindow.length;
      if (lastVolume > avgVolume * VOLUME_SPIKE_MULT) {
        signals.push('volume_spike');
        confidence += 20;
      }
    }

    // --- MACD crossover ---
    if (this.models.includes('macd')) {
      const closes = candles.map((c) => c.close);
      const ema12 = this.calcEMA(closes, 12);
      const ema26 = this.calcEMA(closes, 26);
      if (ema12.length >= 2 && ema26.length >= 2) {
        // Align arrays: both have same length (candles.length)
        const macdLine = ema12.map((v, i) => v - ema26[i]);
        const signalLine = this.calcEMA(macdLine, 9);
        const len = signalLine.length;
        if (len >= 2) {
          const curr = macdLine[len - 1] - signalLine[len - 1];
          const prev = macdLine[len - 2] - signalLine[len - 2];
          if (curr > 0 && prev <= 0) {
            signals.push('macd_bullish');
            confidence += 30;
          } else if (curr < 0 && prev >= 0) {
            signals.push('macd_bearish');
            confidence -= 15;
          }
        }
      }
    }

    // --- Bollinger Squeeze ---
    if (this.models.includes('bollinger')) {
      const closes = candles.map((c) => c.close);
      if (closes.length >= BOLLINGER_PERIOD) {
        const window = closes.slice(-BOLLINGER_PERIOD);
        const sma = window.reduce((s, v) => s + v, 0) / BOLLINGER_PERIOD;
        const variance =
          window.reduce((s, v) => s + (v - sma) ** 2, 0) / BOLLINGER_PERIOD;
        const std = Math.sqrt(variance);
        const lowerBand = sma - BOLLINGER_STD * std;
        const lastClose = closes[closes.length - 1];
        if (lastClose < lowerBand) {
          signals.push('bollinger_squeeze');
          confidence += 35;
        }
      }
    }

    // --- EMA Cross ---
    if (this.models.includes('ema')) {
      const closes = candles.map((c) => c.close);
      const ema9 = this.calcEMA(closes, 9);
      const ema21 = this.calcEMA(closes, 21);
      if (ema9.length >= 2 && ema21.length >= 2) {
        const len = ema9.length;
        const currDiff = ema9[len - 1] - ema21[len - 1];
        const prevDiff = ema9[len - 2] - ema21[len - 2];
        if (currDiff > 0 && prevDiff <= 0) {
          signals.push('ema_bullish');
          confidence += 25;
        }
      }
    }

    // --- Deep Value Crash ---
    if (this.models.includes('deep_value')) {
      const recentForDV = candles.slice(-DEEP_VALUE_LOOKBACK);
      const dvHigh = Math.max(...recentForDV.map((c) => c.high));
      const dvClose = candles[candles.length - 1].close;
      const dvDrop = (dvHigh - dvClose) / dvHigh;
      if (dvDrop > DEEP_VALUE_THRESHOLD) {
        signals.push('deep_value_crash');
        confidence += 40;
      }
    }

    // --- Dip detection ---
    if (this.models.includes('dip')) {
      const recentCandles = candles.slice(-DIP_LOOKBACK);
      const recentHigh = Math.max(...recentCandles.map((c) => c.high));
      const lastClose = candles[candles.length - 1].close;
      const dipPct = (recentHigh - lastClose) / recentHigh;
      if (dipPct > DIP_THRESHOLD) {
        signals.push('dip_buy');
        confidence += 25;
      }
    }

    // Apply sentiment boost/penalty
    confidence += this.sentimentBoost;
    confidence += this.macroBoost;

    // Clamp confidence 0-100
    confidence = Math.max(0, Math.min(100, confidence));

    if (signals.length === 0) return [];

    const proposal: TradeProposal = {
      id: randomUUID().slice(0, 8),
      podId: this.podId,
      symbol,
      adapter,
      side: 'BUY',
      confidence,
      sizing: { qty: 0, notional: 0 },
      reasoning: `Signals: ${signals.join(', ')}`,
      models: [...this.models],
      signals,
      timestamp: Date.now(),
    };

    return [proposal];
  }

  private calcEMA(data: number[], period: number): number[] {
    if (data.length < period) return [...data];
    const k = 2 / (period + 1);
    const result: number[] = new Array(data.length);
    // Seed with SMA of first `period` values
    let sum = 0;
    for (let i = 0; i < period; i++) {
      sum += data[i];
      result[i] = data[i]; // placeholder for pre-seed values
    }
    result[period - 1] = sum / period;
    for (let i = period; i < data.length; i++) {
      result[i] = data[i] * k + result[i - 1] * (1 - k);
    }
    return result;
  }

  private calcRSI(candles: Candle[]): number {
    const closes = candles.map((c) => c.close);
    const deltas: number[] = [];
    for (let i = 1; i < closes.length; i++) {
      deltas.push(closes[i] - closes[i - 1]);
    }

    const recent = deltas.slice(-RSI_PERIOD);
    let avgGain = 0;
    let avgLoss = 0;
    for (const d of recent) {
      if (d > 0) avgGain += d;
      else avgLoss += Math.abs(d);
    }
    avgGain /= RSI_PERIOD;
    avgLoss = (avgLoss / RSI_PERIOD) || 0.0001; // division-by-zero protection

    const rs = avgGain / avgLoss;
    const rsi = 100 - 100 / (1 + rs);

    // Clamp [1, 99]
    return Math.max(1, Math.min(99, rsi));
  }
}
