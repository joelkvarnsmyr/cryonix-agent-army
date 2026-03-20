import type { ApexTomlConfig } from './config';

export interface RiskState {
    peakCapital: number;
    currentCapital: number;
    deployedCapital: number;
    dailyPnl: number;
    dailyPnlResetAt: number;    // Unix ms — midnight UTC
    consecutiveLosses: number;
    reducedSizingTradesLeft: number;
    openPositionCount: number;
    isPaused: boolean;
    pausedUntil: number;        // Unix ms
}

function nextMidnightUtc(): number {
    const now = new Date();
    const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    return midnight.getTime();
}

export class RiskGate {
    private config: ApexTomlConfig['risk'];
    private modesConfig: ApexTomlConfig['modes'];
    private confluenceConfig: ApexTomlConfig['confluence'];
    private state: RiskState;

    constructor(config: ApexTomlConfig) {
        this.config = config.risk;
        this.modesConfig = config.modes;
        this.confluenceConfig = config.confluence;
        this.state = this.defaultState(config.general.capital);
    }

    // -------------------------------------------------------------------------
    // canTrade — circuit breaker checks before any entry
    // -------------------------------------------------------------------------
    canTrade(): { allowed: boolean; reason?: string } {
        const now = Date.now();

        // Reset daily PnL at midnight UTC
        if (now >= this.state.dailyPnlResetAt) {
            this.state.dailyPnl = 0;
            this.state.dailyPnlResetAt = nextMidnightUtc();
        }

        // Pause window (e.g. after consecutive losses)
        if (this.state.isPaused) {
            if (now < this.state.pausedUntil) {
                const remainingMin = Math.ceil((this.state.pausedUntil - now) / 60_000);
                return { allowed: false, reason: `Paused after consecutive losses — ${remainingMin}min remaining` };
            }
            // Pause expired — lift it
            this.state.isPaused = false;
            this.state.pausedUntil = 0;
        }

        // Drawdown circuit breaker — pause 24h
        const drawdownPct = this.state.peakCapital > 0
            ? (this.state.peakCapital - this.state.currentCapital) / this.state.peakCapital * 100
            : 0;
        if (drawdownPct >= this.config.max_drawdown_pct) {
            this.state.isPaused = true;
            this.state.pausedUntil = now + 24 * 60 * 60 * 1_000;
            return {
                allowed: false,
                reason: `Max drawdown breached (${drawdownPct.toFixed(2)}% >= ${this.config.max_drawdown_pct}%) — paused 24h`,
            };
        }

        // Daily loss limit
        const dailyLossPct = this.state.peakCapital > 0
            ? Math.abs(this.state.dailyPnl) / this.state.peakCapital * 100
            : 0;
        if (this.state.dailyPnl < 0 && dailyLossPct >= this.config.daily_loss_limit_pct) {
            return {
                allowed: false,
                reason: `Daily loss limit reached (${dailyLossPct.toFixed(2)}% >= ${this.config.daily_loss_limit_pct}%)`,
            };
        }

        // Max concurrent positions
        if (this.state.openPositionCount >= this.config.max_concurrent_positions) {
            return {
                allowed: false,
                reason: `Max concurrent positions reached (${this.state.openPositionCount}/${this.config.max_concurrent_positions})`,
            };
        }

        return { allowed: true };
    }

    // -------------------------------------------------------------------------
    // computeSize — Kelly-adjusted position size in USDC
    // -------------------------------------------------------------------------
    computeSize(mode: 'venus_rx' | 'dip_sniper' | 'confluence', score: number): number {
        const modeConfig = this.modesConfig[mode];
        const sizingPct = modeConfig.sizing_pct / 100;
        const kellyFraction = this.config.kelly_fraction;

        // Base size: mode's sizing_pct * kelly_fraction * current capital
        let size = this.state.currentCapital * sizingPct * kellyFraction;

        // Score-based Kelly reduction
        const { min_score_full_kelly, min_score_half_kelly } = this.confluenceConfig;
        if (score >= min_score_full_kelly) {
            // Full kelly — no reduction
        } else if (score >= min_score_half_kelly) {
            size *= 0.5;
        } else {
            size *= 0.25;
        }

        // Post-loss reduced sizing
        if (this.state.reducedSizingTradesLeft > 0) {
            size *= this.config.loss_reduction_factor;
        }

        // Available capital respecting cash reserve and already-deployed capital
        const deployable = this.state.currentCapital * (1 - this.config.cash_reserve_pct / 100);
        const available = deployable - this.state.deployedCapital;

        const result = Math.min(size, available);

        if (result < 1) return 0;
        return result;
    }

    // -------------------------------------------------------------------------
    // recordEntry — call immediately after a BUY order is confirmed
    // -------------------------------------------------------------------------
    recordEntry(amount: number): void {
        this.state.deployedCapital += amount;
        this.state.openPositionCount += 1;
    }

    // -------------------------------------------------------------------------
    // recordExit — call after a position closes; pnl = net profit/loss in USDC
    //              amount = original entry size (to unwind deployedCapital)
    // -------------------------------------------------------------------------
    recordExit(pnl: number, amount: number): void {
        this.state.deployedCapital = Math.max(0, this.state.deployedCapital - amount);
        this.state.openPositionCount = Math.max(0, this.state.openPositionCount - 1);
        this.state.currentCapital += pnl;
        this.state.dailyPnl += pnl;

        // Decrement reduced sizing on every exit (counts trades, not outcomes)
        if (this.state.reducedSizingTradesLeft > 0) {
            this.state.reducedSizingTradesLeft -= 1;
        }

        if (pnl < 0) {
            this.state.consecutiveLosses += 1;
        } else {
            this.state.consecutiveLosses = 0;
        }

        // Consecutive loss circuit breaker
        if (this.state.consecutiveLosses >= this.config.max_consecutive_losses) {
            this.state.reducedSizingTradesLeft = this.config.loss_reduction_trades;
            this.state.isPaused = true;
            this.state.pausedUntil = Date.now() + 60 * 60 * 1_000; // pause 1h
            this.state.consecutiveLosses = 0; // reset so the breaker fires once per streak
        }

        // Update high-water mark
        this.state.peakCapital = Math.max(this.state.peakCapital, this.state.currentCapital);
    }

    // -------------------------------------------------------------------------
    // State helpers — for Redis persistence by the APEX agent
    // -------------------------------------------------------------------------
    getState(): RiskState {
        return { ...this.state };
    }

    loadState(state: RiskState): void {
        this.state = { ...state };
    }

    // -------------------------------------------------------------------------
    // defaultState — fresh state for a given starting capital
    // -------------------------------------------------------------------------
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
        };
    }
}
