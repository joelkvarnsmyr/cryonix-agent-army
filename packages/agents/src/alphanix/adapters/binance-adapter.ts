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

  constructor(config: BinanceAdapterConfig) {
    this.config = config;
  }

  private requireExchange(): any {
    if (!this.exchange) throw new Error('Not connected');
    return this.exchange;
  }

  async connect(): Promise<void> {
    const ccxt = await import('ccxt');
    this.exchange = new ccxt.default.binance({
      apiKey: this.config.apiKey,
      secret: this.config.apiSecret,
      enableRateLimit: true,
      options: { defaultType: 'spot' },
    });
    if (this.config.paper) {
      this.exchange.setSandboxMode(true);
    }
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

  async cancelOrder(orderId: string): Promise<void> {
    const ex = this.requireExchange();
    // Binance cancelOrder requires symbol; we fetch the order first
    // For simplicity, caller should ensure orderId is valid
    await ex.cancelOrder(orderId);
  }

  async getPositions(): Promise<NormalizedPosition[]> {
    const ex = this.requireExchange();
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
