import type { Exchange, Order, Ticker, Balance } from 'ccxt';

/**
 * Mock CCXT Exchange for testing
 * Simulates exchange responses without making real API calls
 */
export class MockExchange {
    public id = 'mock';
    public orders: Map<string, MockOrder> = new Map();
    public balances: Record<string, number> = {
        USDT: 10000,
        BTC: 0,
        ETH: 0,
    };

    private orderIdCounter = 1;
    private shouldFailNext = false;
    private latencyMs = 0; // Default to 0 for fast tests

    /**
     * Configure the mock to fail the next operation
     */
    failNext(): void {
        this.shouldFailNext = true;
    }

    /**
     * Set simulated network latency
     */
    setLatency(ms: number): void {
        this.latencyMs = ms;
    }

    /**
     * Reset mock to initial state
     */
    reset(): void {
        this.orders.clear();
        this.balances = {
            USDT: 10000,
            BTC: 0,
            ETH: 0,
        };
        this.orderIdCounter = 1;
        this.shouldFailNext = false;
    }

    /**
     * Simulate network delay
     */
    private async delay(): Promise<void> {
        if (this.latencyMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
        }
    }

    /**
     * Check if operation should fail
     */
    private checkFail(): void {
        if (this.shouldFailNext) {
            this.shouldFailNext = false;
            throw new Error('Mock exchange: Simulated failure');
        }
    }

    /**
     * Create a market order
     */
    async createMarketOrder(
        symbol: string,
        side: 'buy' | 'sell',
        amount: number,
        params?: any
    ): Promise<MockOrder> {
        await this.delay();
        this.checkFail();

        const price = await this.getCurrentPrice(symbol);
        const orderId = `order-${this.orderIdCounter++}`;

        const order: MockOrder = {
            id: orderId,
            clientOrderId: params?.clientOrderId || orderId,
            timestamp: Date.now(),
            datetime: new Date().toISOString(),
            lastTradeTimestamp: Date.now(),
            symbol,
            type: 'market',
            side,
            price,
            amount,
            cost: price * amount,
            average: price,
            filled: amount,
            remaining: 0,
            status: 'closed',
            fee: {
                currency: 'USDT',
                cost: price * amount * 0.001, // 0.1% fee
            },
            trades: [],
            info: {},
        };

        this.orders.set(orderId, order);
        this.updateBalances(symbol, side, amount, price);

        return order;
    }

    /**
     * Create a limit order
     */
    async createLimitOrder(
        symbol: string,
        side: 'buy' | 'sell',
        amount: number,
        price: number,
        params?: any
    ): Promise<MockOrder> {
        await this.delay();
        this.checkFail();

        const orderId = `order-${this.orderIdCounter++}`;

        const order: MockOrder = {
            id: orderId,
            clientOrderId: params?.clientOrderId || orderId,
            timestamp: Date.now(),
            datetime: new Date().toISOString(),
            lastTradeTimestamp: undefined,
            symbol,
            type: 'limit',
            side,
            price,
            amount,
            cost: price * amount,
            average: undefined,
            filled: 0,
            remaining: amount,
            status: 'open',
            fee: undefined,
            trades: [],
            info: {},
        };

        this.orders.set(orderId, order);

        return order;
    }

    /**
     * Create an OCO (One-Cancels-Other) order
     * Used for simultaneous stop-loss and take-profit
     */
    async createOrder(
        symbol: string,
        type: string,
        side: 'buy' | 'sell',
        amount: number,
        price?: number,
        params?: any
    ): Promise<MockOrder> {
        await this.delay();
        this.checkFail();

        if (type === 'market') {
            return this.createMarketOrder(symbol, side, amount, params);
        } else if ((type === 'limit' || type === 'stop_loss_limit' || type === 'take_profit_limit') && price) {
            // Treat stop/take profit limits as regular limits for mock purposes
            // In a real exchange, they trigger based on stopPrice, but for mock storage it's fine
            return this.createLimitOrder(symbol, side, amount, price, params);
        }

        throw new Error(`Unsupported order type: ${type}`);
    }

    /**
     * Fetch order status
     */
    async fetchOrder(orderId: string, symbol?: string): Promise<MockOrder> {
        await this.delay();
        this.checkFail();

        const order = this.orders.get(orderId);
        if (!order) {
            throw new Error(`Order not found: ${orderId}`);
        }

        return order;
    }

