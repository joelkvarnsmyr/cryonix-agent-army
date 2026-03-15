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

export class DirectionalEngine {
    private priceHistory: Map<string, PricePoint[]> = new Map();
    private readonly maxHistoryMs = 5 * 60 * 1000; // 5 minutes

    /**
     * Record a price update for an asset. Called every scan tick.
     */
    recordPrice(asset: string, price: number): void {
        const now = Date.now();
        const history = this.priceHistory.get(asset) ?? [];

        history.push({ price, timestamp: now });

        // Evict entries older than 5 minutes
        const cutoff = now - this.maxHistoryMs;
        const trimmed = history.filter(p => p.timestamp >= cutoff);

        this.priceHistory.set(asset, trimmed);
    }

    /**
     * Fetch current prices from Binance REST for all configured symbols.
     */
    async fetchPrices(config: PolynixConfig): Promise<void> {
        for (const symbol of config.data_sources.binance_symbols) {
            try {
                const url = `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`;
                const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
                if (!res.ok) continue;
                const data = await res.json() as { symbol: string; price: string };
                const price = parseFloat(data.price);
                if (isNaN(price)) continue;

                // Map BTCUSDT -> BTC
                const asset = this.binanceToAsset(symbol);
                if (asset) this.recordPrice(asset, price);
            } catch {
                // Non-critical, continue
            }
        }
    }

    /**
     * Evaluate a market for directional opportunity.
     */
    async evaluate(
        market: CryptoMicroMarket,
        spreadDetector: SpreadDetector,
        config: PolynixConfig,
    ): Promise<DirectionalSignal | null> {
        const history = this.priceHistory.get(market.asset);
        if (!history || history.length < 2) return null;

        // Get Polymarket YES midpoint
        const polyProb = await spreadDetector.getYesMidpoint(market);
        if (polyProb === null) return null;

        // Calculate momentum over lookback window
        const lookbackMs = config.strategy.momentum_lookback_seconds * 1000;
        const now = Date.now();
        const cutoff = now - lookbackMs;

        const recentPrices = history.filter(p => p.timestamp >= cutoff);
        if (recentPrices.length < 2) return null;

        const oldestPrice = recentPrices[0].price;
        const latestPrice = recentPrices[recentPrices.length - 1].price;
        const priceChangePct = ((latestPrice - oldestPrice) / oldestPrice) * 100;

        // Map momentum to implied fair probability
        const impliedFairProb = this.momentumToProb(priceChangePct, config.strategy.momentum_lookback_seconds);

        // Calculate edge
        const minEdge = config.strategy.min_edge_pct / 100;
        let direction: 'YES' | 'NO';
        let edge: number;

        if (impliedFairProb > polyProb) {
            // Price momentum is bullish, Polymarket hasn't caught up -> buy YES
            direction = 'YES';
            edge = impliedFairProb - polyProb;
        } else {
            // Price momentum is bearish, Polymarket hasn't caught up -> buy NO
            direction = 'NO';
            edge = polyProb - impliedFairProb; // polyProb(YES) is high, so NO is cheap
        }

        if (edge < minEdge) return null;

        // Confidence based on edge magnitude + momentum consistency
        const consistency = this.momentumConsistency(recentPrices);
        const confidence = Math.min(95, Math.round(edge * 100 * 2 * consistency));

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

    /**
     * Get current price for an asset from the buffer.
     */
    getCurrentPrice(asset: string): number | null {
        const history = this.priceHistory.get(asset);
        if (!history || history.length === 0) return null;
        return history[history.length - 1].price;
    }

    /**
     * Map price momentum percentage to implied binary probability.
     *
     * Heuristic (calibrate with live data):
     *   0.0% -> 50%
     *  +0.3% -> 60%
     *  +0.5% -> 70%
     *  +1.0% -> 85%
     * Symmetric for negative moves.
     */
    private momentumToProb(changePct: number, _lookbackSeconds: number): number {
        // Sigmoid-like mapping centered at 50%
        // f(x) = 0.5 + 0.5 * tanh(x * k) where k controls sensitivity
        const k = 3.0; // Sensitivity factor (calibrate with real data)
        const prob = 0.5 + 0.5 * Math.tanh((changePct / 100) * k * 100);
        return Math.max(0.05, Math.min(0.95, prob));
    }

    /**
     * Measure how consistent the price trend is (0-1).
     * A steady drift scores higher than a spike-and-reversal.
     */
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
