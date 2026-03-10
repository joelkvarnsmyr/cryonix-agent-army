// packages/agents/src/aktienix/intelligence/macro-classifier-agent.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MacroClassifierAgent, ClassifiedEvent } from './macro-classifier-agent';
import type { RawArticle } from './news-ingestion-service';

const mockCreate = vi.fn();
// Use regular function (not arrow) so it works as a constructor with `new OpenAI()`
vi.mock('openai', () => ({
    OpenAI: vi.fn().mockImplementation(function () {
        return { chat: { completions: { create: mockCreate } } };
    }),
}));

const makeArticle = (headline: string, pipeline: 'rss' | 'x' = 'rss'): RawArticle => ({
    url: `https://example.com/${Date.now()}`,
    urlHash: 'abc123',
    headline,
    summary: headline,
    source: 'reuters',
    sourceTrust: 'tier1',
    domain: 'energy',
    publishedAt: new Date(),
    pipeline,
});

describe('MacroClassifierAgent', () => {
    let agent: MacroClassifierAgent;

    beforeEach(() => {
        vi.clearAllMocks();
        agent = new MacroClassifierAgent('xai-test-key');
    });

    it('returns empty array when no articles', async () => {
        const result = await agent.classify([]);
        expect(result).toEqual([]);
        expect(mockCreate).not.toHaveBeenCalled();
    });

    it('parses valid LLM response into ClassifiedEvent[]', async () => {
        mockCreate.mockResolvedValue({
            choices: [{
                message: {
                    content: JSON.stringify([{
                        event_id: 'oil_supply_shock',
                        category: 'known',
                        causal_chain: {
                            immediate: {
                                bearish_tickers: ['UAL', 'DAL'],
                                bullish_tickers: ['XOM', 'CVX'],
                                reasoning: 'Oil spike hurts airlines',
                            },
                            secondary: {
                                recovery_watch_tickers: ['UAL'],
                                watch_after_days: 4,
                                reasoning: 'Airlines recover after hedges kick in',
                            },
                            resolution_signal: 'WTI falls back below spike level',
                        },
                        confidence: 0.82,
                        reasoning: 'Reuters reports OPEC unexpected cut.',
                        phase: 'developing',
                        ttl_hours: 96,
                        market_moving: true,
                    }]),
                },
            }],
        });

        const result = await agent.classify([makeArticle('OPEC cuts production')]);
        expect(result).toHaveLength(1);
        expect(result[0].event_id).toBe('oil_supply_shock');
        expect(result[0].confidence).toBe(0.82);
        expect(result[0].causal_chain.immediate.bullish_tickers).toContain('XOM');
    });

    it('drops events where market_moving is false', async () => {
        mockCreate.mockResolvedValue({
            choices: [{
                message: {
                    content: JSON.stringify([{
                        event_id: 'oil_supply_shock',
                        category: 'known',
                        causal_chain: { immediate: { bearish_tickers: [], bullish_tickers: [], reasoning: '' },
                            secondary: { recovery_watch_tickers: [], watch_after_days: 0, reasoning: '' },
                            resolution_signal: '' },
                        confidence: 0.6,
                        reasoning: 'Minor news',
                        phase: 'developing',
                        ttl_hours: 24,
                        market_moving: false,
                    }]),
                },
            }],
        });

        const result = await agent.classify([makeArticle('Minor oil news')]);
        expect(result).toHaveLength(0);
    });

    it('batches articles into groups of 8 max', async () => {
        mockCreate.mockResolvedValue({ choices: [{ message: { content: '[]' } }] });
        const articles = Array.from({ length: 20 }, (_, i) => makeArticle(`Article ${i}`));
        await agent.classify(articles);
        expect(mockCreate).toHaveBeenCalledTimes(3); // 8 + 8 + 4
    });
});
