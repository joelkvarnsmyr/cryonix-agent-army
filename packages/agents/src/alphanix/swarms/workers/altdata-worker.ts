import type { SwarmWorkerTask, SwarmWorkerResult } from '../types';

/**
 * Alt-data worker — Bitcoin hash rate from blockchain.info.
 * Detects trend direction from 7-day data.
 */
export async function altdataWorker(task: SwarmWorkerTask): Promise<SwarmWorkerResult> {
  const start = Date.now();
  try {
    const url = 'https://api.blockchain.info/charts/hash-rate?timespan=7days&format=json';
    const res = await fetch(url, { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'Alphanix/1.0' } });

    if (!res.ok) {
      return { taskId: task.id, success: true, data: { type: 'altdata', btcHashRate: 0, hashRateTrend: 'stable' }, durationMs: Date.now() - start };
    }

    const data = await res.json();
    const values: number[] = (data?.values || []).map((v: any) => v.y).filter((v: number) => v > 0);

    if (values.length < 2) {
      return { taskId: task.id, success: true, data: { type: 'altdata', btcHashRate: 0, hashRateTrend: 'stable' }, durationMs: Date.now() - start };
    }

    const latest = values[values.length - 1];
    const earliest = values[0];
    const changePct = ((latest - earliest) / earliest) * 100;

    // >5% rise = rising, >5% drop = falling, else stable
    const hashRateTrend = changePct > 5 ? 'rising' : changePct < -5 ? 'falling' : 'stable';

    return {
      taskId: task.id,
      success: true,
      data: {
        type: 'altdata',
        btcHashRate: Math.round(latest * 100) / 100,
        hashRateTrend,
        changePct: Math.round(changePct * 100) / 100,
      },
      durationMs: Date.now() - start,
    };
  } catch (err: any) {
    return { taskId: task.id, success: false, data: { type: 'altdata', btcHashRate: 0, hashRateTrend: 'stable' }, error: err.message, durationMs: Date.now() - start };
  }
}
