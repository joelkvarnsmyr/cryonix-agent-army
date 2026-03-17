/**
 * Ψ (Psi) — The Phase Convergence Trading Function
 *
 * A novel signal aggregation framework that treats wallet signals as
 * coupled oscillators and detects phase transitions (synchronization)
 * rather than linear averaging.
 *
 * Core insight: When enough independent signals synchronize, a qualitative
 * phase transition occurs — like water freezing at 0°C. Linear models miss
 * this threshold phenomenon entirely.
 *
 * Three disciplines combined for the first time:
 *   1. Kuramoto order parameter (synchronization physics, 1975)
 *   2. Shannon entropy (information theory → adaptive temperature)
 *   3. Kelly criterion + Bayesian posteriors (position sizing)
 *
 * Ψ(t) = tanh(β(t) · C(t) · Σᵢ wᵢ(t)·σᵢ(t)) × Kelly(t) × C(t)²
 *
 * Output ∈ (-1, +1) × position% — negative = short signal, positive = long
 */

// ── Types ────────────────────────────────────────────────────────────

export interface PsiSignal {
    sourceId: string;         // wallet address or signal source
    direction: number;        // σᵢ ∈ [-1, +1]: +1=max long, -1=max short
    weight: number;           // wᵢ: Bayesian posterior weight (0-1)
    timestamp: number;        // when this signal was observed
}

export interface PsiResult {
    psi: number;              // Ψ ∈ (-1, +1) — final position signal
    positionPct: number;      // Position size as % of max (0-100)
    coherence: number;        // C(t) — Kuramoto order parameter (0-1)
    entropy: number;          // H(market) — Shannon entropy
    beta: number;             // β(t) = 1/H — inverse temperature
    weightedSignal: number;   // Σ wᵢσᵢ — raw weighted signal sum
    kellyFraction: number;    // Kelly optimal fraction
    phaseTransition: boolean; // true if C > threshold (signals synchronized)
    debug: {
        signalCount: number;
        avgDirection: number;
        phases: number[];     // θᵢ values on unit circle
    };
}

// ── Constants ────────────────────────────────────────────────────────

const PHASE_TRANSITION_THRESHOLD = 0.6; // C above this = signals are synchronized
const MIN_SIGNALS = 2;                   // Need at least 2 signals for coherence
const KELLY_FRACTION_CAP = 0.25;         // Never risk more than 25% Kelly
const ENTROPY_FLOOR = 0.1;              // Prevent division by zero in β

// ── Ψ Engine ─────────────────────────────────────────────────────────

export class PsiEngine {
    /**
     * Compute Ψ(t) from a set of trading signals.
     *
     * @param signals   Array of directional signals with Bayesian weights
     * @param entropy   H(market) — Shannon entropy of recent market state
     * @param winRate   Overall win rate for Kelly calculation (0-1)
     * @param avgWinLossRatio  Average win/loss ratio for Kelly (e.g., 1.5)
     * @returns         PsiResult with position signal and diagnostics
     */
    static compute(
        signals: PsiSignal[],
        entropy: number,
        winRate: number = 0.5,
        avgWinLossRatio: number = 1.0,
    ): PsiResult {
        // Edge case: not enough signals
        if (signals.length < MIN_SIGNALS) {
            return this.neutralResult(signals.length, entropy);
        }

        // ── Step 1: Compute phases θᵢ on unit circle ──
        // Map σᵢ ∈ [-1, +1] → θᵢ ∈ [0, π]
        // +1 (max long) → θ = 0 (east)
        //  0 (neutral)  → θ = π/2 (north)
        // -1 (max short) → θ = π (west)
        // BUY and SELL are π apart = opposite on circle → cancel in Kuramoto.
        const phases = signals.map(s => {
            return ((1 - s.direction) / 2) * Math.PI;
        });

        // ── Step 2: Kuramoto order parameter C(t) ──
        // C = |Σ exp(iθᵢ)| / N
        // Measures synchronization: 1 = all aligned, 0 = uniformly spread
        let realSum = 0;
        let imagSum = 0;
        for (const theta of phases) {
            realSum += Math.cos(theta);
            imagSum += Math.sin(theta);
        }
        const N = signals.length;
        const coherence = Math.sqrt(realSum * realSum + imagSum * imagSum) / N;

        // ── Step 3: Entropy temperature β(t) ──
        // β = 1 / H(market) — low entropy = sharp decisions, high = cautious
        const H = Math.max(entropy, ENTROPY_FLOOR);
        const beta = 1 / H;

        // ── Step 4: Weighted signal sum Σ wᵢσᵢ ──
        let weightedSum = 0;
        let totalWeight = 0;
        for (const s of signals) {
            weightedSum += s.weight * s.direction;
            totalWeight += s.weight;
        }
        // Normalize by total weight
        const normalizedSignal = totalWeight > 0 ? weightedSum / totalWeight : 0;

        // ── Step 5: Phase transition function S(t) ──
        // S = tanh(β · C · Σ wᵢσᵢ)
        // The magic: C multiplies (not adds), so low coherence dampens
        // everything regardless of individual signal strength.
        // tanh creates the S-curve phase transition behavior.
        const rawInput = beta * coherence * weightedSum;
        const S = Math.tanh(rawInput);

        // ── Step 6: Kelly criterion ──
        // f* = (p·b - q) / b where p=WR, q=1-p, b=win/loss ratio
        const p = Math.max(0.01, Math.min(0.99, winRate));
        const q = 1 - p;
        const b = Math.max(0.01, avgWinLossRatio);
        const kellyRaw = (p * b - q) / b;
        const kellyFraction = Math.max(0, Math.min(KELLY_FRACTION_CAP, kellyRaw));

        // ── Step 7: Final Ψ(t) ──
        // Ψ = S × Kelly × C²
        // C² is the key insight: at C=0.5 you only bet 25% of Kelly.
        // At C=0.3, only 9%. Built-in protection against noisy signals.
        const psi = S * kellyFraction * (coherence * coherence);

        // Position size as percentage (0-100)
        const positionPct = Math.abs(psi) * 100;

        const phaseTransition = coherence >= PHASE_TRANSITION_THRESHOLD;

        return {
            psi,
            positionPct,
            coherence,
            entropy: H,
            beta,
            weightedSignal: normalizedSignal,
            kellyFraction,
            phaseTransition,
            debug: {
                signalCount: N,
                avgDirection: signals.reduce((s, sig) => s + sig.direction, 0) / N,
                phases,
            },
        };
    }

