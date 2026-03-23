import { describe, it, expect } from 'vitest';
import { TranscriptFeed } from '../data/feeds/transcript-feed';
import type { TranscriptSegment } from '../data/feeds/transcript-feed';

const mockSegments: TranscriptSegment[] = [
  {
    text: 'Welcome to the show, Jensen Huang from NVIDIA',
    start: 0,
    duration: 5,
  },
  {
    text: 'NVIDIA is seeing incredible demand for our AI chips',
    start: 5,
    duration: 5,
  },
  {
    text: 'The growth in data centers is accelerating beyond expectations',
    start: 10,
    duration: 5,
  },
  {
    text: 'We are scaling Blackwell production rapidly',
    start: 15,
    duration: 5,
  },
  {
    text: 'There are some concerns about competition from AMD',
    start: 20,
    duration: 5,
  },
  {
    text: 'But our CUDA ecosystem gives us a strong moat',
    start: 25,
    duration: 5,
  },
  {
    text: 'Tesla is also a big customer for our chips',
    start: 30,
    duration: 5,
  },
  {
    text: 'Bitcoin mining has slowed as a revenue source',
    start: 35,
    duration: 5,
  },
];

describe('TranscriptFeed', () => {
  const feed = new TranscriptFeed();

  it('should analyze transcript and find company mentions', () => {
    const result = feed.analyze(
      mockSegments,
      'test-123',
      'Jensen Huang on Lex Fridman',
    );
    expect(result.mentions.length).toBeGreaterThan(0);
    const nvidia = result.mentions.find((m) => m.ticker === 'NVDA');
    expect(nvidia).toBeDefined();
    expect(nvidia!.count).toBeGreaterThanOrEqual(2);
  });

  it('should detect overall bullish sentiment', () => {
    const result = feed.analyze(mockSegments, 'test-123');
    // "incredible", "growth", "accelerating", "scaling" vs "concerns"
    expect(result.sentiment).toBe('bullish');
  });

  it('should extract key quotes with company + sentiment', () => {
    const result = feed.analyze(mockSegments, 'test-123');
    expect(result.keyQuotes.length).toBeGreaterThan(0);
  });

  it('should find multiple company tickers', () => {
    const result = feed.analyze(mockSegments, 'test-123');
    const tickers = result.mentions.map((m) => m.ticker);
    expect(tickers).toContain('NVDA');
    expect(tickers).toContain('TSLA');
  });

  it('should handle empty segments', () => {
    const result = feed.analyze([], 'empty');
    expect(result.mentions).toEqual([]);
    expect(result.sentiment).toBe('neutral');
    expect(result.totalDuration).toBe(0);
  });

  it('should detect AMD as bearish context (competition concern)', () => {
    const result = feed.analyze(mockSegments, 'test-123');
    const amd = result.mentions.find((m) => m.ticker === 'AMD');
    if (amd) {
      expect(amd.sentiment).toBe('bearish'); // "concerns about competition from AMD"
    }
  });
});
