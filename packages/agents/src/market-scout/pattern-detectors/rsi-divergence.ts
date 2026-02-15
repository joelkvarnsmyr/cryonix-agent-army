import { RSI } from 'technicalindicators';
import type { PatternDetector, PatternSignal, OhlcvData } from './pattern-detector.interface';
import { findSwingHighs, findSwingLows } from './pattern-detector.interface';

/**
 * RSI Divergence Pattern Detector
 * 
 * Detects divergences between price and RSI indicator, which often signal
 * potential trend reversals. Divergence occurs when price and RSI move in
 * opposite directions at swing points.
 * 
 * Types of divergences:
 * - Bullish: Price makes lower low, RSI makes higher low (reversal up)
 * - Bearish: Price makes higher high, RSI makes lower high (reversal down)
 * 
 * Strategy:
 * - Calculate 14-period RSI
 * - Identify swing highs/lows in both price and RSI
 * - Compare recent swing points for divergence
 * - Signal reversal when divergence confirmed
 * 
 * Confidence factors:
 * - Stronger divergence (larger difference) = higher confidence
 * - RSI in oversold (<30) or overbought (>70) = higher confidence
 * - Multiple consecutive divergences = higher confidence
 * - Range: 0.60 - 0.75
 */
export class RSIDivergenceDetector implements PatternDetector {
    name = 'rsi_divergence';

    detect(data: OhlcvData[], symbol: string): PatternSignal | null {
        // Need at least 50 candles for reliable divergence detection
        if (data.length < 50) {
            return null;
        }

        const closes = data.map(d => d.close);
        const period = 14;

        // Calculate RSI
        const rsiValues = RSI.calculate({
            values: closes,
            period
        });

        if (rsiValues.length < 30) {
            return null;
        }

        // Find swing highs and lows in price (using closes)
        const priceSwingHighs = findSwingHighs(closes, 5);
        const priceSwingLows = findSwingLows(closes, 5);

        // Find swing highs and lows in RSI
        const rsiSwingHighs = findSwingHighs(rsiValues, 5);
        const rsiSwingLows = findSwingLows(rsiValues, 5);

        // Need at least 2 swing points of each type to detect divergence
        if (priceSwingHighs.length < 2 || priceSwingLows.length < 2 ||
            rsiSwingHighs.length < 2 || rsiSwingLows.length < 2) {
            return null;
        }

        // Get the two most recent swing points
        const lastPriceHigh = priceSwingHighs[priceSwingHighs.length - 1];
        const prevPriceHigh = priceSwingHighs[priceSwingHighs.length - 2];

        const lastPriceLow = priceSwingLows[priceSwingLows.length - 1];
        const prevPriceLow = priceSwingLows[priceSwingLows.length - 2];

        const lastRSIHigh = rsiSwingHighs[rsiSwingHighs.length - 1];
        const prevRSIHigh = rsiSwingHighs[rsiSwingHighs.length - 2];

        const lastRSILow = rsiSwingLows[rsiSwingLows.length - 1];
        const prevRSILow = rsiSwingLows[rsiSwingLows.length - 2];

        const currentRSI = rsiValues[rsiValues.length - 1];
        const lastCandle = data[data.length - 1];

        // Check for BULLISH divergence
        // Price: lower low, RSI: higher low
        if (lastPriceLow.value < prevPriceLow.value &&
            lastRSILow.value > prevRSILow.value &&
            currentRSI < 40) { // RSI in lower range

            // Calculate divergence strength
            const priceDiff = ((prevPriceLow.value - lastPriceLow.value) / prevPriceLow.value) * 100;
            const rsiDiff = lastRSILow.value - prevRSILow.value;

            // Confidence based on RSI level and divergence strength
            let confidence = 0.60;
            if (currentRSI < 30) confidence += 0.10; // Oversold bonus
            if (rsiDiff > 10) confidence += 0.05; // Strong divergence
            confidence = Math.min(confidence, 0.75);

            const entry = lastCandle.close;
            const stopLoss = lastPriceLow.value * 0.97; // 3% below swing low
            const target = prevPriceHigh.value; // Target: previous swing high

            return {
                symbol,
                action: 'BUY',
                confidence,
                pattern: this.name,
                reasoning: [
                    `Bullish RSI divergence detected`,
                    `Price made lower low (${priceDiff.toFixed(2)}% down), RSI made higher low (+${rsiDiff.toFixed(1)})`,
                    `RSI at ${currentRSI.toFixed(1)} - ${currentRSI < 30 ? 'oversold territory' : 'lower range'}`,
                    `Potential reversal to upside - risk/reward ${((target - entry) / (entry - stopLoss)).toFixed(2)}:1`
                ],
                entry_price: entry,
                target_price: target,
                stop_loss: stopLoss,
                timeframe: '2-5 days',
                metadata: {
                    divergenceType: 'bullish',
                    rsiSwingLow: lastRSILow.value,
                    priceSwingLow: lastPriceLow.value
                }
            };
        }

        // Check for BEARISH divergence
        // Price: higher high, RSI: lower high
        if (lastPriceHigh.value > prevPriceHigh.value &&
            lastRSIHigh.value < prevRSIHigh.value &&
            currentRSI > 60) { // RSI in upper range

            // Calculate divergence strength
            const priceDiff = ((lastPriceHigh.value - prevPriceHigh.value) / prevPriceHigh.value) * 100;
            const rsiDiff = prevRSIHigh.value - lastRSIHigh.value;

            // Confidence based on RSI level and divergence strength
            let confidence = 0.60;
            if (currentRSI > 70) confidence += 0.10; // Overbought bonus
            if (rsiDiff > 10) confidence += 0.05; // Strong divergence
            confidence = Math.min(confidence, 0.75);

            const entry = lastCandle.close;
            const stopLoss = lastPriceHigh.value * 1.03; // 3% above swing high
            const target = prevPriceLow.value; // Target: previous swing low

            return {
                symbol,
                action: 'SELL',
                confidence,
                pattern: this.name,
                reasoning: [
                    `Bearish RSI divergence detected`,
                    `Price made higher high (+${priceDiff.toFixed(2)}%), RSI made lower high (-${rsiDiff.toFixed(1)})`,
                    `RSI at ${currentRSI.toFixed(1)} - ${currentRSI > 70 ? 'overbought territory' : 'upper range'}`,
                    `Potential reversal to downside - risk/reward ${((entry - target) / (stopLoss - entry)).toFixed(2)}:1`
                ],
                entry_price: entry,
                target_price: target,
                stop_loss: stopLoss,
                timeframe: '2-5 days',
                metadata: {
                    divergenceType: 'bearish',
                    rsiSwingHigh: lastRSIHigh.value,
                    priceSwingHigh: lastPriceHigh.value
                }
            };
        }

        return null;
    }
}
