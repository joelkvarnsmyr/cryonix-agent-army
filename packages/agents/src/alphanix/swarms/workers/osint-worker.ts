import type { SwarmWorkerTask, SwarmWorkerResult } from '../types';
import { SecEdgarFeed } from '../../data/feeds/sec-edgar-feed';
import { SentimentFeed } from '../../data/feeds/sentiment-feed';

export async function osintWorker(task: SwarmWorkerTask): Promise<SwarmWorkerResult> {
  const start = Date.now();
  try {
    const symbol = (task.params.symbol as string) || 'AAPL';
    const cik = (task.params.cik as string) || '';

    const results: any = { symbol };

    // SEC filings (if CIK provided)
    if (cik) {
      const edgar = new SecEdgarFeed();
      results.filings = await edgar.getRecentFilings(cik, undefined, 5);
    }

    // Sentiment
    const sentiment = new SentimentFeed();
    results.sentiment = await sentiment.getAggregateSentiment(symbol);

    return {
      taskId: task.id,
      success: true,
      data: { type: 'osint', ...results },
      durationMs: Date.now() - start,
    };
  } catch (err: any) {
    return { taskId: task.id, success: false, data: null, error: err.message, durationMs: Date.now() - start };
  }
}
