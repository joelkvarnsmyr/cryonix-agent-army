/**
 * Price-Based Signal Generators for Ψnix
 *
 * Computes mathematically independent signals directly from OHLCV data.
 * Ported from v2 research (psi_v2_backtest.py) adapted for TypeScript.
 *
 * Each generator produces σ ∈ [-1, +1]:
 *   1. Hurst (variance ratio) — trend character
 *   2. OU z-score — mean reversion distance
 *   3. Momentum — Bayesian posterior strength
 */

import type { PsiSignal } from './psi-engine';

export class PriceSignals {
    /**
     * Hurst exponent via variance ratio test.
     * VR > 1 = trending → follow trend direction
     * VR < 1 = mean-reverting → fade trend
     * VR ≈ 1 = random walk → no signal
     */
    static hurst(prices: number[], window: number = 80): PsiSignal | null {
        if (prices.length < window) return null;

        const slice = prices.slice(-window);
        const logP = slice.map(p => Math.log(p));
        const returns: number[] = [];
        for (let i = 1; i < logP.length; i++) returns.push(logP[i] - logP[i - 1]);
        if (returns.length < 20) return null;

        const n = returns.length;
        const var1 = variance(returns);
        if (var1 < 1e-15) return null;

        const lags = [2, 4, 8, 16];
        const vrValues: number[] = [];
        for (const q of lags) {
            if (q >= n / 2) continue;
            const qReturns: number[] = [];
            for (let i = q; i < logP.length; i++) {
                qReturns.push(logP[i] - logP[i - q]);
            }
            const varQ = variance(qReturns);
            if (var1 > 1e-15) {
                vrValues.push(varQ / (q * var1));
            }
        }
        if (vrValues.length === 0) return null;

        const avgVR = vrValues.reduce((a, b) => a + b, 0) / vrValues.length;
        const H = clamp(Math.log(avgVR + 1e-10) / Math.log(2) * 0.5 + 0.5, 0.01, 0.99);

        // Recent direction
        const recent = returns.slice(-5);
        const recentMean = recent.reduce((a, b) => a + b, 0) / recent.length;

        let direction: number;
        if (H > 0.58) {
            // Trending → follow
            direction = clamp(Math.sign(recentMean) * (H - 0.5) * 5, -1, 1);
        } else if (H < 0.42) {
            // Mean-reverting → fade
            direction = clamp(-Math.sign(recentMean) * (0.5 - H) * 5, -1, 1);
        } else {
            return null; // Random walk zone
        }

        if (Math.abs(direction) < 0.05) return null;

        return {
            sourceId: 'price:hurst',
            direction,
            weight: 0.6,
            timestamp: Date.now(),
        };
    }

    /**
     * Ornstein-Uhlenbeck mean reversion with half-life estimation.
     * Fits AR(1) on log-prices: Δy = α + β·y(t-1) + ε
     * Only trades when half-life is reasonable (2-50 periods).
     */
    static ouSpread(prices: number[], window: number = 60): PsiSignal | null {
        if (prices.length < window) return null;

        const logP = prices.slice(-window).map(p => Math.log(p));
        const n = logP.length - 1;
        if (n < 10) return null;

        // OLS: Δy = α + β·y(t-1)
        const deltaY: number[] = [];
        const yLag: number[] = [];
        for (let i = 0; i < n; i++) {
            deltaY.push(logP[i + 1] - logP[i]);
            yLag.push(logP[i]);
        }

        // Simple OLS for β
        const meanY = yLag.reduce((a, b) => a + b, 0) / n;
        const meanDY = deltaY.reduce((a, b) => a + b, 0) / n;

        let ssYY = 0, ssYDY = 0;
        for (let i = 0; i < n; i++) {
            const dy = yLag[i] - meanY;
            ssYY += dy * dy;
            ssYDY += dy * (deltaY[i] - meanDY);
        }

        if (ssYY < 1e-15) return null;
        const beta = ssYDY / ssYY;
        const alpha = meanDY - beta * meanY;

        const theta = -beta; // mean reversion speed
        if (theta <= 0) return null; // not mean-reverting

        const mu = Math.abs(beta) > 1e-10 ? -alpha / beta : mean(logP);
        const halfLife = Math.log(2) / theta;

        // Only trade if half-life is reasonable
        if (halfLife < 2 || halfLife > 50) return null;

        // Compute z-score
        const residuals = deltaY.map((dy, i) => dy - alpha - beta * yLag[i]);
        const sigma = std(residuals);
        if (sigma < 1e-10) return null;

        const z = (logP[logP.length - 1] - mu) / sigma;

        // Speed multiplier: shorter half-life = stronger signal
        const speedMult = Math.min(2.0, 10.0 / halfLife);
        const direction = clamp(-z * speedMult * 0.3, -1, 1);

        if (Math.abs(direction) < 0.05) return null;

        return {
            sourceId: 'price:ou',
            direction,
            weight: 0.6,
            timestamp: Date.now(),
        };
    }

    /**
     * Bayesian momentum with adaptive prior.
     * Prior from first half of window, likelihood from recent 10 bars.
     * Confidence = reduction in posterior variance.
     */
    static momentum(prices: number[], window: number = 40): PsiSignal | null {
        if (prices.length < window) return null;

        const logP = prices.slice(-window).map(p => Math.log(p));
        const returns: number[] = [];
        for (let i = 1; i < logP.length; i++) returns.push(logP[i] - logP[i - 1]);

        if (returns.length < 10) return null;

        // Adaptive prior from first half
        const halfLen = Math.floor(returns.length / 2);
        const priorSlice = returns.slice(0, halfLen);
        const priorMean = priorSlice.length > 0 ? mean(priorSlice) : 0;
        const priorVar = Math.max(variance(priorSlice), 1e-8);

        // Likelihood from recent 10
        const recent = returns.slice(-10);
        const dataMean = mean(recent);
        const dataVar = Math.max(variance(recent) / recent.length, 1e-15);

        // Bayesian posterior
        const postVar = 1 / (1 / priorVar + 1 / dataVar);
        const postMean = postVar * (priorMean / priorVar + dataMean / dataVar);

        // Confidence from variance reduction
        const confidence = Math.min(1.0, Math.sqrt(priorVar / Math.max(postVar, 1e-15)) * 0.5);
        const direction = clamp(
            (Math.abs(postMean) > 1e-8 ? postMean / Math.abs(postMean) : 0) * confidence,
            -1, 1,
        );

        if (Math.abs(direction) < 0.05) return null;

        return {
            sourceId: 'price:momentum',
            direction,
            weight: 0.5,
            timestamp: Date.now(),
        };
    }

    /**
     * Generate all price-based signals from a close price array.
     */
    static all(prices: number[]): PsiSignal[] {
        const signals: PsiSignal[] = [];
        const h = PriceSignals.hurst(prices);
        if (h) signals.push(h);
        const ou = PriceSignals.ouSpread(prices);
        if (ou) signals.push(ou);
        const mom = PriceSignals.momentum(prices);
        if (mom) signals.push(mom);
        return signals;
    }
}

// ── Helpers ─────────────────────────────────────────────────────

function clamp(v: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, v));
}

function mean(arr: number[]): number {
    if (arr.length === 0) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function variance(arr: number[]): number {
    if (arr.length < 2) return 0;
    const m = mean(arr);
    return arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1);
}

function std(arr: number[]): number {
    return Math.sqrt(variance(arr));
}
