const GDELT_BASE = 'https://api.gdeltproject.org/api/v2/doc/doc';

export interface NewsArticle {
  title: string;
  description: string;
  source: string;
  url: string;
  publishedAt: string;
  sentiment: 'bullish' | 'bearish' | 'neutral';
  relevance: number;  // 0-100
  keywords: string[];
}

export interface GeopoliticalSignal {
  type: 'ceasefire' | 'war_escalation' | 'sanctions' | 'trade_deal' | 'election' | 'central_bank' | 'natural_disaster' | 'pandemic';
  severity: 'low' | 'medium' | 'high' | 'critical';
  headline: string;
  source: string;
  timestamp: number;
  affectedMarkets: string[];  // ['crypto', 'us_stocks', 'eu_stocks', 'energy', 'defense']
  tradingImplication: 'bullish' | 'bearish' | 'volatile';
}

// Keyword patterns for geopolitical detection
const GEOPOLITICAL_PATTERNS: Record<string, { type: GeopoliticalSignal['type']; severity: GeopoliticalSignal['severity']; markets: string[]; implication: GeopoliticalSignal['tradingImplication'] }> = {
  // Peace/Ceasefire
  'ceasefire': { type: 'ceasefire', severity: 'critical', markets: ['eu_stocks', 'energy', 'defense'], implication: 'bullish' },
  'peace deal': { type: 'ceasefire', severity: 'critical', markets: ['eu_stocks', 'energy', 'crypto'], implication: 'bullish' },
  'peace agreement': { type: 'ceasefire', severity: 'critical', markets: ['eu_stocks', 'energy'], implication: 'bullish' },
  'war ends': { type: 'ceasefire', severity: 'critical', markets: ['eu_stocks', 'energy', 'defense'], implication: 'bullish' },
  'negotiations progress': { type: 'ceasefire', severity: 'high', markets: ['eu_stocks', 'energy'], implication: 'bullish' },

  // War escalation
  'invasion': { type: 'war_escalation', severity: 'critical', markets: ['eu_stocks', 'energy', 'defense', 'crypto'], implication: 'volatile' },
  'missile strike': { type: 'war_escalation', severity: 'high', markets: ['energy', 'defense'], implication: 'bearish' },
  'troops deployed': { type: 'war_escalation', severity: 'high', markets: ['defense', 'energy'], implication: 'volatile' },
  'nuclear threat': { type: 'war_escalation', severity: 'critical', markets: ['crypto', 'eu_stocks', 'us_stocks'], implication: 'bearish' },

  // Sanctions
  'sanctions imposed': { type: 'sanctions', severity: 'high', markets: ['energy', 'eu_stocks'], implication: 'volatile' },
  'sanctions lifted': { type: 'sanctions', severity: 'high', markets: ['energy', 'eu_stocks'], implication: 'bullish' },
  'trade ban': { type: 'sanctions', severity: 'medium', markets: ['us_stocks', 'eu_stocks'], implication: 'bearish' },

  // Trade
  'trade deal': { type: 'trade_deal', severity: 'high', markets: ['us_stocks', 'eu_stocks', 'crypto'], implication: 'bullish' },
  'tariff': { type: 'trade_deal', severity: 'medium', markets: ['us_stocks', 'eu_stocks'], implication: 'bearish' },
  'trade war': { type: 'trade_deal', severity: 'high', markets: ['us_stocks', 'eu_stocks'], implication: 'bearish' },

  // Central bank
  'rate cut': { type: 'central_bank', severity: 'high', markets: ['us_stocks', 'crypto', 'eu_stocks'], implication: 'bullish' },
  'rate hike': { type: 'central_bank', severity: 'high', markets: ['us_stocks', 'crypto'], implication: 'bearish' },
  'quantitative easing': { type: 'central_bank', severity: 'high', markets: ['us_stocks', 'crypto'], implication: 'bullish' },
  'fed pivot': { type: 'central_bank', severity: 'critical', markets: ['us_stocks', 'crypto', 'eu_stocks'], implication: 'bullish' },

  // Disasters
  'hurricane': { type: 'natural_disaster', severity: 'medium', markets: ['energy', 'us_stocks'], implication: 'volatile' },
  'earthquake': { type: 'natural_disaster', severity: 'medium', markets: ['us_stocks'], implication: 'volatile' },
  'tsunami': { type: 'natural_disaster', severity: 'high', markets: ['us_stocks', 'eu_stocks'], implication: 'bearish' },
};

