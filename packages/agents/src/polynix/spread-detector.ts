import type { CryptoMicroMarket, ArbOpportunity, PolynixConfig } from './types';

interface ClobOrderbook {
    market: string;
    asset_id: string;
    bids: { price: string; size: string }[];
    asks: { price: string; size: string }[];
}

export class SpreadDetector {
    private clobUrl: string;

    constructor(config: PolynixConfig) {
        this.clobUrl = config.broker.clob_api_url;
    }

    async check(market: CryptoMicroMarket, config: PolynixConfig): Promise<ArbOpportunity | null> {
        const [yesBook, noBook] = await Promise.all([
            this.fetchOrderbook(market.yesTokenId),
            this.fetchOrderbook(market.noTokenId),
        ]);

        if (!yesBook || !noBook) return null;

        // Best ask = cheapest available to buy
        const yesBestAsk = this.bestAsk(yesBook);
        const noBestAsk = this.bestAsk(noBook);

        if (!yesBestAsk || !noBestAsk) return null;

        const combinedCost = yesBestAsk.price + noBestAsk.price;
        const grossEdge = 1.0 - combinedCost;

        // Net edge after round-trip fees (buy both sides)
        const roundTripFees = 2 * config.risk.fee_rate;
        const netEdge = grossEdge - roundTripFees;

        // Only return if profitable after fees
        if (netEdge <= 0) return null;

        // Also check threshold
        if (combinedCost >= config.strategy.arb_threshold) return null;

        const yesLiquidity = yesBestAsk.size * yesBestAsk.price;
        const noLiquidity = noBestAsk.size * noBestAsk.price;

        return {
            market,
            yesBestAsk: yesBestAsk.price,
            noBestAsk: noBestAsk.price,
            combinedCost,
            grossEdge,
            netEdge,
            yesLiquidity,
            noLiquidity,
            maxSize: Math.min(yesBestAsk.size, noBestAsk.size),
        };
    }

    private async fetchOrderbook(tokenId: string): Promise<ClobOrderbook | null> {
        const url = `${this.clobUrl}/book?token_id=${tokenId}`;
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
            if (!res.ok) return null;
            return await res.json() as ClobOrderbook;
        } catch {
            return null;
        }
    }

    private bestAsk(book: ClobOrderbook): { price: number; size: number } | null {
        if (!book.asks || book.asks.length === 0) return null;

        // Asks sorted ascending — first is best (lowest price)
        let best: { price: number; size: number } | null = null;
        for (const ask of book.asks) {
            const price = parseFloat(ask.price);
            const size = parseFloat(ask.size);
            if (isNaN(price) || isNaN(size) || size <= 0) continue;
            if (!best || price < best.price) {
                best = { price, size };
            }
        }
        return best;
    }

    /**
     * Get the YES midpoint price for a market (used by directional engine).
     */
    async getYesMidpoint(market: CryptoMicroMarket): Promise<number | null> {
        const book = await this.fetchOrderbook(market.yesTokenId);
        if (!book) return null;

        const bestBid = this.bestBid(book);
        const bestAsk = this.bestAsk(book);
        if (!bestBid || !bestAsk) return bestAsk?.price ?? bestBid?.price ?? null;

        return (bestBid.price + bestAsk.price) / 2;
    }

    private bestBid(book: ClobOrderbook): { price: number; size: number } | null {
        if (!book.bids || book.bids.length === 0) return null;

        let best: { price: number; size: number } | null = null;
        for (const bid of book.bids) {
            const price = parseFloat(bid.price);
            const size = parseFloat(bid.size);
            if (isNaN(price) || isNaN(size) || size <= 0) continue;
            if (!best || price > best.price) {
                best = { price, size };
            }
        }
        return best;
    }
}
