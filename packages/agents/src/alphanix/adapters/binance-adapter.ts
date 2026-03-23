import type { Candle, OrderBook, NormalizedOrder, OrderResult,
              NormalizedPosition, AccountState, AssetClass } from '../types';
import type { MarketAdapter, HealthStatus, SymbolInfo, TradingSchedule, FeeStructure } from './types';

interface BinanceAdapterConfig {
  paper: boolean;
  apiKey?: string;
  apiSecret?: string;
}

export class BinanceAdapter implements MarketAdapter {
  readonly id = 'binance';
  readonly assetClass: AssetClass = 'crypto';

  private exchange: any = null;
  private config: BinanceAdapterConfig;
  private paper = false;
  private paperBalance = 10000;  // Virtual starting balance (USDC)
  private paperPositions = new Map<string, { qty: number; avgPrice: number }>();

  constructor(config: BinanceAdapterConfig) {
    this.config = config;
  }

  private requireExchange(): any {
    if (!this.exchange) throw new Error('Not connected');
    return this.exchange;
  }

  async connect(): Promise<void> {
    this.paper = this.config.paper;
    const ccxt = await import('ccxt');
    // Always connect to real Binance for market data.
    // In paper mode we simulate orders locally instead of using sandbox
    // (sandbox rejects mainnet API keys).
    this.exchange = new ccxt.default.binance({
      apiKey: this.paper ? undefined : this.config.apiKey,
      secret: this.paper ? undefined : this.config.apiSecret,
      enableRateLimit: true,
      options: { defaultType: 'spot' },
    });
  }

  async disconnect(): Promise<void> {
    this.exchange = null;
  }

  async healthCheck(): Promise<HealthStatus> {
    if (!this.exchange) {
      return { connected: false, latencyMs: 0, error: 'Not connected' };
    }
    try {
      const start = Date.now();
      await this.exchange.fetchTime();
      const latencyMs = Date.now() - start;
      return { connected: true, latencyMs };
    } catch (err: any) {
      return { connected: false, latencyMs: 0, error: err.message };
    }
  }

  async getOHLCV(symbol: string, timeframe: string, limit = 100): Promise<Candle[]> {
    const ex = this.requireExchange();
    const raw: any[][] = await ex.fetchOHLCV(symbol, timeframe, undefined, limit);
    return raw.map(([timestamp, open, high, low, close, volume]: number[]) => ({
      timestamp, open, high, low, close, volume,
    }));
  }

  async getOrderBook(symbol: string, depth = 20): Promise<OrderBook> {
    const ex = this.requireExchange();
    const raw = await ex.fetchOrderBook(symbol, depth);
    return {
      bids: raw.bids as Array<[number, number]>,
      asks: raw.asks as Array<[number, number]>,
      timestamp: raw.timestamp ?? Date.now(),
    };
  }

  async getSymbols(): Promise<SymbolInfo[]> {
    const ex = this.requireExchange();
    await ex.loadMarkets();
    const symbols: SymbolInfo[] = [];
    for (const [, market] of Object.entries(ex.markets) as any) {
      if (market.spot && market.active && market.quote === 'USDC') {
        symbols.push({
          symbol: market.symbol,
          baseAsset: market.base,
          quoteAsset: market.quote,
          minQty: market.limits?.amount?.min ?? 0,
          minNotional: market.limits?.cost?.min ?? 0,
          pricePrecision: market.precision?.price ?? 8,
          qtyPrecision: market.precision?.amount ?? 8,
        });
      }
    }
    return symbols;
  }

