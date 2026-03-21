import type Redis from 'ioredis';
import type { RSSAlert } from '../types';

// 6 verified free RSS feeds
const FEEDS: Array<{ name: string; url: string }> = [
  { name: 'Protos', url: 'https://protos.com/feed/' },
  { name: 'Halborn Blog', url: 'https://www.halborn.com/blog/rss.xml' },
  { name: 'Halborn Updates', url: 'https://www.halborn.com/updates/rss.xml' },
  { name: 'Chainalysis', url: 'https://www.chainalysis.com/blog/feed/' },
  { name: 'CFTC', url: 'https://www.cftc.gov/Newsroom/PressReleases/RSS' },
  { name: 'FCA Warnings', url: 'https://www.fca.org.uk/news/rss.xml' },
];

const SEEN_SET_KEY = 'huntrix:rss:seen';
const SEEN_TTL = 7 * 24 * 3600; // 7 days

// Keyword classification
const EXPLOIT_KEYWORDS = ['hack', 'exploit', 'breach', 'drain', 'stolen', 'flash loan', 'reentrancy', 'vulnerability', 'compromised'];
const ENFORCEMENT_KEYWORDS = ['enforcement', 'charged', 'lawsuit', 'fine', 'penalty', 'sanction', 'sec ', 'cftc ', 'cease and desist', 'fraud'];
const SCAM_KEYWORDS = ['scam', 'rug pull', 'ponzi', 'pyramid', 'phishing', 'fake'];
const VULNERABILITY_KEYWORDS = ['vulnerability', 'cve', 'patch', 'bug bounty', 'security flaw', 'zero-day'];

// Common crypto symbol patterns
const SYMBOL_PATTERN = /\b(BTC|ETH|SOL|BNB|XRP|ADA|DOGE|AVAX|DOT|MATIC|LINK|UNI|AAVE|CRV|COMP|SUSHI|CAKE|FTM|ARB|OP|LDO|MKR|SNX|YFI|SHIB|PEPE|FLOKI|BONK|WIF)\b/gi;

export class RSSFeedScanner {
  private redis: Redis;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  /**
   * Poll all feeds and return new alerts not seen before.
   */
  async scan(): Promise<RSSAlert[]> {
    const alerts: RSSAlert[] = [];

    const results = await Promise.allSettled(
      FEEDS.map(feed => this.fetchFeed(feed.name, feed.url))
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        alerts.push(...result.value);
      }
    }

    return alerts;
  }

  /**
   * Fetch and parse a single RSS feed.
   */
  async fetchFeed(feedName: string, url: string): Promise<RSSAlert[]> {
    const alerts: RSSAlert[] = [];

    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Huntrix/1.0 (crypto safety monitor)' },
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) return alerts;

      const xml = await response.text();
      const items = this.parseXML(xml);

      for (const item of items) {
        // Dedup via Redis seen set
        const itemId = `${feedName}:${item.link || item.title}`;
        const alreadySeen = await this.redis.sismember(SEEN_SET_KEY, itemId);
        if (alreadySeen) continue;

        const alert = this.classifyArticle(feedName, item);
        if (alert.category !== 'general') {
          alerts.push(alert);
        }

        await this.redis.sadd(SEEN_SET_KEY, itemId);
      }

      // Set TTL on seen set (refresh on each scan)
      await this.redis.expire(SEEN_SET_KEY, SEEN_TTL);
    } catch (err) {
      console.warn(`[HUNTRIX] RSS fetch failed for ${feedName}:`, err instanceof Error ? err.message : err);
    }

    return alerts;
  }

  /**
   * Simple regex XML parser for RSS 2.0 + Atom feeds.
   * No external dependencies needed.
   */
  parseXML(xml: string): Array<{ title: string; link: string; description: string; published: string }> {
    const items: Array<{ title: string; link: string; description: string; published: string }> = [];

    // RSS 2.0: <item>...</item>
    const rssItems = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
    for (const itemXml of rssItems) {
      items.push({
        title: this.extractTag(itemXml, 'title'),
        link: this.extractTag(itemXml, 'link'),
        description: this.extractTag(itemXml, 'description'),
        published: this.extractTag(itemXml, 'pubDate') || this.extractTag(itemXml, 'dc:date'),
      });
    }

    // Atom: <entry>...</entry>
    if (items.length === 0) {
      const atomEntries = xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
      for (const entryXml of atomEntries) {
        const linkMatch = entryXml.match(/<link[^>]*href=["']([^"']*)["']/i);
        items.push({
          title: this.extractTag(entryXml, 'title'),
          link: linkMatch?.[1] || '',
          description: this.extractTag(entryXml, 'summary') || this.extractTag(entryXml, 'content'),
          published: this.extractTag(entryXml, 'published') || this.extractTag(entryXml, 'updated'),
        });
      }
    }

    return items;
  }

  /**
   * Extract text content from an XML tag.
   */
  private extractTag(xml: string, tag: string): string {
    const cdataMatch = xml.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i'));
    if (cdataMatch) return cdataMatch[1].trim();

    const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
    return match ? match[1].replace(/<[^>]+>/g, '').trim() : '';
  }

  /**
   * Classify an article by keyword matching.
   */
  classifyArticle(feedName: string, item: { title: string; link: string; description: string; published: string }): RSSAlert {
    const text = `${item.title} ${item.description}`.toLowerCase();
    const symbols = this.extractSymbols(text);

    let category: RSSAlert['category'] = 'general';
    let severity: RSSAlert['severity'] = 'low';

    if (EXPLOIT_KEYWORDS.some(kw => text.includes(kw))) {
      category = 'exploit';
      severity = 'high';
    } else if (ENFORCEMENT_KEYWORDS.some(kw => text.includes(kw))) {
      category = 'enforcement';
      severity = 'high';
    } else if (SCAM_KEYWORDS.some(kw => text.includes(kw))) {
      category = 'scam';
      severity = 'high';
    } else if (VULNERABILITY_KEYWORDS.some(kw => text.includes(kw))) {
      category = 'vulnerability';
      severity = 'medium';
    }

    return {
      feedName,
      title: item.title,
      link: item.link,
      published: item.published || new Date().toISOString(),
      category,
      symbols,
      severity,
    };
  }

  /**
   * Extract crypto symbols from text.
   */
  private extractSymbols(text: string): string[] {
    const matches = text.toUpperCase().match(SYMBOL_PATTERN) || [];
    return [...new Set(matches)];
  }
}
