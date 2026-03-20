/**
 * APEX Confluence Scorer — direction-aware multi-source scoring.
 *
 * Takes an AggregatorSnapshot and the APEX config, then produces a ranked list
 * of ScoredOpportunity objects (one per symbol × direction pair) that meet the
 * minimum score threshold.
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
// Weight table types
// ---------------------------------------------------------------------------

interface WeightEntry {
    weight: keyof ApexTomlConfig['confluence']['weights'];
    minField?: 'confidence' | 'score';
    minValue?: number;
}

// ---------------------------------------------------------------------------
// Bullish weight table
// ---------------------------------------------------------------------------

const BULLISH_WEIGHTS: Record<string, WeightEntry> = {
    'DEEP_VALUE_CRASH':        { weight: 'cryonix_deep_value',          minField: 'confidence', minValue: 75 },
    'DIP_BUY':                 { weight: 'cryonix_dip_buy',             minField: 'confidence', minValue: 70 },
    'whale_buy':               { weight: 'copynix_single_whale',        minField: 'score',      minValue: 80 },
    'sentiment_shift_bullish': { weight: 'polymarket_sentiment_shift' },
    'extreme_fear':            { weight: 'cmc_extreme_fear' },
    'phase_convergence':       { weight: 'psinix_coherence' },
    'psinix_online':           { weight: 'psinix_coherence' },
    'volume_spike':            { weight: 'solanix_volume_spike' },
    'dex_momentum':            { weight: 'solanix_volume_spike' },
    'macro_bullish':           { weight: 'aktienix_macro_bullish' },
    'btc_dom':                 { weight: 'cmc_btc_dom_falling' }, // only added when signal.direction === 'bullish'
};

// ---------------------------------------------------------------------------
// Bearish weight table
// ---------------------------------------------------------------------------

const BEARISH_WEIGHTS: Record<string, WeightEntry> = {
    'venus_rx':                { weight: 'vedic_venus_rx' },
    'mercury_rx':              { weight: 'vedic_venus_rx' }, // lower config weight; reuses key
    'RSI_OVERBOUGHT':          { weight: 'cryonix_rsi_overbought',      minField: 'confidence', minValue: 70 },
    'MACD_BEARISH_CROSS':      { weight: 'cryonix_macd_bearish',        minField: 'confidence', minValue: 65 },
    'sentiment_shift_bearish': { weight: 'polymarket_sentiment_falling' },
    'multi_retrograde':        { weight: 'cmc_fear_greed_dropping' },
    'btc_dom':                 { weight: 'cmc_btc_dom_rising' }, // only added when signal.direction === 'bearish'
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when a signal meets the minimum field threshold defined
 * in its weight entry (e.g. confidence >= 75 or score >= 80).
 */
function meetsThreshold(signal: NormalizedSignal, entry: WeightEntry): boolean {
    if (!entry.minField || entry.minValue === undefined) return true;
    const actual = signal[entry.minField] as number;
    return actual >= entry.minValue;
}

/**
 * Determine mode from the final contributing signals and direction.
 * Priority: venus_rx > dip_sniper > confluence
 */
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

/**
 * Score all symbols present in the snapshot and return sorted opportunities
 * with score >= config.confluence.min_score_half_kelly.
 */
export function scoreOpportunities(
    snapshot: AggregatorSnapshot,
    config: ApexTomlConfig,
): ScoredOpportunity[] {
    const { signals } = snapshot;
    const weights = config.confluence.weights;
    const thresholds = config.confluence.thresholds;
    const windowMs = thresholds.confluence_window_seconds * 1000;
    const minScore = config.confluence.min_score_half_kelly;
    const cutoff = snapshot.timestamp - windowMs;

    // ── Filter signals by confluence window ──────────────────────────────────
    const fresh = signals.filter(s => s.timestamp > cutoff);

    // ── Collect all per-symbol signals (MARKET signals apply to every symbol) ─
    const marketSignals = fresh.filter(s => s.symbol === 'MARKET' || s.symbol === 'CRYPTO');

    // Gather all distinct non-market symbols
    const symbolSet = new Set<string>();
    for (const s of fresh) {
        if (s.symbol !== 'MARKET' && s.symbol !== 'CRYPTO') {
            symbolSet.add(s.symbol);
        }
    }

    const opportunities: ScoredOpportunity[] = [];

    for (const symbol of symbolSet) {
        const symbolSignals = fresh.filter(s => s.symbol === symbol);
        // Combine symbol-specific signals with global market-context signals
        const combined = [...symbolSignals, ...marketSignals];

        // ── Compute bullish score ───────────────────────────────────────────
        let bullishScore = 0;
        const bullishContributors: NormalizedSignal[] = [];

        for (const sig of combined) {
            if (sig.direction !== 'bullish') continue;
            const entry = BULLISH_WEIGHTS[sig.signalType];
            if (!entry) continue;
            if (!meetsThreshold(sig, entry)) continue;
            bullishScore += weights[entry.weight];
            bullishContributors.push(sig);
        }

        // ── Compute bearish score ───────────────────────────────────────────
        let bearishScore = 0;
        const bearishContributors: NormalizedSignal[] = [];

        for (const sig of combined) {
            if (sig.direction !== 'bearish') continue;
            const entry = BEARISH_WEIGHTS[sig.signalType];
            if (!entry) continue;
            if (!meetsThreshold(sig, entry)) continue;
            bearishScore += weights[entry.weight];
            bearishContributors.push(sig);
        }

        // ── Pick the stronger direction ─────────────────────────────────────
        const direction: SignalDirection = bearishScore >= bullishScore ? 'bearish' : 'bullish';
        const score = direction === 'bearish' ? bearishScore : bullishScore;
        const contributors = direction === 'bearish' ? bearishContributors : bullishContributors;

        if (score < minScore) continue;

        const mode = determineMode(contributors, direction);

        opportunities.push({
            symbol,
            direction,
            score,
            mode,
            contributingSignals: contributors,
            timestamp: snapshot.timestamp,
        });
    }

    // ── Sort by score descending ─────────────────────────────────────────────
    opportunities.sort((a, b) => b.score - a.score);

    return opportunities;
}
