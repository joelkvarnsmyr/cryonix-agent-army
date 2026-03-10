// packages/agents/src/aktienix/intelligence/x-ingestion-service.ts
import OpenAI from 'openai';
import type { RawArticle, SourceTrust } from './news-ingestion-service';

const TIER1_ACCOUNTS = new Set([
    'WalterBloomberg', 'DeItaone', 'FirstSquawk', 'FinancialJuice',
    'NickTimiraos', 'bespokeinvest', 'unusual_whales', 'LizAnnSonders',
    'OSINTdefender', 'Faytuks', 'spectatorindex',
    'EIAgov', 'JavierBlas', 'Amena__Bakr',
]);

const MAX_AGE_X_MS = 4 * 60 * 60 * 1000; // 4 hours

const CURATED_ACCOUNTS = [
    '@WalterBloomberg', '@DeItaone', '@NickTimiraos', '@EIAgov',
    '@JavierBlas', '@OSINTdefender', '@FirstSquawk', '@unusual_whales',
    '@FreightWaves', '@statnews',
];

export class XIngestionService {
    private grok: OpenAI | null = null;

    constructor(apiKey: string) {
        if (apiKey) {
            // Use a try/catch to support both real class instantiation and
            // vi.fn() mock implementations (which may not be constructible).
            try {
                this.grok = new OpenAI({ apiKey, baseURL: 'https://api.x.ai/v1' });
            } catch {
                this.grok = (OpenAI as any)({ apiKey, baseURL: 'https://api.x.ai/v1' });
            }
        }
    }

    async scan(): Promise<RawArticle[]> {
        if (!this.grok) return [];

        const fromQuery = CURATED_ACCOUNTS.map(a => `from:${a.replace('@', '')}`).join(' OR ');
        const now = new Date().toISOString();
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

        try {
            const response = await (this.grok.chat.completions.create as any)({
                model: 'grok-3-mini',
                messages: [{
                    role: 'user',
                    content: `Search X for breaking financial/macro news from these accounts in the last 2 hours.
Query: (${fromQuery}) OR ("breaking" AND ("market" OR "fed" OR "oil" OR "rate"))
Date range: ${twoHoursAgo} to ${now}

Return a JSON array of market-moving posts only (ignore opinions/analysis). For each:
{
  "headline": "one-line summary of what happened",
  "url": "https://x.com/...",
  "summary": "2-3 sentence context",
  "account": "@handle",
  "publishedAt": "ISO8601"
}
Return [] if nothing market-moving. JSON only, no markdown.`,
                }],
                temperature: 0.1,
                search: { mode: 'on', from_date: twoHoursAgo, to_date: now },
            } as any);

            const content = response.choices[0]?.message?.content ?? '[]';
            return this.parse(content);
        } catch {
            return [];
        }
    }

    private parse(text: string): RawArticle[] {
        let raw: any[] = [];
        try {
            raw = JSON.parse(text);
        } catch {
            const m = text.match(/\[[\s\S]*\]/);
            if (m) { try { raw = JSON.parse(m[0]); } catch { return []; } }
        }

        if (!Array.isArray(raw)) return [];

        const now = Date.now();
        return raw
            .filter((item): item is { headline: string; url: string; summary: string; account: string; publishedAt: string } =>
                typeof item?.headline === 'string' && typeof item?.url === 'string')
            .filter(item => {
                const age = now - new Date(item.publishedAt).getTime();
                return age <= MAX_AGE_X_MS;
            })
            .map(item => {
                const handle = (item.account ?? '').replace('@', '');
                const trust: SourceTrust = TIER1_ACCOUNTS.has(handle) ? 'tier1' : 'tier2';
                return {
                    url: item.url,
                    urlHash: Buffer.from(item.url).toString('base64').slice(0, 16),
                    headline: item.headline.slice(0, 200),
                    summary: item.summary?.slice(0, 300) ?? '',
                    source: `x_${item.account ?? 'unknown'}`,
                    sourceTrust: trust,
                    domain: 'social',
                    publishedAt: new Date(item.publishedAt),
                    pipeline: 'x' as const,
                };
            });
    }
}
