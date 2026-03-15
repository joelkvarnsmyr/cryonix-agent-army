/**
 * StatePublisher — publishes Aktienix state to Redis so API routes can read it.
 */

import { RespClient } from './redis-client';
import { StockPosition, AccountState } from './types';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const TTL = 300; // 5 minutes
const MAX_SIGNALS = 50;

export interface PublishableSignal {
    symbol: string;
    action: 'BUY' | 'SELL' | 'WAIT';
    confidence: number;
    reasoning: string;
    timestamp: number; // Unix ms
}

export class StatePublisher {
    private client: RespClient;
    private connecting: Promise<void> | null = null;
    private readonly ns: string;

    constructor(kvUrl: string, namespace: string = 'aktienix') {
        this.client = new RespClient(kvUrl);
        this.ns = namespace;
    }

    // -----------------------------------------------------------------------
    // Connection management (lazy, single-flight)
    // -----------------------------------------------------------------------

    private async ensureConnected(): Promise<void> {
        if (this.client.isConnected()) return;
        if (!this.connecting) {
            this.connecting = this.client.connect().finally(() => {
                this.connecting = null;
            });
        }
        await this.connecting;
    }

    isConnected(): boolean {
        return this.client.isConnected();
    }

    // -----------------------------------------------------------------------
    // Publish helpers (all errors are swallowed — never throw to callers)
    // -----------------------------------------------------------------------

    async publishPositions(positions: StockPosition[]): Promise<void> {
        try {
            await this.ensureConnected();
            await this.client.send('SET', `${this.ns}:positions`, JSON.stringify(positions), 'EX', TTL);
        } catch (err) {
            console.error('[StatePublisher] publishPositions error:', err);
        }
    }

    async publishAccount(account: AccountState): Promise<void> {
        try {
            await this.ensureConnected();
            await this.client.send('SET', `${this.ns}:account`, JSON.stringify(account), 'EX', TTL);
        } catch (err) {
            console.error('[StatePublisher] publishAccount error:', err);
        }
    }

    async publishRisk(risk: {
        canTrade: boolean;
        dailyPnlDollar: number;
        weeklyPnlDollar: number;
        consecutiveLosses: number;
        tradesToday: number;
        dayTradesThisWeek: number;
    }): Promise<void> {
        try {
            await this.ensureConnected();
            await this.client.send('SET', `${this.ns}:risk`, JSON.stringify(risk), 'EX', TTL);
        } catch (err) {
            console.error('[StatePublisher] publishRisk error:', err);
        }
    }

    /**
     * Prepend a signal to the rolling list (LPUSH) and trim to 50 entries (LTRIM 0 49).
     * TTL is refreshed on the list key after each push.
     */
    async addSignal(signal: PublishableSignal): Promise<void> {
        try {
            await this.ensureConnected();
            await this.client.send('LPUSH', `${this.ns}:signals`, JSON.stringify(signal));
            await this.client.send('LTRIM', `${this.ns}:signals`, 0, MAX_SIGNALS - 1);
            await this.client.send('EXPIRE', `${this.ns}:signals`, TTL);
        } catch (err) {
            console.error('[StatePublisher] addSignal error:', err);
        }
    }

    async publishStatus(status: 'running' | 'paused' | 'stopped'): Promise<void> {
        try {
            await this.ensureConnected();
            await this.client.send('SET', `${this.ns}:status`, status, 'EX', TTL);
        } catch (err) {
            console.error('[StatePublisher] publishStatus error:', err);
        }
    }

    /**
     * Write an arbitrary key/value to Redis with the standard TTL.
     * Errors are swallowed so callers degrade gracefully.
     */
    async set(key: string, value: string): Promise<void> {
        try {
            await this.ensureConnected();
            await this.client.send('SET', key, value, 'EX', TTL);
        } catch (err) {
            console.error('[StatePublisher] set error:', err);
        }
    }

    /**
     * Read an arbitrary key from Redis.
     * Returns null if the key does not exist or if Redis is unavailable.
     */
    async get(key: string): Promise<string | null> {
        try {
            await this.ensureConnected();
            const value = await this.client.send('GET', key);
            return typeof value === 'string' ? value : null;
        } catch (err) {
            console.error('[StatePublisher] get error:', err);
            return null;
        }
    }

    async disconnect(): Promise<void> {
        try {
            await this.client.disconnect();
        } catch (err) {
            console.error('[StatePublisher] disconnect error:', err);
        }
    }
}
