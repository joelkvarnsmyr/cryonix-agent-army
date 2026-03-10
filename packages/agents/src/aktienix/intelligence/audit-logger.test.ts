// packages/agents/src/aktienix/intelligence/audit-logger.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuditLogger, AuditEntry } from './audit-logger';

const mockRedis = vi.hoisted(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    lpush: vi.fn().mockResolvedValue(undefined),
    ltrim: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
}));

vi.mock('../redis-client', () => ({
    RespClient: vi.fn().mockImplementation(function () { return mockRedis; }),
}));

describe('AuditLogger', () => {
    let logger: AuditLogger;

    beforeEach(() => {
        vi.clearAllMocks();
        logger = new AuditLogger('redis://localhost:6379');
    });

    it('writes accepted signal to Redis with LPUSH + LTRIM', async () => {
        const entry: Omit<AuditEntry, 'id' | 'timestamp'> = {
            event_id: 'oil_supply_shock',
            sources: ['reuters'],
            corroboration: 'rss_only',
            validation_steps: [{ step: 'ticker_universe', passed: true }],
            final_decision: 'accepted',
            confidence_raw: 0.75,
            confidence_trust_adjusted: 0.75,
            confidence_corroboration_adjusted: 0.75,
            confidence_final: 0.75,
        };

        await logger.log(entry);

        expect(mockRedis.lpush).toHaveBeenCalledWith(
            'aktienix:intelligence:audit',
            expect.stringContaining('"oil_supply_shock"'),
        );
        expect(mockRedis.ltrim).toHaveBeenCalledWith('aktienix:intelligence:audit', 0, 9999);
    });

    it('assigns unique id and timestamp to each entry', async () => {
        const calls: string[] = [];
        mockRedis.lpush.mockImplementation((_key: string, value: string) => {
            calls.push(value);
            return Promise.resolve(undefined);
        });

        const base = { event_id: 'test', sources: [], corroboration: 'rss_only' as const,
            validation_steps: [], final_decision: 'rejected' as const,
            confidence_raw: 0.3, confidence_trust_adjusted: 0.3,
            confidence_corroboration_adjusted: 0.3, confidence_final: 0.3 };

        await logger.log(base);
        await logger.log(base);

        const entry1 = JSON.parse(calls[0]);
        const entry2 = JSON.parse(calls[1]);
        expect(entry1.id).not.toBe(entry2.id);
    });
});
