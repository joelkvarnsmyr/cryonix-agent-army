// packages/agents/src/aktienix/intelligence/x-ingestion-service.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { XIngestionService } from './x-ingestion-service';

const mockCreate = vi.hoisted(() => vi.fn());

vi.mock('openai', () => {
    const MockOpenAI = vi.fn().mockImplementation(function () {
        return { chat: { completions: { create: mockCreate } } };
    });
    return { default: MockOpenAI };
});

describe('XIngestionService', () => {
    let service: XIngestionService;

    beforeEach(() => {
        vi.clearAllMocks();
        service = new XIngestionService('xai-test-key');
    });

    it('returns empty array when API key is missing', async () => {
        const s = new XIngestionService('');
        const articles = await s.scan();
        expect(articles).toEqual([]);
    });

    it('normalizes Grok response to RawArticle[]', async () => {
        mockCreate.mockResolvedValue({
            choices: [{
                message: {
                    content: JSON.stringify([{
                        headline: 'OPEC cuts output by 1M barrels',
                        url: 'https://x.com/WalterBloomberg/status/123',
                        summary: 'Unexpected OPEC production cut announced.',
                        account: '@WalterBloomberg',
                        publishedAt: new Date().toISOString(),
                    }]),
                },
            }],
        });

        const articles = await service.scan();
        expect(articles).toHaveLength(1);
        expect(articles[0].headline).toBe('OPEC cuts output by 1M barrels');
        expect(articles[0].pipeline).toBe('x');
        expect(articles[0].sourceTrust).toBe('tier1');
    });

    it('drops X posts older than 4 hours', async () => {
        const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
        mockCreate.mockResolvedValue({
            choices: [{
                message: {
                    content: JSON.stringify([{
                        headline: 'Old news',
                        url: 'https://x.com/test/status/456',
                        summary: 'Too old.',
                        account: '@test',
                        publishedAt: fiveHoursAgo,
                    }]),
                },
            }],
        });

        const articles = await service.scan();
        expect(articles).toHaveLength(0);
    });
});
