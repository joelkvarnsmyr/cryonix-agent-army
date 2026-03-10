import { BrokerClient, BrokerOrder, BrokerOrderResult, Logger } from '../types';
import type { AccountState, StockPosition, AktienixConfig } from '../../types';

/**
 * Client for Interactive Brokers Client Portal (CP) Web API Gateway.
 * Assumes the gateway is running locally (e.g., via IBeam) at https://localhost:5000.
 */
export class IbkrClient implements BrokerClient {
    private config: AktienixConfig;
    private logger: Logger;
    private baseUrl: string = 'https://localhost:5000/v1/api';
    private tickleInterval?: NodeJS.Timeout;
    private isConnected: boolean = false;

    constructor(config: AktienixConfig, logger: Logger) {
        this.config = config;
        this.logger = logger;
    }

    public async connect(): Promise<void> {
        this.logger.info('Initializing IBKR CP Gateway connection...', { component: 'IbkrClient' });

        // We intentionally ignore self-signed cert errors as the local gateway serves one
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

        // Wait until authenticated
        await this.waitForAuthentication();

        this.isConnected = true;
        this.logger.info('IBKR Client authenticated and ready.', { component: 'IbkrClient' });

        // Start auto-tickle to keep session alive
        this.startTickle();
    }

    public async disconnect(): Promise<void> {
        this.logger.info('Disconnecting IBKR client...', { component: 'IbkrClient' });
        this.isConnected = false;
        if (this.tickleInterval) {
            clearInterval(this.tickleInterval);
        }

        try {
            await this.request('/logout', 'POST');
        } catch (err) {
            this.logger.warn('Failed to cleanly logout from IBKR gateway: ' + (err as Error).message, { component: 'IbkrClient' });
        }
    }

    public async getAccountState(): Promise<AccountState> {
        this.ensureConnected();

        // Step 1: Fetch accounts to get the Account ID
        const accounts = await this.request('/portfolio/accounts');
        if (!accounts || accounts.length === 0) {
            throw new Error('No IBKR accounts found for this user.');
        }

        // Use the first account (often the only one)
        const accountId = accounts[0].accountId;

        // Step 2: Fetch portfolio summary
        // Typically /portfolio/{accountId}/summary
        const summary = await this.request(`/portfolio/${accountId}/summary`);

        // Map IBKR responses to our standard AccountState. 
        // Actual keys depend on IBKR API version, these are common approximations.
        const getVal = (key: string) => {
            const item = summary[key];
            return item && item.amount ? parseFloat(item.amount) : 0;
        };

        return {
            portfolioValue: getVal('netliquidation'),
            buyingPower: getVal('buyingpower'),
            settledCash: getVal('settledcash') || getVal('cashbalance'),
            isPatternDayTrader: false, // In a cash account or ISK, PDT doesn't apply
        };
    }

    public async getPositions(): Promise<StockPosition[]> {
        this.ensureConnected();

        const accounts = await this.request('/portfolio/accounts');
        const accountId = accounts[0].accountId;

        // Typically /portfolio/{accountId}/positions/{pageId}
        const ibkrPositions = await this.request(`/portfolio/${accountId}/positions/0`);

        return ibkrPositions.map((p: any) => ({
            symbol: p.contractDesc, // Contains ticker
            qty: p.position,
            avgEntryPrice: p.avgCost,
            marketValue: p.mktValue,
            unrealizedPl: p.unrealizedPnl,
        }));
    }

