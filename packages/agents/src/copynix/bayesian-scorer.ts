/**
 * BayesianScorer — Self-improving wallet scoring using Bayesian inference.
 *
 * Each wallet has a Beta(α, β) prior representing our belief about its
 * win probability. After each completed trade:
 *   - Win:  α += 1 (evidence of skill)
 *   - Loss: β += 1 (evidence of noise/luck)
 *
 * Score = E[Beta(α, β)] = α / (α + β) × 100
 *
 * Beta distribution is the conjugate prior for Bernoulli trials,
 * which makes this mathematically clean: each trade is a Bernoulli
 * trial (win/loss), and the posterior is still a Beta distribution.
 *
 * The system also tracks:
 *   - Per-wallet time-of-day performance (when are they best?)
 *   - Consensus level outcomes (is strong consensus actually better?)
 *   - Token category affinity (memecoins, defi, gaming)
 *   - Automatic promotion/demotion based on posterior score
 *
 * State persisted to Redis for durability across container restarts.
 */

export interface WalletBelief {
    address: string;
    alpha: number;          // wins + prior_alpha
    beta: number;           // losses + prior_beta
    score: number;          // E[Beta] × 100
    confidence: number;     // 0-1, how certain we are (based on sample size)
    totalTrades: number;
    wins: number;
    losses: number;
    totalPnlUsd: number;
    avgPnlPerTrade: number;
    bestHourUtc: number | null;   // hour with highest WR
    lastUpdated: number;
}

export interface ConsensusLevelStats {
    strong: { wins: number; losses: number; totalPnl: number };
    medium: { wins: number; losses: number; totalPnl: number };
    single: { wins: number; losses: number; totalPnl: number };
}

export interface TradeOutcome {
    walletAddresses: string[];
    consensusLevel: 'strong' | 'medium' | 'single';
    pnlUsd: number;
    isWin: boolean;
    tokenSymbol: string;
    hourUtc: number;
}

const REDIS_KEY = 'copynix:bayesian';

// Uninformative prior: Beta(2, 2) = slight belief in 50% win rate
// This means a new wallet needs ~5 trades before the data dominates the prior
const PRIOR_ALPHA = 2;
const PRIOR_BETA = 2;

// Thresholds
const DEMOTION_SCORE = 35;    // Below this → remove from tracking
const PROMOTION_SCORE = 75;   // Above this → single-whale privileges
const MIN_TRADES_FOR_ACTION = 5; // Need at least 5 trades before promote/demote

export interface RedisAdapter {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
}

export class BayesianScorer {
    private beliefs = new Map<string, WalletBelief>();
    private consensusStats: ConsensusLevelStats = {
        strong: { wins: 0, losses: 0, totalPnl: 0 },
        medium: { wins: 0, losses: 0, totalPnl: 0 },
        single: { wins: 0, losses: 0, totalPnl: 0 },
    };
    private hourlyStats = new Map<string, Map<number, { wins: number; losses: number }>>();
    private redis: RedisAdapter | null = null;

    /**
     * Connect to Redis and load persisted state.
     */
    async connect(redisAdapter: RedisAdapter): Promise<void> {
        this.redis = redisAdapter;
        await this.loadState();
    }

