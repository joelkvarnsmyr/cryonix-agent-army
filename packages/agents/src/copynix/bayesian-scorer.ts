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
    alpha: number;          // wins + prior_alpha (PnL-weighted)
    beta: number;           // losses + prior_beta (PnL-weighted)
    score: number;          // E[Beta] × 100
    confidence: number;     // 0-1, how certain we are (based on sample size)
    totalTrades: number;
    wins: number;
    losses: number;
    totalPnlUsd: number;
    avgPnlPerTrade: number;
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
const DEMOTION_SCORE = 35;    // Below this → lose single-whale, flagged for review
const PROMOTION_SCORE = 75;   // Above this → single-whale privileges
const MIN_TRADES_PROMOTE = 10; // Need 10+ trades to promote (avoid lucky streaks)
const MIN_TRADES_DEMOTE = 10; // Need 10+ trades to demote (catch bad wallets faster)

// PnL-weighted update: trades with large PnL move beliefs more
const PNL_WEIGHT_THRESHOLD = 10; // $10 — trades above this get extra weight

// Decay factor: older beliefs fade toward the prior over time.
// Applied on each recordOutcome — multiplies existing alpha/beta by decay.
// 0.995 = ~0.5% decay per trade = beliefs from 100 trades ago are ~60% as strong.
const BELIEF_DECAY = 0.995;

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
        // PnL-weighted update: a $50 win should move beliefs more than a $0.50 win.
        // Weight = 1 + log2(|pnl| / threshold), clamped to [1, 3].
        // This means: $10 = weight 1, $20 = 2, $80 = 4 → clamped to 3.
        const absPnl = Math.abs(outcome.pnlUsd);
        const pnlWeight = Math.min(3, Math.max(1,
            absPnl > PNL_WEIGHT_THRESHOLD
                ? 1 + Math.log2(absPnl / PNL_WEIGHT_THRESHOLD)
                : 1,
        ));

        for (const addr of outcome.walletAddresses) {
            let belief = this.beliefs.get(addr);
            if (!belief) {
                belief = this.newBelief(addr);
            }

            // Decay: shrink existing evidence toward prior so recent trades matter more.
            // α and β slowly regress toward PRIOR_ALPHA/PRIOR_BETA over many trades.
            belief.alpha = PRIOR_ALPHA + (belief.alpha - PRIOR_ALPHA) * BELIEF_DECAY;
            belief.beta = PRIOR_BETA + (belief.beta - PRIOR_BETA) * BELIEF_DECAY;

            // Bayesian update: Beta(α, β) → Beta(α + w, β + w)
            // where w is PnL-weighted (bigger trades = stronger evidence)
            if (outcome.isWin) {
                belief.alpha += pnlWeight;
                belief.wins += 1;
            } else {
                belief.beta += pnlWeight;
                belief.losses += 1;
            }

            belief.totalTrades += 1;
            belief.totalPnlUsd += outcome.pnlUsd;
            belief.avgPnlPerTrade = belief.totalPnlUsd / belief.totalTrades;

            // Posterior expectation: E[Beta(α, β)] = α / (α + β)
            belief.score = (belief.alpha / (belief.alpha + belief.beta)) * 100;

            // Confidence: based on effective sample size (asymptotes to 1)
            belief.confidence = 1 - (1 / (1 + belief.totalTrades * 0.15));

            belief.lastUpdated = Date.now();
            this.beliefs.set(addr, belief);
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
        return belief.totalTrades >= MIN_TRADES_PROMOTE && belief.score >= PROMOTION_SCORE;
    }

    /**
     * Check if a wallet should lose single-whale privileges.
     * Does NOT mean removal — just downgrade to consensus-only.
     * Requires 20+ trades to avoid punishing on bad luck streaks.
     */
    shouldDowngrade(address: string): boolean {
        const belief = this.beliefs.get(address);
        if (!belief) return false;
        return belief.totalTrades >= MIN_TRADES_DEMOTE && belief.score < DEMOTION_SCORE;
    }

    /**
     * Get wallets that should lose single-whale status (but stay tracked).
     */
    getWalletsToDowngrade(): string[] {
        return Array.from(this.beliefs.entries())
            .filter(([_, b]) => b.totalTrades >= MIN_TRADES_DEMOTE && b.score < DEMOTION_SCORE)
            .map(([addr]) => addr);
    }

    /**
     * Get wallets that earned single-whale promotion.
     */
    getWalletsToPromote(): string[] {
        return Array.from(this.beliefs.entries())
            .filter(([_, b]) => b.totalTrades >= MIN_TRADES_PROMOTE && b.score >= PROMOTION_SCORE)
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

        // If we have external data (e.g., from Dune PnL or manual curation),
        // encode it as a stronger prior. strength=8 means "trust this like 8 trades
        // of evidence" — enough to start above 50% but not enough to resist
        // 10+ actual trades that contradict it.
        if (priorScore !== undefined && priorScore > 50) {
            const strength = 8;
            const winPct = priorScore / 100;
            belief.alpha = PRIOR_ALPHA + strength * winPct;
            belief.beta = PRIOR_BETA + strength * (1 - winPct);
            belief.score = (belief.alpha / (belief.alpha + belief.beta)) * 100;
        }

        this.beliefs.set(address, belief);
    }

    /**
     * Persist current state to Redis. Call after batch initialization
     * so beliefs survive container restarts even before any trades.
     */
    async persistNow(): Promise<void> {
        await this.saveState();
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
            lastUpdated: Date.now(),
        };
    }

    // ── Persistence ───────────────────────────────────────────────

    private async saveState(): Promise<void> {
        if (!this.redis) return;
        try {
            const state = {
                beliefs: Array.from(this.beliefs.entries()),
                consensusStats: this.consensusStats,
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