    public async submitOrder(order: BrokerOrder): Promise<BrokerOrderResult> {
        this.ensureConnected();
        this.logger.info(`Submitting IBKR order: ${order.action} ${order.qty} ${order.symbol}`, { component: 'IbkrClient' });

        const accounts = await this.request('/portfolio/accounts');
        const accountId = accounts[0].accountId;

        // Construct IBKR Order JSON
        // Mapping our simplified BrokerOrder to IBKR CP API format
        const ibkrOrder = {
            conid: await this.resolveContractId(order.symbol),
            secType: "STK",
            cOID: `aktienix-${Date.now()}`,
            orderType: order.orderType === 'MARKET' ? 'MKT' : 'LMT',
            price: order.limitPrice,
            side: order.action,
            quantity: order.qty,
            tif: "DAY",
        };

        try {
            // Endpoint is usually /iserver/account/{accountId}/orders
            const response = await this.request(`/iserver/account/${accountId}/orders`, 'POST', {
                orders: [ibkrOrder]
            });

            return {
                success: true,
                orderId: response[0]?.order_id || 'unknown',
                status: 'submitted',
            };
        } catch (err) {
            this.logger.error('IBKR Order submission failed', { component: 'IbkrClient', error: err });
            return {
                success: false,
                orderId: '',
                status: 'rejected',
                message: (err as Error).message,
            };
        }
    }

    /**
     * Helper to resolve a ticker symbol to an IBKR Contract ID (conid).
     */
    private async resolveContractId(symbol: string): Promise<number> {
        const searchRes = await this.request(`/iserver/secdef/search?name=${symbol}&secType=STK`);
        if (searchRes && searchRes.length > 0) {
            // Find the US stock
            const stock = searchRes.find((s: any) => s.secType === 'STK');
            if (stock) return stock.conid;
        }
        throw new Error(`Could not resolve contract ID for symbol ${symbol}`);
    }

    /**
     * Polls the auth status endpoint until the gateway reports it's authenticated.
     * If running entirely headless (e.g. via IBeam), this just waits for IBeam to finish.
     * If manual, this logs the URL for the user to visit.
     */
    private async waitForAuthentication(): Promise<void> {
        const maxAttempts = 60; // 1 minute timeout for testing
        let attempts = 0;

        while (attempts < maxAttempts) {
            try {
                const response = await this.request('/iserver/auth/status');

                if (response.authenticated) {
                    // Sometimes it requires 'competing' session resolution
                    if (response.competing) {
                        this.logger.warn('Competing session detected, attempting to kick other session...', { component: 'IbkrClient' });
                        await this.request('/logout', 'POST'); // or similar competing resolution mechanism depending on CP version
                        continue;
                    }
                    return; // Success
                }

                if (attempts === 0 || attempts % 10 === 0) {
                    this.logger.info(`IBKR is NOT authenticated. Waiting for login. Access https://localhost:5000 to manually login if IBeam headles auth is not working.`, { component: 'IbkrClient' });
                }
            } catch (err) {
                if (attempts === 0) {
                    this.logger.warn('Could not reach IBKR CP Gateway. Is the docker container running?', { component: 'IbkrClient' });
                }
            }

            // Wait 1 second before polling again
            await new Promise(res => setTimeout(res, 1000));
            attempts++;
        }

        throw new Error('Timeout waiting for IBKR authentication.');
    }

    /**
     * Pings the IBKR Gateway every minute to keep the session alive.
     */
    private startTickle() {
        this.tickleInterval = setInterval(async () => {
            try {
                await this.request('/tickle');
            } catch (err) {
                this.logger.error('IBKR Session Tickle failed. Session might be lost.', { component: 'IbkrClient' });
                this.isConnected = false;
            }
        }, 60000); // Every 60 seconds
    }

    private ensureConnected() {
        if (!this.isConnected) {
            throw new Error('IBKR Client is not connected/authenticated.');
        }
    }

    /**
     * Wrapper for making fetch requests to the Gateway.
     */
    private async request(endpoint: string, method: string = 'GET', body?: any): Promise<any> {
        const url = `${this.baseUrl}${endpoint}`;

        // We expect node fetch to be available (Node 18+)
        const response = await fetch(url, {
            method,
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: body ? JSON.stringify(body) : undefined,
        });

        if (!response.ok) {
            const errText = await response.text().catch(() => '');
            throw new Error(`IBKR API Error ${response.status} ${response.statusText}: ${errText}`);
        }

        // Sometimes responses are empty (e.g., tickle)
        const text = await response.text();
        if (!text) return {};

        try {
            return JSON.parse(text);
        } catch {
            return text;
        }
    }
}