    /**
     * Record the outcome of a completed trade (after SELL).
     * Updates wallet beliefs using Bayesian posterior update.
     */
    recordOutcome(outcome: TradeOutcome): void {
        for (const addr of outcome.walletAddresses) {
            let belief = this.beliefs.get(addr);
            if (!belief) {
                belief = this.newBelief(addr);
            }

            // Bayesian update: Beta(α, β) → Beta(α + win, β + loss)
            if (outcome.isWin) {
                belief.alpha += 1;
                belief.wins += 1;
            } else {
                belief.beta += 1;
                belief.losses += 1;
            }

            belief.totalTrades += 1;
            belief.totalPnlUsd += outcome.pnlUsd;
            belief.avgPnlPerTrade = belief.totalPnlUsd / belief.totalTrades;

            // Posterior expectation: E[Beta(α, β)] = α / (α + β)
            belief.score = (belief.alpha / (belief.alpha + belief.beta)) * 100;

            // Confidence: based on effective sample size
            // More trades → higher confidence (asymptotes to 1)
            belief.confidence = 1 - (1 / (1 + belief.totalTrades * 0.2));

            belief.lastUpdated = Date.now();
            this.beliefs.set(addr, belief);

            // Track hourly performance
            this.updateHourlyStats(addr, outcome.hourUtc, outcome.isWin);
            belief.bestHourUtc = this.getBestHour(addr);
        }

        // Update consensus level stats
        const level = this.consensusStats[outcome.consensusLevel];
        if (outcome.isWin) level.wins++;
        else level.losses++;
        level.totalPnl += outcome.pnlUsd;

        // Persist async (non-blocking)
        this.saveState().catch(() => {});
    }

    /**
     * Get current belief about a wallet's quality.
     */
    getBelief(address: string): WalletBelief | null {
        return this.beliefs.get(address) ?? null;
    }

    /**
     * Get all wallet beliefs, sorted by score.
     */
    getAllBeliefs(): WalletBelief[] {
        return Array.from(this.beliefs.values())
            .sort((a, b) => b.score - a.score);
    }

    /**
     * Get the Bayesian-adjusted score for a wallet.
     * Returns the prior score if we have no data yet.
     */
    getScore(address: string): number {
        const belief = this.beliefs.get(address);
        if (!belief) return 50; // Uninformative prior
        return belief.score;
    }

    /**
     * Check if a wallet should be promoted to single-whale status.
     */
    shouldPromote(address: string): boolean {
        const belief = this.beliefs.get(address);
        if (!belief) return false;
        return belief.totalTrades >= MIN_TRADES_FOR_ACTION && belief.score >= PROMOTION_SCORE;
    }

    /**
     * Check if a wallet should be demoted (removed from tracking).
     */
    shouldDemote(address: string): boolean {
        const belief = this.beliefs.get(address);
        if (!belief) return false;
        return belief.totalTrades >= MIN_TRADES_FOR_ACTION && belief.score < DEMOTION_SCORE;
    }

    /**
     * Get wallets that should be removed (score too low after enough trades).
     */
    getWalletsToRemove(): string[] {
        return Array.from(this.beliefs.entries())
            .filter(([_, b]) => b.totalTrades >= MIN_TRADES_FOR_ACTION && b.score < DEMOTION_SCORE)
            .map(([addr]) => addr);
    }

    /**
     * Get wallets that earned single-whale promotion.
     */
    getWalletsToPromote(): string[] {
        return Array.from(this.beliefs.entries())
            .filter(([_, b]) => b.totalTrades >= MIN_TRADES_FOR_ACTION && b.score >= PROMOTION_SCORE)
            .map(([addr]) => addr);
    }

    /**
     * Get consensus level performance stats.
     * Used to dynamically adjust consensus thresholds.
     */
    getConsensusStats(): ConsensusLevelStats & {
        strongWR: number;
        mediumWR: number;
        singleWR: number;
        recommendation: string;
    } {
        const wr = (s: { wins: number; losses: number }) =>
            s.wins + s.losses > 0 ? s.wins / (s.wins + s.losses) : 0;

        const strongWR = wr(this.consensusStats.strong);
        const mediumWR = wr(this.consensusStats.medium);
        const singleWR = wr(this.consensusStats.single);

        let recommendation = 'Keep current thresholds';
        if (singleWR > 0.65 && this.consensusStats.single.wins + this.consensusStats.single.losses >= 10) {
            recommendation = 'Single-whale performing well — consider lowering consensus requirement';
        }
        if (strongWR < 0.4 && this.consensusStats.strong.wins + this.consensusStats.strong.losses >= 5) {
            recommendation = 'Strong consensus underperforming — review tracked wallets';
        }

        return { ...this.consensusStats, strongWR, mediumWR, singleWR, recommendation };
    }

