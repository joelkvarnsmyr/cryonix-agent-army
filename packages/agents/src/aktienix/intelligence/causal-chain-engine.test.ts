// packages/agents/src/aktienix/intelligence/causal-chain-engine.test.ts
import { describe, it, expect } from 'vitest';
import { CausalChainEngine } from './causal-chain-engine';
import type { LiveEvent } from './event-lifecycle-tracker';

const makeEvent = (phase: LiveEvent['phase'], conf = 0.75, daysSinceDetected = 0): LiveEvent => ({
    event_id: 'oil_supply_shock',
    phase,
    causal_chain: {
        immediate: { bearish_tickers: ['UAL', 'DAL'], bullish_tickers: ['XOM'], reasoning: 'fuel costs up' },
        secondary: { recovery_watch_tickers: ['UAL'], watch_after_days: 4, reasoning: 'recovery' },
        resolution_signal: 'WTI falls',
    },
    sources: [],
    corroboration: 'confirmed',
    confidence: conf,
    detectedAt: new Date(Date.now() - daysSinceDetected * 86_400_000).toISOString(),
    expiresAt: new Date(Date.now() + 48 * 3600_000).toISOString(),
    lastEvaluatedAt: new Date().toISOString(),
    auditIds: [],
});

describe('CausalChainEngine', () => {
    const engine = new CausalChainEngine();

    it('emits bearish MacroSignal for developing event on bearish tickers', () => {
        const signals = engine.toMacroSignals([makeEvent('developing')]);
        const bearish = signals.filter(s => s.impact === 'bearish');
        expect(bearish.length).toBeGreaterThan(0);
        expect(bearish[0].tickers).toContain('UAL');
        expect(bearish[0].tickers).toContain('DAL');
    });

    it('emits bullish MacroSignal for developing event on bullish tickers', () => {
        const signals = engine.toMacroSignals([makeEvent('developing')]);
        const bullish = signals.filter(s => s.impact === 'bullish');
        expect(bullish[0].tickers).toContain('XOM');
    });

    it('emits neutral WATCH_RECOVERY signal when resolving + past watchAfterDays', () => {
        const signals = engine.toMacroSignals([makeEvent('resolving', 0.45, 5)]); // 5 days in
        const neutral = signals.filter(s => s.impact === 'neutral');
        expect(neutral.length).toBeGreaterThan(0);
        expect(neutral[0].tickers).toContain('UAL');
    });

    it('does NOT emit recovery signal before watchAfterDays', () => {
        const signals = engine.toMacroSignals([makeEvent('resolving', 0.45, 1)]); // only 1 day in
        const neutral = signals.filter(s => s.impact === 'neutral');
        expect(neutral.length).toBe(0);
    });

    it('emits no signals for resolved events', () => {
        const signals = engine.toMacroSignals([makeEvent('resolved')]);
        expect(signals.length).toBe(0);
    });

    it('emits no signals for detected (not yet confirmed) events', () => {
        const signals = engine.toMacroSignals([makeEvent('detected')]);
        expect(signals.length).toBe(0);
    });

    it('confidence is capped at 0.95', () => {
        const signals = engine.toMacroSignals([makeEvent('developing', 0.99)]);
        for (const s of signals) expect(s.confidence).toBeLessThanOrEqual(0.95);
    });
});
