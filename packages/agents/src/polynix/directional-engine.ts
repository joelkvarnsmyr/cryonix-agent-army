import type { CryptoMicroMarket, DirectionalSignal, PolynixConfig } from './types';
import type { SpreadDetector } from './spread-detector';

interface PricePoint {
    price: number;
    timestamp: number;
}

const ASSET_TO_BINANCE: Record<string, string> = {
    BTC: 'BTCUSDT',
    ETH: 'ETHUSDT',
    SOL: 'SOLUSDT',
};

/**
 * DirectionalEngine — finds mispriced Polymarket markets based on
 * real-time CEX price data.
 *
 * For markets with price targets (e.g. "BTC above $80K by June"):
 *   - Compares current price distance to target with Polymarket probability
 *   - Uses momentum to estimate fair probability
 *   - Generates signal when Polymarket probability diverges from fair value
 *
 * For markets without explicit price targets:
 *   - Falls back to momentum comparison with midpoint probability
 */
export class DirectionalEngine {
    private priceHistory: Map<string, PricePoint[]> = new Map();
    private readonly maxHistoryMs = 60 * 60 * 1000; // 1 hour (longer for long-duration markets)

    recordPrice(asset: string, price: number): void {
        const now = Date.now();
        const history = this.priceHistory.get(asset) ?? [];
        history.push({ price, timestamp: now });

        const cutoff = now - this.maxHistoryMs;
        const trimmed = history.filter(p => p.timestamp >= cutoff);
        this.priceHistory.set(asset, trimmed);
    }

    async fetchPrices(config: PolynixConfig): Promise<void> {
        for (const symbol of config.data_sources.binance_symbols) {
            try {
                const url = `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`;
                const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
                if (!res.ok) continue;
                const data = await res.json() as { symbol: string; price: string };
                const price = parseFloat(data.price);
                if (isNaN(price)) continue;

                const asset = this.binanceToAsset(symbol);
                if (asset) this.recordPrice(asset, price);
            } catch {
                // Non-critical
            }
        }
    }

    /**
     * Evaluate a crypto market for directional opportunity.
     */
    async evaluate(
        market: CryptoMicroMarket,
        spreadDetector: SpreadDetector,
        config: PolynixConfig,
    ): Promise<DirectionalSignal | null> {
        // Only evaluate crypto assets (not MACRO arb-only markets)
        if (market.asset === 'MACRO' || market.asset === 'CRYPTO') return null;

        const history = this.priceHistory.get(market.asset);
        if (!history || history.length < 2) return null;

        const latestPrice = history[history.length - 1].price;

        // Get Polymarket YES midpoint
        const polyProb = await spreadDetector.getYesMidpoint(market);
        if (polyProb === null) return null;

        let impliedFairProb: number;
        let priceChangePct: number;

        if (market.priceTarget && market.targetDirection) {
            // Price target market: compute fair probability based on distance
            impliedFairProb = this.priceTargetToProb(
                latestPrice,
                market.priceTarget,
                market.targetDirection,
                market.timeToExpiry,
            );
            priceChangePct = ((latestPrice - market.priceTarget) / market.priceTarget) * 100;
        } else {
            // No price target: use momentum heuristic
            const lookbackMs = config.strategy.momentum_lookback_seconds * 1000;
            const now = Date.now();
            const cutoff = now - lookbackMs;
            const recentPrices = history.filter(p => p.timestamp >= cutoff);
            if (recentPrices.length < 2) return null;

            const oldestPrice = recentPrices[0].price;
            priceChangePct = ((latestPrice - oldestPrice) / oldestPrice) * 100;
            impliedFairProb = this.momentumToProb(priceChangePct);
        }

        // Calculate edge
        const minEdge = config.strategy.min_edge_pct / 100;
        let direction: 'YES' | 'NO';
        let edge: number;

        if (impliedFairProb > polyProb) {
            direction = 'YES';
            edge = impliedFairProb - polyProb;
        } else {
            direction = 'NO';
            edge = polyProb - impliedFairProb;
        }

        if (edge < minEdge) return null;

        // Confidence based on edge + momentum consistency + liquidity
        const consistency = this.momentumConsistency(history.slice(-20));
        const liqBonus = market.liquidity > 10_000 ? 1.0 : market.liquidity / 10_000;
        const confidence = Math.min(95, Math.round(edge * 100 * 2 * consistency * liqBonus));

        if (confidence < 20) return null; // Too low confidence

        return {
            market,
            direction,
            currentPrice: latestPrice,
            priceChangePct,
            polymarketProb: polyProb,
            impliedFairProb,
            edge,
            confidence,
        };
    }

    getCurrentPrice(asset: string): number | null {
        const history = this.priceHistory.get(asset);
        if (!history || history.length === 0) return null;
        return history[history.length - 1].price;
    }

    /**
     * Estimate fair probability for a price target market.
     *
     * Example: "BTC above $80K by June"
     *   - BTC at $79K, 30 days left → ~45-55% (close, plenty of time)
     *   - BTC at $85K, 30 days left → ~80-90% (already above target)
     *   - BTC at $70K, 3 days left → ~5-10% (far below, little time)
     */
    private priceTargetToProb(
        currentPrice: number,
        target: number,
        direction: 'above' | 'below',
        timeToExpirySec: number,
    ): number {
        const distancePct = (currentPrice - target) / target;
        const daysToExpiry = timeToExpirySec / 86400;

        // Assume ~2% daily volatility for crypto
        const dailyVol = 0.02;
        const totalVol = dailyVol * Math.sqrt(Math.max(daysToExpiry, 0.1));

        // Simple z-score approximation
        let zScore: number;
        if (direction === 'above') {
            // Probability current price drifts above target
            zScore = distancePct / totalVol;
        } else {
            // Probability current price drops below target
            zScore = -distancePct / totalVol;
        }

        // Approximate normal CDF using logistic approximation
        const prob = 1 / (1 + Math.exp(-1.7 * zScore));

        return Math.max(0.02, Math.min(0.98, prob));
    }

    /**
     * Map short-term momentum to implied probability (for non-target markets).
     */
    private momentumToProb(changePct: number): number {
        const k = 3.0;
        const prob = 0.5 + 0.5 * Math.tanh((changePct / 100) * k * 100);
        return Math.max(0.05, Math.min(0.95, prob));
    }

    private momentumConsistency(prices: PricePoint[]): number {
        if (prices.length < 3) return 0.5;

        let sameDirection = 0;
        const total = prices.length - 1;
        const overallDir = prices[prices.length - 1].price > prices[0].price ? 1 : -1;

        for (let i = 1; i < prices.length; i++) {
            const dir = prices[i].price > prices[i - 1].price ? 1 : -1;
            if (dir === overallDir) sameDirection++;
        }

        return sameDirection / total;
    }

    private binanceToAsset(symbol: string): string | null {
        for (const [asset, binSymbol] of Object.entries(ASSET_TO_BINANCE)) {
            if (binSymbol === symbol) return asset;
        }
        return null;
    }
}
