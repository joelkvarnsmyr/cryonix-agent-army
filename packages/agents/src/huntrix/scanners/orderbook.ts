import type { SpoofDetection } from '../types';

interface OrderBookLevel {
  price: number;
  amount: number; // in base currency
}

interface OrderBookSnapshot {
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  timestamp: number;
}

const MIN_WALL_USD = 50_000;  // Minimum wall size to track ($50K)
const DISAPPEAR_THRESHOLD = 0.80; // 80% must vanish to count as spoof

export class OrderBookSpoofDetector {
  /**
   * Compare two order book snapshots to detect spoofing.
   * A spoof is when a large wall ($50K+) disappears (80%+) without price filling through.
   */
  detect(
    before: OrderBookSnapshot,
    after: OrderBookSnapshot,
    symbol: string,
    midPrice: number,
  ): SpoofDetection[] {
    const detections: SpoofDetection[] = [];

    // Check bid walls (large buy walls that vanish)
    const bidSpoofs = this.findPhantomWalls(before.bids, after.bids, midPrice, 'bid');
    detections.push(...bidSpoofs.map(s => ({
      ...s,
      symbol,
      snapshot_interval_ms: after.timestamp - before.timestamp,
      detected_at: new Date().toISOString(),
    })));

    // Check ask walls (large sell walls that vanish)
    const askSpoofs = this.findPhantomWalls(before.asks, after.asks, midPrice, 'ask');
    detections.push(...askSpoofs.map(s => ({
      ...s,
      symbol,
      snapshot_interval_ms: after.timestamp - before.timestamp,
      detected_at: new Date().toISOString(),
    })));

    return detections;
  }

  /**
   * Find large walls in "before" that disappeared in "after"
   * without price filling through them.
   */
  private findPhantomWalls(
    before: OrderBookLevel[],
    after: OrderBookLevel[],
    midPrice: number,
    side: 'bid' | 'ask',
  ): Omit<SpoofDetection, 'symbol' | 'snapshot_interval_ms' | 'detected_at'>[] {
    const phantoms: Omit<SpoofDetection, 'symbol' | 'snapshot_interval_ms' | 'detected_at'>[] = [];

    for (const level of before) {
      const wallUsd = level.price * level.amount;
      if (wallUsd < MIN_WALL_USD) continue;

      // Find same price level in "after"
      const afterLevel = after.find(a => Math.abs(a.price - level.price) / level.price < 0.001);
      const afterAmount = afterLevel?.amount || 0;

      // How much disappeared?
      const disappeared = (level.amount - afterAmount) / level.amount;

      if (disappeared < DISAPPEAR_THRESHOLD) continue;

      // Check that price did NOT fill through the wall
      // For bids: price should still be above the wall (wall wasn't hit)
      // For asks: price should still be below the wall (wall wasn't hit)
      const priceFilled = side === 'bid'
        ? midPrice <= level.price  // Price dropped through bid wall = real selling
        : midPrice >= level.price; // Price rose through ask wall = real buying

      if (priceFilled) continue; // Not a spoof — wall was actually filled

      phantoms.push({
        side,
        wall_size_usd: wallUsd,
        wall_price: level.price,
        disappeared_pct: disappeared * 100,
      });
    }

    return phantoms;
  }

  /**
   * Create OrderBookSnapshot from CCXT fetchOrderBook result.
   */
  static fromCCXT(orderbook: any): OrderBookSnapshot {
    return {
      bids: (orderbook.bids || []).map((b: [number, number]) => ({ price: b[0], amount: b[1] })),
      asks: (orderbook.asks || []).map((a: [number, number]) => ({ price: a[0], amount: a[1] })),
      timestamp: orderbook.timestamp || Date.now(),
    };
  }
}
