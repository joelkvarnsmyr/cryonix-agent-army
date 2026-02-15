import ccxt, { Exchange, Order } from 'ccxt';
import type { OrderSide, OrderType, OrderStatus } from '@cryonix/types';

// ============================================================================
// TYPES
// ============================================================================

export interface OrderRequest {
  symbol: string;
  side: OrderSide;
  type: 'market' | 'limit' | 'stop_loss' | 'stop_loss_limit' | 'take_profit';
  quantity: number;
  price?: number;
  stopPrice?: number;
  clientOrderId?: string;
  timeInForce?: 'GTC' | 'IOC' | 'FOK';
}

export interface ManagedOrder {
  id: string;
  clientOrderId?: string;
  symbol: string;
  side: OrderSide;
  type: string;
  quantity: number;
  price?: number;
  stopPrice?: number;
  status: OrderStatus;
  filledQuantity: number;
  averagePrice: number;
  fees: number;
  createdAt: Date;
  updatedAt: Date;
  rawOrder?: Order;
}

export interface ProtectiveOrderSet {
  entryOrderId: string;
  stopLossOrderId?: string;
  takeProfitOrderId?: string;
  ocoOrderId?: string; // If using OCO
  symbol: string;
  isActive: boolean;
}

export interface CircuitBreakerState {
  isOpen: boolean;
  failures: number;
  lastFailure: Date | null;
  resetAt: Date | null;
}

interface OrderManagerConfig {
  maxRetries: number;
  retryDelayMs: number;
  orderTimeoutMs: number;
  circuitBreakerThreshold: number;
  circuitBreakerResetMs: number;
  enablePartialFills: boolean;
}

// ============================================================================
// ORDER MANAGER CLASS
// ============================================================================

export class OrderManager {
  private exchange: Exchange | null = null;
  private activeOrders: Map<string, ManagedOrder> = new Map();
  private protectiveOrders: Map<string, ProtectiveOrderSet> = new Map();
  private circuitBreaker: CircuitBreakerState = {
    isOpen: false,
    failures: 0,
    lastFailure: null,
    resetAt: null,
  };
  private config: OrderManagerConfig;
  private logFn: (level: 'info' | 'warn' | 'error', message: string, data?: any) => void;

  constructor(
    config?: Partial<OrderManagerConfig>,
    logFn?: (level: 'info' | 'warn' | 'error', message: string, data?: any) => void
  ) {
    this.config = {
      maxRetries: 3,
      retryDelayMs: 1000,
      orderTimeoutMs: 30000,
      circuitBreakerThreshold: 5,
      circuitBreakerResetMs: 60000, // 1 minute
      enablePartialFills: true,
      ...config,
    };

    this.logFn = logFn || ((level, message, data) => {
      console[level](`[OrderManager] ${message}`, data || '');
    });
  }

  /**
   * Set the exchange instance
   */
  setExchange(exchange: Exchange): void {
    this.exchange = exchange;
  }

  /**
   * Check if circuit breaker is open
   */
  isCircuitBreakerOpen(): boolean {
    if (!this.circuitBreaker.isOpen) return false;

    // Check if reset time has passed
    if (this.circuitBreaker.resetAt && new Date() > this.circuitBreaker.resetAt) {
      this.resetCircuitBreaker();
      return false;
    }

    return true;
  }

  /**
   * Record a failure for circuit breaker
   */
  private recordFailure(): void {
    this.circuitBreaker.failures++;
    this.circuitBreaker.lastFailure = new Date();

    if (this.circuitBreaker.failures >= this.config.circuitBreakerThreshold) {
      this.circuitBreaker.isOpen = true;
      this.circuitBreaker.resetAt = new Date(Date.now() + this.config.circuitBreakerResetMs);
      this.logFn('warn', 'Circuit breaker OPENED', {
        failures: this.circuitBreaker.failures,
        resetAt: this.circuitBreaker.resetAt,
      });
    }
  }

  /**
   * Reset circuit breaker
   */
  resetCircuitBreaker(): void {
    this.circuitBreaker = {
      isOpen: false,
      failures: 0,
      lastFailure: null,
      resetAt: null,
    };
    this.logFn('info', 'Circuit breaker RESET');
  }

