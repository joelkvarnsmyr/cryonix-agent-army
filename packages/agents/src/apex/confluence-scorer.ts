/**
 * APEX Confluence Scorer — direction-aware multi-source scoring with ORAKEL.
 *
 * Takes an AggregatorSnapshot and the APEX config, then produces a ranked list
 * of ScoredOpportunity objects (one per symbol × direction pair) that meet the
 * minimum score threshold.
 *
 * Ambient signals contribute regardless of 5min window.
 * Momentary signals require timestamp > now - staleness.momentary_seconds.
 * ORAKEL vol spike acts as negative score (subtracts from total).
 */

import type { NormalizedSignal, AggregatorSnapshot, SignalDirection } from './signal-aggregator';
import type { ApexTomlConfig } from './config';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ScoredOpportunity {
    symbol: string;
    direction: SignalDirection;
    score: number;
    mode: 'venus_rx' | 'dip_sniper' | 'confluence';
    contributingSignals: NormalizedSignal[];
    timestamp: number;
}

// ---------------------------------------------------------------------------
// Weight mapping: signalType → config weight key + threshold
// ---------------------------------------------------------------------------

interface WeightEntry {
    weight: string;
    minField?: 'confidence' | 'score';
    minValue?: number;
}

const BULLISH_WEIGHTS: Record<string, WeightEntry> = {
    'DEEP_VALUE_CRASH':        { weight: 'cryonix_deep_value',          minField: 'confidence', minValue: 0.75 },
    'DIP_BUY':                 { weight: 'cryonix_dip_buy',             minField: 'confidence', minValue: 0.70 },
    'BOLLINGER_SQUEEZE':       { weight: 'cryonix_bollinger',           minField: 'confidence', minValue: 0.65 },
    'RSI_OVERSOLD':            { weight: 'cryonix_bollinger',           minField: 'confidence', minValue: 0.65 },
    'whale_buy':               { weight: 'copynix_single_whale',        minField: 'score',      minValue: 80 },
    'ecosystem_bullish':       { weight: 'copynix_single_whale',        minField: 'confidence', minValue: 50 },
    'sentiment_shift_bullish': { weight: 'polymarket_sentiment_shift' },
    'extreme_fear':            { weight: 'cmc_extreme_fear' },
    'phase_convergence':       { weight: 'psinix_coherence' },
    'volume_spike':            { weight: 'solanix_volume_spike' },
    'dex_momentum':            { weight: 'solanix_volume_spike' },
    'macro_bullish':           { weight: 'aktienix_macro_bullish' },
    'btc_dom':                 { weight: 'cmc_btc_dom_falling' },
    // ORAKEL bullish
    'orakel_direction_up':     { weight: 'orakel_direction' },
    'orakel_regime_bull':      { weight: 'orakel_regime' },
    'orakel_fused_high':       { weight: 'orakel_fused' },
};

const BEARISH_WEIGHTS: Record<string, WeightEntry> = {
    'venus_rx':                { weight: 'vedic_venus_rx' },
    'mercury_rx':              { weight: 'vedic_venus_rx' },
    'RSI_OVERBOUGHT':          { weight: 'cryonix_rsi_overbought',      minField: 'confidence', minValue: 0.70 },
    'MACD_BEARISH_CROSS':      { weight: 'cryonix_macd_bearish',        minField: 'confidence', minValue: 0.65 },
    'sentiment_shift_bearish': { weight: 'polymarket_sentiment_falling' },
    'multi_retrograde':        { weight: 'cmc_fear_greed_dropping' },
    'btc_dom':                 { weight: 'cmc_btc_dom_rising' },
    // ORAKEL bearish
    'orakel_direction_down':   { weight: 'orakel_direction' },
    'orakel_regime_bear':      { weight: 'orakel_regime' },
};

// Vol spike is a special negative signal — handled separately
const VOL_SPIKE_PENALTY = 20;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function meetsThreshold(signal: NormalizedSignal, entry: WeightEntry): boolean {
    if (!entry.minField || entry.minValue === undefined) return true;
    return (signal[entry.minField] as number) >= entry.minValue;
}

