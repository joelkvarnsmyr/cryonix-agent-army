/**
 * Polynix Bayesian Learner — improves with every trade.
 *
 * Uses Beta-Binomial conjugate priors to track win probability per category.
 * After each settled trade, the posterior is updated via Bayes' theorem:
 *
 *   Prior:     Beta(α, β)
 *   Win:       Beta(α + 1, β)
 *   Loss:      Beta(α, β + 1)
 *   Posterior:  E[p] = α / (α + β)
 *
 * Design decisions (from audit):
 *   - Arb trades are OBSERVATION-ONLY — never penalized or vetoed (arb = risk-free by design)
 *   - Only directional trades get adjustments
 *   - Uses single worst-category factor (no multiplicative stacking)
 *   - High minimum observations (10 penalty, 20 veto) to avoid noise-fitting
 *   - Combo categories removed (too sparse to be useful early on)
 *
 * Persisted to Postgres table `polynix_priors` (survives restarts).
 */

import { Client as PgClient } from 'pg';

const TABLE = 'polynix_priors';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BetaParams {
    alpha: number;
    beta: number;
}

export interface CategoryPrior extends BetaParams {
    category: string;
    key: string;
    observations: number;
    winRate: number;
    confidence: number;
}

export interface TradeFeatures {
    type: 'arb' | 'directional';
    asset: string;
    side: 'YES' | 'NO' | 'BOTH';
    edge: number;           // 0-1 (actual edge from signal)
    timeToExpirySec: number;
    won: boolean;
}

export interface BayesianAdjustment {
    factor: number;
    reasons: string[];
    posteriors: Record<string, number>;
    veto: boolean;
}

// ---------------------------------------------------------------------------
// Learner
// ---------------------------------------------------------------------------

export class BayesianLearner {
    private priors: Map<string, BetaParams> = new Map();
    private pg: PgClient | null = null;

    private readonly DEFAULT_PRIOR: BetaParams = { alpha: 1, beta: 1 };

    // High thresholds — need real data before acting
    private readonly MIN_OBS_FOR_PENALTY = 10;
    private readonly MIN_OBS_FOR_VETO = 20;

    async connect(pgUrl?: string): Promise<void> {
        const url = pgUrl ?? process.env.POSTGRES_URL;
        if (!url) return;
        try {
            this.pg = new PgClient({ connectionString: url });
            await this.pg.connect();
            await this.ensureTable();
            await this.loadPriors();
            console.log(`[bayesian] Loaded ${this.priors.size} category priors from DB.`);
        } catch (err: any) {
            console.warn('[bayesian] Postgres connect failed (non-fatal):', err.message);
            this.pg = null;
        }
    }

    /**
     * Record a trade outcome. Updates all relevant category priors.
     * Both arb and directional outcomes are recorded for observation,
     * but only directional categories are used for trading adjustments.
     */
    async recordOutcome(features: TradeFeatures): Promise<void> {
        const categories = this.featuresToCategories(features);

        for (const cat of categories) {
            const prior = this.getPrior(cat);
            if (features.won) {
                prior.alpha += 1;
            } else {
                prior.beta += 1;
            }
            this.priors.set(cat, prior);
            await this.persistPrior(cat, prior);
        }
    }