  /**
   * Create a market order
   */
  async createMarketOrder(
    symbol: string,
    side: OrderSide,
    quantity: number,
    clientOrderId?: string
  ): Promise<ManagedOrder> {
    return this.createOrder({
      symbol,
      side,
      type: 'market',
      quantity,
      clientOrderId,
    });
  }

  /**
   * Create a limit order
   */
  async createLimitOrder(
    symbol: string,
    side: OrderSide,
    quantity: number,
    price: number,
    clientOrderId?: string
  ): Promise<ManagedOrder> {
    return this.createOrder({
      symbol,
      side,
      type: 'limit',
      quantity,
      price,
      clientOrderId,
    });
  }

  /**
   * Create a stop-loss order
   */
  async createStopLossOrder(
    symbol: string,
    side: OrderSide,
    quantity: number,
    stopPrice: number,
    limitPrice?: number,
    clientOrderId?: string
  ): Promise<ManagedOrder> {
    return this.createOrder({
      symbol,
      side,
      type: limitPrice ? 'stop_loss_limit' : 'stop_loss',
      quantity,
      price: limitPrice,
      stopPrice,
      clientOrderId,
    });
  }

  /**
   * Create any order type with retry logic
   */
  async createOrder(request: OrderRequest): Promise<ManagedOrder> {
    if (!this.exchange) {
      throw new Error('Exchange not initialized');
    }

    if (this.isCircuitBreakerOpen()) {
      throw new Error('Circuit breaker is open - order creation blocked');
    }

    let lastError: Error | null = null;
    let attempt = 0;

    while (attempt < this.config.maxRetries) {
      attempt++;

      try {
        const order = await this.executeOrder(request);
        return order;
      } catch (error) {
        lastError = error as Error;
        this.logFn('warn', `Order attempt ${attempt} failed`, { error: String(error) });
        this.recordFailure();

        if (attempt < this.config.maxRetries) {
          await this.sleep(this.config.retryDelayMs * attempt);
        }
      }
    }

    throw lastError || new Error('Order creation failed after all retries');
  }

  /**
   * Execute an order on the exchange
   */
  private async executeOrder(request: OrderRequest): Promise<ManagedOrder> {
    let rawOrder: Order;
    const side = request.side.toLowerCase() as 'buy' | 'sell';

    switch (request.type) {
      case 'market':
        rawOrder = await this.exchange!.createMarketOrder(
          request.symbol,
          side,
          request.quantity,
          undefined,
          request.clientOrderId ? { clientOrderId: request.clientOrderId } : undefined
        );
        break;

      case 'limit':
        if (!request.price) throw new Error('Limit order requires price');
        rawOrder = await this.exchange!.createLimitOrder(
          request.symbol,
          side,
          request.quantity,
          request.price,
          request.clientOrderId ? { clientOrderId: request.clientOrderId } : undefined
        );
        break;

      case 'stop_loss':
      case 'stop_loss_limit':
        if (!request.stopPrice) throw new Error('Stop order requires stopPrice');
        rawOrder = await this.exchange!.createOrder(
          request.symbol,
          request.type,
          side,
          request.quantity,
          request.price,
          {
            stopPrice: request.stopPrice,
            ...(request.clientOrderId ? { clientOrderId: request.clientOrderId } : {}),
          }
        );
        break;

      case 'take_profit':
        if (!request.price) throw new Error('Take profit order requires price');
        rawOrder = await this.exchange!.createLimitOrder(
          request.symbol,
          side,
          request.quantity,
          request.price,
          request.clientOrderId ? { clientOrderId: request.clientOrderId } : undefined
        );
        break;

      default:
        throw new Error(`Unknown order type: ${request.type}`);
    }

    const managedOrder: ManagedOrder = {
      id: rawOrder.id,
      clientOrderId: rawOrder.clientOrderId,
      symbol: request.symbol,
      side: request.side,
      type: request.type,
      quantity: request.quantity,
      price: request.price,
      stopPrice: request.stopPrice,
      status: this.mapOrderStatus(rawOrder.status),
      filledQuantity: rawOrder.filled || 0,
      averagePrice: rawOrder.average || rawOrder.price || 0,
      fees: rawOrder.fee?.cost || 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      rawOrder,
    };

    this.activeOrders.set(managedOrder.id, managedOrder);
    this.logFn('info', `Order created: ${managedOrder.id}`, {
      symbol: managedOrder.symbol,
      type: managedOrder.type,
      side: managedOrder.side,
      quantity: managedOrder.quantity,
    });

    return managedOrder;
  }

