import type { OrderResult, ArbOpportunity, PolynixConfig } from './types';
import { randomUUID } from 'crypto';

export class OrderManager {
    private paperMode: boolean;
    private clobUrl: string;

    constructor(config: PolynixConfig) {
        this.paperMode = config.broker.paper_trading;
        this.clobUrl = config.broker.clob_api_url;
    }

    /**
     * Helper to simulate network latency.
     */
    private async sleep(ms: number) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Fetch L2 Orderbook and calculate VWAP to fill a target number of shares.
     */
    private async fetchBookFillVWAP(tokenId: string, side: 'BUY' | 'SELL', targetShares: number): Promise<number | null> {
        try {
            const url = `${this.clobUrl}/book?token_id=${tokenId}`;
            const res = await fetch(url, {
                headers: { 'Accept': 'application/json' },
                signal: AbortSignal.timeout(8_000),
            });
            if (!res.ok) return null;
            const data = await res.json() as { bids: { price: string, size: string }[], asks: { price: string, size: string }[] };
            
            const orders = side === 'BUY' ? data.asks : data.bids;
            if (!orders || orders.length === 0) return null;
            
            // Sort: asks (buy) lowest to highest price. bids (sell) highest to lowest price.
            const parsedOrders = orders
                .map(o => ({ price: parseFloat(o.price), sizeShares: parseFloat(o.size) }))
                .filter(o => !isNaN(o.price) && !isNaN(o.sizeShares) && o.price > 0 && o.sizeShares > 0)
                .sort((a, b) => side === 'BUY' ? a.price - b.price : b.price - a.price);

            let remainingShares = targetShares;
            let totalCostSpentUSD = 0;
            let totalSharesFilled = 0;

            for (const order of parsedOrders) {
                if (remainingShares <= 0) break;
                
                const fillShares = Math.min(remainingShares, order.sizeShares);
                const spendUSD = fillShares * order.price;
                
                totalSharesFilled += fillShares;
                totalCostSpentUSD += spendUSD;
                remainingShares -= fillShares;
            }

            if (totalSharesFilled === 0) return null;
            
            // Return VWAP
            return totalCostSpentUSD / totalSharesFilled;
        } catch {
            return null;
        }
    }

    /**
     * Place a single order.
     * Paper mode: Virtual Broker simulation with latency and L2 VWAP verification.
     */
    async placeOrder(
        tokenId: string,
        side: 'BUY' | 'SELL',
        price: number,
        size: number,
    ): Promise<OrderResult> {
        if (this.paperMode) {
            // Virtual Broker: Simulate Latency (200 - 600 ms)
            const latency = 200 + Math.random() * 400;
            await this.sleep(latency);

            // Re-fetch L2 book to find actual VWAP fill price after latency
            const actualVWAP = await this.fetchBookFillVWAP(tokenId, side, size);
            
            if (actualVWAP === null) {
                return {
                    orderId: `paper-${randomUUID().slice(0, 8)}`,
                    status: 'rejected',
                    filledQty: 0,
                    filledPrice: 0,
                };
            }

            return {
                orderId: `paper-${randomUUID().slice(0, 8)}`,
                status: 'filled',
                filledQty: size,
                filledPrice: actualVWAP,
            };
        }

        // Live mode stub (Phase 2: @polymarket/clob-client)
        return {
            orderId: 'not-implemented',
            status: 'rejected',
            filledQty: 0,
            filledPrice: 0,
        };
    }

    /**
     * Place both legs of an arb trade (buy YES + NO simultaneously).
     */
    async placeArbOrders(
        arb: ArbOpportunity,
        size: number,
    ): Promise<{ yesOrder: OrderResult; noOrder: OrderResult }> {
        const [yesOrder, noOrder] = await Promise.all([
            this.placeOrder(arb.market.yesTokenId, 'BUY', arb.yesBestAsk, size),
            this.placeOrder(arb.market.noTokenId, 'BUY', arb.noBestAsk, size),
        ]);
        return { yesOrder, noOrder };
    }

    isPaperMode(): boolean {
        return this.paperMode;
    }
}
