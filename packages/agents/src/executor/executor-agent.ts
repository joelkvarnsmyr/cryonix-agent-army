import { BaseAgent } from '../base-agent';
import type { AgentMessage, TradingSignal, OrderSide, OrderStatus } from '@cryonix/types';
import ccxt, { Exchange, Order } from 'ccxt';
import { OrderManager, type ManagedOrder, type CircuitBreakerState } from './order-manager';
import { PositionTracker, type TrackedPosition, type ClosedPositionRecord, type PortfolioRiskMetrics } from './position-tracker';
import { ExecutionReporter, type ExecutionRecord, type SlippageStats, type ExecutionQualityMetrics } from './execution-reporter';

// ============================================================================
// TYPES
// ============================================================================

export interface ExecuteOrderRequest {
  signalId: string;
  symbol: string;
  side: OrderSide;
  quantity: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  orderType: 'market' | 'limit';
  confidence: number;
  pattern: string;
}

export interface ExecutionResult {
  success: boolean;
  orderId?: string;
  signalId: string;
  symbol: string;
  side: OrderSide;
  status: 'filled' | 'partial' | 'failed' | 'pending';
  executedQuantity: number;
  averagePrice: number;
  timestamp: Date;
  error?: string;
  slippage?: number;
  fees?: number;
}

export interface Position {
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
  openedAt: Date;
  orderId: string;
  stopLossOrderId?: string;
  takeProfitOrderId?: string;
}

export interface ClosedPosition extends Position {
  exitPrice: number;
  exitReason: 'stop_loss' | 'take_profit' | 'manual' | 'signal';
  realizedPnl: number;
  realizedPnlPercent: number;
  closedAt: Date;
  fees: number;
}

interface ExecutorConfig {
  exchange: 'binance' | 'binance_testnet';
  maxSlippagePercent: number;
  retryAttempts: number;
  retryDelayMs: number;
  positionMonitorIntervalMs: number;
  enableTrailingStop: boolean;
  trailingStopPercent: number;
  useOcoOrders: boolean; // One-Cancels-Other for SL/TP
  enableDatabaseLogging: boolean;
  circuitBreakerThreshold: number;
  circuitBreakerResetMs: number;
}

// ============================================================================
// EXECUTOR AGENT
// ============================================================================

export class ExecutorAgent extends BaseAgent {
  private exchange: Exchange | null = null;
  private executorConfig: ExecutorConfig;
  private openPositions: Map<string, Position> = new Map();
  private closedPositions: ClosedPosition[] = [];
  private monitorInterval: NodeJS.Timeout | null = null;
  private isTestnet: boolean = false;

  // New module instances
  private orderManager: OrderManager;
  private positionTracker: PositionTracker;
  private executionReporter: ExecutionReporter;

  constructor(config?: Partial<ExecutorConfig>) {
    super({
      id: 'executor',
      name: 'Executor Agent',
      description: 'Executes trades on exchanges and monitors positions',
      enabled: true,
    });

    this.executorConfig = {
      exchange: 'binance_testnet',
      maxSlippagePercent: 0.5,
      retryAttempts: 3,
      retryDelayMs: 1000,
      positionMonitorIntervalMs: 5000, // Check positions every 5s
      enableTrailingStop: false,
      trailingStopPercent: 1.5,
      useOcoOrders: true,
      enableDatabaseLogging: true,
      circuitBreakerThreshold: 5,
      circuitBreakerResetMs: 60000,
      ...config,
    };

    this.isTestnet = this.executorConfig.exchange === 'binance_testnet' ||
      process.env.BINANCE_TESTNET === 'true';

    // Initialize modules with logging function
    const logFn = (level: 'info' | 'warn' | 'error', message: string, data?: any) => {
      this.log(level, message, data);
    };

    this.orderManager = new OrderManager({
      maxRetries: this.executorConfig.retryAttempts,
      retryDelayMs: this.executorConfig.retryDelayMs,
      circuitBreakerThreshold: this.executorConfig.circuitBreakerThreshold,
      circuitBreakerResetMs: this.executorConfig.circuitBreakerResetMs,
    }, logFn);

    this.positionTracker = new PositionTracker({
      monitorIntervalMs: this.executorConfig.positionMonitorIntervalMs,
      enableTrailingStop: this.executorConfig.enableTrailingStop,
      trailingStopPercent: this.executorConfig.trailingStopPercent,
      stopLossCallback: (pos) => this.handleStopLossHit(pos),
      takeProfitCallback: (pos) => this.handleTakeProfitHit(pos),
      priceUpdateCallback: (positions) => this.handlePositionUpdates(positions),
    }, logFn);

    this.executionReporter = new ExecutionReporter(
      'executor',
      this.executorConfig.enableDatabaseLogging,
      logFn
    );
  }

