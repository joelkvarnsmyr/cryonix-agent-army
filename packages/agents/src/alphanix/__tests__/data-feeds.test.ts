import { describe, it, expect } from 'vitest';
import { FredFeed } from '../data/feeds/fred-feed';
import { SecEdgarFeed } from '../data/feeds/sec-edgar-feed';
import { SentimentFeed } from '../data/feeds/sentiment-feed';
import { OpenSkyFeed } from '../data/feeds/opensky-feed';
import { TrafikverketFeed } from '../data/feeds/trafikverket-feed';

describe('FredFeed', () => {
  it('should throw without API key', async () => {
    const feed = new FredFeed('');
    await expect(feed.getSeries('GDP')).rejects.toThrow('FRED_API_KEY');
  });

  it('should construct with custom key', () => {
    const feed = new FredFeed('test-key');
    expect(feed).toBeDefined();
  });
});

describe('SecEdgarFeed', () => {
  it('should construct with user agent', () => {
    const feed = new SecEdgarFeed('Test/1.0');
    expect(feed).toBeDefined();
  });
});

describe('SentimentFeed', () => {
  it('should return neutral score on error', async () => {
    const feed = new SentimentFeed();
    // This will fail to connect in test env — should return neutral, not throw
    const score = await feed.getRedditSentiment('INVALID_SYMBOL_XYZ');
    expect(score.score).toBe(0);
    expect(score.mentions).toBe(0);
  });
});

describe('OpenSkyFeed', () => {
  it('should construct', () => {
    const feed = new OpenSkyFeed();
    expect(feed).toBeDefined();
  });
});

describe('TrafikverketFeed', () => {
  it('should return empty without API key', async () => {
    const feed = new TrafikverketFeed('');
    const trains = await feed.getTrainAnnouncements('KRA', 'NAV');
    expect(trains).toEqual([]);
  });

  it('should return malmbanen status without key', async () => {
    const feed = new TrafikverketFeed('');
    const status = await feed.getMalmbanenStatus();
    expect(status.trains).toEqual([]);
  });
});
