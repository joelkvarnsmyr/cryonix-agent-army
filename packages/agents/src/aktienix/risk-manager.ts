import type { AktienixTomlConfig } from './config';

type RiskConfig = AktienixTomlConfig['risk'];
type LimitsConfig = AktienixTomlConfig['limits'];

export type BlockReason =
    | 'daily_loss_limit'
    | 'weekly_loss_limit'
    | 'consecutive_losses'
    | 'pdt_limit'
    | 'daily_trade_limit';

export interface RiskDecision {
    canTrade: boolean;
    reason?: BlockReason;
}

export interface RiskState {
    canTrade: boolean;
    dailyPnlDollar: number;
    weeklyPnlDollar: number;
    consecutiveLosses: number;
    tradesToday: number;
    dayTradesThisWeek: number;
}

export class RiskManager {
    private dailyPnlDollar = 0;
    private weeklyPnlDollar = 0;
    private consecutiveLosses = 0;
    private tradesToday = 0;
    private dayTradesThisWeek = 0;
    private lastPortfolioValue = 0;

    updatePortfolioValue(value: number): void {
        if (value > 0) this.lastPortfolioValue = value;
    }

    canTrade(portfolioValue: number, risk: RiskConfig, limits: LimitsConfig): RiskDecision {
        this.updatePortfolioValue(portfolioValue);

        if (portfolioValue > 0) {
            const dailyLossPct = Math.abs(this.dailyPnlDollar) / portfolioValue;
            if (this.dailyPnlDollar < 0 && dailyLossPct >= risk.max_daily_loss_pct) {
                return { canTrade: false, reason: 'daily_loss_limit' };
            }

            const weeklyLossPct = Math.abs(this.weeklyPnlDollar) / portfolioValue;
            if (this.weeklyPnlDollar < 0 && weeklyLossPct >= risk.max_weekly_loss_pct) {
                return { canTrade: false, reason: 'weekly_loss_limit' };
            }
        }

        if (this.consecutiveLosses >= risk.max_consecutive_losses) {
            return { canTrade: false, reason: 'consecutive_losses' };
        }

        if (this.dayTradesThisWeek >= limits.max_day_trades_per_5d) {
            return { canTrade: false, reason: 'pdt_limit' };
        }

        if (this.tradesToday >= limits.max_trades_per_day) {
            return { canTrade: false, reason: 'daily_trade_limit' };
        }

        return { canTrade: true };
    }

    recordTrade(isDayTrade: boolean): void {
        this.tradesToday++;
        if (isDayTrade) this.dayTradesThisWeek++;
    }

    /**
     * @param pnlDollar Realized P&L in dollars (negative = loss). NOT a percentage.
     */
    recordExit(pnlDollar: number): void {
        this.dailyPnlDollar += pnlDollar;
        this.weeklyPnlDollar += pnlDollar;

        if (pnlDollar < 0) {
            this.consecutiveLosses++;
        } else {
            this.consecutiveLosses = 0;
        }
    }

    resetDaily(): void {
        this.dailyPnlDollar = 0;
        this.tradesToday = 0;
        this.consecutiveLosses = 0; // new day = fresh start, prevents permanent block
    }

    resetWeekly(): void {
        this.weeklyPnlDollar = 0;
        this.dayTradesThisWeek = 0;
    }

    getState(): RiskState {
        return {
            canTrade: this.canTrade(
                this.lastPortfolioValue || 1,
                { min_confidence: 0, min_settled_cash: 0, max_daily_loss_pct: 1, max_weekly_loss_pct: 1, max_consecutive_losses: 999 },
                { max_open_positions: 999, max_trades_per_day: 999, max_day_trades_per_5d: 999 },
            ).canTrade,
            dailyPnlDollar: this.dailyPnlDollar,
            weeklyPnlDollar: this.weeklyPnlDollar,
            consecutiveLosses: this.consecutiveLosses,
            tradesToday: this.tradesToday,
            dayTradesThisWeek: this.dayTradesThisWeek,
        };
    }
}
