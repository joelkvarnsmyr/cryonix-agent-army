/**
 * Signal Bus Writer — lightweight publish-only client.
 *
 * For agents that only broadcast signals (Cryonix Core, Aktienix, etc.)
 * without needing a dedicated subscription connection.
 *
 * Uses a single ioredis connection.
 */

import Redis from 'ioredis';
import { SIGNAL_BUS_CHANNEL, type BusSignal, type BusSignalSource, type BusSignalType } from './signal-bus';

export { type BusSignal, type BusSignalSource, type BusSignalType } from './signal-bus';

// ---------------------------------------------------------------------------
// SignalBusWriter
// ---------------------------------------------------------------------------

export class SignalBusWriter {
  private redis: Redis;
  private source: BusSignalSource;

  /**
   * @param source   Agent identifier (e.g. 'cryonix-core')
   * @param redis    Existing ioredis instance to reuse, or omit to create new
   */
  private ownsConnection: boolean;

  constructor(source: BusSignalSource, redis?: Redis) {
    this.source = source;
    this.ownsConnection = !redis;
    this.redis = redis ?? new Redis(process.env.KV_URL ?? 'redis://localhost:6379', {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    });
    if (this.ownsConnection) {
      this.redis.on('error', (err) => console.error(`[SIGNAL-BUS-WRITER:${source}] Redis error:`, err.message));
    }
  }

  /** Publish a signal to the bus. Fills in source + timestamp automatically. */
  async publish(signal: Omit<BusSignal, 'source' | 'timestamp'> & { source?: BusSignalSource; timestamp?: number }): Promise<void> {
    if (this.ownsConnection && this.redis.status !== 'ready') await this.redis.connect();
    const full: BusSignal = {
      source: this.source,
      timestamp: Date.now(),
      ...signal,
    };
    const payload = JSON.stringify(full);
    await this.redis.publish(SIGNAL_BUS_CHANNEL, payload);
  }

  /** Disconnect (only if we own the connection). */
  async destroy(): Promise<void> {
    if (this.ownsConnection) this.redis.disconnect();
  }
}
