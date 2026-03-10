import { describe, it, expect } from 'vitest';
import type { SolanaPosition, SolanaSignal, SolanaAccountState } from '../types';

describe('Solanix types', () => {
    it('SolanaPosition has required fields', () => {
        const pos: SolanaPosition = {
            symbol: 'SOL',
            mintAddress: 'So11111111111111111111111111111111111111112',
            qty: 1.5,
            avgEntryPrice: 150.0,
            currentPrice: 155.0,
            unrealizedPl: 7.5,
            entryTime: Date.now(),
            highWatermark: 155.0,
        };
        expect(pos.symbol).toBe('SOL');
        expect(pos.mintAddress).toBeDefined();
        expect(pos.highWatermark).toBeDefined();
    });

    it('SolanaSignal has required fields', () => {
        const sig: SolanaSignal = {
            symbol: 'BONK',
            mintAddress: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
            action: 'BUY',
            confidence: 0.75,
            reasoning: ['RSI oversold'],
            currentPrice: 0.000025,
            source: 'ta',
            timestamp: Date.now(),
        };
        expect(sig.source).toBe('ta');
    });
});
