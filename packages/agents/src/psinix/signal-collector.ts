/**
 * SignalCollector — Aggregates independent signals for Kuramoto phase convergence.
 *
 * Signal independence is critical for Ψnix. Kuramoto coherence C measures
 * synchronization of *independent* oscillators. Correlated signals inflate C
 * artificially. Each signal source must measure a DIFFERENT property.
 *
 * Independent signal sources:
 *   1. Price: Hurst (trend character) — from OHLCV
 *   2. Price: OU z-score (mean reversion) — from OHLCV
 *   3. Price: Bayesian momentum — from OHLCV
 *   4. Polymarket: macro sentiment (ONE composite, not 4 separate)
 *   5. Fear & Greed: crowd contrarian — from CMC
 *   6. Smart Money: on-chain whale behavior — from Copynix
 *   7. Cryonix TA: technical pattern signals — from engine
 *   8. Market Regime: bull/bear/volatile — from engine
 */

import type { PsiSignal } from './psi-engine';
import { PriceSignals } from './price-signals';

export interface RedisReader {
    get(key: string): Promise<string | null>;
    keys(pattern: string): Promise<string[]>;
    lrange(key: string, start: number, stop: number): Promise<string[]>;
}

export class SignalCollector {
    private redis: RedisReader;

    constructor(redis: RedisReader) {
        this.redis = redis;
    }

    /**
     * Collect all available independent signals.
     * Price-based signals require close prices passed separately.
     */
    async collect(symbol: string, closePrices?: number[]): Promise<PsiSignal[]> {
        const signals: PsiSignal[] = [];

        // ── Price-based signals (mathematically independent) ──
        if (closePrices && closePrices.length >= 20) {
            const priceSignals = PriceSignals.all(closePrices);
            signals.push(...priceSignals);
        }

        // ── Polymarket — ONE composite signal (not 4 correlated ones) ──
        const poly = await this.getPolymarketComposite();
        if (poly) signals.push(poly);

        // ── Fear & Greed — contrarian crowd sentiment ──
        const fng = await this.getFearAndGreed();
        if (fng) signals.push(fng);

        // ── Smart Money — on-chain whale behavior (requires sufficient data) ──
        const sm = await this.getSmartMoney(symbol);
        if (sm) signals.push(sm);

        // ── Cryonix TA — technical pattern signals ──
        const ta = await this.getCryonixTA(symbol);
        if (ta) signals.push(ta);

        // ── Market Regime — engine's regime classification ──
        const regime = await this.getMarketRegime();
        if (regime) signals.push(regime);

        return signals;
    }

    // ── Polymarket: ONE composite signal ──────────────────────────────

    /**
     * Collapse 4 Polymarket categories into 1 weighted-average signal.
     * crypto=50%, fed=25%, geopolitik=15%, oil=10%
     * This prevents 4 correlated signals from inflating Kuramoto coherence.
     */
    private async getPolymarketComposite(): Promise<PsiSignal | null> {
        const categoryWeights: Record<string, number> = {
            crypto: 0.50,
            fed: 0.25,
            geopolitik: 0.15,
            oil: 0.10,
        };

        let weightedSum = 0;
        let totalWeight = 0;

        for (const [cat, w] of Object.entries(categoryWeights)) {
            try {
                const raw = await this.redis.get(`polymarket:${cat}`);
                if (!raw) continue;

                const data = JSON.parse(raw);
                const score = data.score ?? 50;
                const direction = (score - 50) / 50; // 0-100 → [-1, +1]

                weightedSum += direction * w;
                totalWeight += w;
            } catch {
                continue;
            }
        }

        if (totalWeight < 0.3) return null; // Need at least some categories

        const compositeDirection = weightedSum / totalWeight;
        if (Math.abs(compositeDirection) < 0.05) return null; // Too weak

        return {
            sourceId: 'polymarket:composite',
            direction: Math.max(-1, Math.min(1, compositeDirection)),
            weight: 0.5,
            timestamp: Date.now(),
        };
    }

    // ── Smart Money ───────────────────────────────────────────────────

    /**
     * Smart Money: per-asset whale sentiment from Copynix.
     * Requires: score based on >= 3 trades, data < 30min old.
     * Falls back to overall if per-asset unavailable.
     */
    private async getSmartMoney(symbol: string): Promise<PsiSignal | null> {
        const base = symbol.split('/')[0];

        // Try per-asset first
        const perAsset = await this.readSmartMoney(`smartmoney:${base}`, `smartmoney:${base}`);
        if (perAsset) return perAsset;

        // Fall back to overall — but require sufficient data
        return this.readSmartMoney('smartmoney:_overall', 'smartmoney:overall');
    }

