import type { Exchange } from 'ccxt';
import type { OrderSide } from '@cryonix/types';

// ============================================================================
// TYPES
// ============================================================================

export interface TrackedPosition {
  id: string;
  signalId: string;
  symbol: string;
  side: OrderSide;
  quantity: number;
  entryPrice: number;
  currentPrice: number;
  stopLoss: number;
  takeProfit: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  maxDrawdown: number;
  maxDrawdownPercent: number;
  highWaterMark: number;
  openedAt: Date;
  lastUpdatedAt: Date;
  entryOrderId: string;
  stopLossOrderId?: string;
  takeProfitOrderId?: string;
  trailingStopEnabled: boolean;
  trailingStopActivationPrice?: number;
  trailingStopDistance?: number;
  metadata?: Record<string, any>;
}

export interface PositionSummary {
  symbol: string;
  side: OrderSide;
  quantity: number;
  entryPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  durationMs: number;
  isProfit: boolean;
}

export interface ClosedPositionRecord {
  id: string;
  signalId: string;
  symbol: string;
  side: OrderSide;
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  realizedPnl: number;
  realizedPnlPercent: number;
  fees: number;
  slippage: number;
  holdingPeriodMs: number;
  exitReason: 'stop_loss' | 'take_profit' | 'trailing_stop' | 'manual' | 'signal' | 'emergency';
  maxDrawdown: number;
  maxProfit: number;
  openedAt: Date;
  closedAt: Date;
  metadata?: Record<string, any>;
}

export interface PortfolioRiskMetrics {
  totalExposure: number;
  totalUnrealizedPnl: number;
  totalRiskAtStop: number;
  averageDrawdown: number;
  positionCount: number;
  largestPosition: number;
  correlatedExposure: Map<string, number>;
}

interface PositionTrackerConfig {
  monitorIntervalMs: number;
  enableTrailingStop: boolean;
  trailingStopPercent: number;
  trailingStopActivationPercent: number;
  priceUpdateCallback?: (positions: TrackedPosition[]) => void;
  stopLossCallback?: (position: TrackedPosition) => void;
  takeProfitCallback?: (position: TrackedPosition) => void;
}

// ============================================================================
// POSITION TRACKER CLASS
// ============================================================================

export class PositionTracker {
  private exchange: Exchange | null = null;
  private positions: Map<string, TrackedPosition> = new Map();
  private closedPositions: ClosedPositionRecord[] = [];
  private monitorInterval: NodeJS.Timeout | null = null;
  private config: PositionTrackerConfig;
  private logFn: (level: 'info' | 'warn' | 'error', message: string, data?: any) => void;

  constructor(
    config?: Partial<PositionTrackerConfig>,
    logFn?: (level: 'info' | 'warn' | 'error', message: string, data?: any) => void
  ) {
    this.config = {
      monitorIntervalMs: 5000,
      enableTrailingStop: false,
      trailingStopPercent: 1.5,
      trailingStopActivationPercent: 1.0, // Activate trailing stop when 1% in profit
      ...config,
    };

    this.logFn = logFn || ((level, message, data) => {
      console[level](`[PositionTracker] ${message}`, data || '');
    });
  }

  /**
   * Set the exchange instance
   */
  setExchange(exchange: Exchange): void {
    this.exchange = exchange;
  }

  /**
   * Start position monitoring
   */
  startMonitoring(): void {
    if (this.monitorInterval) return;

    this.monitorInterval = setInterval(
      () => this.updateAllPositions(),
      this.config.monitorIntervalMs
    );
    this.logFn('info', 'Position monitoring started');
  }

