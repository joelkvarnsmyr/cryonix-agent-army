import type Redis from 'ioredis';
import type { ManipulationSignal, PumpProfile } from './types';

const MAX_CONCURRENT = 10;
const MAX_HISTORY = 200;
const HISTORY_TTL = 7 * 24 * 3600; // 7 days
const STATS_TTL = 86400;           // 24 hours
const TRACKING_TIMEOUT_MS = 60 * 60 * 1000; // 60 min

interface ActivePump {
  profile: PumpProfile;
  startedAt: number;
}

export class PumpProfiler {
  private redis: Redis;
  private active: Map<string, ActivePump> = new Map();

  constructor(redis: Redis) {
    this.redis = redis;
  }

  startTracking(signal: ManipulationSignal): void {
    if (this.active.size >= MAX_CONCURRENT) {
      console.log(`[PumpProfiler] Max concurrent tracking (${MAX_CONCURRENT}) — skipping ${signal.symbol}`);
      return;
    }
    if (this.active.has(signal.id)) return;

    const profile: PumpProfile = {
      id: signal.id,
      symbol: signal.symbol,
      exchange: signal.exchange,
      detected_at: Date.now(),
      detection_phase: signal.phase,
      source: signal.source,
      price_at_detection: signal.price_at_detection,
      peak_price: signal.price_at_detection,
      peak_minutes: 0,
      dump_start_price: 0,
      duration_minutes: 0,
      dump_velocity_pct_per_min: 0,
      volume_spike_ratio: signal.volume_spike_ratio,
      was_traded: false,
      pnl_pct: null,
    };

    this.active.set(signal.id, { profile, startedAt: Date.now() });
    console.log(`[PumpProfiler] Tracking ${signal.symbol} on ${signal.exchange} (${this.active.size} active)`);
  }

  updatePrice(signalId: string, currentPrice: number): void {
    const entry = this.active.get(signalId);
    if (!entry) return;
    const { profile } = entry;

    if (currentPrice > profile.peak_price) {
      profile.peak_price = currentPrice;
      profile.peak_minutes = (Date.now() - profile.detected_at) / 60_000;
    }

    if (profile.dump_start_price === 0 && profile.peak_price > 0) {
      const dropFromPeak = ((profile.peak_price - currentPrice) / profile.peak_price) * 100;
      const minutesSincePeak = ((Date.now() - profile.detected_at) / 60_000) - profile.peak_minutes;
      if (minutesSincePeak > 0 && dropFromPeak / minutesSincePeak >= 2.0) {
        profile.dump_start_price = currentPrice;
        profile.dump_velocity_pct_per_min = dropFromPeak / minutesSincePeak;
      }
    }
  }

  async checkTimeouts(): Promise<void> {
    const toFinalize: string[] = [];
    const now = Date.now();
    for (const [id, entry] of this.active) {
      if (now - entry.startedAt > TRACKING_TIMEOUT_MS) {
        console.log(`[PumpProfiler] Timeout for ${entry.profile.symbol} — finalizing`);
        toFinalize.push(id);
        continue;
      }
      if (entry.profile.peak_price > 0 && entry.profile.dump_start_price > 0) {
        const dropFromPeak = ((entry.profile.peak_price - entry.profile.dump_start_price) / entry.profile.peak_price) * 100;
        if (dropFromPeak >= 50) {
          toFinalize.push(id);
        }
      }
    }
    for (const id of toFinalize) {
      await this.finalize(id, false);
    }
  }

  async finalize(id: string, wasTraded: boolean, pnlPct?: number): Promise<void> {
    const entry = this.active.get(id);
    if (!entry) return;

    const { profile } = entry;
    profile.was_traded = wasTraded;
    profile.pnl_pct = pnlPct ?? null;
    profile.duration_minutes = (Date.now() - profile.detected_at) / 60_000;
    this.active.delete(id);

    try {
      await this.redis.lpush('huntrix:pump_history', JSON.stringify(profile));
      await this.redis.ltrim('huntrix:pump_history', 0, MAX_HISTORY - 1);
      await this.redis.expire('huntrix:pump_history', HISTORY_TTL);
      await this.refreshStats();
      console.log(`[PumpProfiler] Finalized ${profile.symbol} on ${profile.exchange} — peak at ${profile.peak_minutes.toFixed(1)}min, duration ${profile.duration_minutes.toFixed(1)}min`);
    } catch (err: any) {
      console.error(`[PumpProfiler] Failed to store profile: ${err.message}`);
    }
  }

  async refreshStats(): Promise<void> {
    try {
      const rawList = await this.redis.lrange('huntrix:pump_history', 0, -1);
      const profiles: PumpProfile[] = rawList.map(r => JSON.parse(r));

      const byExchange = new Map<string, PumpProfile[]>();
      for (const p of profiles) {
        if (!byExchange.has(p.exchange)) byExchange.set(p.exchange, []);
        byExchange.get(p.exchange)!.push(p);
      }

      const statsObj: Record<string, any> = {};
      for (const [exchange, pumps] of byExchange) {
        const peakMinutes = pumps.map(p => p.peak_minutes).filter(v => v > 0);
        const durations = pumps.map(p => p.duration_minutes).filter(v => v > 0);
        const dumpVelocities = pumps.map(p => p.dump_velocity_pct_per_min).filter(v => v > 0);

        statsObj[`${exchange}:median_peak_minutes`] = PumpProfiler.median(peakMinutes);
        statsObj[`${exchange}:median_duration_minutes`] = PumpProfiler.median(durations);
        statsObj[`${exchange}:median_dump_velocity`] = PumpProfiler.median(dumpVelocities);
        statsObj[`${exchange}:sample_count`] = pumps.length;
      }

      await this.redis.set('huntrix:pump_stats', JSON.stringify(statsObj), 'EX', STATS_TTL);
    } catch (err: any) {
      console.error(`[PumpProfiler] Failed to refresh stats: ${err.message}`);
    }
  }

  async getStats(): Promise<Record<string, any> | null> {
    try {
      const raw = await this.redis.get('huntrix:pump_stats');
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  getActiveCount(): number {
    return this.active.size;
  }

  getActive(id: string): ActivePump | undefined {
    return this.active.get(id);
  }

  static median(arr: number[]): number {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  }
}
