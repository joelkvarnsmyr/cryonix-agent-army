// packages/agents/src/alphanix/pod/exit-monitor.ts
// Tracks open positions and triggers exits based on TP/SL/trailing stop/stagnation.

// ============================================================================
// Types
// ============================================================================

export interface ExitConfig {
  takeProfitPct: number;           // e.g. 5.0 (5%)
  stopLossPct: number;             // e.g. 3.0 (3%)
  trailingStopActivation: number;  // e.g. 2.0 (activate after 2% gain)
  trailingStopDistance: number;    // e.g. 1.0 (1% from high water mark)
  stagnationHours: number;         // e.g. 48
}

export type ExitReason = 'take_profit' | 'stop_loss' | 'trailing_stop' | 'stagnation';

export interface ExitSignal {
  symbol: string;
  reason: ExitReason;
  entryPrice: number;
  currentPrice: number;
  pnlPct: number;
  highWaterMark: number;
}

interface TrackedPosition {
  symbol: string;
  entryPrice: number;
  highWaterMark: number;
  enteredAt: number; // epoch ms
}

// ============================================================================
// ExitMonitor class — stateful, tracks per-symbol high water marks + entry
// ============================================================================

export class ExitMonitor {
  private config: ExitConfig;
  private positions = new Map<string, TrackedPosition>();

  constructor(config: ExitConfig) {
    this.config = config;
  }

  /** Start tracking a position. */
  track(symbol: string, entryPrice: number): void {
    this.positions.set(symbol, {
      symbol,
      entryPrice,
      highWaterMark: entryPrice,
      enteredAt: Date.now(),
    });
  }

  /** Stop tracking a position (after exit). */
  untrack(symbol: string): void {
    this.positions.delete(symbol);
  }

  /**
   * Check a single position against all exit rules.
   * Updates the high water mark as a side effect.
   * Returns an ExitSignal if an exit should be triggered, null otherwise.
   */
  check(symbol: string, currentPrice: number): ExitSignal | null {
    const pos = this.positions.get(symbol);
    if (!pos) return null;

    // Update high water mark
    if (currentPrice > pos.highWaterMark) {
      pos.highWaterMark = currentPrice;
    }

    const pnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
    const base: ExitSignal = {
      symbol,
      entryPrice: pos.entryPrice,
      currentPrice,
      pnlPct,
      highWaterMark: pos.highWaterMark,
      reason: 'take_profit', // placeholder, overwritten below
    };

    // Take profit
    if (pnlPct >= this.config.takeProfitPct) {
      return { ...base, reason: 'take_profit' };
    }

    // Stop loss
    if (pnlPct <= -this.config.stopLossPct) {
      return { ...base, reason: 'stop_loss' };
    }

    // Trailing stop (only active after activation threshold)
    const gainFromEntry = ((pos.highWaterMark - pos.entryPrice) / pos.entryPrice) * 100;
    if (gainFromEntry >= this.config.trailingStopActivation) {
      const dropFromHigh = ((pos.highWaterMark - currentPrice) / pos.highWaterMark) * 100;
      if (dropFromHigh >= this.config.trailingStopDistance) {
        return { ...base, reason: 'trailing_stop' };
      }
    }

    // Stagnation
    const hoursOpen = (Date.now() - pos.enteredAt) / (1000 * 60 * 60);
    const absPnl = Math.abs(pnlPct);
    if (hoursOpen >= this.config.stagnationHours && absPnl < 1.0) {
      return { ...base, reason: 'stagnation' };
    }

    return null;
  }

  /** Return all currently tracked symbols. */
  getTrackedSymbols(): string[] {
    return Array.from(this.positions.keys());
  }
}
