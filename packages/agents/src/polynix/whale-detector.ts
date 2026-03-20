/**
 * Whale Detector — Detects whale manipulation on Polymarket orderbooks.
 *
 * "Classic manipulation: Whale accumulated DOWN cheap, used UP as cover."
 *
 * Detection logic:
 * 1. Fetch orderbook for YES and NO tokens
 * 2. Compare bid depth asymmetry (which side has more liquidity?)
 * 3. If one side has 5x+ more depth → whale is market-making that side
 *    → their REAL position is the OTHER side
 * 4. High asymmetry + tight spread = high confidence whale signal
 */

import type { CryptoMicroMarket } from './types';

interface WhaleSignal {
    conditionId: string;
    title: string;
    dominantSide: 'YES' | 'NO';
    realBet: 'YES' | 'NO';  // Opposite of dominant (whale's real position)
    asymmetryRatio: number;
    yesDepth: number;
    noDepth: number;
    confidence: number;  // 0-100
    timestamp: number;
}

interface OrderbookSide {
    bids: Array<{ price: number; size: number }>;
    asks: Array<{ price: number; size: number }>;
}

const MIN_ASYMMETRY = 5.0;   // 5x depth difference to signal whale
const MIN_DEPTH_USD = 500;    // Minimum $500 depth on dominant side
const MAX_SPREAD = 0.10;      // Max 10% spread (liquid market)

export class WhaleDetector {
    private clobUrl: string;

    constructor(clobUrl: string) {
        this.clobUrl = clobUrl;
    }

    /**
     * Analyze a market for whale manipulation signals.
     * Returns null if no whale detected.
     */
    async detect(market: CryptoMicroMarket): Promise<WhaleSignal | null> {
        try {
            const [yesBook, noBook] = await Promise.all([
                this.fetchOrderbook(market.yesTokenId),
                this.fetchOrderbook(market.noTokenId),
            ]);

            if (!yesBook || !noBook) return null;

            // Calculate total bid depth (how much $ available to buy)
            const yesDepth = this.totalDepth(yesBook.bids);
            const noDepth = this.totalDepth(noBook.bids);

            if (yesDepth < 10 && noDepth < 10) return null; // Dead market

            // Asymmetry ratio
            const maxDepth = Math.max(yesDepth, noDepth);
            const minDepth = Math.max(Math.min(yesDepth, noDepth), 1); // Avoid div/0
            const asymmetry = maxDepth / minDepth;

            if (asymmetry < MIN_ASYMMETRY) return null;
            if (maxDepth < MIN_DEPTH_USD) return null;

            // Which side is dominant (has more bids = whale market-making)?
            const dominantSide: 'YES' | 'NO' = yesDepth > noDepth ? 'YES' : 'NO';
            const realBet: 'YES' | 'NO' = dominantSide === 'YES' ? 'NO' : 'YES';

            // Check spread (tight spread = active market-making = more confident)
            const yesSpread = this.spread(yesBook);
            const noSpread = this.spread(noBook);
            const avgSpread = (yesSpread + noSpread) / 2;

            if (avgSpread > MAX_SPREAD) return null; // Too wide = not actively market-making

            // Confidence based on asymmetry + depth + spread tightness
            let confidence = Math.min(95, Math.round(
                (asymmetry / 20) * 40 +          // Asymmetry component (5x→10, 20x→40)
                (maxDepth / 5000) * 30 +          // Depth component ($500→3, $5000→30)
                ((MAX_SPREAD - avgSpread) / MAX_SPREAD) * 25  // Spread tightness
            ));

            if (confidence < 30) return null;

            return {
                conditionId: market.conditionId,
                title: market.title,
                dominantSide,
                realBet,
                asymmetryRatio: Math.round(asymmetry * 10) / 10,
                yesDepth: Math.round(yesDepth),
                noDepth: Math.round(noDepth),
                confidence,
                timestamp: Date.now(),
            };
        } catch {
            return null;
        }
    }

    private async fetchOrderbook(tokenId: string): Promise<OrderbookSide | null> {
        try {
            const url = `${this.clobUrl}/book?token_id=${tokenId}`;
            const res = await fetch(url, {
                headers: { 'Accept': 'application/json' },
                signal: AbortSignal.timeout(8_000),
            });
            if (!res.ok) return null;
            const data = await res.json() as any;

            return {
                bids: (data.bids || []).map((b: any) => ({
                    price: parseFloat(b.price),
                    size: parseFloat(b.size),
                })),
                asks: (data.asks || []).map((a: any) => ({
                    price: parseFloat(a.price),
                    size: parseFloat(a.size),
                })),
            };
        } catch {
            return null;
        }
    }

    private totalDepth(orders: Array<{ price: number; size: number }>): number {
        return orders.reduce((sum, o) => sum + (o.price * o.size), 0);
    }

    private spread(book: OrderbookSide): number {
        if (book.bids.length === 0 || book.asks.length === 0) return 1.0;
        const bestBid = Math.max(...book.bids.map(b => b.price));
        const bestAsk = Math.min(...book.asks.map(a => a.price));
        if (bestBid <= 0) return 1.0;
        return (bestAsk - bestBid) / bestBid;
    }
}
