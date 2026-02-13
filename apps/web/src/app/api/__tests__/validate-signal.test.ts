import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from '../validate-signal/route';
import { NextRequest } from 'next/server';

// Mock Dependencies
vi.mock('@cryonix/agents', () => {
    const MockSignalValidator = vi.fn().mockImplementation(function() {
        return {
            validate: vi.fn().mockResolvedValue({
                isValid: true,
                validatedAction: 'BUY',
                validatedConfidence: 0.85,
                consensusLevel: 0.8,
                bullishSentiment: 0.8,
                bearishSentiment: 0.2,
                riskLevel: 'LOW',
                riskFactors: [],
                entryTiming: 'GOOD',
                timingReasoning: [],
                votes: [],
                technicalIndicators: {
                    rsi14: 50,
                    macd: 1,
                    macdHistogram: 0.1,
                    sma20: 100,
                    sma50: 99,
                    sma200: 98,
                    bollingerUpper: 110,
                    bollingerLower: 90,
                    volumeRatio: 1.2,
                    atr14: 5,
                },
                marketStructure: {
                    trend: 'UPTREND',
                    trendStrength: 0.7,
                    volatilityState: 'NORMAL',
                    volumeState: 'NORMAL',
                    nearestSupport: 95,
                    nearestResistance: 110,
                },
                adjustedEntry: 100,
                adjustedTarget: 110,
                adjustedStopLoss: 95,
                processingTimeMs: 100
            }),
            getAccuracyStats: vi.fn().mockReturnValue({})
        };
    });
    return { SignalValidator: MockSignalValidator };
});

const mockFetchOHLCV = vi.fn().mockResolvedValue([
    [1600000000000, 100, 105, 95, 102, 1000],
    [1600000060000, 102, 108, 100, 106, 1200],
]);

vi.mock('ccxt', () => {
    const MockBinance = vi.fn().mockImplementation(function() {
        return { fetchOHLCV: mockFetchOHLCV };
    });
    return { default: { binance: MockBinance } };
});

describe('Validate Signal API', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('POST /api/validate-signal returns validation result', async () => {
        const body = {
            symbol: 'BTC/USDT',
            action: 'BUY',
            entryPrice: 50000,
            confidence: 0.8
        };

        const req = new NextRequest('http://localhost:3000/api/validate-signal', {
            method: 'POST',
            body: JSON.stringify(body)
        });

        const res = await POST(req);

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.success).toBe(true);
        expect(data.validation.isValid).toBe(true);
        expect(mockFetchOHLCV).toHaveBeenCalled();
    });

    it('POST /api/validate-signal handles missing parameters', async () => {
        const body = {
            // Missing symbol and action
            entryPrice: 50000
        };

        const req = new NextRequest('http://localhost:3000/api/validate-signal', {
            method: 'POST',
            body: JSON.stringify(body)
        });

        const res = await POST(req);

        expect(res.status).toBe(400);
    });
});