    /**
     * Get a Bayesian adjustment for a proposed DIRECTIONAL trade.
     * Arb trades always return factor=1.0, veto=false (arb is risk-free by design).
     *
     * Uses single worst-category approach (no multiplicative stacking):
     * - Find the category with the lowest win rate
     * - Apply that single adjustment as the factor
     */
    evaluate(
        type: 'arb' | 'directional',
        asset: string,
        side: 'YES' | 'NO' | 'BOTH',
        edge: number,
        timeToExpirySec: number,
    ): BayesianAdjustment {
        // Arb: never adjust — risk-free by design
        if (type === 'arb') {
            return { factor: 1.0, reasons: [], posteriors: {}, veto: false };
        }

        const categories = this.featuresToCategories({
            type, asset, side, edge, timeToExpirySec, won: false,
        });

        const reasons: string[] = [];
        const posteriors: Record<string, number> = {};
        let worstFactor = 1.0;
        let worstCat = '';
        let veto = false;

        for (const cat of categories) {
            const prior = this.getPrior(cat);
            const observations = (prior.alpha - 1) + (prior.beta - 1);
            const winRate = prior.alpha / (prior.alpha + prior.beta);
            posteriors[cat] = winRate;

            if (observations < this.MIN_OBS_FOR_PENALTY) continue;

            // Veto: consistent loser with enough data
            if (winRate < 0.25 && observations >= this.MIN_OBS_FOR_VETO) {
                veto = true;
                reasons.push(`Veto: ${cat} WR ${(winRate * 100).toFixed(0)}% (n=${observations})`);
                continue;
            }

            // Penalty: WR below 40% → factor 0.5-1.0
            // Boost: WR above 60% → factor 1.0-1.3
            let factor = 1.0;
            if (winRate < 0.40) {
                factor = 0.5 + (winRate / 0.40) * 0.5; // 0.5 at WR=0%, 1.0 at WR=40%
                reasons.push(`${cat}: WR ${(winRate * 100).toFixed(0)}% → ${(factor * 100).toFixed(0)}%`);
            } else if (winRate > 0.60 && observations >= this.MIN_OBS_FOR_PENALTY) {
                factor = 1.0 + ((winRate - 0.60) / 0.40) * 0.3; // 1.0 at WR=60%, 1.3 at WR=100%
                reasons.push(`${cat}: WR ${(winRate * 100).toFixed(0)}% → +${((factor - 1) * 100).toFixed(0)}% boost`);
            }

            // Track worst (most conservative) single factor
            if (factor < worstFactor) {
                worstFactor = factor;
                worstCat = cat;
            }
            // Track best boost separately
            if (factor > 1.0 && worstFactor >= 1.0) {
                worstFactor = factor; // Apply boost only if no penalties
            }
        }

        // Clamp: floor 0.5, ceiling 1.3
        worstFactor = Math.max(0.5, Math.min(1.3, worstFactor));

        return { factor: worstFactor, reasons, posteriors, veto };
    }

    getSummary(): CategoryPrior[] {
        const result: CategoryPrior[] = [];
        for (const [key, params] of this.priors) {
            const parts = key.split(':');
            const observations = (params.alpha - 1) + (params.beta - 1);
            result.push({
                category: parts[0],
                key,
                alpha: params.alpha,
                beta: params.beta,
                observations,
                winRate: params.alpha / (params.alpha + params.beta),
                confidence: Math.min(1, observations / 30),
            });
        }
        return result.sort((a, b) => b.observations - a.observations);
    }

    // -------------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------------

    private featuresToCategories(f: TradeFeatures): string[] {
        const cats: string[] = [];

        cats.push(`type:${f.type}`);
        cats.push(`asset:${f.asset.toLowerCase()}`);
        cats.push(`side:${f.side}`);

        // Edge bucket (using actual edge value)
        const edgePct = f.edge * 100;
        if (edgePct < 5) cats.push('edge:low');
        else if (edgePct < 15) cats.push('edge:medium');
        else cats.push('edge:high');

        // Expiry bucket
        const days = f.timeToExpirySec / 86400;
        if (days < 7) cats.push('expiry:short');
        else if (days < 30) cats.push('expiry:medium');
        else cats.push('expiry:long');

        // No combo categories — too sparse with limited data

        return cats;
    }

    private getPrior(category: string): BetaParams {
        if (this.priors.has(category)) {
            return { ...this.priors.get(category)! };
        }
        return { ...this.DEFAULT_PRIOR };
    }

    private async ensureTable(): Promise<void> {
        if (!this.pg) return;
        await this.pg.query(`
            CREATE TABLE IF NOT EXISTS ${TABLE} (
                category TEXT PRIMARY KEY,
                alpha DOUBLE PRECISION NOT NULL DEFAULT 1,
                beta DOUBLE PRECISION NOT NULL DEFAULT 1,
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
    }

    private async loadPriors(): Promise<void> {
        if (!this.pg) return;
        const res = await this.pg.query(`SELECT category, alpha, beta FROM ${TABLE}`);
        for (const row of res.rows) {
            this.priors.set(row.category, {
                alpha: parseFloat(row.alpha),
                beta: parseFloat(row.beta),
            });
        }
    }

    private async persistPrior(category: string, params: BetaParams): Promise<void> {
        if (!this.pg) return;
        try {
            await this.pg.query(
                `INSERT INTO ${TABLE} (category, alpha, beta, updated_at)
                 VALUES ($1, $2, $3, NOW())
                 ON CONFLICT (category) DO UPDATE SET alpha = $2, beta = $3, updated_at = NOW()`,
                [category, params.alpha, params.beta],
            );
        } catch (err: any) {
            console.warn('[bayesian] persistPrior error:', err.message);
        }
    }

    async disconnect(): Promise<void> {
        try { await this.pg?.end(); } catch { /* ignore */ }
    }
}
