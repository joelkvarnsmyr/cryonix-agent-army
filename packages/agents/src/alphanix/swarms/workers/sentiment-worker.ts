import type { SwarmWorkerTask, SwarmWorkerResult } from '../types';

/**
 * Sentiment worker — aggregates existing Cryonix sentiment from Redis.
 * Reads polymarket + cmc:fear_greed keys. No external API calls.
 */
export async function sentimentWorker(task: SwarmWorkerTask): Promise<SwarmWorkerResult> {
  const start = Date.now();
  try {
    const kvUrl = (task.params.kvUrl as string) || process.env.KV_URL || 'redis://localhost:6379';
    const Redis = (await import('ioredis')).default;
    const redis = new Redis(kvUrl);

    const [cryptoRaw, fedRaw, oilRaw, fgRaw] = await Promise.all([
      redis.get('polymarket:crypto'),
      redis.get('polymarket:fed'),
      redis.get('polymarket:oil'),
      redis.get('cmc:fear_greed'),
    ]);
    await redis.quit();

    const crypto = parseScore(cryptoRaw);
    const macro = parseScore(fedRaw);
    const oil = parseScore(oilRaw);
    const fearGreed = parseScore(fgRaw);

    // Composite: weighted average mapped to -100..+100
    // Fear & Greed 0-100 → map to -100..+100; polymarket scores already 0-100
    const fgNorm = (fearGreed - 50) * 2;          // 0→-100, 50→0, 100→+100
    const cryptoNorm = (crypto - 50) * 2;
    const macroNorm = (macro - 50) * 2;
    const oilNorm = (oil - 50) * 2;
    const composite = Math.round((fgNorm * 0.4 + cryptoNorm * 0.3 + macroNorm * 0.2 + oilNorm * 0.1));

    return {
      taskId: task.id,
      success: true,
      data: {
        type: 'sentiment',
        scores: { crypto, macro, oil },
        fearGreed,
        composite: Math.max(-100, Math.min(100, composite)),
      },
      durationMs: Date.now() - start,
    };
  } catch (err: any) {
    return { taskId: task.id, success: false, data: { type: 'sentiment', scores: { crypto: 50, macro: 50, oil: 50 }, composite: 0 }, error: err.message, durationMs: Date.now() - start };
  }
}

function parseScore(raw: string | null): number {
  if (!raw) return 50;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'number') return parsed;
    return parsed?.score ?? parsed?.value ?? parsed?.sentiment ?? 50;
  } catch {
    const num = parseFloat(raw);
    return isNaN(num) ? 50 : num;
  }
}
