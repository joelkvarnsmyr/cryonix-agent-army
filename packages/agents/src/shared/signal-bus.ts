/**
 * Signal Bus — Redis pub/sub for real-time cross-agent signal broadcasting.
 *
 * Uses two ioredis connections:
 *   - pubRedis:  for PUBLISH (shared with normal commands)
 *   - subRedis:  dedicated SUBSCRIBE connection (Redis requirement)
 *
 * Channel: cryonix:signals
 */

import Redis from 'ioredis';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BusSignalSource =
  | 'cryonix-core'
  | 'aktienix'
  | 'copynix'
  | 'psinix'
  | 'apex'
  | 'huntrix'
  | 'solanix'
  | 'polynix';

export type BusSignalType = 'BUY' | 'SELL' | 'ALERT' | 'BLACKLIST';

export interface BusSignal {
  source: BusSignalSource;
  type: BusSignalType;
  symbol: string;
  confidence: number;        // 0–1
  pattern?: string;
  reasoning?: string;
  timestamp: number;         // Date.now()
  metadata?: Record<string, any>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SIGNAL_BUS_CHANNEL = 'cryonix:signals';

// ---------------------------------------------------------------------------
// SignalBus — full pub + sub
// ---------------------------------------------------------------------------

export class SignalBus {
  private pubRedis: Redis;
  private subRedis: Redis | null = null;
  private subscribed = false;

  constructor(redisUrl?: string) {
    const url = redisUrl ?? process.env.KV_URL ?? 'redis://localhost:6379';
    this.pubRedis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 3 });
    this.pubRedis.on('error', (err) => console.error('[SIGNAL-BUS] pub error:', err.message));
  }

  /** Publish a signal to all listeners. */
  async publish(signal: BusSignal): Promise<void> {
    if (this.pubRedis.status !== 'ready') await this.pubRedis.connect();
    const payload = JSON.stringify(signal);
    await this.pubRedis.publish(SIGNAL_BUS_CHANNEL, payload);
  }

  /** Subscribe to real-time signals from all agents. */
  async subscribe(callback: (signal: BusSignal) => void): Promise<void> {
    if (this.subscribed) return;

    const url = this.pubRedis.options?.host
      ? `redis://${this.pubRedis.options.host}:${this.pubRedis.options.port ?? 6379}`
      : process.env.KV_URL ?? 'redis://localhost:6379';

    this.subRedis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 3 });
    this.subRedis.on('error', (err) => console.error('[SIGNAL-BUS] sub error:', err.message));
    await this.subRedis.connect();

    this.subRedis.on('message', (_channel: string, message: string) => {
      try {
        const signal = JSON.parse(message) as BusSignal;
        callback(signal);
      } catch (err) {
        console.warn('[SIGNAL-BUS] Failed to parse message:', err);
      }
    });

    await this.subRedis.subscribe(SIGNAL_BUS_CHANNEL);
    this.subscribed = true;
    console.log(`[SIGNAL-BUS] Subscribed to ${SIGNAL_BUS_CHANNEL}`);
  }

  /** Unsubscribe and close the subscription connection. */
  async unsubscribe(): Promise<void> {
    if (this.subRedis && this.subscribed) {
      await this.subRedis.unsubscribe(SIGNAL_BUS_CHANNEL);
      this.subRedis.disconnect();
      this.subRedis = null;
      this.subscribed = false;
      console.log('[SIGNAL-BUS] Unsubscribed.');
    }
  }

  /** Disconnect all connections. */
  async destroy(): Promise<void> {
    await this.unsubscribe();
    this.pubRedis.disconnect();
  }
}
