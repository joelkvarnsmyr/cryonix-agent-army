import type { OrderResult, ArbOpportunity, PolynixConfig } from './types';
import { randomUUID } from 'crypto';

export class OrderManager {
    private paperMode: boolean;

    constructor(config: PolynixConfig) {
        this.paperMode = config.broker.paper_trading;
    }

    /**
     * Place a single order (directional bet).
     * Paper mode: instant fill at quoted price.
     */
    async placeOrder(
        tokenId: string,
        side: 'BUY' | 'SELL',
        price: number,
        size: number,
    ): Promise<OrderResult> {
        if (this.paperMode) {
            return {
                orderId: `paper-${randomUUID().slice(0, 8)}`,
                status: 'filled',
                filledQty: size,
                filledPrice: price,
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
     * Paper mode: both legs fill instantly.
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
