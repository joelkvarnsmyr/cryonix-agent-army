import type { ApexTomlConfig } from './config';

export interface ApexPosition {
    id: string;
    symbol: string;
    direction: 'long' | 'short';
    mode: 'venus_rx' | 'dip_sniper' | 'momentum' | 'confluence';
    entryPrice: number;
    currentPrice: number;
    quantity: number;
    entryTime: number;          // Unix ms
    highWatermark: number;
    trailingActive: boolean;
    confluenceScore: number;
    contributingSignals: (string | { source: string; signalType: string; confidence: number; score: number })[];
}

export interface ExitDecision {
    shouldExit: boolean;
    reason: 'tp' | 'sl' | 'trailing' | 'max_hold' | null;
    pnlPct: number;
}

export class ExitMonitor {
    constructor(private config: ApexTomlConfig) {}

    evaluate(position: ApexPosition): ExitDecision {
        const modeConfig = this.config.modes[position.mode];

        // Calculate PnL percentage
        const pnlPct = position.direction === 'long'
            ? (position.currentPrice - position.entryPrice) / position.entryPrice * 100
            : (position.entryPrice - position.currentPrice) / position.entryPrice * 100;

        // Update highWatermark (best price seen so far for the position's direction)
        if (position.direction === 'long') {
            if (position.currentPrice > position.highWatermark) {
                position.highWatermark = position.currentPrice;
            }
        } else {
            // For shorts, highWatermark tracks the lowest price seen (best for short)
            if (position.highWatermark === 0 || position.currentPrice < position.highWatermark) {
                position.highWatermark = position.currentPrice;
            }
        }

        // Activate trailing if profit threshold reached
        if (pnlPct >= modeConfig.trailing_activation_pct) {
            position.trailingActive = true;
        }

        // Priority 1: Stop Loss (most urgent)
        if (pnlPct <= -modeConfig.sl_pct) {
            return { shouldExit: true, reason: 'sl', pnlPct };
        }

        // Priority 2: Trailing Stop
        if (position.trailingActive) {
            let trailPnlPct: number;
            if (position.direction === 'long') {
                trailPnlPct = (position.currentPrice - position.highWatermark) / position.highWatermark * 100;
            } else {
                trailPnlPct = (position.highWatermark - position.currentPrice) / position.highWatermark * 100;
            }
            if (trailPnlPct <= -modeConfig.trailing_pct) {
                return { shouldExit: true, reason: 'trailing', pnlPct };
            }
        }

        // Priority 3: Take Profit
        if (pnlPct >= modeConfig.tp_pct) {
            return { shouldExit: true, reason: 'tp', pnlPct };
        }

        // Priority 4: Max Hold
        const holdMs = Date.now() - position.entryTime;
        if (holdMs > modeConfig.max_hold_hours * 3_600_000) {
            return { shouldExit: true, reason: 'max_hold', pnlPct };
        }

        return { shouldExit: false, reason: null, pnlPct };
    }
}
