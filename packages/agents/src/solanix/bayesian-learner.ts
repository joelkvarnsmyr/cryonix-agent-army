/**
 * Bayesian Self-Learning Module for Solanix
 *
 * Uses Beta-Binomial conjugate priors to learn signal quality from trade history.
 * The Beta distribution is the natural prior for Bernoulli trials (win/loss):
 *
 *   Prior:     Beta(α₀, β₀)           — weak belief, ~50% win rate
 *   Posterior: Beta(α₀ + wins, β₀ + losses)
 *   E[win_rate] = (α₀ + wins) / (α₀ + β₀ + wins + losses)
 *
 * As data grows, the posterior converges on the true win rate.
 * With few trades, the prior dominates (safe default).
 *
 * Buckets learned:
 *   - Per symbol           → which tokens actually profit?
 *   - Per confidence band  → is 0.5 confidence really 50% WR?
 *   - Per hour-of-day      → when do signals work best?
 *   - Per signal source    → TA vs DexScreener breakout
 */

import pg from 'pg';

const { Pool } = pg;

// Weak prior: 2 wins, 2 losses → E[WR] = 0.5, low conviction
const ALPHA_0 = 2;
const BETA_0 = 2;

const REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

interface BetaPosterior {
    alpha: number;
    beta: number;
    wins: number;
    losses: number;
    expectedWinRate: number;
    sampleSize: number;
    /** Cumulative P&L in dollars — better metric than win/loss count */
    totalPnl: number;
    /** Average P&L per trade (dollar-weighted, not just win/loss) */
    avgPnl: number;
}

interface SignalFeatures {
    symbol: string;
    source: 'ta' | 'dexscreener' | 'breakout';
    confidence: number;
    h1Change?: number;
    h6Change?: number;
    volumeRatio?: number;
    buyPressure?: number;
    hourUtc: number;
}

export class BayesianLearner {
    private pool: pg.Pool | null = null;
    private lastRefresh = 0;

    // Posteriors per bucket
    private symbolPosteriors = new Map<string, BetaPosterior>();
    private confidenceBandPosteriors = new Map<string, BetaPosterior>();
    private hourPosteriors = new Map<number, BetaPosterior>();
    private sourcePosteriors = new Map<string, BetaPosterior>();
    private globalPosterior: BetaPosterior = makePrior();

    async connect(postgresUrl?: string): Promise<boolean> {
        const url = postgresUrl || process.env.POSTGRES_URL;
        if (!url) return false;
        try {
            this.pool = new Pool({ connectionString: url, max: 1 });
            await this.pool.query('SELECT 1');
            await this.refresh();
            return true;
        } catch {
            this.pool = null;
            return false;
        }
    }

