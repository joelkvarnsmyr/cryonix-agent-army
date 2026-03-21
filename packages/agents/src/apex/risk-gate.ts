import type Redis from 'ioredis';
import type { ApexTomlConfig } from './config';

export interface RiskState {
    peakCapital: number;
    currentCapital: number;
    deployedCapital: number;
    dailyPnl: number;
    dailyPnlResetAt: number;
    consecutiveLosses: number;
    reducedSizingTradesLeft: number;
    openPositionCount: number;
    isPaused: boolean;
    pausedUntil: number;
    // Adaptive Kelly tracking
    totalWins: number;
    totalLosses: number;
    avgWinPct: number;
    avgLossPct: number;
}

function nextMidnightUtc(): number {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).getTime();
}

export class RiskGate {
    private config: ApexTomlConfig['risk'];
    private modesConfig: ApexTomlConfig['modes'];
    private confluenceConfig: ApexTomlConfig['confluence'];
    private state: RiskState;
    private redis: Redis | null = null;

    constructor(config: ApexTomlConfig) {
        this.config = config.risk;
        this.modesConfig = config.modes;
        this.confluenceConfig = config.confluence;
        this.state = this.defaultState(config.general.capital);
    }

    setRedis(redis: Redis): void {
        this.redis = redis;
    }

    // -------------------------------------------------------------------------
    // canTrade — circuit breaker checks
    // -------------------------------------------------------------------------
    canTrade(): { allowed: boolean; reason?: string } {
        const now = Date.now();

        if (now >= this.state.dailyPnlResetAt) {
            this.state.dailyPnl = 0;
            this.state.dailyPnlResetAt = nextMidnightUtc();
        }

        if (this.state.isPaused) {
            if (now < this.state.pausedUntil) {
                const remainingMin = Math.ceil((this.state.pausedUntil - now) / 60_000);
                return { allowed: false, reason: `Paused — ${remainingMin}min remaining` };
            }
            this.state.isPaused = false;
            this.state.pausedUntil = 0;
        }

        const drawdownPct = this.state.peakCapital > 0
            ? (this.state.peakCapital - this.state.currentCapital) / this.state.peakCapital * 100
            : 0;
        if (drawdownPct >= this.config.max_drawdown_pct) {
            this.state.isPaused = true;
            this.state.pausedUntil = now + 24 * 60 * 60 * 1_000;
            return { allowed: false, reason: `Max drawdown breached (${drawdownPct.toFixed(2)}%)` };
        }

        const dailyLossPct = this.state.peakCapital > 0
            ? Math.abs(this.state.dailyPnl) / this.state.peakCapital * 100
            : 0;
        if (this.state.dailyPnl < 0 && dailyLossPct >= this.config.daily_loss_limit_pct) {
            return { allowed: false, reason: `Daily loss limit (${dailyLossPct.toFixed(2)}%)` };
        }

        if (this.state.openPositionCount >= this.config.max_concurrent_positions) {
            return { allowed: false, reason: `Max positions (${this.state.openPositionCount}/${this.config.max_concurrent_positions})` };
        }

        return { allowed: true };
    }

    // -------------------------------------------------------------------------
    // checkCryonixDedup — reduce sizing if Cryonix already holds same symbol
    // -------------------------------------------------------------------------
    async checkCryonixDedup(symbol: string): Promise<number> {
        if (!this.redis) return 1.0;
        try {
            const raw = await this.redis.get('positions:open');
            if (!raw) return 1.0;
            const positions = JSON.parse(raw);
            const arr = Array.isArray(positions) ? positions : Object.values(positions);
            const cryonixHolds = arr.some((p: any) => {
                const sym = String(p?.symbol ?? '').split('/')[0].toUpperCase();
                return sym === symbol;
            });
            return cryonixHolds ? 0.5 : 1.0;
        } catch {
            return 1.0;
        }
    }

