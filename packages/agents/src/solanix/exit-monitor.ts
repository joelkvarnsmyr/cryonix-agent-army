import type { SolanaPosition } from './types';

export type ExitReason =
    | 'take_profit'
    | 'stop_loss'
    | 'trailing_stop'
    | 'stagnation';

export interface ExitDecision {
    symbol: string;
    reason: ExitReason;
    pnlPct: number;
}

export interface ExitConfig {
    take_profit_pct: number;
    stop_loss_pct: number;
    trailing_stop_pct: number;
    trailing_activation_pct: number;
    stagnation_timeout_days: number;
    stagnation_min_pnl_pct: number;
}

export class SolanaExitMonitor {
    /**
     * Check all positions against exit rules.
     * Uses the position's own highWatermark (updated by the agent each loop).
     */
    check(positions: SolanaPosition[], config: ExitConfig): ExitDecision[] {
        const exits: ExitDecision[] = [];
        for (const pos of positions) {
            const decision = this.checkOne(pos, config);
            if (decision) exits.push(decision);
        }
        return exits;
    }

    private checkOne(pos: SolanaPosition, config: ExitConfig): ExitDecision | null {
        if (pos.avgEntryPrice <= 0 || pos.qty <= 0) return null;

        const positionCost = pos.avgEntryPrice * pos.qty;
        const pnlPct = (pos.unrealizedPl / positionCost) * 100;

        // Take Profit
        if (pnlPct >= config.take_profit_pct) {
            return { symbol: pos.symbol, reason: 'take_profit', pnlPct };
        }

        // Stop Loss
        if (pnlPct <= -config.stop_loss_pct) {
            return { symbol: pos.symbol, reason: 'stop_loss', pnlPct };
        }

        // Trailing Stop — uses position's highWatermark
        const highWaterPnlPct = ((pos.highWatermark - pos.avgEntryPrice) / pos.avgEntryPrice) * 100;
        const trailingActive = pos.trailingStopActive || highWaterPnlPct >= config.trailing_activation_pct;

        if (trailingActive && pos.highWatermark > 0) {
            const pullbackFromHighPct = ((pos.highWatermark - pos.currentPrice) / pos.highWatermark) * 100;
            if (pullbackFromHighPct >= config.trailing_stop_pct) {
                return { symbol: pos.symbol, reason: 'trailing_stop', pnlPct };
            }
        }

        // Stagnation — position has been flat for too long
        const daysHeld = (Date.now() - pos.entryTime) / (24 * 3_600_000);
        if (daysHeld >= config.stagnation_timeout_days && Math.abs(pnlPct) < config.stagnation_min_pnl_pct) {
            return { symbol: pos.symbol, reason: 'stagnation', pnlPct };
        }

        return null;
    }
}
