export interface SentimentScore {
  symbol: string;
  source: string;
  score: number;      // -100 to 100
  mentions: number;
  timestamp: number;
}

export class SentimentFeed {
  async getRedditSentiment(symbol: string, subreddit: string = 'wallstreetbets'): Promise<SentimentScore> {
    try {
      const url = `https://www.reddit.com/r/${subreddit}/search.json?q=${symbol}&sort=new&limit=25&restrict_sr=1&t=day`;
      const res = await fetch(url, { headers: { 'User-Agent': 'Alphanix/1.0' } });
      if (!res.ok) return this.neutral(symbol, 'reddit');
      const data = await res.json();
      const posts = data?.data?.children || [];
      const mentions = posts.length;
      if (mentions === 0) return this.neutral(symbol, 'reddit');

      // Simple sentiment: ratio of upvotes (positive proxy)
      let totalScore = 0;
      for (const post of posts) {
        const ratio = post.data?.upvote_ratio || 0.5;
        totalScore += (ratio - 0.5) * 200;  // Normalize to -100 to 100
      }

      return {
        symbol, source: 'reddit',
        score: Math.round(totalScore / mentions),
        mentions, timestamp: Date.now(),
      };
    } catch {
      return this.neutral(symbol, 'reddit');
    }
  }

  async getStockTwitsSentiment(symbol: string): Promise<SentimentScore> {
    try {
      const url = `https://api.stocktwits.com/api/2/streams/symbol/${symbol}.json`;
      const res = await fetch(url);
      if (!res.ok) return this.neutral(symbol, 'stocktwits');
      const data = await res.json();
      const messages = data?.messages || [];
      const mentions = messages.length;
      if (mentions === 0) return this.neutral(symbol, 'stocktwits');

      let bullish = 0, bearish = 0;
      for (const msg of messages) {
        if (msg.entities?.sentiment?.basic === 'Bullish') bullish++;
        if (msg.entities?.sentiment?.basic === 'Bearish') bearish++;
      }

      const total = bullish + bearish || 1;
      const score = Math.round(((bullish - bearish) / total) * 100);
      return { symbol, source: 'stocktwits', score, mentions, timestamp: Date.now() };
    } catch {
      return this.neutral(symbol, 'stocktwits');
    }
  }

  async getAggregateSentiment(symbol: string): Promise<SentimentScore> {
    const [reddit, stocktwits] = await Promise.all([
      this.getRedditSentiment(symbol),
      this.getStockTwitsSentiment(symbol),
    ]);
    const totalMentions = reddit.mentions + stocktwits.mentions;
    if (totalMentions === 0) return this.neutral(symbol, 'aggregate');

    const weightedScore = (reddit.score * reddit.mentions + stocktwits.score * stocktwits.mentions) / totalMentions;
    return {
      symbol, source: 'aggregate',
      score: Math.round(weightedScore),
      mentions: totalMentions, timestamp: Date.now(),
    };
  }

  private neutral(symbol: string, source: string): SentimentScore {
    return { symbol, source, score: 0, mentions: 0, timestamp: Date.now() };
  }
}
