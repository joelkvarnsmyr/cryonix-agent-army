/**
 * Timing Service - Position Velocity & ETA Estimation
 * Handles real-time monitoring of trade progress and stagnation exits.
 */

export interface TimingMetrics {
  velocity: number;
  lastPrice: number;
  estimatedTpTime?: string;
}

export class TimingService {
  private static readonly CYCLE_INTERVAL_MIN = 0.5; // 30 seconds

  /**
   * Updates velocity and calculates new ETA for a position.
   */
  static calculateMetrics(
    currentPrice: number,
    entryPrice: number,
    takeProfit: number,
    side: string,
    previousVelocity?: number,
    previousPrice?: number
  ): TimingMetrics {
    const lastPrice = previousPrice || entryPrice;
    const priceDelta = currentPrice - lastPrice;
    const currentVelocity = priceDelta / this.CYCLE_INTERVAL_MIN; // $/min

    // Smoothing velocity (EMA-like)
    const velocity = previousVelocity !== undefined
      ? (previousVelocity * 0.8) + (currentVelocity * 0.2)
      : currentVelocity;

    let estimatedTpTime: string | undefined;

    // Estimate time to TP
    if (side === 'BUY' && currentPrice < takeProfit && velocity > 0) {
      const distance = takeProfit - currentPrice;
      const minutesToTp = distance / velocity;
      if (minutesToTp < 1440) {
        estimatedTpTime = new Date(Date.now() + minutesToTp * 60000).toISOString();
      }
    } else if (side === 'SELL' && currentPrice > takeProfit && velocity < 0) {
      const distance = currentPrice - takeProfit;
      const minutesToTp = distance / Math.abs(velocity);
      if (minutesToTp < 1440) {
        estimatedTpTime = new Date(Date.now() + minutesToTp * 60000).toISOString();
      }
    }

    return { velocity, lastPrice: currentPrice, estimatedTpTime };
  }

  /**
   * Checks if a position has stagnant movement.
   */
  static isStagnant(
    openedAt: string,
    pnlPct: number,
    options: {
      isScalp?: boolean;
      overrideHours?: number;
      defaultTimeout?: number;
      minPnl?: number;
      scalpMaxHoldMins?: number;
    }
  ): { stagnant: boolean; ageHours: number; timeout: number } {
    const ageHours = (Date.now() - new Date(openedAt).getTime()) / (1000 * 60 * 60);
    
    const timeout = options.overrideHours || (options.isScalp
      ? (options.scalpMaxHoldMins || 45) / 60
      : (options.defaultTimeout || 16));

    const minPnl = options.isScalp ? 0.3 : (options.minPnl || 1.0);

    const stagnant = ageHours > timeout && Math.abs(pnlPct) < minPnl;

    return { stagnant, ageHours, timeout };
  }
}