    /**
     * Adjust raw signal confidence using learned posteriors.
     * Returns a Bayesian-weighted confidence that reflects historical outcomes.
     *
     * Formula: weighted average of raw confidence and empirical posteriors,
     * where weight shifts toward posteriors as sample size grows.
     */
    adjustConfidence(rawConfidence: number, features: SignalFeatures): {
        adjusted: number;
        factors: string[];
    } {
        const factors: string[] = [];
        let adjustment = 0;
        let adjustmentCount = 0;

        // 1. Symbol posterior — uses avgPnl as primary signal (not just WR)
        //    A token with 60% WR but -$0.50 avgPnl is bad; +$2 avgPnl is good.
        //    Hard block: 0% WR after 3+ trades → reject entirely.
        const symPost = this.symbolPosteriors.get(features.symbol);
        if (symPost && symPost.sampleSize >= 3 && symPost.wins === 0) {
            return {
                adjusted: 0,
                factors: [`${features.symbol} 0% WR after ${symPost.sampleSize} trades → BLOCKED`],
            };
        }
        if (symPost && symPost.sampleSize >= 3) {
            // Normalize avgPnl: $2 avg → +0.10 boost, -$2 avg → -0.10 penalty
            const pnlSignal = Math.max(-0.15, Math.min(0.15, symPost.avgPnl * 0.05));
            const symDelta = pnlSignal * credibilityWeight(symPost.sampleSize);
            adjustment += symDelta;
            adjustmentCount++;
            if (Math.abs(symDelta) > 0.02) {
                factors.push(`${features.symbol} avgPnl=$${symPost.avgPnl.toFixed(2)} WR=${(symPost.expectedWinRate * 100).toFixed(0)}% (n=${symPost.sampleSize}) → ${symDelta > 0 ? '+' : ''}${(symDelta * 100).toFixed(1)}%`);
            }
        }

        // 2. Confidence band posterior (calibration)
        const band = confidenceBand(rawConfidence);
        const bandPost = this.confidenceBandPosteriors.get(band);
        if (bandPost && bandPost.sampleSize >= 5) {
            const calibratedWR = bandPost.expectedWinRate;
            const calibrationDelta = (calibratedWR - rawConfidence) * credibilityWeight(bandPost.sampleSize) * 0.5;
            adjustment += calibrationDelta;
            adjustmentCount++;
            if (Math.abs(calibrationDelta) > 0.02) {
                factors.push(`band ${band}: actual WR=${(calibratedWR * 100).toFixed(0)}% → ${calibrationDelta > 0 ? '+' : ''}${(calibrationDelta * 100).toFixed(1)}%`);
            }
        }

        // 3. Hour-of-day posterior
        const hourPost = this.hourPosteriors.get(features.hourUtc);
        if (hourPost && hourPost.sampleSize >= 3) {
            const hourDelta = (hourPost.expectedWinRate - 0.5) * credibilityWeight(hourPost.sampleSize) * 0.3;
            adjustment += hourDelta;
            adjustmentCount++;
            if (Math.abs(hourDelta) > 0.02) {
                factors.push(`hour ${features.hourUtc}:00 WR=${(hourPost.expectedWinRate * 100).toFixed(0)}% → ${hourDelta > 0 ? '+' : ''}${(hourDelta * 100).toFixed(1)}%`);
            }
        }

        // 4. Source posterior
        const srcPost = this.sourcePosteriors.get(features.source);
        if (srcPost && srcPost.sampleSize >= 5) {
            const srcDelta = (srcPost.expectedWinRate - 0.5) * credibilityWeight(srcPost.sampleSize) * 0.3;
            adjustment += srcDelta;
            adjustmentCount++;
            if (Math.abs(srcDelta) > 0.02) {
                factors.push(`source ${features.source} WR=${(srcPost.expectedWinRate * 100).toFixed(0)}% → ${srcDelta > 0 ? '+' : ''}${(srcDelta * 100).toFixed(1)}%`);
            }
        }

        // Clamp adjustment and apply
        const clampedAdj = Math.max(-0.20, Math.min(0.20, adjustment));
        const adjusted = Math.max(0, Math.min(1, rawConfidence + clampedAdj));

        if (factors.length === 0 && this.globalPosterior.sampleSize < 5) {
            factors.push('insufficient data — using raw confidence');
        }

        return { adjusted, factors };
    }

