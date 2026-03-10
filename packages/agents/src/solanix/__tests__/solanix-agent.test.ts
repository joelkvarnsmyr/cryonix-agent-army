import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SolanaAgent } from '../solanix-agent';

// Mock net module (used by StatePublisher's Redis client)
vi.mock('net', () => ({
    default: { createConnection: vi.fn(() => ({ on: vi.fn(), write: vi.fn(), end: vi.fn() })) },
    createConnection: vi.fn(() => ({ on: vi.fn(), write: vi.fn(), end: vi.fn() })),
}));

const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 429 });
vi.stubGlobal('fetch', mockFetch);

describe('SolanaAgent', () => {
    let agent: SolanaAgent;

    beforeEach(() => {
        agent = new SolanaAgent({
            id: 'orchestrator',
            name: 'Solanix Test Agent',
            description: 'Test',
            enabled: true,
        });
    });

    it('initializes to idle state', async () => {
        await agent.initialize();
        expect(agent.getStatus()).toBe('idle');
    });

    it('transitions to paused on stop', async () => {
        await agent.initialize();
        await agent.stop();
        expect(agent.getStatus()).toBe('paused');
    });

    it('handles TRADE_SIGNAL message without throwing', async () => {
        await agent.initialize();
        await expect(agent.handleMessage({
            agent_id: 'orchestrator',
            timestamp: new Date(),
            message_type: 'TRADE_SIGNAL',
            priority: 'HIGH',
            requires_approval: false,
            data: { symbol: 'SOL', action: 'BUY', confidence: 0.8, currentPrice: 150 },
        })).resolves.not.toThrow();
    });
});
