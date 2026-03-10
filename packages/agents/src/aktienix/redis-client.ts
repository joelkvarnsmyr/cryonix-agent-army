/**
 * Minimal hand-rolled RESP (Redis Serialization Protocol) client.
 *
 * Built on Node's built-in `net` module — zero external dependencies.
 * Supports all commands needed by Aktienix: SET EX, GET, LPUSH, LTRIM,
 * EXPIRE, HSET, HDEL, HGETALL, and arbitrary send().
 *
 * Exported so that audit-logger.ts and event-lifecycle-tracker.ts can
 * share the same implementation without duplication.
 */

import * as net from 'net';

// ---------------------------------------------------------------------------
// RESP encoding
// ---------------------------------------------------------------------------

export function encodeResp(args: (string | number)[]): Buffer {
    const parts: string[] = [`*${args.length}\r\n`];
    for (const arg of args) {
        const s = String(arg);
        parts.push(`$${Buffer.byteLength(s, 'utf8')}\r\n${s}\r\n`);
    }
    return Buffer.from(parts.join(''), 'utf8');
}

// ---------------------------------------------------------------------------
// Pending command queue entry
// ---------------------------------------------------------------------------

export interface PendingCommand {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
}

// ---------------------------------------------------------------------------
// RespClient
// ---------------------------------------------------------------------------

export class RespClient {
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
            // Array (multi-bulk) — used by HGETALL, LRANGE, etc.
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

    // -------------------------------------------------------------------------
    // Typed convenience wrappers
    // -------------------------------------------------------------------------

    async set(key: string, value: string, exSeconds?: number): Promise<void> {
        if (exSeconds !== undefined) {
            await this.send('SET', key, value, 'EX', exSeconds);
        } else {
            await this.send('SET', key, value);
        }
    }

    async get(key: string): Promise<string | null> {
        const value = await this.send('GET', key);
        return typeof value === 'string' ? value : null;
    }

    async lpush(key: string, value: string): Promise<void> {
        await this.send('LPUSH', key, value);
    }

    async ltrim(key: string, start: number, stop: number): Promise<void> {
        await this.send('LTRIM', key, start, stop);
    }

    async hset(key: string, field: string, value: string): Promise<void> {
        await this.send('HSET', key, field, value);
    }

    async hdel(key: string, field: string): Promise<void> {
        await this.send('HDEL', key, field);
    }

    /**
     * HGETALL returns a flat array [field1, value1, field2, value2, ...].
     * This method converts it to a plain object for convenience.
     * Returns an empty object if the key does not exist.
     */
    async hgetall(key: string): Promise<Record<string, string>> {
        const raw = await this.send('HGETALL', key);
        if (!Array.isArray(raw) || raw.length === 0) return {};
        const result: Record<string, string> = {};
        for (let i = 0; i + 1 < raw.length; i += 2) {
            const k = raw[i];
            const v = raw[i + 1];
            if (typeof k === 'string' && typeof v === 'string') {
                result[k] = v;
            }
        }
        return result;
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
