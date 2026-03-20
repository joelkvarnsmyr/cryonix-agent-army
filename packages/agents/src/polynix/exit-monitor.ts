/**
 * Polynix Exit Monitor — early exit for directional positions.
 * Arb positions are excluded (guaranteed profit at expiry).
 * Checks take-profit, stop-loss, and stagnation conditions.
 */

import type { PolynixPosition, ExitConfig, ExitDecision } from './types';

export class PolynixExitMonitor {
    /**
     * Evaluate all open positions for early exit.
     * Returns a list of exit decisions (positions that should be sold).
     */
    check(positions: PolynixPosition[], config: ExitConfig): ExitDecision[] {
        if (!config.enabled) return [];

        const now = Date.now();
        const decisions: ExitDecision[] = [];

        for (const pos of positions) {
            // Skip arb — guaranteed profit at expiry
            if (pos.type === 'arb') continue;

            // Skip if no current price available
            if (pos.currentPrice == null) continue;

            // Skip if held less than min_hold_seconds
            const heldSeconds = (now - pos.enteredAt) / 1000;
            if (heldSeconds < config.min_hold_seconds) continue;

            // Calculate P&L percentage
            const currentValue = pos.currentPrice * pos.size;
            const pnlPct = ((currentValue - pos.costBasis) / pos.costBasis) * 100;

            // Stop-loss: exit if P&L below threshold
            if (pnlPct <= -config.stop_loss_pct) {
                decisions.push({
                    positionId: pos.id,
                    reason: 'stop_loss',
                    pnlPct,
                    currentPrice: pos.currentPrice,
                });
                continue;
            }

            // Take-profit: exit if P&L above threshold
            if (pnlPct >= config.take_profit_pct) {
                decisions.push({
                    positionId: pos.id,
                    reason: 'take_profit',
                    pnlPct,
                    currentPrice: pos.currentPrice,
                });
                continue;
            }

            // Stagnation: exit if flat for too long
            const heldHours = heldSeconds / 3600;
            if (heldHours >= config.stagnation_hours && Math.abs(pnlPct) < 5) {
                decisions.push({
                    positionId: pos.id,
                    reason: 'stagnation',
                    pnlPct,
                    currentPrice: pos.currentPrice,
                });
            }
        }

        return decisions;
    }
}