  /**
   * Stop position monitoring
   */
  stopMonitoring(): void {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
      this.logFn('info', 'Position monitoring stopped');
    }
  }

  /**
   * Track a new position
   */
  trackPosition(position: Omit<TrackedPosition, 'unrealizedPnl' | 'unrealizedPnlPercent' | 'maxDrawdown' | 'maxDrawdownPercent' | 'highWaterMark' | 'lastUpdatedAt'>): TrackedPosition {
    const trackedPosition: TrackedPosition = {
      ...position,
      currentPrice: position.entryPrice,
      unrealizedPnl: 0,
      unrealizedPnlPercent: 0,
      maxDrawdown: 0,
      maxDrawdownPercent: 0,
      highWaterMark: position.entryPrice,
      lastUpdatedAt: new Date(),
      trailingStopEnabled: this.config.enableTrailingStop,
    };

    this.positions.set(position.symbol, trackedPosition);
    this.logFn('info', `Position tracked: ${position.symbol}`, {
      side: position.side,
      quantity: position.quantity,
      entryPrice: position.entryPrice,
    });

    return trackedPosition;
  }

  /**
   * Update a single position with current market price
   */
  async updatePosition(symbol: string): Promise<TrackedPosition | null> {
    const position = this.positions.get(symbol);
    if (!position) return null;

    if (!this.exchange) {
      this.logFn('warn', 'Exchange not set, cannot update position');
      return position;
    }

    try {
      const ticker = await this.exchange.fetchTicker(symbol);
      if (!ticker?.last) return position;

      const currentPrice = ticker.last;
      position.currentPrice = currentPrice;
      position.lastUpdatedAt = new Date();

      // Calculate unrealized P&L
      this.calculatePnl(position);

      // Update high water mark and drawdown
      this.updateDrawdownMetrics(position);

      // Check trailing stop conditions
      if (position.trailingStopEnabled) {
        this.checkTrailingStop(position);
      }

      // Check if stop-loss or take-profit hit
      const stopHit = this.checkStopLossHit(position);
      const targetHit = this.checkTakeProfitHit(position);

      if (stopHit && this.config.stopLossCallback) {
        this.config.stopLossCallback(position);
      }

      if (targetHit && this.config.takeProfitCallback) {
        this.config.takeProfitCallback(position);
      }

      return position;
    } catch (error) {
      this.logFn('error', `Failed to update position ${symbol}`, { error: String(error) });
      return position;
    }
  }

  /**
   * Update all tracked positions
   */
  async updateAllPositions(): Promise<void> {
    if (this.positions.size === 0) return;

    const symbols = Array.from(this.positions.keys());

    for (const symbol of symbols) {
      await this.updatePosition(symbol);
    }

    // Call price update callback if configured
    if (this.config.priceUpdateCallback) {
      this.config.priceUpdateCallback(Array.from(this.positions.values()));
    }
  }

  /**
   * Calculate P&L for a position
   */
  private calculatePnl(position: TrackedPosition): void {
    const positionValue = position.quantity * position.entryPrice;

    if (position.side === 'BUY') {
      position.unrealizedPnl = (position.currentPrice - position.entryPrice) * position.quantity;
    } else {
      position.unrealizedPnl = (position.entryPrice - position.currentPrice) * position.quantity;
    }

    position.unrealizedPnlPercent = positionValue > 0
      ? (position.unrealizedPnl / positionValue) * 100
      : 0;
  }

  /**
   * Update drawdown metrics
   */
  private updateDrawdownMetrics(position: TrackedPosition): void {
    // Update high water mark based on position direction
    if (position.side === 'BUY') {
      if (position.currentPrice > position.highWaterMark) {
        position.highWaterMark = position.currentPrice;
      }
      // Calculate drawdown from high water mark
      const drawdown = (position.highWaterMark - position.currentPrice) * position.quantity;
      if (drawdown > position.maxDrawdown) {
        position.maxDrawdown = drawdown;
        position.maxDrawdownPercent = (drawdown / (position.quantity * position.highWaterMark)) * 100;
      }
    } else {
      // For short positions, low price is the high water mark
      if (position.currentPrice < position.highWaterMark || position.highWaterMark === position.entryPrice) {
        position.highWaterMark = position.currentPrice;
      }
      const drawdown = (position.currentPrice - position.highWaterMark) * position.quantity;
      if (drawdown > position.maxDrawdown) {
        position.maxDrawdown = drawdown;
        position.maxDrawdownPercent = (drawdown / (position.quantity * position.highWaterMark)) * 100;
      }
    }
  }

  /**
   * Check and update trailing stop
   */
  private checkTrailingStop(position: TrackedPosition): void {
    const pnlPercent = position.unrealizedPnlPercent;

    // Check if trailing stop should be activated
    if (!position.trailingStopActivationPrice && pnlPercent >= this.config.trailingStopActivationPercent) {
      position.trailingStopActivationPrice = position.currentPrice;
      position.trailingStopDistance = position.currentPrice * (this.config.trailingStopPercent / 100);
      this.logFn('info', `Trailing stop activated for ${position.symbol}`, {
        activationPrice: position.trailingStopActivationPrice,
        distance: position.trailingStopDistance,
      });
    }

    // Update trailing stop if active
    if (position.trailingStopActivationPrice && position.trailingStopDistance) {
      let newStopLoss: number;

      if (position.side === 'BUY') {
        newStopLoss = position.currentPrice - position.trailingStopDistance;
        if (newStopLoss > position.stopLoss) {
          this.logFn('info', `Trailing stop updated for ${position.symbol}: ${position.stopLoss} -> ${newStopLoss}`);
          position.stopLoss = newStopLoss;
        }
      } else {
        newStopLoss = position.currentPrice + position.trailingStopDistance;
        if (newStopLoss < position.stopLoss) {
          this.logFn('info', `Trailing stop updated for ${position.symbol}: ${position.stopLoss} -> ${newStopLoss}`);
          position.stopLoss = newStopLoss;
        }
      }
    }
  }

  /**
   * Check if stop-loss is hit
   */
  private checkStopLossHit(position: TrackedPosition): boolean {
    if (position.side === 'BUY') {
      return position.currentPrice <= position.stopLoss;
    } else {
      return position.currentPrice >= position.stopLoss;
    }
  }

  /**
   * Check if take-profit is hit
   */
  private checkTakeProfitHit(position: TrackedPosition): boolean {
    if (position.side === 'BUY') {
      return position.currentPrice >= position.takeProfit;
    } else {
      return position.currentPrice <= position.takeProfit;
    }
  }

  /**
   * Close a position and record it
   */
  closePosition(
    symbol: string,
    exitPrice: number,
    exitReason: ClosedPositionRecord['exitReason'],
    fees: number = 0
  ): ClosedPositionRecord | null {
    const position = this.positions.get(symbol);
    if (!position) return null;

    // Calculate final P&L
    let realizedPnl: number;
    if (position.side === 'BUY') {
      realizedPnl = (exitPrice - position.entryPrice) * position.quantity;
    } else {
      realizedPnl = (position.entryPrice - exitPrice) * position.quantity;
    }
    realizedPnl -= fees;

    const realizedPnlPercent = (realizedPnl / (position.quantity * position.entryPrice)) * 100;

    // Calculate slippage
    const expectedExitPrice = exitReason === 'stop_loss' ? position.stopLoss : position.takeProfit;
    const slippage = Math.abs(exitPrice - expectedExitPrice) / expectedExitPrice * 100;

    const closedPosition: ClosedPositionRecord = {
      id: position.id,
      signalId: position.signalId,
      symbol: position.symbol,
      side: position.side,
      quantity: position.quantity,
      entryPrice: position.entryPrice,
      exitPrice,
      realizedPnl,
      realizedPnlPercent,
      fees,
      slippage,
      holdingPeriodMs: Date.now() - position.openedAt.getTime(),
      exitReason,
      maxDrawdown: position.maxDrawdown,
      maxProfit: position.side === 'BUY'
        ? (position.highWaterMark - position.entryPrice) * position.quantity
        : (position.entryPrice - position.highWaterMark) * position.quantity,
      openedAt: position.openedAt,
      closedAt: new Date(),
      metadata: position.metadata,
    };

    // Remove from active positions
    this.positions.delete(symbol);

    // Add to closed positions history
    this.closedPositions.push(closedPosition);

    // Keep only last 1000 closed positions in memory
    if (this.closedPositions.length > 1000) {
      this.closedPositions = this.closedPositions.slice(-1000);
    }

    this.logFn('info', `Position closed: ${symbol}`, {
      exitReason,
      realizedPnl: `$${realizedPnl.toFixed(2)} (${realizedPnlPercent.toFixed(2)}%)`,
      holdingPeriod: `${Math.round(closedPosition.holdingPeriodMs / 60000)}m`,
    });

    return closedPosition;
  }

  /**
   * Get a position by symbol
   */
  getPosition(symbol: string): TrackedPosition | undefined {
    return this.positions.get(symbol);
  }

  /**
   * Get all open positions
   */
  getOpenPositions(): TrackedPosition[] {
    return Array.from(this.positions.values());
  }

  /**
   * Get position summaries
   */
  getPositionSummaries(): PositionSummary[] {
    return Array.from(this.positions.values()).map(pos => ({
      symbol: pos.symbol,
      side: pos.side,
      quantity: pos.quantity,
      entryPrice: pos.entryPrice,
      currentPrice: pos.currentPrice,
      unrealizedPnl: pos.unrealizedPnl,
      unrealizedPnlPercent: pos.unrealizedPnlPercent,
      durationMs: Date.now() - pos.openedAt.getTime(),
      isProfit: pos.unrealizedPnl > 0,
    }));
  }

  /**
   * Get closed positions history
   */
  getClosedPositions(limit: number = 50): ClosedPositionRecord[] {
    return this.closedPositions.slice(-limit);
  }

  /**
   * Get portfolio risk metrics
   */
  getPortfolioRiskMetrics(): PortfolioRiskMetrics {
    const positions = this.getOpenPositions();

    let totalExposure = 0;
    let totalUnrealizedPnl = 0;
    let totalRiskAtStop = 0;
    let totalDrawdown = 0;
    let largestPosition = 0;
    const correlatedExposure = new Map<string, number>();

    for (const pos of positions) {
      const positionValue = pos.quantity * pos.currentPrice;
      totalExposure += positionValue;
      totalUnrealizedPnl += pos.unrealizedPnl;
      totalDrawdown += pos.maxDrawdown;

      // Calculate risk at stop
      const riskAtStop = Math.abs(pos.currentPrice - pos.stopLoss) * pos.quantity;
      totalRiskAtStop += riskAtStop;

      if (positionValue > largestPosition) {
        largestPosition = positionValue;
      }

      // Track correlated exposure by base asset
      const baseAsset = pos.symbol.split('/')[0];
      const existing = correlatedExposure.get(baseAsset) || 0;
      correlatedExposure.set(baseAsset, existing + positionValue);
    }

    return {
      totalExposure,
      totalUnrealizedPnl,
      totalRiskAtStop,
      averageDrawdown: positions.length > 0 ? totalDrawdown / positions.length : 0,
      positionCount: positions.length,
      largestPosition,
      correlatedExposure,
    };
  }

  /**
   * Get trading statistics
   */
  getTradingStats(): {
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    winRate: number;
    averageWin: number;
    averageLoss: number;
    profitFactor: number;
    totalPnl: number;
    averageHoldingTime: number;
    bestTrade: number;
    worstTrade: number;
  } {
    const closed = this.closedPositions;

    if (closed.length === 0) {
      return {
        totalTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        winRate: 0,
        averageWin: 0,
        averageLoss: 0,
        profitFactor: 0,
        totalPnl: 0,
        averageHoldingTime: 0,
        bestTrade: 0,
        worstTrade: 0,
      };
    }

    const winners = closed.filter(p => p.realizedPnl > 0);
    const losers = closed.filter(p => p.realizedPnl < 0);

    const totalWins = winners.reduce((sum, p) => sum + p.realizedPnl, 0);
    const totalLosses = Math.abs(losers.reduce((sum, p) => sum + p.realizedPnl, 0));
    const totalPnl = closed.reduce((sum, p) => sum + p.realizedPnl, 0);
    const totalHoldingTime = closed.reduce((sum, p) => sum + p.holdingPeriodMs, 0);

    const pnls = closed.map(p => p.realizedPnl);
    const bestTrade = Math.max(...pnls);
    const worstTrade = Math.min(...pnls);

    return {
      totalTrades: closed.length,
      winningTrades: winners.length,
      losingTrades: losers.length,
      winRate: winners.length / closed.length,
      averageWin: winners.length > 0 ? totalWins / winners.length : 0,
      averageLoss: losers.length > 0 ? totalLosses / losers.length : 0,
      profitFactor: totalLosses > 0 ? totalWins / totalLosses : totalWins > 0 ? Infinity : 0,
      totalPnl,
      averageHoldingTime: totalHoldingTime / closed.length,
      bestTrade,
      worstTrade,
    };
  }

  /**
   * Update stop-loss for a position
   */
  updateStopLoss(symbol: string, newStopLoss: number): boolean {
    const position = this.positions.get(symbol);
    if (!position) return false;

    // Validate new stop-loss
    if (position.side === 'BUY' && newStopLoss >= position.currentPrice) {
      this.logFn('warn', 'Invalid stop-loss for long position', { newStopLoss, currentPrice: position.currentPrice });
      return false;
    }
    if (position.side === 'SELL' && newStopLoss <= position.currentPrice) {
      this.logFn('warn', 'Invalid stop-loss for short position', { newStopLoss, currentPrice: position.currentPrice });
      return false;
    }

    position.stopLoss = newStopLoss;
    this.logFn('info', `Stop-loss updated for ${symbol}: ${newStopLoss}`);
    return true;
  }

  /**
   * Update take-profit for a position
   */
  updateTakeProfit(symbol: string, newTakeProfit: number): boolean {
    const position = this.positions.get(symbol);
    if (!position) return false;

    position.takeProfit = newTakeProfit;
    this.logFn('info', `Take-profit updated for ${symbol}: ${newTakeProfit}`);
    return true;
  }

  /**
   * Check if already in position for a symbol
   */
  hasPosition(symbol: string): boolean {
    return this.positions.has(symbol);
  }

  /**
   * Get count of open positions
   */
  getOpenPositionCount(): number {
    return this.positions.size;
  }

  /**
   * Clear all positions (emergency)
   */
  clearAllPositions(): void {
    this.positions.clear();
    this.logFn('warn', 'All positions cleared from tracker');
  }
}
