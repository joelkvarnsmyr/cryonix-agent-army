import type { SwarmWorkerTask, SwarmWorkerResult } from '../types';

/**
 * Macro worker — fetches VIX from Yahoo Finance + Fear & Greed from Redis.
 * No API key required.
 */
export async function macroWorker(task: SwarmWorkerTask): Promise<SwarmWorkerResult> {
  const start = Date.now();
  try {
    const [vix, fearGreed] = await Promise.all([fetchVIX(), fetchFearGreed(task)]);
    const regime = vix >= 30 ? 'risk_off' : vix <= 18 ? 'risk_on' : 'neutral';

    return {
      taskId: task.id,
      success: true,
      data: { type: 'macro', vix, fearGreed, regime },
      durationMs: Date.now() - start,
    };
  } catch (err: any) {
    return { taskId: task.id, success: false, data: { type: 'macro', vix: 0, fearGreed: 50, regime: 'neutral' }, error: err.message, durationMs: Date.now() - start };
  }
}

async function fetchVIX(): Promise<number> {
  try {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=5d';
    const res = await fetch(url, { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'Alphanix/1.0' } });
    if (!res.ok) return 0;
    const data = await res.json();
    const closes = data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close;
    if (!Array.isArray(closes) || closes.length === 0) return 0;
    // Latest non-null close
    for (let i = closes.length - 1; i >= 0; i--) {
      if (closes[i] != null) return Math.round(closes[i] * 100) / 100;
    }
    return 0;
  } catch {
    return 0;
  }
}

async function fetchFearGreed(task: SwarmWorkerTask): Promise<number> {
  try {
    const kvUrl = (task.params.kvUrl as string) || process.env.KV_URL || 'redis://localhost:6379';
    const Redis = (await import('ioredis')).default;
    const redis = new Redis(kvUrl);
    const raw = await redis.get('cmc:fear_greed');
    await redis.quit();
    if (!raw) return 50;
    const parsed = JSON.parse(raw);
    return typeof parsed === 'number' ? parsed : (parsed?.value ?? parsed?.score ?? 50);
  } catch {
    return 50;
  }
}
