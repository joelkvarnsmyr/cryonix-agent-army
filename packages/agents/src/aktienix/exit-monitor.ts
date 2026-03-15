import { AktienixTomlConfig } from './config';
import { StockPosition } from './types';

// ============================================================================
// Types
// ============================================================================

export type ExitReason =
    | 'take_profit'
    | 'stop_loss'
    | 'trailing_stop'
    | 'stagnation';

// ============================================================================
// ExitMonitor class — stateful, tracks per-symbol high water marks + entry
// ============================================================================

export interface ExitDecision {
    symbol: string;
    reason: ExitReason;
    pnlPct: number;
}

interface PositionState {
    entryPrice: number;
    entryDate: Date;
    highWaterMark: number;
    trailingActive: boolean;
}

export class ExitMonitor {
    private state = new Map<string, PositionState>();

    recordEntry(symbol: string, price: number, entryDate: Date): void {
        this.state.set(symbol, {
            entryPrice: price,
            entryDate,
            highWaterMark: price,
            trailingActive: false,
        });
    }

    clearPosition(symbol: string): void {
        this.state.delete(symbol);
    }

    /**
     * Check all positions and return exit decisions.
     * Updates internal high-water marks as a side effect.
     */
    check(positions: StockPosition[], config: AktienixTomlConfig['exits']): ExitDecision[] {
        const exits: ExitDecision[] = [];
        for (const pos of positions) {
            const decision = this.checkOne(pos, config);
            if (decision) exits.push(decision);
        }
        return exits;
    }

    private checkOne(pos: StockPosition, config: AktienixTomlConfig['exits']): ExitDecision | null {
        const positionCost = pos.avgEntryPrice * pos.qty;
        if (positionCost <= 0) return null;

        const pnlPct = (pos.unrealizedPl / positionCost) * 100;
        const currentPrice = pos.currentPrice ?? (pos.marketValue / pos.qty);

        // Take Profit
        if (pnlPct >= config.take_profit_pct) {
            return { symbol: pos.symbol, reason: 'take_profit', pnlPct };
        }

        // Stop Loss
        if (pnlPct <= -config.stop_loss_pct) {
            return { symbol: pos.symbol, reason: 'stop_loss', pnlPct };
        }

        // Trailing Stop + Stagnation (require persisted state)
        const ps = this.state.get(pos.symbol);
        if (ps) {
            if (currentPrice > ps.highWaterMark) {
                ps.highWaterMark = currentPrice;
            }

            const highWaterPnlPct = ((ps.highWaterMark - ps.entryPrice) / ps.entryPrice) * 100;
            if (highWaterPnlPct >= config.trailing_activation_pct) {
                ps.trailingActive = true;
            }

            if (ps.trailingActive) {
                // Trailing stop fires when price pulls back enough from the peak.
                // Standard "N% from peak" formula: drop measured as % of high water
                // mark (not entry price). The || pnlPct < 0 clause is a safety net —
                // always exit a once-profitable position that has reverted below entry.
                const pullbackFromHighPct = ((ps.highWaterMark - currentPrice) / ps.highWaterMark) * 100;
                if (pullbackFromHighPct >= config.trailing_stop_pct || pnlPct < 0) {
                    return { symbol: pos.symbol, reason: 'trailing_stop', pnlPct };
                }
            }

            const daysHeld = (Date.now() - ps.entryDate.getTime()) / (24 * 3_600_000);
            if (daysHeld >= config.stagnation_timeout_days && Math.abs(pnlPct) < config.stagnation_min_pnl_pct) {
                return { symbol: pos.symbol, reason: 'stagnation', pnlPct };
            }
        }

        return null;
    }
}