  /**
   * Place protective orders (stop-loss and take-profit)
   */
  async placeProtectiveOrders(
    entryOrderId: string,
    symbol: string,
    quantity: number,
    entrySide: OrderSide,
    stopLossPrice: number,
    takeProfitPrice: number
  ): Promise<ProtectiveOrderSet> {
    const closeSide: OrderSide = entrySide === 'BUY' ? 'SELL' : 'BUY';

    const orderSet: ProtectiveOrderSet = {
      entryOrderId,
      symbol,
      isActive: true,
    };

    try {
      // Place stop-loss order
      const slOrder = await this.createStopLossOrder(
        symbol,
        closeSide,
        quantity,
        stopLossPrice,
        stopLossPrice // Using limit price same as stop
      );
      orderSet.stopLossOrderId = slOrder.id;
      this.logFn('info', `Stop-loss order placed at ${stopLossPrice}`, { orderId: slOrder.id });
    } catch (error) {
      this.logFn('warn', 'Failed to place stop-loss order', { error: String(error) });
    }

    try {
      // Place take-profit order (limit order)
      const tpOrder = await this.createLimitOrder(
        symbol,
        closeSide,
        quantity,
        takeProfitPrice
      );
      orderSet.takeProfitOrderId = tpOrder.id;
      this.logFn('info', `Take-profit order placed at ${takeProfitPrice}`, { orderId: tpOrder.id });
    } catch (error) {
      this.logFn('warn', 'Failed to place take-profit order', { error: String(error) });
    }

    this.protectiveOrders.set(symbol, orderSet);
    return orderSet;
  }

  /**
   * Cancel an order
   */
  async cancelOrder(orderId: string, symbol: string): Promise<boolean> {
    if (!this.exchange) return false;

    try {
      await this.exchange.cancelOrder(orderId, symbol);
      const order = this.activeOrders.get(orderId);
      if (order) {
        order.status = 'CANCELLED';
        order.updatedAt = new Date();
      }
      this.logFn('info', `Order cancelled: ${orderId}`);
      return true;
    } catch (error) {
      this.logFn('warn', `Failed to cancel order ${orderId}`, { error: String(error) });
      return false;
    }
  }

  /**
   * Cancel all protective orders for a symbol
   */
  async cancelProtectiveOrders(symbol: string): Promise<void> {
    const orderSet = this.protectiveOrders.get(symbol);
    if (!orderSet || !orderSet.isActive) return;

    if (orderSet.stopLossOrderId) {
      await this.cancelOrder(orderSet.stopLossOrderId, symbol);
    }
    if (orderSet.takeProfitOrderId) {
      await this.cancelOrder(orderSet.takeProfitOrderId, symbol);
    }

    orderSet.isActive = false;
    this.logFn('info', `Protective orders cancelled for ${symbol}`);
  }

