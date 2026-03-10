// packages/agents/src/aktienix/intelligence/event-lifecycle-tracker.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventLifecycleTracker, LiveEvent } from './event-lifecycle-tracker';

const mockRedis = {
    connect: vi.fn().mockResolvedValue(undefined),
    hset: vi.fn().mockResolvedValue(undefined),
    hdel: vi.fn().mockResolvedValue(undefined),
    hgetall: vi.fn().mockResolvedValue({}),
    isConnected: vi.fn().mockReturnValue(true),
};
vi.mock('../redis-client', () => ({
    RespClient: vi.fn(function() { return mockRedis; }),
}));

const mockGrok = { chat: { completions: { create: vi.fn() } } };
vi.mock('openai', () => ({
    OpenAI: vi.fn(function() { return mockGrok; }),
}));

describe('EventLifecycleTracker', () => {
    let tracker: EventLifecycleTracker;

    beforeEach(() => {
        vi.clearAllMocks();
        tracker = new EventLifecycleTracker('redis://localhost:6379', 'xai-key');
    });

    it('stores new event with detected phase', async () => {
        const event: LiveEvent = {
            event_id: 'oil_supply_shock',
            phase: 'detected',
            causal_chain: {
                immediate: { bearish_tickers: ['UAL'], bullish_tickers: ['XOM'], reasoning: 'test' },
                secondary: { recovery_watch_tickers: ['UAL'], watch_after_days: 3, reasoning: 'test' },
                resolution_signal: 'test',
            },
            sources: ['https://reuters.com/1'],
            corroboration: 'rss_only',
            confidence: 0.72,
            detectedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
            lastEvaluatedAt: new Date().toISOString(),
            auditIds: [],
        };

        await tracker.upsertEvent(event);
        expect(mockRedis.hset).toHaveBeenCalledWith(
            'aktienix:macro:event_states',
            'oil_supply_shock',
            expect.stringContaining('"phase":"detected"'),
        );
    });

    it('promotes detected → developing when second confirmation arrives', async () => {
        const stored: LiveEvent = {
            event_id: 'oil_supply_shock', phase: 'detected', confidence: 0.72,
            causal_chain: { immediate: { bearish_tickers: [], bullish_tickers: [], reasoning: '' },
                secondary: { recovery_watch_tickers: [], watch_after_days: 0, reasoning: '' },
                resolution_signal: '' },
            sources: [], corroboration: 'rss_only',
            detectedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
            lastEvaluatedAt: new Date().toISOString(), auditIds: [],
        };
        mockRedis.hgetall.mockResolvedValue({
            oil_supply_shock: JSON.stringify(stored),
        });

        await tracker.confirmEvent('oil_supply_shock');

        const saved = JSON.parse(mockRedis.hset.mock.calls[0][2]);
        expect(saved.phase).toBe('developing');
    });

    it('applies confidence decay when re-evaluated without new evidence', async () => {
        const stored: LiveEvent = {
            event_id: 'oil_supply_shock', phase: 'developing', confidence: 0.80,
            causal_chain: { immediate: { bearish_tickers: [], bullish_tickers: [], reasoning: '' },
                secondary: { recovery_watch_tickers: [], watch_after_days: 0, reasoning: '' },
                resolution_signal: '' },
            sources: [], corroboration: 'confirmed',
            detectedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
            lastEvaluatedAt: new Date().toISOString(), auditIds: [],
        };
        mockRedis.hgetall.mockResolvedValue({ oil_supply_shock: JSON.stringify(stored) });
        mockGrok.chat.completions.create.mockRejectedValue(new Error('API error'));

        await tracker.reEvaluate();

        const saved = JSON.parse(mockRedis.hset.mock.calls[0][2]);
        expect(saved.confidence).toBeCloseTo(0.80 * 0.85, 3);
    });

    it('transitions to resolved when confidence drops below 0.30', async () => {
        const stored: LiveEvent = {
            event_id: 'oil_supply_shock', phase: 'resolving', confidence: 0.32,
            causal_chain: { immediate: { bearish_tickers: [], bullish_tickers: [], reasoning: '' },
                secondary: { recovery_watch_tickers: [], watch_after_days: 0, reasoning: '' },
                resolution_signal: '' },
            sources: [], corroboration: 'rss_only',
            detectedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
            lastEvaluatedAt: new Date().toISOString(), auditIds: [],
        };
        mockRedis.hgetall.mockResolvedValue({ oil_supply_shock: JSON.stringify(stored) });
        mockGrok.chat.completions.create.mockRejectedValue(new Error('API error'));

        await tracker.reEvaluate();

        const saved = JSON.parse(mockRedis.hset.mock.calls[0][2]);
        expect(saved.phase).toBe('resolved');
    });
});
