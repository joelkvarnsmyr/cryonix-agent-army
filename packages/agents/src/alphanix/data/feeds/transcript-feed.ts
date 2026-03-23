export interface TranscriptSegment {
  text: string;
  start: number; // seconds
  duration: number;
}

export interface TranscriptAnalysis {
  videoId: string;
  title: string;
  totalDuration: number;
  segments: TranscriptSegment[];
  mentions: CompanyMention[];
  sentiment: 'bullish' | 'bearish' | 'neutral';
  keyQuotes: string[];
}

export interface CompanyMention {
  company: string;
  ticker?: string;
  count: number;
  context: string[]; // surrounding text snippets
  sentiment: 'bullish' | 'bearish' | 'neutral';
}

// Known company -> ticker mappings for NLP extraction
const COMPANY_TICKERS: Record<string, string> = {
  nvidia: 'NVDA',
  apple: 'AAPL',
  microsoft: 'MSFT',
  google: 'GOOGL',
  alphabet: 'GOOGL',
  amazon: 'AMZN',
  meta: 'META',
  facebook: 'META',
  tesla: 'TSLA',
  openai: 'MSFT',
  anthropic: 'GOOGL',
  amd: 'AMD',
  intel: 'INTC',
  tsmc: 'TSM',
  asml: 'ASML',
  broadcom: 'AVGO',
  qualcomm: 'QCOM',
  arm: 'ARM',
  bitcoin: 'BTC',
  ethereum: 'ETH',
  solana: 'SOL',
};

const BULLISH_WORDS = [
  'growth',
  'breakthrough',
  'record',
  'incredible',
  'amazing',
  'revolutionary',
  'demand',
  'exceeding',
  'outperform',
  'bullish',
  'opportunity',
  'accelerating',
  'scaling',
];
const BEARISH_WORDS = [
  'concern',
  'risk',
  'decline',
  'slowdown',
  'challenge',
  'difficult',
  'headwind',
  'competition',
  'regulation',
  'worried',
  'downturn',
  'recession',
];

export class TranscriptFeed {
  async getYouTubeTranscript(videoId: string): Promise<TranscriptSegment[]> {
    try {
      // Use YouTube's innertube timedtext API (no auth needed)
      const url = `https://www.youtube.com/watch?v=${videoId}`;
      const pageRes = await fetch(url, {
        headers: { 'User-Agent': 'Alphanix/1.0' },
      });
      if (!pageRes.ok) return [];
      const html = await pageRes.text();

      // Extract captions URL from page source
      const captionMatch = html.match(/"captionTracks":\[(.+?)\]/);
      if (!captionMatch) return [];

      const tracks = JSON.parse(`[${captionMatch[1]}]`);
      const enTrack =
        tracks.find((t: any) => t.languageCode === 'en') || tracks[0];
      if (!enTrack?.baseUrl) return [];

      const captionRes = await fetch(enTrack.baseUrl + '&fmt=json3');
      if (!captionRes.ok) return [];
      const data = await captionRes.json();

      return (data.events || [])
        .filter((e: any) => e.segs)
        .map((e: any) => ({
          text: e.segs.map((s: any) => s.utf8).join(''),
          start: (e.tStartMs || 0) / 1000,
          duration: (e.dDurationMs || 0) / 1000,
        }));
    } catch (err) {
      console.warn('[TranscriptFeed] Failed to fetch transcript:', err);
      return [];
    }
  }

  analyze(
    segments: TranscriptSegment[],
    videoId: string,
    title: string = '',
  ): TranscriptAnalysis {
    const fullText = segments
      .map((s) => s.text)
      .join(' ')
      .toLowerCase();
    const mentions: CompanyMention[] = [];

    // Extract company mentions
    for (const [company, ticker] of Object.entries(COMPANY_TICKERS)) {
      const regex = new RegExp(`\\b${company}\\b`, 'gi');
      const matches = fullText.match(regex);
      if (!matches || matches.length === 0) continue;

      // Get context around mentions
      const contexts: string[] = [];
      for (const seg of segments) {
        if (seg.text.toLowerCase().includes(company)) {
          contexts.push(seg.text.trim());
        }
      }

      // Simple sentiment from surrounding context
      const contextText = contexts.join(' ').toLowerCase();
      const bullCount = BULLISH_WORDS.filter((w) =>
        contextText.includes(w),
      ).length;
      const bearCount = BEARISH_WORDS.filter((w) =>
        contextText.includes(w),
      ).length;

      mentions.push({
        company,
        ticker,
        count: matches.length,
        context: contexts.slice(0, 3),
        sentiment:
          bullCount > bearCount
            ? 'bullish'
            : bearCount > bullCount
              ? 'bearish'
              : 'neutral',
      });
    }

    // Overall sentiment
    const bullTotal = BULLISH_WORDS.filter((w) => fullText.includes(w)).length;
    const bearTotal = BEARISH_WORDS.filter((w) => fullText.includes(w)).length;

    // Extract key quotes (sentences with company names + sentiment words)
    const keyQuotes: string[] = [];
    for (const seg of segments) {
      const lower = seg.text.toLowerCase();
      const hasCompany = Object.keys(COMPANY_TICKERS).some((c) =>
        lower.includes(c),
      );
      const hasSentiment = [...BULLISH_WORDS, ...BEARISH_WORDS].some((w) =>
        lower.includes(w),
      );
      if (hasCompany && hasSentiment && seg.text.length > 20) {
        keyQuotes.push(seg.text.trim());
      }
    }

    return {
      videoId,
      title,
      totalDuration:
        segments.length > 0
          ? segments[segments.length - 1].start +
            segments[segments.length - 1].duration
          : 0,
      segments,
      mentions: mentions.sort((a, b) => b.count - a.count),
      sentiment:
        bullTotal > bearTotal
          ? 'bullish'
          : bearTotal > bullTotal
            ? 'bearish'
            : 'neutral',
      keyQuotes: keyQuotes.slice(0, 10),
    };
  }
}
