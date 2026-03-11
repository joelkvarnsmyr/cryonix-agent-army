import type { SolanaPosition } from './types';

/**
 * Smart Position Rotation for Solanix.
 *
 * When all position slots are full and a strong new signal arrives,
 * the rotation engine scores open positions vs the incoming signal.
 * If the signal clearly outscores the weakest position, it recommends
 * closing that position to make room.
 *
 * Ported from Cryonix auto-trade route (ADR-027), adapted for Solana DEX.
 */

export interface RotationConfig {
    enabled: boolean;
    /** Signal must beat weakest position by at least this many points */
    min_score_advantage: number;
    /** Don't rotate positions held less than this (minutes) */
    min_hold_minutes: number;
}

export const ROTATION_DEFAULTS: RotationConfig = {
    enabled: true,
    min_score_advantage: 15,
    min_hold_minutes: 30,
};

export interface RotationDecision {
    shouldRotate: boolean;
    victim?: SolanaPosition;
    reason: string;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Score an open position (0–80 range).
 * Higher = stronger position that should be kept.
 */
export function scorePosition(pos: SolanaPosition): number {
    let score = 0;
    const positionCost = pos.avgEntryPrice * pos.qty;
    const pnlPct = positionCost > 0 ? (pos.unrealizedPl / positionCost) * 100 : 0;
    const ageHours = (Date.now() - pos.entryTime) / 3_600_000;
    const hwmDistance = pos.highWatermark > 0
        ? (pos.currentPrice - pos.highWatermark) / pos.highWatermark
        : 0;

    // P&L component (0–40 pts)
    if (pnlPct > 5) score += 40;
    else if (pnlPct > 2) score += 30;
    else if (pnlPct > 0) score += 20;
    else if (pnlPct > -2) score += 10;
    else if (pnlPct > -5) score += 5;
    // heavy losers: 0

    // Momentum component (-15 to +15 pts): distance from high water mark
    if (hwmDistance > -0.01) score += 15;       // Near/at HWM — strong
    else if (hwmDistance > -0.03) score += 5;   // Slight pullback
    else if (hwmDistance > -0.05) score -= 5;   // Fading
    else score -= 15;                            // Well below HWM — weak

    // Age component (-15 to +15 pts): fresh positions get benefit of doubt
    if (ageHours < 0.5) score += 15;            // Just opened — don't rotate
    else if (ageHours < 2) score += 5;          // Still fresh
    else if (ageHours < 6) score += 0;          // Neutral
    else if (ageHours < 24) score -= 5;         // Getting stale
    else score -= 15;                            // Very old — likely stagnant

    return score;
}

/**
 * Score an incoming signal (0–55 range).
 * Higher = stronger opportunity worth making room for.
 */
export function scoreSignal(confidence: number, reasoning: string): number {
    let score = 0;

    // Confidence component (0–45 pts)
    score += Math.round(Math.min(1, confidence) * 45);

    // Source quality bonus
    const lower = reasoning.toLowerCase();
    if (lower.includes('volume spike')) score += 5;
    if (lower.includes('oversold')) score += 5;
    if (lower.includes('bullish crossover')) score += 3;
    if (lower.includes('below bollinger')) score += 3;

    return score;
}

// ---------------------------------------------------------------------------
// Rotation decision
// ---------------------------------------------------------------------------

export function trySmartRotation(
    signalConfidence: number,
    signalReasoning: string,
    signalSymbol: string,
    openPositions: SolanaPosition[],
    config: RotationConfig = ROTATION_DEFAULTS,
): RotationDecision {
    if (!config.enabled) {
        return { shouldRotate: false, reason: 'rotation disabled' };
    }

    const sigScore = scoreSignal(signalConfidence, signalReasoning);

    // Filter candidates: must be held long enough
    const candidates = openPositions
        .filter(p => {
            const ageMin = (Date.now() - p.entryTime) / 60_000;
            return ageMin >= config.min_hold_minutes;
        })
        .map(p => ({ position: p, score: scorePosition(p) }))
        .sort((a, b) => a.score - b.score);

    if (candidates.length === 0) {
        return { shouldRotate: false, reason: 'no eligible positions to rotate (all too fresh)' };
    }

    const weakest = candidates[0];
    const advantage = sigScore - weakest.score;

    if (advantage >= config.min_score_advantage) {
        return {
            shouldRotate: true,
            victim: weakest.position,
            reason: `${signalSymbol} (${sigScore}pts) beats ${weakest.position.symbol} (${weakest.score}pts) by ${advantage}pts`,
        };
    }

    return {
        shouldRotate: false,
        reason: `advantage ${advantage}pts < required ${config.min_score_advantage}pts`,
    };
}
