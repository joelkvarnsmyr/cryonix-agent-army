// packages/agents/src/alphanix/pod/quant-agent.ts

import { randomUUID } from 'crypto';
import type { Candle, TradeProposal } from '../types.js';

const MIN_CANDLES = 14;
const RSI_PERIOD = 14;
const VOLUME_AVG_PERIOD = 20;
const VOLUME_SPIKE_MULT = 1.5;
const DIP_LOOKBACK = 5;
const DIP_THRESHOLD = 0.03; // 3%

export class QuantAgent {
  readonly podId: string;
  readonly models: string[];

  constructor(podId: string, models: string[]) {
    this.podId = podId;
    this.models = models;
  }

  analyze(symbol: string, adapter: string, candles: Candle[]): TradeProposal[] {
    if (candles.length < MIN_CANDLES) return [];

    const signals: string[] = [];
    let confidence = 50; // base confidence

    // --- RSI ---
    if (this.models.includes('rsi')) {
      const rsi = this.calcRSI(candles);
      if (rsi < 35) {
        signals.push('rsi_oversold');
        confidence += 40;
      } else if (rsi > 70) {
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

    // --- Dip detection ---
    const recentCandles = candles.slice(-DIP_LOOKBACK);
    const recentHigh = Math.max(...recentCandles.map((c) => c.high));
    const lastClose = candles[candles.length - 1].close;
    const dipPct = (recentHigh - lastClose) / recentHigh;
    if (dipPct > DIP_THRESHOLD) {
      signals.push('dip_buy');
      confidence += 25;
    }

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
