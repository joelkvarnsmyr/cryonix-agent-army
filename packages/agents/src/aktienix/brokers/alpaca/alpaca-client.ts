import Alpaca from '@alpacahq/alpaca-trade-api';
import { BrokerClient, BrokerOrder, BrokerOrderResult, Logger } from '../types';
import type { AccountState, StockPosition, AktienixConfig } from '../../types';

export class AlpacaClient implements BrokerClient {
    private alpaca: any; // Type 'any' used to avoid complex internal Alpaca types for now
    private logger: Logger;

    constructor(config: AktienixConfig, logger: Logger) {
        this.logger = logger;

        // Fallbacks to process.env if not provided in config (simplest approach for MVP)
        const isPaper = config.paperTrading ?? (process.env.ALPACA_PAPER === 'true');
        const apiKey = isPaper ? process.env.ALPACA_PAPER_API_KEY : process.env.ALPACA_API_KEY;
        const apiSecret = isPaper ? process.env.ALPACA_PAPER_API_SECRET : process.env.ALPACA_API_SECRET;

        if (!apiKey || !apiSecret) {
            throw new Error(`Alpaca API keys not found in environment for ${isPaper ? 'paper' : 'live'} trading.`);
        }

        this.alpaca = new Alpaca({
            keyId: apiKey,
            secretKey: apiSecret,
            paper: true, // We hardcode to paper for safety until proven stable
        });
    }

    async connect(): Promise<void> {
        this.logger.info('Connecting to Alpaca...');
        try {
            // Fetch account details to verify connection
            const account = await this.alpaca.getAccount();
            if (account.status !== 'ACTIVE') {
                throw new Error(`Alpaca account status is ${account.status}, expected ACTIVE.`);
            }
            this.logger.info(`Successfully connected to Alpaca. Account ID: ${account.id}`);
        } catch (error: any) {
            this.logger.error(`Failed to connect to Alpaca: ${error.message}`);
            throw error;
        }
    }

    async disconnect(): Promise<void> {
        this.logger.info('Disconnecting from Alpaca (no-op for REST client).');
    }

    /** Expose the underlying Alpaca SDK instance (used by StockSignalGenerator). */
    getAlpacaInstance(): any {
        return this.alpaca;
    }

    async getAccountState(): Promise<AccountState> {
        try {
            const account = await this.alpaca.getAccount();
            return {
                buyingPower: parseFloat(account.buying_power),
                settledCash: parseFloat(account.cash), // Alpaca defines 'cash' for settled vs 'portfolio_value'
                portfolioValue: parseFloat(account.portfolio_value),
                isPatternDayTrader: account.pattern_day_trader,
            };
        } catch (error: any) {
            this.logger.error(`Error fetching account state from Alpaca: ${error.message}`);
            throw error;
        }
    }

    async getPositions(): Promise<StockPosition[]> {
        try {
            const positions = await this.alpaca.getPositions();
            return positions.map((pos: any) => ({
                symbol: pos.symbol,
                qty: parseFloat(pos.qty),
                avgEntryPrice: parseFloat(pos.avg_entry_price),
                marketValue: parseFloat(pos.market_value),
                unrealizedPl: parseFloat(pos.unrealized_pl),
            }));
        } catch (error: any) {
            this.logger.error(`Error fetching positions from Alpaca: ${error.message}`);
            return []; // Return empty array on error so agent logic doesn't crash completely
        }
    }

    async submitOrder(order: BrokerOrder): Promise<BrokerOrderResult> {
        this.logger.info(`Submitting order to Alpaca: ${order.action} ${order.qty} ${order.symbol}`);
        try {

            const alpacaOrder = await this.alpaca.createOrder({
                symbol: order.symbol,
                qty: order.qty,
                side: order.action === 'BUY' ? 'buy' : 'sell',
                type: order.orderType === 'MARKET' ? 'market' : 'limit',
                time_in_force: 'day', // Defaulting to day orders
                limit_price: order.limitPrice,
            });

            return {
                success: true,
                orderId: alpacaOrder.id,
                status: alpacaOrder.status.toUpperCase(), // e.g. 'ACCEPTED', 'FILLED'
                message: 'Order submitted to Alpaca successfully',
            };
        } catch (error: any) {
            this.logger.error(`Failed to submit order to Alpaca: ${error.message}`, error);
            return {
                success: false,
                message: error.message || 'Unknown error submitting order to Alpaca',
            };
        }
    }
}
