import type { CryptoMicroMarket, ArbOpportunity, PolynixConfig } from './types';

/**
 * SpreadDetector — finds YES+NO arbitrage on Polymarket.
 *
 * Uses CLOB /price endpoint (AMM-inclusive pricing) instead of /book
 * (which only shows thin limit orders). /price returns the real price
 * you'd actually pay to buy a token.
 */
export class SpreadDetector {
    private clobUrl: string;

    constructor(config: PolynixConfig) {
        this.clobUrl = config.broker.clob_api_url;
    }

    /**
     * Check if a market has a spread arb opportunity.
     * Returns non-null only if profitable after round-trip fees.
     */
    async check(market: CryptoMicroMarket, config: PolynixConfig): Promise<ArbOpportunity | null> {
        const [yesBuyPrice, noBuyPrice] = await Promise.all([
            this.fetchPrice(market.yesTokenId, 'buy'),
            this.fetchPrice(market.noTokenId, 'buy'),
        ]);

        if (yesBuyPrice === null || noBuyPrice === null) return null;

        const combinedCost = yesBuyPrice + noBuyPrice;

        // Sanity: combined cost < 0.50 usually means illiquid / bad data
        if (combinedCost < 0.50) return null;

        const grossEdge = 1.0 - combinedCost;
        const roundTripFees = 2 * config.risk.fee_rate;
        const netEdge = grossEdge - roundTripFees;

        // Only return if profitable after fees AND below threshold
        if (netEdge <= 0) return null;
        if (combinedCost >= config.strategy.arb_threshold) return null;

        // Estimate liquidity from the market object
        const liquidity = market.liquidity || 0;
        const halfLiq = liquidity / 2;

        return {
            market,
            yesBestAsk: yesBuyPrice,
            noBestAsk: noBuyPrice,
            combinedCost,
            grossEdge,
            netEdge,
            yesLiquidity: halfLiq,
            noLiquidity: halfLiq,
            maxSize: Math.min(halfLiq, config.capital.max_bet_size_usd),
        };
    }

    /**
     * Get the YES midpoint price for directional comparison.
     */
    async getYesMidpoint(market: CryptoMicroMarket): Promise<number | null> {
        return this.fetchMidpoint(market.yesTokenId);
    }

    /**
     * Fetch the actual AMM-inclusive price to buy/sell a token.
     */
    private async fetchPrice(tokenId: string, side: 'buy' | 'sell'): Promise<number | null> {
        try {
            const url = `${this.clobUrl}/price?token_id=${tokenId}&side=${side}`;
            const res = await fetch(url, {
                headers: { 'Accept': 'application/json' },
                signal: AbortSignal.timeout(8_000),
            });
            if (!res.ok) return null;
            const data = await res.json() as { price: string };
            const price = parseFloat(data.price);
            return isNaN(price) || price <= 0 ? null : price;
        } catch {
            return null;
        }
    }

    /**
     * Fetch midpoint price for a token.
     */
    private async fetchMidpoint(tokenId: string): Promise<number | null> {
        try {
            const url = `${this.clobUrl}/midpoint?token_id=${tokenId}`;
            const res = await fetch(url, {
                headers: { 'Accept': 'application/json' },
                signal: AbortSignal.timeout(8_000),
            });
            if (!res.ok) return null;
            const data = await res.json() as { mid: string };
            const mid = parseFloat(data.mid);
            return isNaN(mid) ? null : mid;
        } catch {
            return null;
        }
    }
}
