import type { RiskDecision, PolynixConfig } from './types';

export class PolynixRiskManager {
    private dailyPnl = 0;
    private consecutiveLosses = 0;
    private lastResetDate = this.todayUtc();
    private pausedUntil = 0;

    check(
        edge: number,
        winProb: number,
        config: PolynixConfig,
        openPositions: number,
        currentExposure: number,
    ): RiskDecision {
        this.maybeResetDaily();

        // Daily loss limit
        if (this.dailyPnl <= -config.risk.max_daily_loss_usd) {
            return { canTrade: false, reason: 'daily_loss_limit', suggestedSize: 0 };
        }

        // Consecutive loss circuit breaker (30 min pause)
        if (this.consecutiveLosses >= config.risk.max_consecutive_losses) {
            if (Date.now() < this.pausedUntil) {
                return { canTrade: false, reason: 'max_consecutive_losses', suggestedSize: 0 };
            }
            // Pause expired, reset
            this.consecutiveLosses = 0;
        }

        // Max concurrent positions
        if (openPositions >= config.capital.max_concurrent_positions) {
            return { canTrade: false, reason: 'max_positions', suggestedSize: 0 };
        }

        // Max exposure (50% of bankroll)
        const bankroll = config.capital.starting_balance_usd + this.dailyPnl;
        const maxExposure = bankroll * (config.capital.max_exposure_pct / 100);
        if (currentExposure >= maxExposure) {
            return { canTrade: false, reason: 'max_exposure', suggestedSize: 0 };
        }

        // For arb bets (winProb >= 0.95), skip Kelly and use max bet
        // Kelly degenerates for near-certain bets with low payout odds
        let size: number;
        if (winProb >= 0.95) {
            size = config.capital.max_bet_size_usd;
        } else {
            size = this.kellySizing(
                edge,
                winProb,
                bankroll,
                config.risk.kelly_fraction,
                config.capital.max_bet_size_usd,
            );
        }

        return { canTrade: size > 0, suggestedSize: size };
    }

    kellySizing(
        edge: number,
        winProb: number,
        bankroll: number,
        kellyFraction: number,
        maxBet: number,
    ): number {
        if (bankroll <= 0 || winProb <= 0 || winProb >= 1) return 0;

        // For binary bets: b = (1/price - 1) ≈ 1/winProb - 1
        // Simplified: f* = (p * b - q) / b
        const b = 1 / winProb - 1;
        if (b <= 0) return 0;

        const q = 1 - winProb;
        const kellyFull = (winProb * b - q) / b;

        if (kellyFull <= 0) return 0;

        const size = bankroll * kellyFull * kellyFraction;
        return Math.min(size, maxBet);
    }

    recordResult(pnl: number): void {
        this.dailyPnl += pnl;

        if (pnl < 0) {
            this.consecutiveLosses++;
            // Start 30-min pause if breaker trips
            if (this.consecutiveLosses >= 5) {
                this.pausedUntil = Date.now() + 30 * 60 * 1000;
            }
        } else {
            this.consecutiveLosses = 0;
        }
    }

    getDailyPnl(): number {
        return this.dailyPnl;
    }

    getConsecutiveLosses(): number {
        return this.consecutiveLosses;
    }

    isCircuitBreakerActive(): boolean {
        return Date.now() < this.pausedUntil;
    }

    getState(): {
        dailyPnl: number;
        consecutiveLosses: number;
        lastResetDate: string;
        circuitBreakerActive: boolean;
    } {
        return {
            dailyPnl: this.dailyPnl,
            consecutiveLosses: this.consecutiveLosses,
            lastResetDate: this.lastResetDate,
            circuitBreakerActive: this.isCircuitBreakerActive(),
        };
    }

    private maybeResetDaily(): void {
        const today = this.todayUtc();
        if (today !== this.lastResetDate) {
            this.dailyPnl = 0;
            this.consecutiveLosses = 0;
            this.pausedUntil = 0;
            this.lastResetDate = today;
        }
    }

    private todayUtc(): string {
        return new Date().toISOString().slice(0, 10);
    }
}