  /**
   * Handle stop-loss hit callback from position tracker
   */
  private async handleStopLossHit(position: TrackedPosition): Promise<void> {
    this.log('warn', `Stop-loss hit for ${position.symbol}`, { price: position.currentPrice, stopLoss: position.stopLoss });
    await this.closePosition(position.symbol, 'stop_loss');
  }

  /**
   * Handle take-profit hit callback from position tracker
   */
  private async handleTakeProfitHit(position: TrackedPosition): Promise<void> {
    this.log('info', `Take-profit hit for ${position.symbol}`, { price: position.currentPrice, takeProfit: position.takeProfit });
    await this.closePosition(position.symbol, 'take_profit');
  }

  /**
   * Handle position updates from tracker
   */
  private handlePositionUpdates(positions: TrackedPosition[]): void {
    for (const pos of positions) {
      // Update legacy position map for backwards compatibility
      const legacyPos = this.openPositions.get(pos.symbol);
      if (legacyPos) {
        legacyPos.currentPrice = pos.currentPrice;
        legacyPos.unrealizedPnl = pos.unrealizedPnl;
        legacyPos.unrealizedPnlPercent = pos.unrealizedPnlPercent;
      }

      // Emit position update event
      this.emit('position_update', pos);
    }
  }

  async initialize(): Promise<void> {
    this.log('info', 'Initializing Executor Agent...');
    this.log('info', `Exchange: ${this.executorConfig.exchange} (Testnet: ${this.isTestnet})`);

    // Initialize exchange
    const exchangeConfig: any = {
      apiKey: process.env.BINANCE_API_KEY,
      secret: process.env.BINANCE_API_SECRET,
      enableRateLimit: true,
      options: {
        defaultType: 'spot',
      },
    };

    if (this.isTestnet) {
      exchangeConfig.urls = {
        api: {
          public: 'https://testnet.binance.vision/api',
          private: 'https://testnet.binance.vision/api',
        },
      };
      this.log('info', 'Using Binance Testnet');
    }

    this.exchange = new ccxt.binance(exchangeConfig);

    // Verify connection
    try {
      const balance = await this.exchange.fetchBalance();
      const balanceTotal = balance.total as unknown as Record<string, number>;
      const assetCount = Object.keys(balanceTotal).filter((k) => balanceTotal[k] > 0).length;
      this.log('info', 'Exchange connection verified', { assets: assetCount });
    } catch (error) {
      this.log('error', 'Failed to connect to exchange', error);
      throw error;
    }

    this.setStatus('idle');
  }

  async start(): Promise<void> {
    this.log('info', 'Starting Executor Agent...');
    this.setStatus('running');

    // Start position monitoring
    this.monitorInterval = setInterval(
      () => this.monitorPositions(),
      this.executorConfig.positionMonitorIntervalMs
    );

    this.log('info', 'Position monitoring started');
  }

  async stop(): Promise<void> {
    this.log('info', 'Stopping Executor Agent...');

    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }

    this.setStatus('idle');
  }

  async handleMessage(message: AgentMessage): Promise<void> {
    this.log('info', `Received message: ${message.message_type}`, message);

    switch (message.message_type) {
      case 'EXECUTE_ORDER':
        const request = message.data as ExecuteOrderRequest;
        const result = await this.executeOrder(request);
        this.emit('execution_complete', result);
        break;

      case 'CLOSE_POSITION':
        const { symbol, reason } = message.data;
        await this.closePosition(symbol, reason || 'manual');
        break;

      case 'CLOSE_ALL_POSITIONS':
        await this.closeAllPositions(message.data?.reason || 'manual');
        break;

      case 'GET_POSITIONS':
        this.emit('positions_status', {
          open: Array.from(this.openPositions.values()),
          closed: this.closedPositions.slice(-50), // Last 50 closed
        });
        break;
    }
  }

  /**
   * Execute a trade order
   */
  async executeOrder(request: ExecuteOrderRequest): Promise<ExecutionResult> {
    this.log('info', 'Executing order', request);

    if (!this.exchange) {
      return this.failedExecution(request, 'Exchange not initialized');
    }

    // Check if already in position for this symbol
    if (this.openPositions.has(request.symbol)) {
      return this.failedExecution(request, `Already in position for ${request.symbol}`);
    }

    let attempt = 0;
    let lastError: string = '';

    while (attempt < this.executorConfig.retryAttempts) {
      attempt++;

      try {
        // Fetch current price for slippage check
        const ticker = await this.exchange.fetchTicker(request.symbol);
        const currentPrice = ticker.last || request.entryPrice;

        // Check slippage
        const slippagePercent = Math.abs(currentPrice - request.entryPrice) / request.entryPrice * 100;
        if (slippagePercent > this.executorConfig.maxSlippagePercent) {
          this.log('warn', `Slippage too high: ${slippagePercent.toFixed(2)}%`);

          // Adjust quantity if needed for slippage
          if (slippagePercent > this.executorConfig.maxSlippagePercent * 2) {
            return this.failedExecution(
              request,
              `Slippage too high (${slippagePercent.toFixed(2)}%), max allowed ${this.executorConfig.maxSlippagePercent}%`
            );
          }
        }

        // Execute market order
        let order: Order;

        if (request.orderType === 'market') {
          order = await this.exchange.createMarketOrder(
            request.symbol,
            request.side.toLowerCase() as 'buy' | 'sell',
            request.quantity
          );
        } else {
          order = await this.exchange.createLimitOrder(
            request.symbol,
            request.side.toLowerCase() as 'buy' | 'sell',
            request.quantity,
            request.entryPrice
          );
        }

        this.log('info', 'Order placed', order);

        // Wait for fill if market order
        if (request.orderType === 'market') {
          order = await this.waitForFill(request.symbol, order.id);
        }

        const executedPrice = order.average || order.price || currentPrice;
        const executedQuantity = order.filled || request.quantity;

        // Calculate actual slippage
        const actualSlippage = ((executedPrice - request.entryPrice) / request.entryPrice) * 100;

        // Create position record
        const position: Position = {
          id: crypto.randomUUID(),
          signalId: request.signalId,
          symbol: request.symbol,
          side: request.side,
          quantity: executedQuantity,
          entryPrice: executedPrice,
          currentPrice: executedPrice,
          stopLoss: request.stopLoss,
          takeProfit: request.takeProfit,
          unrealizedPnl: 0,
          unrealizedPnlPercent: 0,
          openedAt: new Date(),
          orderId: order.id,
        };

        // Place stop-loss and take-profit orders
        await this.placeProtectiveOrders(position);

        // Track position
        this.openPositions.set(request.symbol, position);

        // Notify risk manager
        this.emit('position_opened', {
          symbol: request.symbol,
          side: request.side,
          entryPrice: executedPrice,
          quantity: executedQuantity,
          value: executedPrice * executedQuantity,
          entryTime: new Date(),
        });

        return {
          success: true,
          orderId: order.id,
          signalId: request.signalId,
          symbol: request.symbol,
          side: request.side,
          status: order.filled === request.quantity ? 'filled' : 'partial',
          executedQuantity,
          averagePrice: executedPrice,
          timestamp: new Date(),
          slippage: actualSlippage,
          fees: order.fee?.cost || 0,
        };

      } catch (error) {
        lastError = String(error);
        this.log('error', `Order attempt ${attempt} failed`, error);

        if (attempt < this.executorConfig.retryAttempts) {
          await this.sleep(this.executorConfig.retryDelayMs * attempt);
        }
      }
    }

    return this.failedExecution(request, `Failed after ${attempt} attempts: ${lastError}`);
  }

  /**
   * Place stop-loss and take-profit orders
   */
  private async placeProtectiveOrders(position: Position): Promise<void> {
    if (!this.exchange) return;

    try {
      const closeSide = position.side === 'BUY' ? 'sell' : 'buy';

      if (this.executorConfig.useOcoOrders) {
        // Try to place OCO order (One-Cancels-Other)
        try {
          // Binance OCO order
          // Note: CCXT doesn't have direct OCO support, would need raw API
          // For now, place separate orders
          this.log('info', 'OCO orders not directly supported, using separate orders');
        } catch {
          // Fall through to separate orders
        }
      }

      // Place stop-loss order
      const slOrder = await this.exchange.createOrder(
        position.symbol,
        'stop_loss_limit',
        closeSide,
        position.quantity,
        position.stopLoss,
        {
          stopPrice: position.stopLoss,
        }
      );
      position.stopLossOrderId = slOrder.id;
      this.log('info', `Stop-loss order placed at ${position.stopLoss}`, slOrder);

      // Place take-profit order
      const tpOrder = await this.exchange.createLimitOrder(
        position.symbol,
        closeSide as 'buy' | 'sell',
        position.quantity,
        position.takeProfit
      );
      position.takeProfitOrderId = tpOrder.id;
      this.log('info', `Take-profit order placed at ${position.takeProfit}`, tpOrder);

    } catch (error) {
      this.log('warn', 'Failed to place protective orders, will monitor manually', error);
    }
  }

  /**
   * Monitor open positions for stop-loss/take-profit
   */
  private async monitorPositions(): Promise<void> {
    if (this.openPositions.size === 0) return;

    for (const [symbol, position] of this.openPositions) {
      try {
        // Fetch current price
        const ticker = await this.exchange?.fetchTicker(symbol);
        if (!ticker || !ticker.last) continue;

        const currentPrice = ticker.last;
        position.currentPrice = currentPrice;

        // Calculate P&L
        if (position.side === 'BUY') {
          position.unrealizedPnl = (currentPrice - position.entryPrice) * position.quantity;
        } else {
          position.unrealizedPnl = (position.entryPrice - currentPrice) * position.quantity;
        }
        position.unrealizedPnlPercent = (position.unrealizedPnl / (position.entryPrice * position.quantity)) * 100;

        // Check protective order status
        if (position.stopLossOrderId && this.exchange) {
          try {
            const order = await this.exchange!.fetchOrder(position.stopLossOrderId, symbol);
            if (order.status === 'filled' || order.status === 'closed') {
              this.log('info', `Stop-loss order filled for ${symbol}`);
              await this.closePosition(symbol, 'stop_loss'); // This records it locally
              continue;
            }
          } catch (e) {
            // Ignore error (order might be gone or fetch failed)
          }
        } else {
          // Manual check
          const hitStopLoss = position.side === 'BUY'
            ? currentPrice <= position.stopLoss
            : currentPrice >= position.stopLoss;

          if (hitStopLoss) {
            this.log('warn', `Stop-loss hit for ${symbol} at ${currentPrice}`);
            await this.closePosition(symbol, 'stop_loss');
            continue;
          }
        }

        if (position.takeProfitOrderId && this.exchange) {
          try {
            const order = await this.exchange!.fetchOrder(position.takeProfitOrderId, symbol);
            if (order.status === 'filled' || order.status === 'closed') {
              this.log('info', `Take-profit order filled for ${symbol}`);
              await this.closePosition(symbol, 'take_profit');
              continue;
            }
          } catch (e) {
            // Ignore
          }
        } else {
          // Manual check
          const hitTakeProfit = position.side === 'BUY'
            ? currentPrice >= position.takeProfit
            : currentPrice <= position.takeProfit;

          if (hitTakeProfit) {
            this.log('info', `Take-profit hit for ${symbol} at ${currentPrice}`);
            await this.closePosition(symbol, 'take_profit');
            continue;
          }
        }

        // Optional: Trailing stop
        if (this.executorConfig.enableTrailingStop && position.unrealizedPnlPercent > 0) {
          const trailingStopPrice = position.side === 'BUY'
            ? currentPrice * (1 - this.executorConfig.trailingStopPercent / 100)
            : currentPrice * (1 + this.executorConfig.trailingStopPercent / 100);

          // Update stop-loss if trailing is better
          const shouldUpdate = position.side === 'BUY'
            ? trailingStopPrice > position.stopLoss
            : trailingStopPrice < position.stopLoss;

          if (shouldUpdate) {
            this.log('info', `Updating trailing stop for ${symbol}: ${position.stopLoss} -> ${trailingStopPrice}`);
            position.stopLoss = trailingStopPrice;
            // TODO: Cancel and replace stop-loss order
          }
        }

        // Emit position update
        this.emit('position_update', position);

      } catch (error) {
        this.log('error', `Error monitoring position ${symbol}`, error);
      }
    }
  }

  /**
   * Close a position
   */
  async closePosition(symbol: string, reason: 'stop_loss' | 'take_profit' | 'manual' | 'signal'): Promise<ClosedPosition | null> {
    const position = this.openPositions.get(symbol);
    if (!position) {
      this.log('warn', `No open position for ${symbol}`);
      return null;
    }

    if (!this.exchange) {
      this.log('error', 'Exchange not initialized');
      return null;
    }

    try {
      // Cancel any pending protective orders
      if (position.stopLossOrderId) {
        try {
          await this.exchange.cancelOrder(position.stopLossOrderId, symbol);
        } catch (e) {
          // Order may already be executed or cancelled
        }
      }
      if (position.takeProfitOrderId) {
        try {
          await this.exchange.cancelOrder(position.takeProfitOrderId, symbol);
        } catch (e) {
          // Order may already be executed or cancelled
        }
      }

      // Close position with market order
      const closeSide = position.side === 'BUY' ? 'sell' : 'buy';
      const closeOrder = await this.exchange.createMarketOrder(
        symbol,
        closeSide,
        position.quantity
      );

      // Wait for fill
      const filledOrder = await this.waitForFill(symbol, closeOrder.id);
      const exitPrice = filledOrder.average || filledOrder.price || position.currentPrice;

      // Calculate realized P&L
      let realizedPnl: number;
      if (position.side === 'BUY') {
        realizedPnl = (exitPrice - position.entryPrice) * position.quantity;
      } else {
        realizedPnl = (position.entryPrice - exitPrice) * position.quantity;
      }

      // Subtract fees
      const fees = (filledOrder.fee?.cost || 0) + (position.entryPrice * position.quantity * 0.001); // Estimate entry fee
      realizedPnl -= fees;

      const realizedPnlPercent = (realizedPnl / (position.entryPrice * position.quantity)) * 100;

      // Create closed position record
      const closedPosition: ClosedPosition = {
        ...position,
        exitPrice,
        exitReason: reason,
        realizedPnl,
        realizedPnlPercent,
        closedAt: new Date(),
        fees,
      };

      // Update tracking
      this.openPositions.delete(symbol);
      this.closedPositions.push(closedPosition);

      // Notify risk manager
      this.emit('position_closed', {
        symbol,
        pnl: realizedPnl,
        pnlPercent: realizedPnlPercent,
        reason,
      });

      this.log('info', `Position closed: ${symbol}`, {
        reason,
        pnl: `$${realizedPnl.toFixed(2)} (${realizedPnlPercent.toFixed(2)}%)`,
      });

      return closedPosition;

    } catch (error) {
      this.log('error', `Failed to close position ${symbol}`, error);
      return null;
    }
  }

  /**
   * Close all open positions (emergency)
   */
  async closeAllPositions(reason: 'manual' | 'emergency' = 'manual'): Promise<ClosedPosition[]> {
    const closed: ClosedPosition[] = [];

    for (const [symbol] of this.openPositions) {
      const result = await this.closePosition(symbol, reason === 'emergency' ? 'stop_loss' : 'manual');
      if (result) {
        closed.push(result);
      }
    }

    this.log('info', `Closed ${closed.length} positions`, { reason });
    return closed;
  }

  /**
   * Wait for order to be filled
   */
  private async waitForFill(symbol: string, orderId: string, maxWaitMs: number = 30000): Promise<Order> {
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      const order = await this.exchange!.fetchOrder(orderId, symbol);

      if (order.status === 'closed' || order.status === 'filled') {
        return order;
      }

      if (order.status === 'canceled' || order.status === 'expired' || order.status === 'rejected') {
        throw new Error(`Order ${orderId} was ${order.status}`);
      }

      await this.sleep(500);
    }

    throw new Error(`Order ${orderId} not filled within ${maxWaitMs}ms`);
  }

  /**
   * Create failed execution result
   */
  private failedExecution(request: ExecuteOrderRequest, error: string): ExecutionResult {
    return {
      success: false,
      signalId: request.signalId,
      symbol: request.symbol,
      side: request.side,
      status: 'failed',
      executedQuantity: 0,
      averagePrice: 0,
      timestamp: new Date(),
      error,
    };
  }

  /**
   * Get open positions
   */
  getOpenPositions(): Position[] {
    return Array.from(this.openPositions.values());
  }

  /**
   * Get closed positions
   */
  getClosedPositions(limit: number = 50): ClosedPosition[] {
    return this.closedPositions.slice(-limit);
  }

  /**
   * Get portfolio summary
   */
  getPortfolioSummary(): {
    openPositionsCount: number;
    totalUnrealizedPnl: number;
    totalRealizedPnl: number;
    winRate: number;
  } {
    const open = this.getOpenPositions();
    const closed = this.closedPositions;

    const totalUnrealizedPnl = open.reduce((sum, p) => sum + p.unrealizedPnl, 0);
    const totalRealizedPnl = closed.reduce((sum, p) => sum + p.realizedPnl, 0);

    const wins = closed.filter((p) => p.realizedPnl > 0).length;
    const winRate = closed.length > 0 ? (wins / closed.length) * 100 : 0;

    return {
      openPositionsCount: open.length,
      totalUnrealizedPnl,
      totalRealizedPnl,
      winRate,
    };
  }
}
