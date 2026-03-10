// packages/agents/src/aktienix/intelligence/news-ingestion-service.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NewsIngestionService, RawArticle } from './news-ingestion-service';

const MOCK_RSS = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <item>
      <title>Oil prices surge after OPEC cuts</title>
      <link>https://reuters.com/article/1</link>
      <description>Crude oil rose 3% after OPEC announced unexpected cuts.</description>
      <pubDate>Mon, 10 Mar 2026 14:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Oil prices surge after OPEC cuts</title>
      <link>https://reuters.com/article/1</link>
      <description>Duplicate article.</description>
      <pubDate>Mon, 10 Mar 2026 14:05:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

describe('NewsIngestionService', () => {
    let service: NewsIngestionService;

    beforeEach(() => {
        service = new NewsIngestionService();
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            text: () => Promise.resolve(MOCK_RSS),
        }));
    });

    it('parses RSS feed and returns RawArticle array', async () => {
        const articles = await service.fetchFeed(
            'https://feeds.reuters.com/reuters/energy',
            'reuters', 'tier1', 'energy'
        );
        expect(articles.length).toBeGreaterThan(0);
        expect(articles[0].headline).toBe('Oil prices surge after OPEC cuts');
        expect(articles[0].source).toBe('reuters');
        expect(articles[0].sourceTrust).toBe('tier1');
        expect(articles[0].domain).toBe('energy');
        expect(articles[0].pipeline).toBe('rss');
    });

    it('deduplicates articles with same URL', async () => {
        const articles = await service.fetchFeed(
            'https://feeds.reuters.com/reuters/energy',
            'reuters', 'tier1', 'energy'
        );
        expect(articles.length).toBe(1); // 2 items but same URL — deduped
    });

    it('drops articles older than 48h', async () => {
        const oldRss = MOCK_RSS.replace(
            'Mon, 10 Mar 2026 14:00:00 GMT',
            'Fri, 06 Mar 2026 10:00:00 GMT' // 4 days ago
        );
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true, text: () => Promise.resolve(oldRss),
        }));
        const articles = await service.fetchFeed(
            'https://feeds.reuters.com/reuters/energy',
            'reuters', 'tier1', 'energy'
        );
        expect(articles.length).toBe(0);
    });

    it('returns empty array when feed is unreachable', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));
        const articles = await service.fetchFeed(
            'https://unreachable.example.com/rss',
            'unknown', 'unknown', 'general'
        );
        expect(articles).toEqual([]);
    });
});