    /** Refresh posteriors from trade history */
    async refresh(): Promise<void> {
        if (!this.pool) return;

        try {
            // Get all closed position pairs (BUY that has a matching SELL)
            // Exclude rotations — they don't reflect signal quality,
            // just that a better opportunity appeared.
            const { rows } = await this.pool.query(`
                SELECT
                    p.symbol,
                    p.confidence::float AS confidence,
                    p.pnl::float AS pnl,
                    p.pnl_percent::float AS pnl_pct,
                    p.close_reason,
                    p.metadata,
                    EXTRACT(HOUR FROM p.opened_at) AS hour_utc
                FROM solanix_positions p
                WHERE p.status = 'CLOSED'
                  AND p.close_reason != 'rotation'
                ORDER BY p.closed_at
            `);

            // Reset posteriors
            this.symbolPosteriors.clear();
            this.confidenceBandPosteriors.clear();
            this.hourPosteriors.clear();
            this.sourcePosteriors.clear();
            this.globalPosterior = makePrior();

            for (const row of rows) {
                const pnl = row.pnl ?? 0;
                const win = pnl > 0;
                const symbol = row.symbol;
                const conf = row.confidence ?? 0.5;
                const hour = Math.floor(row.hour_utc ?? 0);
                const source = (row.metadata as any)?.source ?? 'ta';
                const band = confidenceBand(conf);

                // Update all buckets with P&L-aware posteriors
                updatePosterior(this.globalPosterior, win, pnl);
                updatePosterior(getOrCreate(this.symbolPosteriors, symbol), win, pnl);
                updatePosterior(getOrCreate(this.confidenceBandPosteriors, band), win, pnl);
                updatePosterior(getOrCreateNum(this.hourPosteriors, hour), win, pnl);
                updatePosterior(getOrCreate(this.sourcePosteriors, source), win, pnl);
            }

            this.lastRefresh = Date.now();

            if (rows.length > 0) {
                console.log(
                    `[bayes] Refreshed from ${rows.length} closed trades — ` +
                    `global WR=${(this.globalPosterior.expectedWinRate * 100).toFixed(1)}% ` +
                    `(${this.globalPosterior.wins}W/${this.globalPosterior.losses}L)`
                );
            }
        } catch (err: any) {
            console.error('[bayes] refresh error:', err.message);
        }
    }

    /** Auto-refresh if stale */
    async maybeRefresh(): Promise<void> {
        if (Date.now() - this.lastRefresh >= REFRESH_INTERVAL_MS) {
            await this.refresh();
        }
    }

    /** Get summary of all learned posteriors (for logging/debugging) */
    getSummary(): string {
        const lines: string[] = [];
        lines.push(`Global: WR=${(this.globalPosterior.expectedWinRate * 100).toFixed(1)}% (n=${this.globalPosterior.sampleSize})`);

        for (const [sym, p] of this.symbolPosteriors) {
            if (p.sampleSize >= 2) {
                lines.push(`  ${sym}: ${(p.expectedWinRate * 100).toFixed(0)}% (${p.wins}W/${p.losses}L) avgPnl=$${p.avgPnl.toFixed(2)}`);
            }
        }
        return lines.join('\n');
    }

    async disconnect(): Promise<void> {
        await this.pool?.end();
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makePrior(): BetaPosterior {
    return {
        alpha: ALPHA_0,
        beta: BETA_0,
        wins: 0,
        losses: 0,
        expectedWinRate: ALPHA_0 / (ALPHA_0 + BETA_0),
        sampleSize: 0,
        totalPnl: 0,
        avgPnl: 0,
    };
}

function updatePosterior(p: BetaPosterior, win: boolean, pnlDollar: number): void {
    if (win) {
        p.alpha++;
        p.wins++;
    } else {
        p.beta++;
        p.losses++;
    }
    p.sampleSize++;
    p.totalPnl += pnlDollar;
    p.avgPnl = p.totalPnl / p.sampleSize;
    p.expectedWinRate = p.alpha / (p.alpha + p.beta);
}

function getOrCreate(map: Map<string, BetaPosterior>, key: string): BetaPosterior {
    let p = map.get(key);
    if (!p) {
        p = makePrior();
        map.set(key, p);
    }
    return p;
}

function getOrCreateNum(map: Map<number, BetaPosterior>, key: number): BetaPosterior {
    let p = map.get(key);
    if (!p) {
        p = makePrior();
        map.set(key, p);
    }
    return p;
}

/**
 * Credibility weight: how much to trust the posterior vs the prior.
 * Grows from 0 → 1 as sample size increases.
 * At n=5: ~0.33, at n=10: ~0.50, at n=30: ~0.75, at n=100: ~0.91
 */
function credibilityWeight(n: number): number {
    return n / (n + 10);
}

/**
 * Bucket confidence into bands for calibration analysis.
 * E.g., 0.35 → "0.30-0.40"
 */
function confidenceBand(conf: number): string {
    const lower = Math.floor(conf * 10) / 10;
    const upper = lower + 0.1;
    return `${lower.toFixed(1)}-${upper.toFixed(1)}`;
}
