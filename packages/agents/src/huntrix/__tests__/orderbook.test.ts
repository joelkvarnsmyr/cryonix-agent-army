import { describe, it, expect } from 'vitest';
import { OrderBookSpoofDetector } from '../scanners/orderbook';

describe('OrderBookSpoofDetector', () => {
  const detector = new OrderBookSpoofDetector();

  it('should detect bid wall spoofing', () => {
    const before = {
      bids: [
        { price: 100, amount: 600 }, // $60K wall
        { price: 99, amount: 10 },
      ],
      asks: [{ price: 101, amount: 10 }],
      timestamp: 1000,
    };

    const after = {
      bids: [
        { price: 100, amount: 50 }, // Wall shrunk from 600 to 50 (~92% gone)
        { price: 99, amount: 10 },
      ],
      asks: [{ price: 101, amount: 10 }],
      timestamp: 6000,
    };

    // Mid price is 100.5 — still above the bid wall, so it wasn't filled
    const detections = detector.detect(before, after, 'BTC/USDC', 100.5);
    expect(detections.length).toBe(1);
    expect(detections[0].side).toBe('bid');
    expect(detections[0].wall_size_usd).toBe(60000);
    expect(detections[0].disappeared_pct).toBeGreaterThan(80);
  });

  it('should NOT flag walls that were actually filled', () => {
    const before = {
      bids: [{ price: 100, amount: 600 }], // $60K wall
      asks: [],
      timestamp: 1000,
    };

    const after = {
      bids: [{ price: 100, amount: 50 }], // Wall consumed
      asks: [],
      timestamp: 6000,
    };

    // Mid price dropped to 99 — below the bid wall — it was actually filled
    const detections = detector.detect(before, after, 'BTC/USDC', 99);
    expect(detections.length).toBe(0);
  });

  it('should convert CCXT orderbook format', () => {
    const ccxtBook = {
      bids: [[100, 5], [99, 3]],
      asks: [[101, 4], [102, 2]],
      timestamp: 12345,
    };

    const snapshot = OrderBookSpoofDetector.fromCCXT(ccxtBook);
    expect(snapshot.bids.length).toBe(2);
    expect(snapshot.bids[0].price).toBe(100);
    expect(snapshot.bids[0].amount).toBe(5);
    expect(snapshot.asks.length).toBe(2);
    expect(snapshot.timestamp).toBe(12345);
  });
});
