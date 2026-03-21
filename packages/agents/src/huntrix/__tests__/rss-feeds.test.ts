import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RSSFeedScanner } from '../scanners/rss-feeds';

function createMockRedis() {
  const seen = new Set<string>();
  return {
    sismember: vi.fn(async (_key: string, member: string) => seen.has(member) ? 1 : 0),
    sadd: vi.fn(async (_key: string, member: string) => { seen.add(member); return 1; }),
    expire: vi.fn(async () => 1),
    _seen: seen,
  };
}

const SAMPLE_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title>Test Feed</title>
  <item>
    <title>Major ETH exploit drains $50M from DeFi protocol</title>
    <link>https://example.com/eth-exploit</link>
    <description>A flash loan attack drained ETH from a major protocol</description>
    <pubDate>Fri, 21 Mar 2026 12:00:00 GMT</pubDate>
  </item>
  <item>
    <title>Crypto market update: BTC reaches new highs</title>
    <link>https://example.com/btc-update</link>
    <description>Bitcoin continues to climb</description>
    <pubDate>Fri, 21 Mar 2026 11:00:00 GMT</pubDate>
  </item>
</channel>
</rss>`;

const SAMPLE_ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>SEC charges AAVE-related firm with fraud</title>
    <link href="https://example.com/sec-charges"/>
    <summary>Enforcement action against crypto firm</summary>
    <published>2026-03-21T12:00:00Z</published>
  </entry>
</feed>`;

describe('RSSFeedScanner', () => {
  let scanner: RSSFeedScanner;
  let redis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    redis = createMockRedis();
    scanner = new RSSFeedScanner(redis as any);
    vi.restoreAllMocks();
  });

  it('should parse RSS 2.0 items', () => {
    const items = scanner.parseXML(SAMPLE_RSS);
    expect(items.length).toBe(2);
    expect(items[0].title).toContain('ETH exploit');
    expect(items[0].link).toBe('https://example.com/eth-exploit');
  });

  it('should parse Atom entries', () => {
    const items = scanner.parseXML(SAMPLE_ATOM);
    expect(items.length).toBe(1);
    expect(items[0].title).toContain('SEC charges');
    expect(items[0].link).toBe('https://example.com/sec-charges');
  });

  it('should classify exploit articles as high severity', () => {
    const alert = scanner.classifyArticle('TestFeed', {
      title: 'Major ETH exploit drains $50M from DeFi protocol',
      link: 'https://example.com/exploit',
      description: 'A flash loan attack drained funds',
      published: '2026-03-21T12:00:00Z',
    });
    expect(alert.category).toBe('exploit');
    expect(alert.severity).toBe('high');
    expect(alert.symbols).toContain('ETH');
  });

  it('should classify enforcement articles', () => {
    const alert = scanner.classifyArticle('TestFeed', {
      title: 'SEC charges crypto firm with fraud',
      link: 'https://example.com/enforcement',
      description: 'Enforcement action and penalty issued',
      published: '2026-03-21T12:00:00Z',
    });
    expect(alert.category).toBe('enforcement');
    expect(alert.severity).toBe('high');
  });

  it('should deduplicate seen articles via Redis', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => SAMPLE_RSS,
    } as Response);

    // First scan — should return exploit article (not general)
    const first = await scanner.fetchFeed('Test', 'https://example.com/feed');
    const exploitAlerts = first.filter(a => a.category !== 'general');
    expect(exploitAlerts.length).toBeGreaterThanOrEqual(1);

    // Second scan — same items should be deduplicated
    const second = await scanner.fetchFeed('Test', 'https://example.com/feed');
    expect(second.length).toBe(0);
  });
});