export class NewsFeed {
  /**
   * Fetch latest news from free sources (no API key needed).
   * Uses GDELT Project (free, real-time global news monitoring).
   */
  async getLatestNews(query: string = 'finance OR stock market OR crypto', maxResults: number = 20): Promise<NewsArticle[]> {
    try {
      // GDELT DOC API (free, no auth)
      const url = `${GDELT_BASE}?query=${encodeURIComponent(query)}&mode=ArtList&maxrecords=${maxResults}&format=json&sort=DateDesc`;
      const res = await fetch(url, { headers: { 'User-Agent': 'Alphanix/1.0' } });
      if (!res.ok) return [];
      const data = await res.json();

      return (data.articles || []).map((a: any) => {
        const title = (a.title || '').toLowerCase();
        const bullish = ['surge', 'rally', 'gains', 'bull', 'record high', 'breakthrough', 'growth'].some(w => title.includes(w));
        const bearish = ['crash', 'plunge', 'bear', 'crisis', 'recession', 'decline', 'warning'].some(w => title.includes(w));

        return {
          title: a.title || '',
          description: a.seendate || '',
          source: a.domain || a.source || 'unknown',
          url: a.url || '',
          publishedAt: a.seendate || new Date().toISOString(),
          sentiment: bullish ? 'bullish' : bearish ? 'bearish' : 'neutral',
          relevance: a.socialimage ? 70 : 50,
          keywords: (a.title || '').toLowerCase().split(/\s+/).filter((w: string) => w.length > 4),
        };
      });
    } catch (err) {
      console.warn('[NewsFeed] GDELT fetch failed:', err);
      return [];
    }
  }

  /**
   * Scan news for geopolitical signals.
   * Returns detected signals sorted by severity.
   */
  async detectGeopoliticalSignals(query?: string): Promise<GeopoliticalSignal[]> {
    const articles = await this.getLatestNews(query || 'war OR peace OR sanctions OR tariff OR fed OR hurricane', 50);
    const signals: GeopoliticalSignal[] = [];
    const seen = new Set<string>();

    for (const article of articles) {
      const titleLower = article.title.toLowerCase();

      for (const [keyword, pattern] of Object.entries(GEOPOLITICAL_PATTERNS)) {
        if (titleLower.includes(keyword) && !seen.has(pattern.type + keyword)) {
          seen.add(pattern.type + keyword);
          signals.push({
            type: pattern.type,
            severity: pattern.severity,
            headline: article.title,
            source: article.source,
            timestamp: Date.now(),
            affectedMarkets: pattern.markets,
            tradingImplication: pattern.implication,
          });
        }
      }
    }

    // Sort by severity (critical > high > medium > low)
    const severityOrder = { critical: 4, high: 3, medium: 2, low: 1 };
    return signals.sort((a, b) => severityOrder[b.severity] - severityOrder[a.severity]);
  }

  /**
   * Get news specifically about Ukraine/Russia conflict.
   */
  async getUkraineNews(): Promise<NewsArticle[]> {
    return this.getLatestNews('Ukraine Russia ceasefire peace war', 20);
  }

  /**
   * Get news about Fed/ECB monetary policy.
   */
  async getCentralBankNews(): Promise<NewsArticle[]> {
    return this.getLatestNews('Federal Reserve ECB rate decision monetary policy', 20);
  }
}
