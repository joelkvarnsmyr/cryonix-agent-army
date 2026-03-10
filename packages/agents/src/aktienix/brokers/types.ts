import type { AccountState, StockPosition } from '../types';

export interface Logger {
    info(msg: string, meta?: any): void;
    warn(msg: string, meta?: any): void;
    error(msg: string, meta?: any): void;
    debug(msg: string, meta?: any): void;
}

export interface BrokerOrder {
    symbol: string;
    action: 'BUY' | 'SELL';
    qty: number;
    orderType: 'MARKET' | 'LIMIT';
    limitPrice?: number;
}

export interface BrokerOrderResult {
    success: boolean;
    orderId?: string;
    status?: string;
    message?: string;
    filledQty?: number;
    filledAvgPrice?: number;
}

/**
 * Interface that all broker integrations (IBKR, Alpaca, Mock) must implement.
 */
export interface BrokerClient {
    /** Called on startup. Should verify connection, handle auth, and start background keepalives if needed. */
    connect(): Promise<void>;

    /** Called to cleanly shut down background tasks. */
    disconnect(): Promise<void>;

    /** Returns the current state of the account (buying power, equity, cash). */
    getAccountState(): Promise<AccountState>;

    /** Returns the currently held positions. */
    getPositions(): Promise<StockPosition[]>;

    /** Submits a trade order. */
    submitOrder(order: BrokerOrder): Promise<BrokerOrderResult>;
}
