import type { SwarmWorkerTask, SwarmWorkerResult } from '../types';
import { FredFeed } from '../../data/feeds/fred-feed';

export async function macroWorker(task: SwarmWorkerTask): Promise<SwarmWorkerResult> {
  const start = Date.now();
  try {
    const feed = new FredFeed();
    const snapshot = await feed.getMacroSnapshot();
    return {
      taskId: task.id,
      success: true,
      data: { type: 'macro', snapshot, seriesCount: Object.keys(snapshot).length },
      durationMs: Date.now() - start,
    };
  } catch (err: any) {
    return { taskId: task.id, success: false, data: null, error: err.message, durationMs: Date.now() - start };
  }
}