  /**
   * Get order status with polling
   */
  async getOrderStatus(orderId: string, symbol: string): Promise<ManagedOrder | null> {
    if (!this.exchange) return null;

    try {
      const rawOrder = await this.exchange.fetchOrder(orderId, symbol);
      const managedOrder = this.activeOrders.get(orderId);

      if (managedOrder) {
        managedOrder.status = this.mapOrderStatus(rawOrder.status);
        managedOrder.filledQuantity = rawOrder.filled || 0;
        managedOrder.averagePrice = rawOrder.average || rawOrder.price || 0;
        managedOrder.fees = rawOrder.fee?.cost || 0;
        managedOrder.updatedAt = new Date();
        managedOrder.rawOrder = rawOrder;
        return managedOrder;
      }

      // Create new managed order if not tracked
      const newManagedOrder: ManagedOrder = {
        id: rawOrder.id,
        clientOrderId: rawOrder.clientOrderId,
        symbol,
        side: rawOrder.side?.toUpperCase() as OrderSide,
        type: rawOrder.type || 'unknown',
        quantity: rawOrder.amount || 0,
        price: rawOrder.price,
        status: this.mapOrderStatus(rawOrder.status),
        filledQuantity: rawOrder.filled || 0,
        averagePrice: rawOrder.average || rawOrder.price || 0,
        fees: rawOrder.fee?.cost || 0,
        createdAt: new Date(rawOrder.timestamp || Date.now()),
        updatedAt: new Date(),
        rawOrder,
      };

      this.activeOrders.set(orderId, newManagedOrder);
      return newManagedOrder;
    } catch (error) {
      this.logFn('error', `Failed to fetch order ${orderId}`, { error: String(error) });
      return null;
    }
  }

  /**
   * Wait for an order to be filled
   */
  async waitForFill(
    orderId: string,
    symbol: string,
    timeoutMs?: number
  ): Promise<ManagedOrder> {
    const timeout = timeoutMs || this.config.orderTimeoutMs;
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const order = await this.getOrderStatus(orderId, symbol);

      if (!order) {
        throw new Error(`Order ${orderId} not found`);
      }

      if (order.status === 'FILLED') {
        return order;
      }

      if (order.status === 'CANCELLED' || order.status === 'REJECTED') {
        throw new Error(`Order ${orderId} was ${order.status}`);
      }

      // Handle partial fills if enabled
      if (this.config.enablePartialFills && order.status === 'PARTIALLY_FILLED') {
        if (order.filledQuantity > 0) {
          this.logFn('info', `Partial fill: ${order.filledQuantity}/${order.quantity}`);
        }
      }

      await this.sleep(500);
    }

    throw new Error(`Order ${orderId} not filled within ${timeout}ms`);
  }

  /**
   * Update stop-loss price (cancel and replace)
   */
  async updateStopLoss(
    symbol: string,
    quantity: number,
    newStopPrice: number
  ): Promise<string | null> {
    const orderSet = this.protectiveOrders.get(symbol);
    if (!orderSet?.stopLossOrderId) return null;

    // Cancel existing stop-loss
    await this.cancelOrder(orderSet.stopLossOrderId, symbol);

    // Place new stop-loss
    const side: OrderSide = orderSet.entryOrderId ? 'SELL' : 'BUY'; // Simplified, should track actual side
    try {
      const newOrder = await this.createStopLossOrder(
        symbol,
        side,
        quantity,
        newStopPrice,
        newStopPrice
      );
      orderSet.stopLossOrderId = newOrder.id;
      this.logFn('info', `Stop-loss updated to ${newStopPrice}`, { orderId: newOrder.id });
      return newOrder.id;
    } catch (error) {
      this.logFn('error', 'Failed to update stop-loss', { error: String(error) });
      return null;
    }
  }

  /**
   * Get all active orders
   */
  getActiveOrders(): ManagedOrder[] {
    return Array.from(this.activeOrders.values()).filter(
      order => order.status === 'PENDING' || order.status === 'PARTIALLY_FILLED'
    );
  }

  /**
   * Get protective orders for a symbol
   */
  getProtectiveOrders(symbol: string): ProtectiveOrderSet | undefined {
    return this.protectiveOrders.get(symbol);
  }

  /**
   * Get circuit breaker state
   */
  getCircuitBreakerState(): CircuitBreakerState {
    return { ...this.circuitBreaker };
  }

  /**
   * Map CCXT order status to our status
   */
  private mapOrderStatus(status?: string): OrderStatus {
    switch (status) {
      case 'open':
        return 'PENDING';
      case 'closed':
      case 'filled':
        return 'FILLED';
      case 'canceled':
      case 'cancelled':
        return 'CANCELLED';
      case 'rejected':
      case 'expired':
        return 'REJECTED';
      default:
        return 'PENDING';
    }
  }

  /**
   * Helper sleep function
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