    /**
     * Initialize a belief for a new wallet with uninformative prior.
     */
    initializeWallet(address: string, priorScore?: number): void {
        if (this.beliefs.has(address)) return;

        const belief = this.newBelief(address);

        // If we have external data (e.g., from Dune PnL), adjust the prior
        if (priorScore !== undefined && priorScore > 50) {
            // Convert external score to alpha/beta that reflects the prior belief
            // Higher prior score → more alpha relative to beta
            const strength = 3; // How much to trust the external data (equivalent to 3 trades)
            belief.alpha = PRIOR_ALPHA + strength * (priorScore / 100);
            belief.beta = PRIOR_BETA + strength * (1 - priorScore / 100);
            belief.score = (belief.alpha / (belief.alpha + belief.beta)) * 100;
        }

        this.beliefs.set(address, belief);
    }

    // ── Internal ──────────────────────────────────────────────────

    private newBelief(address: string): WalletBelief {
        return {
            address,
            alpha: PRIOR_ALPHA,
            beta: PRIOR_BETA,
            score: 50, // E[Beta(2,2)] = 0.5
            confidence: 0,
            totalTrades: 0,
            wins: 0,
            losses: 0,
            totalPnlUsd: 0,
            avgPnlPerTrade: 0,
            bestHourUtc: null,
            lastUpdated: Date.now(),
        };
    }

    private updateHourlyStats(address: string, hour: number, isWin: boolean): void {
        let hourMap = this.hourlyStats.get(address);
        if (!hourMap) {
            hourMap = new Map();
            this.hourlyStats.set(address, hourMap);
        }
        const stats = hourMap.get(hour) ?? { wins: 0, losses: 0 };
        if (isWin) stats.wins++;
        else stats.losses++;
        hourMap.set(hour, stats);
    }

    private getBestHour(address: string): number | null {
        const hourMap = this.hourlyStats.get(address);
        if (!hourMap) return null;

        let bestHour = -1;
        let bestWR = -1;

        for (const [hour, stats] of hourMap) {
            const total = stats.wins + stats.losses;
            if (total < 3) continue; // Need minimum sample
            const wr = stats.wins / total;
            if (wr > bestWR) {
                bestWR = wr;
                bestHour = hour;
            }
        }

        return bestHour >= 0 ? bestHour : null;
    }

    // ── Persistence ───────────────────────────────────────────────

    private async saveState(): Promise<void> {
        if (!this.redis) return;
        try {
            const state = {
                beliefs: Array.from(this.beliefs.entries()),
                consensusStats: this.consensusStats,
                hourlyStats: Array.from(this.hourlyStats.entries()).map(
                    ([addr, hm]) => [addr, Array.from(hm.entries())]
                ),
                savedAt: Date.now(),
            };
            await this.redis.set(REDIS_KEY, JSON.stringify(state));
        } catch (err) {
            console.warn('[BayesianScorer] Save failed:', err instanceof Error ? err.message : String(err));
        }
    }

    private async loadState(): Promise<void> {
        if (!this.redis) return;
        try {
            const raw = await this.redis.get(REDIS_KEY);
            if (!raw) return;

            const state = JSON.parse(raw);

            if (state.beliefs) {
                this.beliefs = new Map(state.beliefs);
            }
            if (state.consensusStats) {
                this.consensusStats = state.consensusStats;
            }
            if (state.hourlyStats) {
                this.hourlyStats = new Map(
                    state.hourlyStats.map(([addr, entries]: [string, [number, any][]]) =>
                        [addr, new Map(entries)]
                    )
                );
            }

            console.log(`[BayesianScorer] Loaded state: ${this.beliefs.size} wallets, ${this.getTotalTrades()} total trades`);
        } catch (err) {
            console.warn('[BayesianScorer] Load failed:', err instanceof Error ? err.message : String(err));
        }
    }

    private getTotalTrades(): number {
        let total = 0;
        for (const b of this.beliefs.values()) total += b.totalTrades;
        return total;
    }
}
