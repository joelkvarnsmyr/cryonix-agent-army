import { AktienixTomlConfig } from './config';
import { StockPosition } from './types';

// ============================================================================
// Types
// ============================================================================

export type ExitReason =
    | 'take_profit'
    | 'stop_loss'
    | 'trailing_stop'
    | 'stagnation'
    | 'eod_close';

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
        const currentPrice = pos.marketValue / pos.qty;

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
                // Trailing stop fires when the position has given back enough of its
                // gains. We measure the total round-trip drop: from high water mark
                // down to current price, as a % of entry. When the position has gone
                // below entry (pnlPct < 0) the round-trip drop always exceeds the
                // activation gain, so we additionally trigger when price falls below
                // entry after trailing has activated.
                const roundTripDropPct = ((ps.highWaterMark - currentPrice) / ps.entryPrice) * 100;
                if (roundTripDropPct >= config.trailing_stop_pct || pnlPct < 0) {
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

export interface LegacyExitDecision {
    symbol: string;
    shouldExit: boolean;
    reason: ExitReason;
    urgency: 'immediate' | 'end_of_day';
}

// ============================================================================
// Core function
// ============================================================================

/**
 * Check every open position against configured exit conditions.
 *
 * Pure function — no I/O. Mutates highWatermark on the position objects in
 * place so the caller can persist the updated watermark back to state.
 *
 * @param positions         Open positions (currentPrice + highWatermark kept
 *                          up-to-date by the caller between cycles).
 * @param config            The [exits] section of aktienix.toml.
 * @param closeBeforeEod    Value of market_hours.close_before_eod.
 * @param minutesUntilClose Minutes remaining until market close this session.
 * @returns                 Only positions where shouldExit=true.
 */
export function checkExits(
    positions: StockPosition[],
    config: AktienixTomlConfig['exits'],
    closeBeforeEod: boolean,
    minutesUntilClose: number,
): LegacyExitDecision[] {
    const decisions: LegacyExitDecision[] = [];

    for (const pos of positions) {
        // Skip positions without a valid current price — we cannot make a
        // reliable exit decision without it.
        if (!pos.currentPrice || pos.currentPrice === 0) {
            continue;
        }

        const currentPrice = pos.currentPrice;
        const plPct = ((currentPrice - pos.avgEntryPrice) / pos.avgEntryPrice) * 100;

        // ------------------------------------------------------------------
        // 1. Take profit
        // ------------------------------------------------------------------
        if (plPct >= config.take_profit_pct) {
            decisions.push({
                symbol: pos.symbol,
                shouldExit: true,
                reason: 'take_profit',
                urgency: 'immediate',
            });
            continue; // Highest priority — no need to evaluate further.
        }

        // ------------------------------------------------------------------
        // 2. Stop loss
        // ------------------------------------------------------------------
        if (plPct <= -config.stop_loss_pct) {
            decisions.push({
                symbol: pos.symbol,
                shouldExit: true,
                reason: 'stop_loss',
                urgency: 'immediate',
            });
            continue;
        }

        // ------------------------------------------------------------------
        // 3. Trailing stop
        //    Only activates once the position has gained enough to warrant it.
        // ------------------------------------------------------------------
        if (plPct >= config.trailing_activation_pct) {
            // Advance the high-water mark whenever price sets a new high.
            if (pos.highWatermark === undefined || currentPrice > pos.highWatermark) {
                pos.highWatermark = currentPrice;
            }

            const trailThreshold = pos.highWatermark * (1 - config.trailing_stop_pct / 100);
            if (currentPrice < trailThreshold) {
                decisions.push({
                    symbol: pos.symbol,
                    shouldExit: true,
                    reason: 'trailing_stop',
                    urgency: 'immediate',
                });
                continue;
            }
        }

        // ------------------------------------------------------------------
        // 4. Stagnation — position is going nowhere; free up capital.
        //    Uses end_of_day urgency to avoid mid-session market impact.
        // ------------------------------------------------------------------
        const daysHeld = pos.tradingDaysHeld ?? 0;
        if (
            daysHeld >= config.stagnation_timeout_days &&
            Math.abs(plPct) < config.stagnation_min_pnl_pct
        ) {
            decisions.push({
                symbol: pos.symbol,
                shouldExit: true,
                reason: 'stagnation',
                urgency: 'end_of_day',
            });
            continue;
        }

        // ------------------------------------------------------------------
        // 5. EOD close — flatten all positions before market close.
        //    Triggered when the session is within 15 minutes of closing.
        // ------------------------------------------------------------------
        if (closeBeforeEod && minutesUntilClose <= 15) {
            decisions.push({
                symbol: pos.symbol,
                shouldExit: true,
                reason: 'eod_close',
                urgency: 'immediate',
            });
            continue;
        }
    }

    return decisions;
}
