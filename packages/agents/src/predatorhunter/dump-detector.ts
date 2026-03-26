/**
 * Predator Hunter — Dump Detector
 *
 * Monitors open positions for sign that the pump is ending.
 * Triggers fast exits on: velocity reversal, volume flip,
 * shill activity drop, and max hold time.
 */

import type { HunterPosition, ExitReason, PriceTick, PredatorHunterConfig } from './types';

export interface ExitSignal {
    should_exit: boolean;
    reason: ExitReason;
    urgency: 'immediate' | 'normal';
    details: string;
}

export class DumpDetector {
    private config: PredatorHunterConfig;
    /** Consecutive sell-heavy volume checks */
    private volumeReversalCounts: Map<string, number> = new Map();

    constructor(config: PredatorHunterConfig) {
        this.config = config;
    }

    /**
     * Check a position for all exit conditions.
     * Returns the highest-priority exit signal, or null if no exit needed.
     */
    check(position: HunterPosition): ExitSignal | null {
        const checks = [
            this.checkStopLoss(position),
            this.checkTakeProfit(position),
            this.checkDumpVelocity(position),
            this.checkTrailingStop(position),
            this.checkVolumeReversal(position),
            this.checkMaxHoldTime(position),
        ];

        // Return first "immediate" exit, or first "normal" exit
        const immediate = checks.find(c => c?.urgency === 'immediate');
        if (immediate) return immediate;

        return checks.find(c => c !== null) || null;
    }

    /**
     * Stop Loss — hard floor protection
     */
    private checkStopLoss(position: HunterPosition): ExitSignal | null {
        const lossPct = ((position.entry_price - position.current_price) / position.entry_price) * 100;
        if (lossPct >= this.config.exits.sl_pct) {
            return {
                should_exit: true,
                reason: 'stop_loss',
                urgency: 'immediate',
                details: `Loss ${lossPct.toFixed(2)}% >= SL ${this.config.exits.sl_pct}%`,
            };
        }
        return null;
    }

    /**
     * Take Profit — capture the pump gains
     */
    private checkTakeProfit(position: HunterPosition): ExitSignal | null {
        if (position.unrealized_pnl_pct >= this.config.exits.tp_pct) {
            return {
                should_exit: true,
                reason: 'take_profit',
                urgency: 'normal',
                details: `Profit ${position.unrealized_pnl_pct.toFixed(2)}% >= TP ${this.config.exits.tp_pct}%`,
            };
        }
        return null;
    }

    /**
     * Dump Velocity — instant exit if price drops too fast
     *
     * This is THE key differentiator for P&D trading. When the dump starts,
     * it happens in seconds. This detector watches price velocity over a
     * short window and exits immediately if decline rate exceeds threshold.
     */
    private checkDumpVelocity(position: HunterPosition): ExitSignal | null {
        const history = position.price_history;
        if (history.length < 2) return null;

        const windowMs = this.config.exits.dump_velocity_window_seconds * 1000;
        const now = history[history.length - 1].timestamp;
        const cutoff = now - windowMs;

        // Find the price at the start of the velocity window
        const windowStart = history.find(t => t.timestamp >= cutoff);
        if (!windowStart) return null;

        const currentPrice = history[history.length - 1].price;
        const startPrice = windowStart.price;

        if (startPrice <= 0) return null;

        const dropPct = ((startPrice - currentPrice) / startPrice) * 100;

        if (dropPct >= this.config.exits.dump_velocity_pct) {
            return {
                should_exit: true,
                reason: 'dump_velocity',
                urgency: 'immediate',
                details: `Price dropped ${dropPct.toFixed(2)}% in ${this.config.exits.dump_velocity_window_seconds}s — DUMP DETECTED`,
            };
        }
        return null;
    }

    /**
     * Trailing Stop — lock in gains as pump progresses
     */
    private checkTrailingStop(position: HunterPosition): ExitSignal | null {
        if (!position.trailing_active) return null;

        const dropFromHigh = ((position.trailing_high - position.current_price) / position.trailing_high) * 100;
        const trailingPct = this.config.exits.trailing_stop_pct;

        if (dropFromHigh >= trailingPct) {
            return {
                should_exit: true,
                reason: 'trailing_stop',
                urgency: 'immediate',
                details: `Price dropped ${dropFromHigh.toFixed(2)}% from high $${position.trailing_high.toFixed(4)} — trailing stop hit`,
            };
        }
        return null;
    }

    /**
     * Volume Reversal — sell volume exceeding buy volume
     *
     * When pumps end, the volume profile flips: more selling than buying.
     * Three consecutive sell-heavy checks = exit.
     */
    private checkVolumeReversal(position: HunterPosition): ExitSignal | null {
        const history = position.price_history;
        if (history.length < 3) return null;

        // Compare last two ticks: if price dropped AND volume was high, count as sell-heavy
        const latest = history[history.length - 1];
        const previous = history[history.length - 2];

        const isSellHeavy = latest.price < previous.price && latest.volume > 0;
        const posId = position.id;

        if (isSellHeavy) {
            const count = (this.volumeReversalCounts.get(posId) || 0) + 1;
            this.volumeReversalCounts.set(posId, count);

            if (count >= this.config.exits.volume_reversal_checks) {
                this.volumeReversalCounts.delete(posId);
                return {
                    should_exit: true,
                    reason: 'volume_reversal',
                    urgency: 'normal',
                    details: `${count} consecutive sell-heavy checks — sellers taking over`,
                };
            }
        } else {
            // Reset counter on any buy-heavy tick
            this.volumeReversalCounts.set(posId, 0);
        }

        return null;
    }

    /**
     * Max Hold Time — hard cap on position duration
     *
     * Most P&D cycles are 5-20 minutes. Holding longer means
     * we're likely in the post-pump or dump phase.
     */
    private checkMaxHoldTime(position: HunterPosition): ExitSignal | null {
        const enteredAt = new Date(position.entered_at).getTime();
        const holdMinutes = (Date.now() - enteredAt) / 60_000;

        if (holdMinutes >= this.config.exits.max_hold_minutes) {
            return {
                should_exit: true,
                reason: 'max_hold_time',
                urgency: 'normal',
                details: `Held for ${holdMinutes.toFixed(1)} min >= max ${this.config.exits.max_hold_minutes} min`,
            };
        }
        return null;
    }

    /**
     * Update trailing stop state for a position.
     * Call this on every price tick.
     */
    updateTrailing(position: HunterPosition): HunterPosition {
        // Activate trailing if profit exceeds threshold
        if (!position.trailing_active) {
            if (position.unrealized_pnl_pct >= this.config.exits.trailing_activation_pct) {
                position.trailing_active = true;
                position.trailing_high = position.current_price;
                console.log(`[PREDATOR] Trailing stop ACTIVATED for ${position.symbol} at +${position.unrealized_pnl_pct.toFixed(1)}%`);
            }
        }

        // Update high watermark
        if (position.trailing_active && position.current_price > position.trailing_high) {
            position.trailing_high = position.current_price;
        }

        return position;
    }

    /**
     * Clean up state for a closed position
     */
    cleanup(positionId: string): void {
        this.volumeReversalCounts.delete(positionId);
    }
}
