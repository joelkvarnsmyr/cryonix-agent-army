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
 * Categories tracked:
 *   - type:       arb | directional
 *   - asset:      BTC | ETH | SOL | MACRO | CRYPTO
 *   - edge_bucket: low (2-5%) | medium (5-15%) | high (15%+)
 *   - side:       YES | NO | BOTH
 *   - expiry:     short (<7d) | medium (7-30d) | long (30d+)
 *
 * Persisted to Postgres table `polynix_priors` (survives restarts).
 */

import { Client as PgClient } from 'pg';

const TABLE = 'polynix_priors';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BetaParams {
    alpha: number;  // wins + prior_alpha
    beta: number;   // losses + prior_beta
}

export interface CategoryPrior extends BetaParams {
    category: string;
    key: string;
    observations: number;
    winRate: number;       // posterior mean: alpha / (alpha + beta)
    confidence: number;    // how "sure" we are (0-1), based on observation count
}

export interface TradeFeatures {
    type: 'arb' | 'directional';
    asset: string;
    side: 'YES' | 'NO' | 'BOTH';
    edge: number;           // 0-1
    timeToExpirySec: number;
    won: boolean;
}

export interface BayesianAdjustment {
    /** Multiplicative adjustment to apply to confidence (e.g., 0.8 = 20% penalty) */
    factor: number;
    /** Human-readable reasons for the adjustment */
    reasons: string[];
    /** Posterior win rates for each relevant category */
    posteriors: Record<string, number>;
    /** Should we skip this trade entirely? */
    veto: boolean;
}

// ---------------------------------------------------------------------------
// Learner
// ---------------------------------------------------------------------------

export class BayesianLearner {
    private priors: Map<string, BetaParams> = new Map();
    private pg: PgClient | null = null;

    // Uninformative prior: Beta(1, 1) = uniform
    // Slightly informative for arb: Beta(5, 1) = expect ~83% win rate
    private readonly DEFAULT_PRIOR: BetaParams = { alpha: 1, beta: 1 };
    private readonly ARB_PRIOR: BetaParams = { alpha: 5, beta: 1 };

    // Minimum observations before we trust the posterior enough to act on it
    private readonly MIN_OBS_FOR_PENALTY = 3;
    private readonly MIN_OBS_FOR_VETO = 8;

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
     * Record a trade outcome and update all relevant category priors.
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
     * Get a Bayesian adjustment for a proposed trade.
     * Returns a factor (0-1.5) to multiply the confidence by,
     * and optionally a veto if the category has very poor track record.
     */
    evaluate(
        type: 'arb' | 'directional',
        asset: string,
        side: 'YES' | 'NO' | 'BOTH',
        edge: number,
        timeToExpirySec: number,
    ): BayesianAdjustment {
        const categories = this.featuresToCategories({
            type, asset, side, edge, timeToExpirySec, won: false, // won doesn't matter for evaluation
        });

        const reasons: string[] = [];
        const posteriors: Record<string, number> = {};
        let factorProduct = 1.0;
        let veto = false;

        for (const cat of categories) {
            const prior = this.getPrior(cat);
            const observations = (prior.alpha - 1) + (prior.beta - 1); // subtract initial prior
            const winRate = prior.alpha / (prior.alpha + prior.beta);
            posteriors[cat] = winRate;

            if (observations < this.MIN_OBS_FOR_PENALTY) continue;

            // Category-specific adjustment
            const catType = cat.split(':')[0];

            if (catType === 'type' && cat.includes('directional')) {
                // Directional: penalize if win rate < 40%, boost if > 65%
                if (winRate < 0.30 && observations >= this.MIN_OBS_FOR_VETO) {
                    veto = true;
                    reasons.push(`Veto: ${cat} win rate ${(winRate * 100).toFixed(0)}% (${observations} obs)`);
                } else if (winRate < 0.40) {
                    const penalty = 0.6 + (winRate / 0.40) * 0.4; // 0.6-1.0
                    factorProduct *= penalty;
                    reasons.push(`${cat}: WR ${(winRate * 100).toFixed(0)}% → ${(penalty * 100).toFixed(0)}% factor`);
                } else if (winRate > 0.65) {
                    const boost = 1.0 + ((winRate - 0.65) / 0.35) * 0.3; // 1.0-1.3
                    factorProduct *= boost;
                    reasons.push(`${cat}: WR ${(winRate * 100).toFixed(0)}% → ${(boost * 100).toFixed(0)}% boost`);
                }
            }

            if (catType === 'asset') {
                // Asset-specific: penalize poorly performing assets
                if (winRate < 0.35 && observations >= this.MIN_OBS_FOR_PENALTY) {
                    const penalty = 0.7 + (winRate / 0.35) * 0.3;
                    factorProduct *= penalty;
                    reasons.push(`${cat}: WR ${(winRate * 100).toFixed(0)}% → ${(penalty * 100).toFixed(0)}% factor`);
                }
            }

            if (catType === 'edge') {
                // Edge bucket: if low-edge trades consistently lose, penalize
                if (winRate < 0.40 && observations >= this.MIN_OBS_FOR_PENALTY) {
                    const penalty = 0.7 + (winRate / 0.40) * 0.3;
                    factorProduct *= penalty;
                    reasons.push(`${cat}: WR ${(winRate * 100).toFixed(0)}% → ${(penalty * 100).toFixed(0)}% factor`);
                }
            }

            if (catType === 'side') {
                // Side: if YES or NO consistently loses
                if (winRate < 0.30 && observations >= this.MIN_OBS_FOR_VETO) {
                    veto = true;
                    reasons.push(`Veto: ${cat} win rate ${(winRate * 100).toFixed(0)}% (${observations} obs)`);
                }
            }
        }

        // Clamp factor
        factorProduct = Math.max(0.3, Math.min(1.5, factorProduct));

        return { factor: factorProduct, reasons, posteriors, veto };
    }

    /**
     * Get a summary of all learned priors (for dashboard/logging).
     */
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
                confidence: Math.min(1, observations / 20), // 20 obs = full confidence
            });
        }
        return result.sort((a, b) => b.observations - a.observations);
    }

    // -------------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------------

    private featuresToCategories(f: TradeFeatures): string[] {
        const cats: string[] = [];

        // Type
        cats.push(`type:${f.type}`);

        // Asset
        cats.push(`asset:${f.asset.toLowerCase()}`);

        // Side
        cats.push(`side:${f.side}`);

        // Edge bucket
        const edgePct = f.edge * 100;
        if (edgePct < 5) cats.push('edge:low');
        else if (edgePct < 15) cats.push('edge:medium');
        else cats.push('edge:high');

        // Expiry bucket
        const days = f.timeToExpirySec / 86400;
        if (days < 7) cats.push('expiry:short');
        else if (days < 30) cats.push('expiry:medium');
        else cats.push('expiry:long');

        // Combo: type + asset
        cats.push(`combo:${f.type}_${f.asset.toLowerCase()}`);

        return cats;
    }

    private getPrior(category: string): BetaParams {
        if (this.priors.has(category)) {
            return { ...this.priors.get(category)! };
        }
        // Informative prior for arb (expected to win most of the time)
        if (category.includes('arb')) return { ...this.ARB_PRIOR };
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
