// packages/agents/src/aktienix/intelligence/signal-merger.test.ts
import { describe, it, expect } from 'vitest';
import { SignalMerger, MergedSignal } from './signal-merger';
import type { ClassifiedEvent } from './macro-classifier-agent';

const makeEvent = (event_id: string, phase = 'developing', conf = 0.75,
    pipeline: 'rss' | 'x' = 'rss', trust: 'tier1' | 'tier2' = 'tier1'): ClassifiedEvent & { pipeline: 'rss' | 'x'; trust: 'tier1' | 'tier2' } => ({
    event_id,
    category: 'known' as const,
    causal_chain: {
        immediate: { bearish_tickers: ['UAL'], bullish_tickers: ['XOM'], reasoning: 'test' },
        secondary: { recovery_watch_tickers: ['UAL'], watch_after_days: 3, reasoning: 'test' },
        resolution_signal: 'test',
    },
    confidence: conf,
    reasoning: 'test',
    phase: phase as any,
    ttl_hours: 48,
    market_moving: true,
    source_articles: ['https://example.com'],
    pipeline,
    trust,
});

describe('SignalMerger', () => {
    const merger = new SignalMerger();

    it('marks confirmed when both RSS and X detect same event same direction', () => {
        const rss = makeEvent('oil_supply_shock', 'developing', 0.75, 'rss');
        const x = makeEvent('oil_supply_shock', 'developing', 0.70, 'x');
        const results = merger.merge([rss], [x]);
        expect(results[0].corroboration).toBe('confirmed');
        expect(results[0].confidence_delta).toBe(0.15);
    });

    it('marks rss_only when X has no matching event', () => {
        const rss = makeEvent('oil_supply_shock', 'developing', 0.75, 'rss');
        const results = merger.merge([rss], []);
        expect(results[0].corroboration).toBe('rss_only');
        expect(results[0].confidence_delta).toBe(0);
    });

    it('marks social_only with negative delta when only X detects', () => {
        const x = makeEvent('oil_supply_shock', 'developing', 0.75, 'x');
        const results = merger.merge([], [x]);
        expect(results[0].corroboration).toBe('social_only');
        expect(results[0].confidence_delta).toBe(-0.10);
    });

    it('marks confirmed_weak for category match (different slugs, same sector)', () => {
        const rss = makeEvent('oil_supply_shock', 'developing', 0.75, 'rss');
        const x = makeEvent('opec_surprise_cut', 'developing', 0.72, 'x'); // emergent but energy
        const results = merger.merge([rss], [x]);
        // Different event_id but both energy category → confirmed_weak
        const merged = results.find(r => r.event_id === 'oil_supply_shock');
        expect(merged?.corroboration).toMatch(/confirmed/);
    });

    it('merges sources array from both pipelines', () => {
        const rss = makeEvent('oil_supply_shock', 'developing', 0.75, 'rss');
        const x = makeEvent('oil_supply_shock', 'developing', 0.70, 'x');
        rss.source_articles = ['https://reuters.com/1'];
        x.source_articles = ['https://x.com/1'];
        const results = merger.merge([rss], [x]);
        expect(results[0].sources).toContain('https://reuters.com/1');
        expect(results[0].sources).toContain('https://x.com/1');
    });
});
