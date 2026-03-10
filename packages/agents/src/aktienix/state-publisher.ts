/**
 * StatePublisher — publishes Aktienix state to Redis so API routes can read it.
 *
 * NOTE: This package does not have `ioredis` or `redis` in its dependencies.
 * To use a proper Redis client, install one:
 *   pnpm --filter @cryonix/agents add ioredis
 * Then replace the RespClient below with:
 *   import Redis from 'ioredis'
 *
 * In the meantime this module uses a minimal hand-rolled RESP (Redis Serialization
 * Protocol) client built on Node's built-in `net` module — zero extra dependencies,
 * supports SET EX, LPUSH, LTRIM, and DISCONNECT.
 */

import * as net from 'net';
import { StockPosition, AccountState } from './types';

// ---------------------------------------------------------------------------
// Minimal RESP client (no external dependencies)
// ---------------------------------------------------------------------------

function encodeResp(args: (string | number)[]): Buffer {
    const parts: string[] = [`*${args.length}\r\n`];
    for (const arg of args) {
        const s = String(arg);
        parts.push(`$${Buffer.byteLength(s, 'utf8')}\r\n${s}\r\n`);
    }
    return Buffer.from(parts.join(''), 'utf8');
}

interface PendingCommand {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
}

class RespClient {
    private socket: net.Socket | null = null;
    private queue: PendingCommand[] = [];
    private buffer = '';
    private connected = false;
    private destroyed = false;

    constructor(private readonly url: string) {}

    isConnected(): boolean {
        return this.connected;
    }

    connect(): Promise<void> {
        if (this.connected) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const parsed = new URL(this.url);
            const host = parsed.hostname || '127.0.0.1';
            const port = parseInt(parsed.port || '6379', 10);
            const password = parsed.password || null;

            this.socket = new net.Socket();
            this.socket.setKeepAlive(true, 10_000);

            this.socket.on('data', (data: Buffer) => {
                this.buffer += data.toString('utf8');
                this.drain();
            });

            this.socket.on('error', (err: Error) => {
                // Reject all pending commands on socket error
                const pending = this.queue.splice(0);
                for (const cmd of pending) cmd.reject(err);
            });

            this.socket.on('close', () => {
                this.connected = false;
                const pending = this.queue.splice(0);
                for (const cmd of pending) {
                    cmd.reject(new Error('Redis connection closed'));
                }
            });

            this.socket.connect(port, host, async () => {
                this.connected = true;
                try {
                    if (password) {
                        await this.send('AUTH', password);
                    }
                    resolve();
                } catch (err) {
                    reject(err);
                }
            });
        });
    }

    /** Parse RESP responses and settle pending promises. */
    private drain(): void {
        while (this.queue.length > 0) {
            const result = this.parseOne();
            if (result === undefined) break; // need more data
            const cmd = this.queue.shift()!;
            if (result instanceof Error) {
                cmd.reject(result);
            } else {
                cmd.resolve(result);
            }
        }
    }

    private parseOne(): unknown | undefined {
        if (this.buffer.length === 0) return undefined;

        const type = this.buffer[0];
        const crlf = this.buffer.indexOf('\r\n');
        if (crlf === -1) return undefined;

        const line = this.buffer.slice(1, crlf);

        if (type === '+') {
            // Simple string
            this.buffer = this.buffer.slice(crlf + 2);
            return line;
        }
        if (type === '-') {
            // Error
            this.buffer = this.buffer.slice(crlf + 2);
            return new Error(line);
        }
        if (type === ':') {
            // Integer
            this.buffer = this.buffer.slice(crlf + 2);
            return parseInt(line, 10);
        }
        if (type === '$') {
            // Bulk string
            const len = parseInt(line, 10);
            if (len === -1) {
                this.buffer = this.buffer.slice(crlf + 2);
                return null;
            }
            const start = crlf + 2;
            const end = start + len;
            if (this.buffer.length < end + 2) return undefined; // need more data
            const value = this.buffer.slice(start, end);
            this.buffer = this.buffer.slice(end + 2);
            return value;
        }
        if (type === '*') {
            // Array
            const count = parseInt(line, 10);
            this.buffer = this.buffer.slice(crlf + 2);
            if (count === -1) return null;
            const arr: unknown[] = [];
            for (let i = 0; i < count; i++) {
                const item = this.parseOne();
                if (item === undefined) return undefined; // incomplete
                arr.push(item);
            }
            return arr;
        }
        return undefined;
    }

    send(...args: (string | number)[]): Promise<unknown> {
        return new Promise((resolve, reject) => {
            if (!this.socket || !this.connected) {
                reject(new Error('Not connected'));
                return;
            }
            this.queue.push({ resolve, reject });
            this.socket.write(encodeResp(args));
        });
    }

    async disconnect(): Promise<void> {
        if (this.destroyed) return;
        this.destroyed = true;
        return new Promise((resolve) => {
            if (!this.socket) {
                resolve();
                return;
            }
            this.socket.once('close', resolve);
            this.socket.destroy();
        });
    }
}

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

    constructor(kvUrl: string) {
        this.client = new RespClient(kvUrl);
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
            await this.client.send('SET', 'aktienix:positions', JSON.stringify(positions), 'EX', TTL);
        } catch (err) {
            console.error('[StatePublisher] publishPositions error:', err);
        }
    }

    async publishAccount(account: AccountState): Promise<void> {
        try {
            await this.ensureConnected();
            await this.client.send('SET', 'aktienix:account', JSON.stringify(account), 'EX', TTL);
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
            await this.client.send('SET', 'aktienix:risk', JSON.stringify(risk), 'EX', TTL);
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
            await this.client.send('LPUSH', 'aktienix:signals', JSON.stringify(signal));
            await this.client.send('LTRIM', 'aktienix:signals', 0, MAX_SIGNALS - 1);
            await this.client.send('EXPIRE', 'aktienix:signals', TTL);
        } catch (err) {
            console.error('[StatePublisher] addSignal error:', err);
        }
    }

    async publishStatus(status: 'running' | 'paused' | 'stopped'): Promise<void> {
        try {
            await this.ensureConnected();
            await this.client.send('SET', 'aktienix:status', status, 'EX', TTL);
        } catch (err) {
            console.error('[StatePublisher] publishStatus error:', err);
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
