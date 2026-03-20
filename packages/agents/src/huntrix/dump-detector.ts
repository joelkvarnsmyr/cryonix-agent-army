import type { HunterPosition, ExitReason, HuntrixConfig } from './types';

export interface ExitSignal {
    should_exit: boolean;
    reason: ExitReason;
    urgency: 'immediate' | 'normal';
    details: string;
}

export class DumpDetector {
    private config: HuntrixConfig;
    private volumeReversalCounts: Map<string, number> = new Map();
    private shillTightened: Set<string> = new Set();
    private xai: import('openai').default | null = null;

    constructor(config: HuntrixConfig) {
        this.config = config;
    }

    async initXai(): Promise<void> {
        if (process.env.XAI_API_KEY) {
            const OpenAI = (await import('openai')).default;
            this.xai = new OpenAI({
                apiKey: process.env.XAI_API_KEY,
                baseURL: 'https://api.x.ai/v1',
            });
        }
    }

    check(position: HunterPosition): ExitSignal | null {
        const checks = [
            this.checkStopLoss(position),
            this.checkDumpVelocity(position),
            this.checkTrailingStop(position),
            this.checkTakeProfit(position),
            this.checkVolumeReversal(position),
            this.checkMaxHoldTime(position),
        ];

        const immediate = checks.find(c => c?.urgency === 'immediate');
        if (immediate) return immediate;
        return checks.find(c => c !== null) || null;
    }

    private checkStopLoss(position: HunterPosition): ExitSignal | null {
        const lossPct = ((position.entry_price - position.current_price) / position.entry_price) * 100;
        if (lossPct >= this.config.exits.stop_loss_pct) {
            return {
                should_exit: true,
                reason: 'stop_loss',
                urgency: 'immediate',
                details: `Loss ${lossPct.toFixed(2)}% >= SL ${this.config.exits.stop_loss_pct}%`,
            };
        }
        return null;
    }

    private checkTakeProfit(position: HunterPosition): ExitSignal | null {
        if (position.unrealized_pnl_pct >= this.config.exits.take_profit_pct) {
            return {
                should_exit: true,
                reason: 'take_profit',
                urgency: 'normal',
                details: `Profit ${position.unrealized_pnl_pct.toFixed(2)}% >= TP ${this.config.exits.take_profit_pct}%`,
            };
        }
        return null;
    }

    private checkDumpVelocity(position: HunterPosition): ExitSignal | null {
        const history = position.price_history;
        if (history.length < 2) return null;

        const windowMs = this.config.timing.velocity_window_seconds * 1000;
        const now = history[history.length - 1].timestamp;
        const cutoff = now - windowMs;

        const windowStart = history.find(t => t.timestamp >= cutoff);
        if (!windowStart) return null;

        const currentPrice = history[history.length - 1].price;
        const startPrice = windowStart.price;
        if (startPrice <= 0) return null;

        const dropPct = ((startPrice - currentPrice) / startPrice) * 100;
        const windowMinutes = this.config.timing.velocity_window_seconds / 60;
        const dropPctPerMin = dropPct / windowMinutes;

        if (dropPctPerMin >= this.config.exits.dump_velocity_exit_pct_per_min) {
            return {
                should_exit: true,
                reason: 'dump_velocity',
                urgency: 'immediate',
                details: `Price dropping ${dropPctPerMin.toFixed(2)}%/min >= ${this.config.exits.dump_velocity_exit_pct_per_min}%/min — DUMP`,
            };
        }
        return null;
    }

    private checkTrailingStop(position: HunterPosition): ExitSignal | null {
        if (!position.trailing_active) return null;

        const dropFromHigh = ((position.trailing_high - position.current_price) / position.trailing_high) * 100;

        // Use tightened trailing if shill activity dropped
        const trailingPct = this.shillTightened.has(position.id)
            ? this.config.exits.shill_tightened_trailing_pct
            : this.config.exits.trailing_stop_pct;

        if (dropFromHigh >= trailingPct) {
            const reason: ExitReason = this.shillTightened.has(position.id) ? 'shill_drop' : 'trailing_stop';
            return {
                should_exit: true,
                reason,
                urgency: 'immediate',
                details: `Price dropped ${dropFromHigh.toFixed(2)}% from high $${position.trailing_high.toFixed(4)} — trailing (${trailingPct}%) hit`,
            };
        }
        return null;
    }

    private checkVolumeReversal(position: HunterPosition): ExitSignal | null {
        const history = position.price_history;
        if (history.length < 3) return null;

        const latest = history[history.length - 1];
        const previous = history[history.length - 2];
        const isSellHeavy = latest.price < previous.price && latest.volume > 0;

        if (isSellHeavy) {
            const count = (this.volumeReversalCounts.get(position.id) || 0) + 1;
            this.volumeReversalCounts.set(position.id, count);

            if (count >= this.config.exits.volume_reversal_checks) {
                this.volumeReversalCounts.delete(position.id);
                return {
                    should_exit: true,
                    reason: 'volume_reversal',
                    urgency: 'normal',
                    details: `${count} consecutive sell-heavy checks — sellers taking over`,
                };
            }
        } else {
            this.volumeReversalCounts.set(position.id, 0);
        }

        return null;
    }

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
     * Re-scan shill activity via lightweight Grok call.
     * If activity dropped >shill_drop_tighten_pct%, tighten trailing stop.
     */
    async recheckShillActivity(position: HunterPosition): Promise<void> {
        if (!this.xai || this.shillTightened.has(position.id)) return;

        const originalShillCount = position.signal.total_shill_accounts;
        if (originalShillCount <= 0) return;

        try {
            const baseSymbol = position.signal.symbol.split('/')[0];
            const response = await this.xai.chat.completions.create({
                model: this.config.scanner.grok_model,
                messages: [{
                    role: 'user',
                    content: `Quick check: How many unique accounts are currently tweeting about $${baseSymbol} in the last 5 minutes? Just reply with a number.`,
                }],
            });

            const raw = response.choices[0]?.message?.content ?? '';
            const match = raw.match(/\d+/);
            if (!match) return;

            const currentCount = parseInt(match[0], 10);
            const dropPct = ((originalShillCount - currentCount) / originalShillCount) * 100;

            if (dropPct >= this.config.exits.shill_drop_tighten_pct) {
                this.shillTightened.add(position.id);
                console.log(
                    `[HUNTRIX] Shill activity dropped ${dropPct.toFixed(0)}% for ${position.symbol} ` +
                    `(${originalShillCount} → ${currentCount}) — trailing tightened to ${this.config.exits.shill_tightened_trailing_pct}%`,
                );
            }
        } catch (err) {
            console.warn(`[HUNTRIX] Shill recheck failed for ${position.symbol}:`, err instanceof Error ? err.message : err);
        }
    }

    updateTrailing(position: HunterPosition): void {
        if (!position.trailing_active) {
            if (position.unrealized_pnl_pct >= this.config.exits.trailing_activation_pct) {
                position.trailing_active = true;
                position.trailing_high = position.current_price;
                console.log(`[HUNTRIX] Trailing stop ACTIVATED for ${position.symbol} at +${position.unrealized_pnl_pct.toFixed(1)}%`);
            }
        }

        if (position.trailing_active && position.current_price > position.trailing_high) {
            position.trailing_high = position.current_price;
        }
    }

    cleanup(positionId: string): void {
        this.volumeReversalCounts.delete(positionId);
        this.shillTightened.delete(positionId);
    }
}