    /**
     * Cancel an order
     */
    async cancelOrder(orderId: string, symbol?: string): Promise<MockOrder> {
        await this.delay();
        this.checkFail();

        const order = this.orders.get(orderId);
        if (!order) {
            throw new Error(`Order not found: ${orderId}`);
        }

        if (order.status === 'closed') {
            throw new Error(`Cannot cancel closed order: ${orderId}`);
        }

        order.status = 'canceled';
        this.orders.set(orderId, order);

        return order;
    }

    /**
     * Fetch current ticker price
     */
    async fetchTicker(symbol: string): Promise<MockTicker> {
        await this.delay();
        this.checkFail();

        const price = await this.getCurrentPrice(symbol);

        return {
            symbol,
            timestamp: Date.now(),
            datetime: new Date().toISOString(),
            high: price * 1.02,
            low: price * 0.98,
            bid: price * 0.999,
            ask: price * 1.001,
            last: price,
            close: price,
            baseVolume: 1000000,
            quoteVolume: 1000000 * price,
            info: {},
        };
    }

    /**
     * Fetch account balances
     */
    async fetchBalance(): Promise<MockBalance> {
        await this.delay();
        this.checkFail();

        const free: Record<string, number> = {};
        const used: Record<string, number> = {};
        const total: Record<string, number> = {};

        for (const [currency, amount] of Object.entries(this.balances)) {
            free[currency] = amount;
            used[currency] = 0;
            total[currency] = amount;
        }

        return {
            free,
            used,
            total,
            info: {},
        };
    }

    /**
     * Simulate order fill (for limit orders)
     */
    fillOrder(orderId: string, fillPrice?: number): void {
        const order = this.orders.get(orderId);
        if (!order) {
            throw new Error(`Order not found: ${orderId}`);
        }

        if (order.status !== 'open') {
            throw new Error(`Cannot fill order with status: ${order.status}`);
        }

        const price = fillPrice || order.price;
        order.status = 'closed';
        order.filled = order.amount;
        order.remaining = 0;
        order.average = price;
        order.cost = price * order.amount;
        order.fee = {
            currency: 'USDT',
            cost: price * order.amount * 0.001,
        };
        order.lastTradeTimestamp = Date.now();

        this.orders.set(orderId, order);
        this.updateBalances(order.symbol, order.side, order.amount, price);
    }

    /**
     * Get current mock price for a symbol
     */
    private async getCurrentPrice(symbol: string): Promise<number> {
        // Simulated prices
        const prices: Record<string, number> = {
            'BTC/USDT': 50000,
            'ETH/USDT': 3000,
            'BNB/USDT': 400,
        };

        return prices[symbol] || 1000;
    }

    /**
     * Update balances after trade
     */
    private updateBalances(
        symbol: string,
        side: 'buy' | 'sell',
        amount: number,
        price: number
    ): void {
        const [base, quote] = symbol.split('/');

        if (side === 'buy') {
            // Buy: decrease quote, increase base
            this.balances[quote] = (this.balances[quote] || 0) - price * amount;
            this.balances[base] = (this.balances[base] || 0) + amount;
        } else {
            // Sell: decrease base, increase quote
            this.balances[base] = (this.balances[base] || 0) - amount;
            this.balances[quote] = (this.balances[quote] || 0) + price * amount;
        }
    }
}

// Type definitions matching CCXT
export interface MockOrder {
    id: string;
    clientOrderId?: string;
    timestamp: number;
    datetime: string;
    lastTradeTimestamp?: number;
    symbol: string;
    type: string;
    side: 'buy' | 'sell';
    price: number;
    amount: number;
    cost: number;
    average?: number;
    filled: number;
    remaining: number;
    status: 'open' | 'closed' | 'canceled';
    fee?: {
        currency: string;
        cost: number;
    };
    trades: any[];
    info: any;
}

export interface MockTicker {
    symbol: string;
    timestamp: number;
    datetime: string;
    high: number;
    low: number;
    bid: number;
    ask: number;
    last: number;
    close: number;
    baseVolume: number;
    quoteVolume: number;
    info: any;
}

export interface MockBalance {
    free: Record<string, number>;
    used: Record<string, number>;
    total: Record<string, number>;
    info: any;
}

/**
 * Create a mock exchange instance
 */
export function createMockExchange(): MockExchange {
    return new MockExchange();
}