    // -------------------------------------------------------------------------
    // computeSize — Adaptive Kelly-adjusted position size in USDC
    // -------------------------------------------------------------------------
    computeSize(mode: 'venus_rx' | 'dip_sniper' | 'confluence', score: number): number {
        const modeConfig = this.modesConfig[mode];
        const sizingPct = modeConfig.sizing_pct / 100;
        const kellyFraction = this.config.kelly_fraction;

        // Adaptive Kelly: use conservative 50% WR until we have 20+ trades
        const totalTrades = this.state.totalWins + this.state.totalLosses;
        let winRate = 0.5; // Conservative default
        if (totalTrades >= 20) {
            winRate = this.state.totalWins / totalTrades;
        }

        // Kelly criterion: f* = (p * b - q) / b where b = avgWin/avgLoss
        // Simplified: use quarter-Kelly for safety
        const kellyMultiplier = Math.max(0.1, Math.min(1.0, winRate * 2 - 0.5));

        let size = this.state.currentCapital * sizingPct * kellyFraction * kellyMultiplier;

        // Score-based reduction
        const { min_score_full_kelly, min_score_half_kelly } = this.confluenceConfig;
        if (score >= min_score_full_kelly) {
            // Full kelly
        } else if (score >= min_score_half_kelly) {
            size *= 0.5;
        } else {
            size *= 0.25;
        }

        // Post-loss reduced sizing
        if (this.state.reducedSizingTradesLeft > 0) {
            size *= this.config.loss_reduction_factor;
        }

        const deployable = this.state.currentCapital * (1 - this.config.cash_reserve_pct / 100);
        const available = deployable - this.state.deployedCapital;
        const result = Math.min(size, available);

        return result < 1 ? 0 : result;
    }

    // -------------------------------------------------------------------------
    // recordEntry / recordExit
    // -------------------------------------------------------------------------
    recordEntry(amount: number): void {
        this.state.deployedCapital += amount;
        this.state.openPositionCount += 1;
    }

    recordExit(pnl: number, amount: number, pnlPct?: number): void {
        this.state.deployedCapital = Math.max(0, this.state.deployedCapital - amount);
        this.state.openPositionCount = Math.max(0, this.state.openPositionCount - 1);
        this.state.currentCapital += pnl;
        this.state.dailyPnl += pnl;

        if (this.state.reducedSizingTradesLeft > 0) {
            this.state.reducedSizingTradesLeft -= 1;
        }

        // Adaptive Kelly: track win/loss stats
        if (pnl >= 0) {
            this.state.totalWins += 1;
            this.state.consecutiveLosses = 0;
            if (pnlPct !== undefined) {
                this.state.avgWinPct = this.state.totalWins === 1
                    ? pnlPct
                    : this.state.avgWinPct * 0.9 + pnlPct * 0.1;
            }
        } else {
            this.state.totalLosses += 1;
            this.state.consecutiveLosses += 1;
            if (pnlPct !== undefined) {
                this.state.avgLossPct = this.state.totalLosses === 1
                    ? Math.abs(pnlPct)
                    : this.state.avgLossPct * 0.9 + Math.abs(pnlPct) * 0.1;
            }
        }

        if (this.state.consecutiveLosses >= this.config.max_consecutive_losses) {
            this.state.reducedSizingTradesLeft = this.config.loss_reduction_trades;
            this.state.isPaused = true;
            this.state.pausedUntil = Date.now() + 60 * 60 * 1_000;
            this.state.consecutiveLosses = 0;
        }

        this.state.peakCapital = Math.max(this.state.peakCapital, this.state.currentCapital);
    }

    // -------------------------------------------------------------------------
    // State helpers
    // -------------------------------------------------------------------------
    getState(): RiskState {
        return { ...this.state };
    }

    loadState(state: RiskState): void {
        this.state = {
            ...this.defaultState(state.currentCapital),
            ...state,
        };
    }

    private defaultState(capital: number): RiskState {
        return {
            peakCapital: capital,
            currentCapital: capital,
            deployedCapital: 0,
            dailyPnl: 0,
            dailyPnlResetAt: nextMidnightUtc(),
            consecutiveLosses: 0,
            reducedSizingTradesLeft: 0,
            openPositionCount: 0,
            isPaused: false,
            pausedUntil: 0,
            totalWins: 0,
            totalLosses: 0,
            avgWinPct: 0,
            avgLossPct: 0,
        };
    }
}