  async submitOrder(order: NormalizedOrder): Promise<OrderResult> {
    const ex = this.requireExchange();

    if (this.paper) {
      // Paper mode: simulate fill at current market price
      try {
        const ticker = await ex.fetchTicker(order.symbol);
        const fillPrice = order.side === 'BUY'
          ? (ticker.ask || ticker.last)
          : (ticker.bid || ticker.last);
        const fillQty = order.qty > 0 ? order.qty : 1;
        const orderId = `paper-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        // Track in virtual portfolio
        const existing = this.paperPositions.get(order.symbol);
        const currentQty = existing?.qty || 0;
        const newQty = currentQty + (order.side === 'BUY' ? fillQty : -fillQty);
        if (newQty > 0) {
          this.paperPositions.set(order.symbol, { qty: newQty, avgPrice: fillPrice });
        } else {
          this.paperPositions.delete(order.symbol);
        }
        this.paperBalance -= order.side === 'BUY'
          ? fillPrice * fillQty
          : -(fillPrice * fillQty);

        console.log(`[BinanceAdapter:PAPER] ${order.side} ${fillQty} ${order.symbol} @ ${fillPrice} (orderId: ${orderId})`);

        return {
          success: true,
          orderId,
          status: 'filled',
          filledQty: fillQty,
          filledAvgPrice: fillPrice,
        };
      } catch (err: any) {
        return { success: false, message: `Paper sim error: ${err.message}` };
      }
    }

    // Real mode
    try {
      const result = await ex.createOrder(
        order.symbol,
        order.type.toLowerCase(),
        order.side.toLowerCase(),
        order.qty,
        order.type === 'LIMIT' ? order.limitPrice : undefined,
      );
      return {
        success: true,
        orderId: result.id,
        status: result.status,
        filledQty: result.filled ?? 0,
        filledAvgPrice: result.average ?? 0,
      };
    } catch (err: any) {
      return {
        success: false,
        message: err.message,
      };
    }
  }

  async cancelOrder(orderId: string, symbol?: string): Promise<void> {
    if (this.paper) return;  // No-op in paper mode
    const ex = this.requireExchange();
    await ex.cancelOrder(orderId, symbol);
  }

  async getPositions(): Promise<NormalizedPosition[]> {
    const ex = this.requireExchange();

    if (this.paper) {
      const positions: NormalizedPosition[] = [];
      for (const [symbol, pos] of this.paperPositions) {
        if (pos.qty <= 0) continue;
        try {
          const ticker = await ex.fetchTicker(symbol);
          const currentPrice = ticker.last || pos.avgPrice;
          positions.push({
            symbol,
            qty: pos.qty,
            avgEntryPrice: pos.avgPrice,
            currentPrice,
            marketValue: pos.qty * currentPrice,
            unrealizedPnl: pos.qty * (currentPrice - pos.avgPrice),
            unrealizedPnlPct: ((currentPrice - pos.avgPrice) / pos.avgPrice) * 100,
            adapter: this.id,
          });
        } catch { /* skip */ }
      }
      return positions;
    }

    const balance = await ex.fetchBalance();
    const positions: NormalizedPosition[] = [];

    for (const [asset, info] of Object.entries(balance.total ?? {}) as any) {
      if (asset === 'USDC' || asset === 'USDT' || !info || info <= 0) continue;
      const symbol = `${asset}/USDC`;
      try {
        const ticker = await ex.fetchTicker(symbol);
        const currentPrice = ticker.last ?? 0;
        const qty = info as number;
        const marketValue = qty * currentPrice;
        positions.push({
          symbol,
          qty,
          avgEntryPrice: 0, // Not available from balance alone
          currentPrice,
          marketValue,
          unrealizedPnl: 0,
          unrealizedPnlPct: 0,
          adapter: this.id,
        });
      } catch {
        // Symbol may not have a USDC pair — skip
      }
    }

    return positions;
  }

  async getOpenOrders(): Promise<NormalizedOrder[]> {
    const ex = this.requireExchange();
    const orders = await ex.fetchOpenOrders();
    return orders.map((o: any) => ({
      symbol: o.symbol,
      side: (o.side as string).toUpperCase() as 'BUY' | 'SELL',
      type: (o.type as string).toUpperCase() as 'MARKET' | 'LIMIT',
      qty: o.amount,
      limitPrice: o.price ?? undefined,
    }));
  }

  async getAccountState(): Promise<AccountState> {
    if (this.paper) {
      return {
        balance: this.paperBalance,
        equity: this.paperBalance,
        availableCapital: this.paperBalance,
        currency: 'USDC',
        updatedAt: Date.now(),
      };
    }

    const ex = this.requireExchange();
    const balance = await ex.fetchBalance();
    const usdc = balance.USDC ?? { free: 0, total: 0 };
    return {
      balance: usdc.total ?? 0,
      equity: usdc.total ?? 0,
      availableCapital: usdc.free ?? 0,
      currency: 'USDC',
      updatedAt: Date.now(),
    };
  }

  getTradingHours(): TradingSchedule {
    return { alwaysOpen: true };
  }

  getFees(): FeeStructure {
    return { maker: 0.001, taker: 0.001 };
  }
}
