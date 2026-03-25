import type { SwarmWorkerTask, SwarmWorkerResult } from '../types';

const CRITICAL_KEYWORDS: Record<string, string[]> = {
  war: ['war', 'iran', 'invasion', 'missile', 'troops deployed', 'nuclear'],
  sanctions: ['sanctions', 'embargo', 'trade ban', 'tariff'],
  fed: ['fed', 'rate cut', 'rate hike', 'fomc', 'powell', 'monetary policy'],
  crash: ['crash', 'plunge', 'recession', 'crisis', 'bear market'],
  hack: ['hack', 'exploit', 'breach', 'stolen', 'vulnerability'],
};

interface NewsSignal {
  title: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  affectedMarkets: string[];
}

/**
 * News worker — fetches headlines from free RSS feeds, scans for critical signals.
 */
export async function newsWorker(task: SwarmWorkerTask): Promise<SwarmWorkerResult> {
  const start = Date.now();
  try {
    const feeds = [
      'https://www.coindesk.com/arc/outboundfeeds/rss/',
      'https://feeds.reuters.com/reuters/businessNews',
    ];

    const results = await Promise.allSettled(feeds.map(url => fetchRSS(url)));
    const allTitles: string[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled') allTitles.push(...r.value);
    }

    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    const signals: NewsSignal[] = [];

    for (const title of allTitles) {
      const lower = title.toLowerCase();
      for (const [category, keywords] of Object.entries(CRITICAL_KEYWORDS)) {
        if (keywords.some(kw => lower.includes(kw))) {
          const severity = ['war', 'hack'].includes(category) ? 'critical' : 'high';
          const markets = category === 'hack' ? ['crypto']
            : category === 'war' ? ['crypto', 'us_stocks', 'energy']
            : category === 'fed' ? ['crypto', 'us_stocks']
            : ['crypto', 'us_stocks', 'eu_stocks'];
          signals.push({ title, severity, affectedMarkets: markets });
          break; // one signal per headline
        }
      }
    }

    return {
      taskId: task.id,
      success: true,
      data: {
        type: 'news',
        articles: allTitles.length,
        criticalSignals: signals.filter(s => s.severity === 'critical').length,
        signals: signals.slice(0, 10),
      },
      durationMs: Date.now() - start,
    };
  } catch (err: any) {
    return { taskId: task.id, success: false, data: { type: 'news', articles: 0, criticalSignals: 0, signals: [] }, error: err.message, durationMs: Date.now() - start };
  }
}

async function fetchRSS(url: string): Promise<string[]> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'Alphanix/1.0' } });
    if (!res.ok) return [];
    const xml = await res.text();
    // Simple XML title extraction (no parser dependency)
    const titles: string[] = [];
    const itemRegex = /<item[\s>][\s\S]*?<\/item>/gi;
    const titleRegex = /<title><!\[CDATA\[(.*?)\]\]>|<title>(.*?)<\/title>/i;
    let match;
    while ((match = itemRegex.exec(xml)) !== null) {
      const titleMatch = titleRegex.exec(match[0]);
      if (titleMatch) titles.push(titleMatch[1] || titleMatch[2] || '');
    }
    return titles.filter(Boolean);
  } catch {
    return [];
  }
}
