import type { PatternDetector, PatternSignal, OhlcvData } from './pattern-detector.interface';
import { calculateSMA } from './pattern-detector.interface';

/**
 * Volume Spike Pattern Detector
 * 
 * Detects significant volume spikes that indicate strong market interest.
 * A volume spike alone isn't enough - we also require meaningful price movement
 * to filter out noise and ensure the spike represents real trading activity.
 * 
 * Strategy:
 * - Calculate 20-period volume moving average
 * - Detect volume > 2x average (spike threshold)
 * - Require price movement > 1% to confirm
 * - Direction determined by price action (bullish if up, bearish if down)
 * 
 * Confidence factors:
 * - 2x volume = 0.60 confidence
 * - 3x volume = 0.70 confidence (max)
 * - Larger price movement = slight boost
 */
export class VolumeSpikeDetector implements PatternDetector {
    name = 'volume_spike';

    detect(data: OhlcvData[], symbol: string): PatternSignal | null {
        // Need at least 21 candles (20 for SMA + 1 current)
        if (data.length < 21) {
            return null;
        }

        const volumes = data.map(d => d.volume);
        const lastVolume = volumes[volumes.length - 1];

        // Calculate 20-period volume average
        const avgVolume = calculateSMA(volumes, 20);

        // Volume ratio (how many times average)
        const volumeRatio = lastVolume / avgVolume;

        // Spike threshold: 2x average
        const spikeThreshold = 2.0;

        if (volumeRatio >= spikeThreshold) {
            const lastCandle = data[data.length - 1];
            const prevCandle = data[data.length - 2];

            // Calculate price change
            const priceChange = (lastCandle.close - prevCandle.close) / prevCandle.close;
            const priceChangePercent = Math.abs(priceChange) * 100;

            // Require at least 1% price movement to filter noise
            if (priceChangePercent < 1.0) {
                return null;
            }

            // Determine direction based on price movement
            const action: 'BUY' | 'SELL' = priceChange > 0 ? 'BUY' : 'SELL';

            // Calculate confidence based on volume ratio
            // 2x = 0.60, 3x = 0.70, capped at 0.70
            const confidenceBase = 0.60;
            const confidenceBoost = Math.min((volumeRatio - 2.0) * 0.10, 0.10);
            const confidence = confidenceBase + confidenceBoost;

            // Entry at current price
            const entry = lastCandle.close;

            // Stop loss: 1.5% from entry
            const stopLossPercent = 0.015;
            const stopLoss = action === 'BUY'
                ? entry * (1 - stopLossPercent)
                : entry * (1 + stopLossPercent);

            // Target: 3% from entry
            const targetPercent = 0.03;
            const target = action === 'BUY'
                ? entry * (1 + targetPercent)
                : entry * (1 - targetPercent);

            return {
                symbol,
                action,
                confidence,
                pattern: this.name,
                reasoning: [
                    `Volume spike detected: ${volumeRatio.toFixed(2)}x average volume`,
                    `Price ${action === 'BUY' ? 'up' : 'down'} ${priceChangePercent.toFixed(2)}% on high volume`,
                    `Indicates strong ${action === 'BUY' ? 'buying' : 'selling'} pressure`,
                    `Potential ${action === 'BUY' ? 'continuation' : 'reversal'} if momentum continues`
                ],
                entry_price: entry,
                target_price: target,
                stop_loss: stopLoss,
                timeframe: '6-24 hours',
                metadata: {
                    volumeRatio,
                    priceChange: priceChangePercent
                }
            };
        }

        return null;
    }
}
