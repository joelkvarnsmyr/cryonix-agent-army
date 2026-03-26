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
        // We evaluate VWAP for the typical max arb bet size to avoid assuming instant 1-share fills
        const targetBetSizeUSD = config.strategy.arb_max_bet_size_usd || 10;
        
        const [yesFill, noFill] = await Promise.all([
            this.fetchBookAskVWAP(market.yesTokenId, targetBetSizeUSD),
            this.fetchBookAskVWAP(market.noTokenId, targetBetSizeUSD),
        ]);

        if (!yesFill || !noFill) return null;

        const combinedCost = yesFill.vwapPrice + noFill.vwapPrice;

        // Sanity: combined cost < 0.50 usually means illiquid / bad data
        if (combinedCost < 0.50) return null;

        const grossEdge = 1.0 - combinedCost;
        const roundTripFeesPct = 2 * config.risk.fee_rate;
        const roundTripFeesUSD = targetBetSizeUSD * roundTripFeesPct;
        
        // Add static Polygon Gas estimate ($0.05 per trade)
        const polyGasUSD = 0.05 * 2;
        
        const totalCostUSD = roundTripFeesUSD + polyGasUSD;
        // Edge expressed as a pure decimal (like grossEdge)
        const netEdge = grossEdge - (totalCostUSD / targetBetSizeUSD);

        // Only return if profitable after fees/gas AND below threshold
        if (netEdge <= 0) return null;
        if (combinedCost >= config.strategy.arb_threshold) return null;

        const maxSize = Math.min(yesFill.filledSizeUSD, noFill.filledSizeUSD, config.capital.max_bet_size_usd);

        return {
            market,
            yesBestAsk: yesFill.vwapPrice,
            noBestAsk: noFill.vwapPrice,
            combinedCost,
            grossEdge,
            netEdge,
            yesLiquidity: yesFill.filledSizeUSD,
            noLiquidity: noFill.filledSizeUSD,
            maxSize,
        };
    }

    /**
     * Get the YES midpoint price for directional comparison.
     */
    async getYesMidpoint(market: CryptoMicroMarket): Promise<number | null> {
        return this.fetchMidpoint(market.yesTokenId);
    }

    /**
     * Fetch L2 Orderbook and calculate VWAP to fill a target USD size from asks.
     */
    private async fetchBookAskVWAP(tokenId: string, targetSizeUSD: number): Promise<{ vwapPrice: number, filledSizeUSD: number } | null> {
        try {
            const url = `${this.clobUrl}/book?token_id=${tokenId}`;
            const res = await fetch(url, {
                headers: { 'Accept': 'application/json' },
                signal: AbortSignal.timeout(8_000),
            });
            if (!res.ok) return null;
            const data = await res.json() as { asks: { price: string, size: string }[] };
            if (!data.asks || data.asks.length === 0) return null;
            
            // Sort asks from lowest to highest price
            const asks = data.asks
                .map(a => ({ price: parseFloat(a.price), sizeShares: parseFloat(a.size) }))
                .filter(a => !isNaN(a.price) && !isNaN(a.sizeShares) && a.price > 0 && a.sizeShares > 0)
                .sort((a, b) => a.price - b.price);

            let remainingUSD = targetSizeUSD;
            let totalCostSpentUSD = 0;
            let totalSharesBought = 0;

            for (const ask of asks) {
                if (remainingUSD <= 0) break;
                
                const askAvailableUSD = ask.price * ask.sizeShares;
                const spendUSD = Math.min(remainingUSD, askAvailableUSD);
                const sharesReceived = spendUSD / ask.price;
                
                totalSharesBought += sharesReceived;
                totalCostSpentUSD += spendUSD;
                remainingUSD -= spendUSD;
            }

            if (totalSharesBought === 0) return null;
            
            // VWAP = total cost / total shares
            const vwapPrice = totalCostSpentUSD / totalSharesBought;
            const filledSizeUSD = totalCostSpentUSD;
            
            return { vwapPrice, filledSizeUSD };
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
