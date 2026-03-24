import type { SwarmWorkerTask, SwarmWorkerResult } from '../types';
import { NewsFeed } from '../../data/feeds/news-feed';

export async function newsWorker(task: SwarmWorkerTask): Promise<SwarmWorkerResult> {
  const start = Date.now();
  try {
    const feed = new NewsFeed();
    const query = (task.params.query as string) || undefined;

    const [signals, news] = await Promise.all([
      feed.detectGeopoliticalSignals(query),
      feed.getLatestNews(query, 10),
    ]);

    return {
      taskId: task.id,
      success: true,
      data: {
        type: 'news',
        signals,
        signalCount: signals.length,
        criticalSignals: signals.filter(s => s.severity === 'critical').length,
        articles: news.length,
        topHeadlines: news.slice(0, 5).map(n => n.title),
      },
      durationMs: Date.now() - start,
    };
  } catch (err: any) {
    return { taskId: task.id, success: false, data: null, error: err.message, durationMs: Date.now() - start };
  }
}
