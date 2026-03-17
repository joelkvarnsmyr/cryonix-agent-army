/**
 * SignalCollector — Aggregates signals from all Cryonix subsystems into
 * PsiSignals for the Kuramoto phase convergence engine.
 *
 * Sources:
 *   1. Smart Money (Copynix whale sentiment) → Redis smartmoney:*
 *   2. Polymarket prediction markets → Redis polymarket:*
 *   3. Fear & Greed Index → Redis cmc:fear_greed
 *   4. Cryonix TA signals → Redis trades:pending
 */

import type { PsiSignal } from './psi-engine';

export interface RedisReader {
    get(key: string): Promise<string | null>;
    keys(pattern: string): Promise<string[]>;
}

export class SignalCollector {
    private redis: RedisReader;

    constructor(redis: RedisReader) {
        this.redis = redis;
    }

    /**
     * Collect all available signals from Redis and convert to PsiSignals.
     * Each source produces a directional signal σ ∈ [-1, +1].
     */
    async collect(symbol: string): Promise<PsiSignal[]> {
        const signals: PsiSignal[] = [];

        // ── 1. Smart Money — Copynix whale consensus ──
        const smartMoney = await this.getSmartMoney(symbol);
        if (smartMoney) signals.push(smartMoney);

        // ── 2. Polymarket — prediction market sentiment ──
        const polySignals = await this.getPolymarketSignals();
        signals.push(...polySignals);

        // ── 3. Fear & Greed Index ──
        const fng = await this.getFearAndGreed();
        if (fng) signals.push(fng);

        // ── 4. Smart Money overall ──
        const overall = await this.getSmartMoneyOverall();
        if (overall) signals.push(overall);

        return signals;
    }

    /**
     * Smart Money: per-asset whale sentiment from Copynix.
     * Score -100 to +100 → σ = score/100
     */
    private async getSmartMoney(symbol: string): Promise<PsiSignal | null> {
        try {
            // Map Binance symbol to Copynix smart money key
            const base = symbol.split('/')[0]; // "BTC/USDC" → "BTC"
            const raw = await this.redis.get(`smartmoney:${base}`);
            if (!raw) return null;

            const data = JSON.parse(raw);
            const age = Date.now() - (data.timestamp ?? 0);
            if (age > 30 * 60_000) return null; // Stale after 30min

            return {
                sourceId: `smartmoney:${base}`,
                direction: Math.max(-1, Math.min(1, (data.score ?? 0) / 100)),
                weight: 0.8, // High weight — real on-chain activity
                timestamp: data.timestamp ?? Date.now(),
            };
        } catch {
            return null;
        }
    }

    /**
     * Smart Money overall: aggregate whale mood across all assets.
     */
    private async getSmartMoneyOverall(): Promise<PsiSignal | null> {
        try {
            const raw = await this.redis.get('smartmoney:_overall');
            if (!raw) return null;

            const data = JSON.parse(raw);
            const age = Date.now() - (data.timestamp ?? 0);
            if (age > 30 * 60_000) return null;

            return {
                sourceId: 'smartmoney:overall',
                direction: Math.max(-1, Math.min(1, (data.score ?? 0) / 100)),
                weight: 0.6,
                timestamp: data.timestamp ?? Date.now(),
            };
        } catch {
            return null;
        }
    }

    /**
     * Polymarket: prediction market sentiment per category.
     * Score 0-100 → σ = (score - 50) / 50 (above 50 = bullish)
     */
    private async getPolymarketSignals(): Promise<PsiSignal[]> {
        const signals: PsiSignal[] = [];
        const categories = ['crypto', 'fed', 'geopolitik', 'oil'];

        for (const cat of categories) {
            try {
                const raw = await this.redis.get(`polymarket:${cat}`);
                if (!raw) continue;

                const data = JSON.parse(raw);
                const score = data.score ?? 50;

                // Map 0-100 → [-1, +1]: 0 = max bearish, 50 = neutral, 100 = max bullish
                const direction = (score - 50) / 50;

                // Different weights per category
                const weights: Record<string, number> = {
                    crypto: 0.7,  // Direct crypto sentiment
                    fed: 0.5,     // Fed policy affects all markets
                    geopolitik: 0.4, // Geopolitical risk
                    oil: 0.3,     // Oil is indirect
                };

                signals.push({
                    sourceId: `polymarket:${cat}`,
                    direction: Math.max(-1, Math.min(1, direction)),
                    weight: weights[cat] ?? 0.3,
                    timestamp: Date.now(),
                });
            } catch {
                continue;
            }
        }

        return signals;
    }

    /**
     * Fear & Greed Index (CoinMarketCap).
     * 0 = Extreme Fear (bearish), 100 = Extreme Greed (bullish)
     * Contrarian signal: extreme fear = buy opportunity
     */
    private async getFearAndGreed(): Promise<PsiSignal | null> {
        try {
            const raw = await this.redis.get('cmc:fear_greed');
            if (!raw) return null;

            const data = JSON.parse(raw);
            const value = data.value ?? data.score ?? 50;

            // Contrarian: extreme fear (+1 buy), extreme greed (-1 sell)
            // Neutral zone (40-60) → near 0
            const contrarian = (50 - value) / 50; // Fear=+1, Greed=-1

            return {
                sourceId: 'fear_greed',
                direction: Math.max(-1, Math.min(1, contrarian)),
                weight: 0.4, // Moderate weight — lagging indicator
                timestamp: Date.now(),
            };
        } catch {
            return null;
        }
    }
}
