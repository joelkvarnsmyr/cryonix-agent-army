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

        // Stop Loss — always honored, even during min holding period
        if (pnlPct <= -config.stop_loss_pct) {
            return { symbol: pos.symbol, reason: 'stop_loss', pnlPct };
        }

        // Min holding period: skip non-SL exits if held less than min_holding_minutes.
        // Prevents daily-bar entries from churning on 60-second exit checks.
        const ps = this.state.get(pos.symbol);
        const minHoldMs = (config.min_holding_minutes ?? 0) * 60_000;
        if (ps && minHoldMs > 0) {
            const heldMs = Date.now() - ps.entryDate.getTime();
            if (heldMs < minHoldMs) return null;
        }

        // Take Profit
        if (pnlPct >= config.take_profit_pct) {
            return { symbol: pos.symbol, reason: 'take_profit', pnlPct };
        }

        // Trailing Stop + Stagnation (require persisted state)
        if (ps) {
            if (currentPrice > ps.highWaterMark) {
                ps.highWaterMark = currentPrice;
            }

            const highWaterPnlPct = ((ps.highWaterMark - ps.entryPrice) / ps.entryPrice) * 100;
            if (highWaterPnlPct >= config.trailing_activation_pct) {
                ps.trailingActive = true;
            }

            if (ps.trailingActive) {
                // Trailing stop fires when price pulls back N% from the high water mark.
                // The fixed stop_loss handles negative PnL — no need to duplicate here.
                const pullbackFromHighPct = ((ps.highWaterMark - currentPrice) / ps.highWaterMark) * 100;
                if (pullbackFromHighPct >= config.trailing_stop_pct) {
                    return { symbol: pos.symbol, reason: 'trailing_stop', pnlPct };
                }
            }

            // Stagnation: approximate trading days (weekdays only)
            const calendarDays = (Date.now() - ps.entryDate.getTime()) / (24 * 3_600_000);
            const tradingDays = calendarDays * (5 / 7);
            if (tradingDays >= config.stagnation_timeout_days && Math.abs(pnlPct) < config.stagnation_min_pnl_pct) {
                return { symbol: pos.symbol, reason: 'stagnation', pnlPct };
            }
        }

        return null;
    }
}

