import type { NormalizedPosition } from '../types';

export interface TrackedPositionWithPnl extends NormalizedPosition {
  holdingHours: number;
  dailyPnlPct: number;
}

export class PositionTracker {
  private positions = new Map<string, NormalizedPosition & { openedAt: number }>();

  open(position: NormalizedPosition): void {
    this.positions.set(`${position.adapter}:${position.symbol}`, {
      ...position,
      openedAt: Date.now(),
    });
  }

  close(adapter: string, symbol: string): NormalizedPosition | undefined {
    const key = `${adapter}:${symbol}`;
    const pos = this.positions.get(key);
    this.positions.delete(key);
    return pos;
  }

  update(adapter: string, symbol: string, currentPrice: number): void {
    const key = `${adapter}:${symbol}`;
    const pos = this.positions.get(key);
    if (!pos) return;
    pos.currentPrice = currentPrice;
    pos.marketValue = pos.qty * currentPrice;
    pos.unrealizedPnl = (currentPrice - pos.avgEntryPrice) * pos.qty;
    pos.unrealizedPnlPct = ((currentPrice - pos.avgEntryPrice) / pos.avgEntryPrice) * 100;
  }

  getAll(): TrackedPositionWithPnl[] {
    const result = Array.from(this.positions.values()).map(p => ({
      ...p,
      holdingHours: (Date.now() - p.openedAt) / (1000 * 60 * 60),
      dailyPnlPct: p.unrealizedPnlPct,
      openedAt: new Date(p.openedAt).toISOString(),
    }));

    // Debug: confirm avgEntryPrice is preserved through serialization
    for (const pos of result) {
      if (!pos.avgEntryPrice || pos.avgEntryPrice <= 0) {
        console.error(`[PositionTracker] BUG: ${pos.symbol} has avgEntryPrice=${pos.avgEntryPrice} — PnL will be broken`);
      }
    }

    return result;
  }

  getByAdapter(adapter: string): TrackedPositionWithPnl[] {
    return this.getAll().filter(p => p.adapter === adapter);
  }

  getCount(): number { return this.positions.size; }

  getTotalUnrealizedPnl(): number {
    return Array.from(this.positions.values()).reduce((sum, p) => sum + p.unrealizedPnl, 0);
  }

  getTotalMarketValue(): number {
    return Array.from(this.positions.values()).reduce((sum, p) => sum + p.marketValue, 0);
  }
}
