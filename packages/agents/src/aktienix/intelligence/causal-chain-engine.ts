// packages/agents/src/aktienix/intelligence/causal-chain-engine.ts
import type { MacroSignal } from './news-scanner';
import type { LiveEvent } from './event-lifecycle-tracker';

export class CausalChainEngine {
    /**
     * Convert active LiveEvents to MacroSignal[] compatible with the existing
     * AktienixAgent.evaluateSignal() method.
     *
     * Adapter mapping (from spec Section 7):
     *   BLOCK_BUY  (developing)  → impact: 'bearish',  tickers: immediate.bearishTickers
     *   BLOCK_BUY  (developing)  → impact: 'bullish',  tickers: immediate.bullishTickers
     *   WATCH_RECOVERY (resolving, past watchAfterDays) → impact: 'neutral', tickers: recoveryWatchTickers
     *   RESOLVED events → no signals emitted
     */
    toMacroSignals(events: LiveEvent[]): MacroSignal[] {
        const signals: MacroSignal[] = [];

        for (const event of events) {
            if (event.phase === 'detected' || event.phase === 'resolved') continue;

            const conf = Math.min(event.confidence, 0.95);
            const chain = event.causal_chain;

            if (event.phase === 'developing') {
                // Bearish: block buys on tickers hurt by this event
                if (chain.immediate.bearish_tickers.length > 0) {
                    signals.push({
                        event: event.event_id,
                        impact: 'bearish',
                        sectors: [],
                        tickers: chain.immediate.bearish_tickers,
                        confidence: conf,
                        reasoning: `[${event.event_id}] developing — ${chain.immediate.reasoning}`,
                    });
                }
                // Bullish: boost buy confidence on tickers that benefit
                if (chain.immediate.bullish_tickers.length > 0) {
                    signals.push({
                        event: event.event_id,
                        impact: 'bullish',
                        sectors: [],
                        tickers: chain.immediate.bullish_tickers,
                        confidence: conf,
                        reasoning: `[${event.event_id}] developing — ${chain.immediate.reasoning}`,
                    });
                }
            } else if (event.phase === 'resolving') {
                // Only emit recovery watch after watchAfterDays
                const daysSince = (Date.now() - new Date(event.detectedAt).getTime()) / 86_400_000;
                if (daysSince >= chain.secondary.watch_after_days && chain.secondary.recovery_watch_tickers.length > 0) {
                    signals.push({
                        event: event.event_id,
                        impact: 'neutral',
                        sectors: [],
                        tickers: chain.secondary.recovery_watch_tickers,
                        confidence: conf * 0.8, // recovery signals get lower boost
                        reasoning: `[${event.event_id}] resolving — watch for recovery: ${chain.secondary.reasoning}`,
                    });
                }
            }
        }

        return signals;
    }
}
