import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST, GET } from '../risk-check/route';
import { NextRequest } from 'next/server';

// Mock Dependencies
vi.mock('@cryonix/agents', () => {
    const MockRiskManager = vi.fn().mockImplementation(function() {
        return {
            initialize: vi.fn().mockResolvedValue(undefined),
            start: vi.fn().mockResolvedValue(undefined),
            checkSignalRisk: vi.fn().mockResolvedValue({
                approved: true,
                position_size: 1000,
                position_value: 1000,
                risk_amount: 100,
                kelly_fraction: 0.1,
                reasoning: ['Looks good']
            }),
            getStatus: vi.fn().mockReturnValue('running')
        };
    });
    return { RiskManagerAgent: MockRiskManager };
});

vi.mock('@cryonix/database', () => ({
    db: {
        insert: vi.fn().mockReturnValue({
            values: vi.fn().mockResolvedValue(true)
        })
    },
    riskChecks: {} // Schema object mock
}));

vi.mock('@/lib/ws-publisher', () => ({
    publishToWebSocket: vi.fn().mockResolvedValue(true)
}));

// Mock RiskCheckRequestSchema
vi.mock('@cryonix/types', async () => {
    // Import actual zod schema if possible, or mock it
    const actual = await vi.importActual<any>('@cryonix/types');
    return {
        ...actual,
        // We can use the actual schema or mock only if needed. 
        // Using actual schema is better for validation tests.
    };
});

describe('Risk Check API', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('POST /api/risk-check approves valid signal', async () => {
        const body = {
            symbol: 'BTC/USDT',
            side: 'BUY',
            confidence: 0.9,
            entry_price: 50000,
            stop_loss: 49000,
            target_price: 55000
        };

        const req = new NextRequest('http://localhost:3000/api/risk-check', {
            method: 'POST',
            body: JSON.stringify(body)
        });

        const res = await POST(req);

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.success).toBe(true);
        expect(data.data.approved).toBe(true);
    });

    it('GET /api/risk-check returns status', async () => {
        const req = new NextRequest('http://localhost:3000/api/risk-check');
        const res = await GET(req);

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.success).toBe(true);
        expect(data.data.status).toBe('running');
    });
});
