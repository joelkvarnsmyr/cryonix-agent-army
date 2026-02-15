import type { PatternDetector, PatternSignal, OhlcvData } from './pattern-detector.interface';
import { calculateSMA, linearRegression, findSwingHighs, findSwingLows } from './pattern-detector.interface';

/**
 * Triangle Breakout Pattern Detector
 * 
 * Detects triangle chart patterns (ascending, descending, symmetric) and their breakouts.
 * Triangles are continuation patterns formed by converging trendlines that typically
 * resolve with a breakout in the direction of the prior trend.
 * 
 * Strategy:
 * - Identify swing highs and lows
 * - Fit trendlines to highs/lows using linear regression
 * - Detect convergence (lines approaching each other)
 * - Wait for breakout with volume confirmation
 * - Measure triangle height for target projection
 * 
 * Triangle types:
 * - Ascending: Flat resistance, rising support (bullish)
 * - Descending: Falling resistance, flat support (bearish)
 * - Symmetric: Both lines converging (neutral, breakout determines direction)
 * 
 * Confidence factors:
 * - R² > 0.8 for both trendlines = good quality
 * - Volume on breakout > 1.5x average = strong confirmation
 * - Max confidence: 0.80
 */
export class TriangleBreakoutDetector implements PatternDetector {
    name = 'triangle_breakout';

    detect(data: OhlcvData[], symbol: string): PatternSignal | null {
        // Need at least 50 candles to identify triangle pattern
        if (data.length < 50) {
            return null;
        }

        // Use last 50 candles for pattern detection
        const recentData = data.slice(-50);
        const highs = recentData.map(d => d.high);
        const lows = recentData.map(d => d.low);
        const volumes = data.map(d => d.volume);

        // Find swing highs and lows
        const swingHighs = findSwingHighs(highs, 3);
        const swingLows = findSwingLows(lows, 3);

        // Need at least 3 swing points for each trendline
        if (swingHighs.length < 3 || swingLows.length < 3) {
            return null;
        }

        // Fit trendlines using linear regression
        const highsX = swingHighs.map(s => s.index);
        const highsY = swingHighs.map(s => s.value);
        const resistanceLine = linearRegression(highsX, highsY);

        const lowsX = swingLows.map(s => s.index);
        const lowsY = swingLows.map(s => s.value);
        const supportLine = linearRegression(lowsX, lowsY);

        // Check trendline quality (R² should be > 0.7)
        const minR2 = 0.7;
        if (resistanceLine.r2 < minR2 || supportLine.r2 < minR2) {
            return null;
        }

        // Check if lines are converging (triangle formation)
        // Resistance slope should be less than support slope (lines getting closer)
        const isConverging = resistanceLine.slope < supportLine.slope;

        if (!isConverging) {
            return null;
        }

        // Determine triangle type
        let triangleType: 'ascending' | 'descending' | 'symmetric';
        const slopeThreshold = 0.05; // Small slope considered flat

        if (Math.abs(resistanceLine.slope) < slopeThreshold && supportLine.slope > slopeThreshold) {
            triangleType = 'ascending';
        } else if (Math.abs(supportLine.slope) < slopeThreshold && resistanceLine.slope < -slopeThreshold) {
            triangleType = 'descending';
        } else {
            triangleType = 'symmetric';
        }

        // Calculate current resistance and support levels
        const lastIndex = recentData.length - 1;
        const currentResistance = resistanceLine.slope * lastIndex + resistanceLine.intercept;
        const currentSupport = supportLine.slope * lastIndex + supportLine.intercept;

        // Triangle height (for target calculation)
        const triangleHeight = currentResistance - currentSupport;

        // Check for breakout
        const lastCandle = data[data.length - 1];
        const lastVolume = volumes[volumes.length - 1];
        const avgVolume = calculateSMA(volumes, 20);
        const volumeRatio = lastVolume / avgVolume;

        // Breakout requires volume > 1.5x average
        const volumeThreshold = 1.5;

        let breakoutDetected = false;
        let action: 'BUY' | 'SELL' = 'BUY';

        // Bullish breakout: price closes above resistance with volume
        if (lastCandle.close > currentResistance && volumeRatio > volumeThreshold) {
            breakoutDetected = true;
            action = 'BUY';
        }
        // Bearish breakout: price closes below support with volume
        else if (lastCandle.close < currentSupport && volumeRatio > volumeThreshold) {
            breakoutDetected = true;
            action = 'SELL';
        }

        if (!breakoutDetected) {
            return null;
        }

        // Calculate confidence based on trendline quality and volume
        const avgR2 = (resistanceLine.r2 + supportLine.r2) / 2;
        const confidenceBase = 0.70;
        const r2Boost = (avgR2 - 0.7) * 0.05; // Up to +0.015
        const volumeBoost = Math.min((volumeRatio - 1.5) * 0.05, 0.05); // Up to +0.05
        const confidence = Math.min(confidenceBase + r2Boost + volumeBoost, 0.80);

        // Entry at breakout price
        const entry = lastCandle.close;

        // Stop loss at opposite trendline
        const stopLoss = action === 'BUY' ? currentSupport : currentResistance;

        // Target: Triangle height projected from breakout
        const target = action === 'BUY'
            ? entry + triangleHeight
            : entry - triangleHeight;

        return {
            symbol,
            action,
            confidence,
            pattern: this.name,
            reasoning: [
                `${triangleType.charAt(0).toUpperCase() + triangleType.slice(1)} triangle breakout detected`,
                `Trendline quality: ${(avgR2 * 100).toFixed(1)}% (R²)`,
                `Breakout confirmed with ${volumeRatio.toFixed(2)}x volume`,
                `Target based on triangle height projection: ${((triangleHeight / entry) * 100).toFixed(2)}%`
            ],
            entry_price: entry,
            target_price: target,
            stop_loss: stopLoss,
            timeframe: '1-3 days',
            metadata: {
                triangleType,
                triangleHeight,
                trendlineR2: avgR2
            }
        };
    }
}
