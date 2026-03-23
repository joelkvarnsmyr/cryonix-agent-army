import type { SwarmWorkerTask, SwarmWorkerResult } from '../types';
import { SentimentFeed } from '../../data/feeds/sentiment-feed';

export async function sentimentWorker(task: SwarmWorkerTask): Promise<SwarmWorkerResult> {
  const start = Date.now();
  try {
    const feed = new SentimentFeed();
    const symbols = (task.params.symbols as string[]) || ['AAPL', 'MSFT', 'NVDA', 'TSLA'];
    const results: Record<string, any> = {};
    for (const sym of symbols) {
      results[sym] = await feed.getAggregateSentiment(sym);
    }
    return {
      taskId: task.id,
      success: true,
      data: { type: 'sentiment', results, symbolCount: Object.keys(results).length },
      durationMs: Date.now() - start,
    };
  } catch (err: any) {
    return { taskId: task.id, success: false, data: null, error: err.message, durationMs: Date.now() - start };
  }
}
