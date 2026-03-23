import type { Candle, OrderBook, NormalizedOrder, OrderResult,
              NormalizedPosition, AccountState, AssetClass } from '../types';
import type { MarketAdapter, HealthStatus, SymbolInfo, TradingSchedule, FeeStructure } from './types';

interface AlpacaAdapterOptions {
  paper: boolean;
  apiKey?: string;
  apiSecret?: string;
}

export class AlpacaAdapter implements MarketAdapter {
  readonly id = 'alpaca';
  readonly assetClass: AssetClass = 'stock';

  private client: any = null;
  private options: AlpacaAdapterOptions;

  constructor(options: AlpacaAdapterOptions) {
    this.options = options;
  }

  private requireClient(): any {
    if (!this.client) throw new Error('Not connected');
    return this.client;
  }

  async connect(): Promise<void> {
    const Alpaca = (await import('@alpacahq/alpaca-trade-api')).default;
    this.client = new Alpaca({
      keyId: this.options.apiKey || process.env.ALPACA_API_KEY,
      secretKey: this.options.apiSecret || process.env.ALPACA_API_SECRET,
      paper: this.options.paper,
    });
  }

  async disconnect(): Promise<void> {
    this.client = null;
  }

  async healthCheck(): Promise<HealthStatus> {
    if (!this.client) {
      return { connected: false, latencyMs: 0, error: 'Not connected' };
    }
    try {
      const start = Date.now();
      await this.client.getAccount();
      return { connected: true, latencyMs: Date.now() - start };
    } catch (err: any) {
      return { connected: false, latencyMs: 0, error: err.message };
    }
  }

  async getOHLCV(symbol: string, timeframe: string = '15Min', limit: number = 100): Promise<Candle[]> {
    const client = this.requireClient();
    const bars = client.getBarsV2(symbol, {
      timeframe,
      limit,
      feed: 'iex',
    });
    const candles: Candle[] = [];
    for await (const bar of bars) {
      candles.push({
        timestamp: new Date(bar.Timestamp).getTime(),
        open: bar.OpenPrice,
        high: bar.HighPrice,
        low: bar.LowPrice,
        close: bar.ClosePrice,
        volume: bar.Volume,
      });
    }
    return candles;
  }

  async getOrderBook(_symbol: string, _depth: number = 20): Promise<OrderBook> {
    // Alpaca doesn't expose a full order book on the free/basic tier.
    // Return empty book — execution agent will skip spread check for stocks.
    return { bids: [], asks: [], timestamp: Date.now() };
  }

  async getSymbols(): Promise<SymbolInfo[]> {
    const client = this.requireClient();
    const assets = await client.getAssets({ status: 'active', asset_class: 'us_equity' });
    return assets
      .filter((a: any) => a.tradable && a.fractionable)
      .slice(0, 500)
      .map((a: any) => ({
        symbol: a.symbol,
        baseAsset: a.symbol,
        quoteAsset: 'USD',
        minQty: 0.001,       // fractional shares
        minNotional: 1,
        pricePrecision: 2,
        qtyPrecision: 4,
      }));
  }

  async submitOrder(order: NormalizedOrder): Promise<OrderResult> {
    const client = this.requireClient();
    try {
      const result = await client.createOrder({
        symbol: order.symbol,
        qty: order.qty,
        side: order.side.toLowerCase(),
        type: order.type.toLowerCase(),
        time_in_force: 'day',
        ...(order.limitPrice ? { limit_price: order.limitPrice } : {}),
      });
      return {
        success: true,
        orderId: result.id,
        status: result.status,
        filledQty: parseFloat(result.filled_qty || '0'),
        filledAvgPrice: parseFloat(result.filled_avg_price || '0'),
      };
    } catch (err: any) {
      return { success: false, message: err.message };
    }
  }

  async cancelOrder(orderId: string): Promise<void> {
    const client = this.requireClient();
    await client.cancelOrder(orderId);
  }

  async getPositions(): Promise<NormalizedPosition[]> {
    const client = this.requireClient();
    const positions = await client.getPositions();
    return positions.map((p: any) => ({
      symbol: p.symbol,
      qty: parseFloat(p.qty),
      avgEntryPrice: parseFloat(p.avg_entry_price),
      currentPrice: parseFloat(p.current_price),
      marketValue: parseFloat(p.market_value),
      unrealizedPnl: parseFloat(p.unrealized_pl),
      unrealizedPnlPct: parseFloat(p.unrealized_plpc) * 100,
      adapter: this.id,
    }));
  }

  async getOpenOrders(): Promise<NormalizedOrder[]> {
    const client = this.requireClient();
    const orders = await client.getOrders({ status: 'open' });
    return orders.map((o: any) => ({
      symbol: o.symbol,
      side: o.side.toUpperCase() as 'BUY' | 'SELL',
      type: o.type.toUpperCase() as 'MARKET' | 'LIMIT',
      qty: parseFloat(o.qty),
      limitPrice: o.limit_price ? parseFloat(o.limit_price) : undefined,
    }));
  }

  async getAccountState(): Promise<AccountState> {
    const client = this.requireClient();
    const acc = await client.getAccount();
    return {
      balance: parseFloat(acc.cash),
      equity: parseFloat(acc.equity),
      availableCapital: parseFloat(acc.buying_power),
      currency: 'USD',
      updatedAt: Date.now(),
    };
  }

  getTradingHours(): TradingSchedule {
    return { hours: '09:30-16:00 ET', timezone: 'America/New_York' };
  }

  getFees(): FeeStructure {
    return { maker: 0, taker: 0 };
  }
}
