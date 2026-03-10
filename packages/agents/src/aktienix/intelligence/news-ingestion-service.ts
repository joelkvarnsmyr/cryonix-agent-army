// packages/agents/src/aktienix/intelligence/news-ingestion-service.ts
import * as crypto from 'crypto';

export type SourceTrust = 'tier1' | 'tier2' | 'unknown';

export interface RawArticle {
    url: string;
    urlHash: string;
    headline: string;
    summary: string;
    source: string;
    sourceTrust: SourceTrust;
    domain: string;
    publishedAt: Date;
    pipeline: 'rss' | 'x';
}

const MAX_AGE_MS = 48 * 60 * 60 * 1000; // 48 hours

/** Extract all <tag>content</tag> occurrences from XML string */
function extractTag(xml: string, tag: string): string[] {
    const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
    const results: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null) {
        results.push(m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim());
    }
    return results;
}

/** Extract all <item> blocks from RSS XML */
function extractItems(xml: string): string[] {
    const re = /<item[\s>]([\s\S]*?)<\/item>/gi;
    const items: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null) items.push(m[1]);
    return items;
}

export class NewsIngestionService {
    private seenHashes = new Map<string, number>();

    async fetchFeed(
        url: string,
        source: string,
        trust: SourceTrust,
        domain: string,
    ): Promise<RawArticle[]> {
        try {
            const res = await fetch(url, {
                headers: { 'User-Agent': 'Aktienix/1.0 (trading research bot)' },
                signal: AbortSignal.timeout(10_000),
            });
            if (!res.ok) return [];
            const xml = await res.text();
            return this.parseRss(xml, source, trust, domain);
        } catch {
            return [];
        }
    }

    private parseRss(xml: string, source: string, trust: SourceTrust, domain: string): RawArticle[] {
        const items = extractItems(xml);
        const now = Date.now();
        const results: RawArticle[] = [];

        for (const item of items) {
            const title = extractTag(item, 'title')[0] ?? '';
            const link = extractTag(item, 'link')[0] ?? '';
            const description = extractTag(item, 'description')[0] ?? '';
            const pubDateStr = extractTag(item, 'pubDate')[0] ?? '';

            if (!title || !link) continue;

            const urlHash = crypto.createHash('sha256').update(link).digest('hex').slice(0, 16);
            if (this.seenHashes.has(urlHash)) continue;
            // Mark URL as seen before age/validity checks so duplicates with different
            // dates cannot slip through when the first occurrence is age-rejected.
            this.seenHashes.set(urlHash, Date.now());

            const publishedAt = pubDateStr ? new Date(pubDateStr) : new Date();
            if (isNaN(publishedAt.getTime())) continue;
            if (now - publishedAt.getTime() > MAX_AGE_MS) continue;

            results.push({
                url: link,
                urlHash,
                headline: title.slice(0, 200),
                summary: description.replace(/<[^>]+>/g, '').slice(0, 300),
                source,
                sourceTrust: trust,
                domain,
                publishedAt,
                pipeline: 'rss',
            });
        }

        return results;
    }

    /** Scan all configured RSS feeds and return deduplicated articles. */
    async scanAll(): Promise<RawArticle[]> {
        const cutoff = Date.now() - 48 * 60 * 60 * 1000;
        for (const [hash, ts] of this.seenHashes) {
            if (ts < cutoff) this.seenHashes.delete(hash);
        }
        const feeds: Array<[string, string, SourceTrust, string]> = [
            ['https://feeds.reuters.com/reuters/businessNews', 'reuters', 'tier1', 'macro'],
            ['https://feeds.reuters.com/reuters/energy', 'reuters', 'tier1', 'energy'],
            ['https://www.eia.gov/rss/press_rss.xml', 'eia', 'tier1', 'energy'],
            ['https://www.federalreserve.gov/feeds/press_all.xml', 'fed', 'tier1', 'fed'],
            ['https://feeds.reuters.com/reuters/technologyNews', 'reuters', 'tier1', 'tech'],
            ['https://feeds.reuters.com/Reuters/worldNews', 'reuters', 'tier1', 'geopolitics'],
            ['https://feeds.reuters.com/reuters/healthNews', 'reuters', 'tier1', 'healthcare'],
            ['https://feeds.marketwatch.com/marketwatch/topstories', 'marketwatch', 'tier2', 'macro'],
        ];

        const results = await Promise.all(
            feeds.map(([url, source, trust, domain]) => this.fetchFeed(url, source, trust, domain))
        );
        return results.flat();
    }
}