function determineMode(
    signals: NormalizedSignal[],
    direction: SignalDirection,
): 'venus_rx' | 'dip_sniper' | 'confluence' {
    if (direction === 'bearish' && signals.some(s => s.signalType === 'venus_rx')) {
        return 'venus_rx';
    }
    if (signals.some(s => s.signalType === 'DEEP_VALUE_CRASH' || s.signalType === 'DIP_BUY')) {
        return 'dip_sniper';
    }
    return 'confluence';
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function scoreOpportunities(
    snapshot: AggregatorSnapshot,
    config: ApexTomlConfig,
): ScoredOpportunity[] {
    const { signals } = snapshot;
    const weights = config.confluence.weights;
    const momentaryMs = config.staleness.momentary_seconds * 1000;
    const minScore = config.confluence.min_score_half_kelly;
    const momentaryCutoff = snapshot.timestamp - momentaryMs;

    // Filter: ambient signals always pass; momentary signals need to be recent
    const fresh = signals.filter(s =>
        s.temporality === 'ambient' || s.timestamp > momentaryCutoff,
    );

    const marketSignals = fresh.filter(s => s.symbol === 'MARKET' || s.symbol === 'CRYPTO');
    const symbolSet = new Set<string>();
    for (const s of fresh) {
        if (s.symbol !== 'MARKET' && s.symbol !== 'CRYPTO') symbolSet.add(s.symbol);
    }

    const opportunities: ScoredOpportunity[] = [];

    // Check for ORAKEL vol spike (global penalty)
    const hasVolSpike = fresh.some(s => s.signalType === 'orakel_vol_spike');

    for (const symbol of symbolSet) {
        const symbolSignals = fresh.filter(s => s.symbol === symbol);
        const rawCombined = [...symbolSignals, ...marketSignals];

        // Dedup: count each (source, signalType) only once per symbol.
        // Multiple BOLLINGER_SQUEEZE from same Cryonix broadcast window
        // is one signal, not four.
        const seen = new Set<string>();
        const combined = rawCombined.filter(s => {
            const key = `${s.source}:${s.signalType}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        // Dedup: count max 1 signal per source × signalType to prevent
        // inflated scores from repeated scans of the same indicator.
        const seen = new Set<string>();

        // ── Bullish score ──────────────────────────────────────────────
        let bullishScore = 0;
        const bullishContributors: NormalizedSignal[] = [];
        for (const sig of combined) {
            if (sig.direction !== 'bullish') continue;
            const dedupKey = `${sig.source}:${sig.signalType}`;
            if (seen.has(dedupKey)) continue;
            const entry = BULLISH_WEIGHTS[sig.signalType];
            if (!entry) continue;
            if (!meetsThreshold(sig, entry)) continue;
            seen.add(dedupKey);
            const w = weights[entry.weight] ?? 0;
            bullishScore += w;
            bullishContributors.push(sig);
        }

        // ── Bearish score ──────────────────────────────────────────────
        let bearishScore = 0;
        const bearishContributors: NormalizedSignal[] = [];
        for (const sig of combined) {
            if (sig.direction !== 'bearish') continue;
            if (sig.signalType === 'orakel_vol_spike') continue; // handled separately
            const dedupKey = `${sig.source}:${sig.signalType}`;
            if (seen.has(dedupKey)) continue;
            const entry = BEARISH_WEIGHTS[sig.signalType];
            if (!entry) continue;
            if (!meetsThreshold(sig, entry)) continue;
            seen.add(dedupKey);
            const w = weights[entry.weight] ?? 0;
            bearishScore += w;
            bearishContributors.push(sig);
        }

        // Apply vol spike penalty (reduces both directions)
        if (hasVolSpike) {
            bullishScore -= VOL_SPIKE_PENALTY;
            bearishScore -= VOL_SPIKE_PENALTY;
        }

        // ── Pick stronger direction ────────────────────────────────────
        const direction: SignalDirection = bearishScore >= bullishScore ? 'bearish' : 'bullish';
        const score = Math.max(0, direction === 'bearish' ? bearishScore : bullishScore);
        const contributors = direction === 'bearish' ? bearishContributors : bullishContributors;

        if (score < minScore) continue;

        const mode = determineMode(contributors, direction);

        // Mode conflict: Venus Rx active AND bullish wins → skip venus_rx mode
        if (mode === 'venus_rx' && direction === 'bullish') continue;

        opportunities.push({
            symbol, direction, score, mode, contributingSignals: contributors,
            timestamp: snapshot.timestamp,
        });
    }

    opportunities.sort((a, b) => b.score - a.score);
    return opportunities;
}