    private async readSmartMoney(key: string, sourceId: string): Promise<PsiSignal | null> {
        try {
            const raw = await this.redis.get(key);
            if (!raw) return null;

            const data = JSON.parse(raw);
            const age = Date.now() - (data.timestamp ?? 0);
            if (age > 30 * 60_000) return null; // Stale

            // Require sufficient trades for meaningful signal
            const totalTrades = (data.buys ?? 0) + (data.sells ?? 0);
            if (totalTrades < 3) return null; // Not enough data

            // Score 0-100: 0=all sells, 50=neutral, 100=all buys
            // Map to [-1, +1]: σ = (score - 50) / 50
            const score = data.score ?? 50;
            const direction = Math.max(-1, Math.min(1, (score - 50) / 50));
            if (Math.abs(direction) < 0.1) return null; // Too neutral

            return {
                sourceId,
                direction,
                weight: 0.7,
                timestamp: data.timestamp ?? Date.now(),
            };
        } catch {
            return null;
        }
    }

    // ── Fear & Greed ──────────────────────────────────────────────────

    /**
     * CoinMarketCap Fear & Greed — contrarian signal.
     * Extreme fear → buy (+1), extreme greed → sell (-1).
     */
    private async getFearAndGreed(): Promise<PsiSignal | null> {
        try {
            const raw = await this.redis.get('cmc:fear_greed');
            if (!raw) return null;

            const data = JSON.parse(raw);
            const value = data.value ?? data.score ?? 50;

            // Contrarian mapping
            const contrarian = (50 - value) / 50;
            if (Math.abs(contrarian) < 0.1) return null; // Neutral zone

            return {
                sourceId: 'fear_greed',
                direction: Math.max(-1, Math.min(1, contrarian)),
                weight: 0.4,
                timestamp: Date.now(),
            };
        } catch {
            return null;
        }
    }

    // ── Cryonix TA ────────────────────────────────────────────────────

    /**
     * Reads trades:pending LIST from Python engine.
     */
    private async getCryonixTA(symbol: string): Promise<PsiSignal | null> {
        try {
            const base = symbol.split('/')[0];
            const entries = await this.redis.lrange('trades:pending', 0, -1);
            if (!entries || entries.length === 0) return null;

            for (let i = entries.length - 1; i >= 0; i--) {
                const signal = SignalCollector.parseTASignal(entries[i], base);
                if (signal) return signal;
            }
            return null;
        } catch {
            return null;
        }
    }

    /**
     * Parse a trades:pending JSON entry into a PsiSignal.
     */
    static parseTASignal(raw: string, filterBase: string): PsiSignal | null {
        try {
            const data = JSON.parse(raw);

            // Guard against circular reference — reject any signal from psinix itself
            if ((data.source ?? '').toLowerCase().includes('psinix')) return null;

            const signalBase = (data.symbol ?? '').split('/')[0];
            if (signalBase !== filterBase) return null;

            const confidence = data.confidence ?? 50;
            const isBuy = (data.action ?? '').toUpperCase() === 'BUY';
            const magnitude = (confidence - 50) / 50;
            const direction = isBuy ? magnitude : -magnitude;

            return {
                sourceId: `cryonix_ta:${signalBase}`,
                direction: Math.max(-1, Math.min(1, direction)),
                weight: 0.7,
                timestamp: data.timestamp ?? Date.now(),
            };
        } catch {
            return null;
        }
    }

    // ── Market Regime ─────────────────────────────────────────────────

    /**
     * Market regime from Python engine.
     */
    private async getMarketRegime(): Promise<PsiSignal | null> {
        try {
            const raw = await this.redis.get('market:regime');
            if (!raw) return null;

            const data = JSON.parse(raw);
            const regimeMap: Record<string, number> = {
                'bullish': 0.5, 'trending_up': 0.5,
                'bearish': -0.5, 'trending_down': -0.5,
                'volatile': 0, 'choppy': -0.2,
                'ranging': 0, 'neutral': 0,
            };

            const direction = regimeMap[data.regime ?? data.state ?? ''] ?? 0;
            if (direction === 0) return null;

            return {
                sourceId: 'market:regime',
                direction,
                weight: 0.3,
                timestamp: Date.now(),
            };
        } catch {
            return null;
        }
    }
}