    /**
     * Compute Shannon entropy of a market price series.
     *
     * Uses binned return distribution to estimate entropy.
     * Higher entropy = more chaotic/unpredictable market.
     * Lower entropy = more ordered/trending market.
     *
     * @param prices  Recent price series (at least 20 data points)
     * @param bins    Number of bins for return distribution
     */
    static computeMarketEntropy(prices: number[], bins: number = 10): number {
        if (prices.length < 3) return 1.0; // Max uncertainty

        // Calculate returns
        const returns: number[] = [];
        for (let i = 1; i < prices.length; i++) {
            if (prices[i - 1] > 0) {
                returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
            }
        }

        if (returns.length === 0) return 1.0;

        // Bin the returns
        const min = Math.min(...returns);
        const max = Math.max(...returns);
        const range = max - min || 1;
        const binSize = range / bins;

        const histogram = new Array(bins).fill(0);
        for (const r of returns) {
            const binIdx = Math.min(bins - 1, Math.floor((r - min) / binSize));
            histogram[binIdx]++;
        }

        // Shannon entropy: H = -Σ pᵢ log₂(pᵢ)
        const total = returns.length;
        let H = 0;
        for (const count of histogram) {
            if (count > 0) {
                const p = count / total;
                H -= p * Math.log2(p);
            }
        }

        // Normalize to [0, 1] by dividing by max entropy (log₂(bins))
        const maxEntropy = Math.log2(bins);
        return maxEntropy > 0 ? H / maxEntropy : 1.0;
    }

    /**
     * Convert Copynix wallet trades into PsiSignals.
     * Each wallet's recent action becomes a directional signal.
     */
    static walletTradesToSignals(
        trades: Array<{ walletAddress: string; action: 'BUY' | 'SELL' }>,
        walletScores: Map<string, number>,
    ): PsiSignal[] {
        // Aggregate per wallet — most recent action wins
        const latestAction = new Map<string, 'BUY' | 'SELL'>();
        for (const t of trades) {
            latestAction.set(t.walletAddress, t.action);
        }

        return Array.from(latestAction.entries()).map(([wallet, action]) => ({
            sourceId: wallet,
            direction: action === 'BUY' ? 1 : -1,
            weight: Math.max(0.1, (walletScores.get(wallet) ?? 50) / 100),
            timestamp: Date.now(),
        }));
    }

    private static neutralResult(signalCount: number, entropy: number): PsiResult {
        return {
            psi: 0,
            positionPct: 0,
            coherence: 0,
            entropy: Math.max(entropy, ENTROPY_FLOOR),
            beta: 1 / Math.max(entropy, ENTROPY_FLOOR),
            weightedSignal: 0,
            kellyFraction: 0,
            phaseTransition: false,
            debug: { signalCount, avgDirection: 0, phases: [] },
        };
    }
}
