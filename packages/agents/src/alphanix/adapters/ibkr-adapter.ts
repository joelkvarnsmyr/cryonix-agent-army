import type { Candle, OrderBook, NormalizedOrder, OrderResult,
              NormalizedPosition, AccountState, AssetClass } from '../types';
import type { MarketAdapter, HealthStatus, SymbolInfo, TradingSchedule, FeeStructure } from './types';

interface IbkrAdapterOptions {
  paper: boolean;
  host?: string;  // IB Gateway host
  port?: number;  // IB Gateway port (4002 paper, 4001 live)
}

/**
 * Interactive Brokers adapter for EU/SE stocks.
 * Phase 3: Will connect to IB Gateway via @stoqey/ib.
 * Currently runs in simulation mode using free stock price APIs.
 */
export class IbkrAdapter implements MarketAdapter {
  readonly id = 'ibkr';
  readonly assetClass: AssetClass = 'stock';

  private options: IbkrAdapterOptions;
  private connected = false;
  private paperBalance = 10000;
  private paperPositions = new Map<string, { qty: number; avgPrice: number }>();

  constructor(options: IbkrAdapterOptions) {
    this.options = options;
  }

  async connect(): Promise<void> {
    // Phase 3: Connect to IB Gateway
    // For now, always run in simulation mode
    console.log('[IbkrAdapter] Running in simulation mode (IB Gateway not configured)');
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async healthCheck(): Promise<HealthStatus> {
    return { connected: this.connected, latencyMs: 0 };
  }

  async getOHLCV(symbol: string, timeframe: string = '1day', limit: number = 30): Promise<Candle[]> {
    // Use Yahoo Finance v8 API (free, no auth) for Swedish/EU stocks
    try {
      const yahooSymbol = this.toYahooSymbol(symbol);
      const interval = timeframe === '15Min' ? '15m' : timeframe === '1Hour' ? '1h' : '1d';
      const range = interval === '15m' ? '5d' : interval === '1h' ? '1mo' : '3mo';
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?interval=${interval}&range=${range}`;

      const res = await fetch(url, { headers: { 'User-Agent': 'Alphanix/1.0' } });
      if (!res.ok) return [];

      const data = await res.json();
      const result = data?.chart?.result?.[0];
      if (!result?.timestamp) return [];

      const timestamps = result.timestamp;
      const quotes = result.indicators?.quote?.[0];
      if (!quotes) return [];

      const candles: Candle[] = [];
      for (let i = 0; i < Math.min(timestamps.length, limit); i++) {
        if (quotes.close[i] == null) continue;
        candles.push({
          timestamp: timestamps[i] * 1000,
          open: quotes.open[i] || quotes.close[i],
          high: quotes.high[i] || quotes.close[i],
          low: quotes.low[i] || quotes.close[i],
          close: quotes.close[i],
          volume: quotes.volume[i] || 0,
        });
      }
      return candles;
    } catch (err) {
      console.warn(`[IbkrAdapter] Failed to fetch ${symbol}:`, err);
      return [];
    }
  }

  async getOrderBook(_symbol: string, _depth?: number): Promise<OrderBook> {
    return { bids: [], asks: [], timestamp: Date.now() };
  }

  async getSymbols(): Promise<SymbolInfo[]> {
    // Return configured Nordic symbols
    return ['HM-B.ST', 'VOLV-B.ST', 'SAND.ST', 'ERIC-B.ST', 'ABB.ST', 'ASSA-B.ST', 'ATCO-A.ST', 'SEB-A.ST'].map(s => ({
      symbol: s,
      baseAsset: s.replace('.ST', ''),
      quoteAsset: 'SEK',
      minQty: 1,
      minNotional: 100,
      pricePrecision: 2,
      qtyPrecision: 0,
    }));
  }

  async submitOrder(order: NormalizedOrder): Promise<OrderResult> {
    // Paper simulation: get current price and simulate fill
    try {
      const candles = await this.getOHLCV(order.symbol, '1day', 1);
      const price = candles.length > 0 ? candles[candles.length - 1].close : 0;
      if (price === 0) return { success: false, message: 'No price data available' };

      const orderId = `ibkr-paper-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const fillQty = order.qty;

      const existing = this.paperPositions.get(order.symbol);
      if (order.side === 'BUY') {
        this.paperPositions.set(order.symbol, {
          qty: (existing?.qty || 0) + fillQty,
          avgPrice: price,
        });
        this.paperBalance -= price * fillQty;
      } else {
        this.paperPositions.set(order.symbol, {
          qty: Math.max(0, (existing?.qty || 0) - fillQty),
          avgPrice: existing?.avgPrice || price,
        });
        this.paperBalance += price * fillQty;
      }

      console.log(`[IbkrAdapter:PAPER] ${order.side} ${fillQty} ${order.symbol} @ ${price.toFixed(2)} SEK`);
      return { success: true, orderId, status: 'filled', filledQty: fillQty, filledAvgPrice: price };
    } catch (err: any) {
      return { success: false, message: err.message };
    }
  }

  async cancelOrder(_orderId: string, _symbol?: string): Promise<void> {
    // Paper mode: no-op
  }

  async getPositions(): Promise<NormalizedPosition[]> {
    const positions: NormalizedPosition[] = [];
    for (const [symbol, pos] of this.paperPositions) {
      if (pos.qty <= 0) continue;
      const candles = await this.getOHLCV(symbol, '1day', 1);
      const currentPrice = candles.length > 0 ? candles[candles.length - 1].close : pos.avgPrice;
      positions.push({
        symbol, qty: pos.qty, avgEntryPrice: pos.avgPrice,
        currentPrice, marketValue: pos.qty * currentPrice,
        unrealizedPnl: pos.qty * (currentPrice - pos.avgPrice),
        unrealizedPnlPct: ((currentPrice - pos.avgPrice) / pos.avgPrice) * 100,
        adapter: this.id,
      });
    }
    return positions;
  }

  async getOpenOrders(): Promise<NormalizedOrder[]> { return []; }

  async getAccountState(): Promise<AccountState> {
    return {
      balance: this.paperBalance,
      equity: this.paperBalance,
      availableCapital: this.paperBalance,
      currency: 'SEK',
      updatedAt: Date.now(),
    };
  }

  getTradingHours(): TradingSchedule {
    return { hours: '09:00-17:30 CET', timezone: 'Europe/Stockholm' };
  }

  getFees(): FeeStructure {
    return { maker: 0.001, taker: 0.001 };  // ~0.1% typical IBKR Nordic
  }

  /** Convert our symbol format to Yahoo Finance format */
  private toYahooSymbol(symbol: string): string {
    // HM-B.ST → HM-B.ST (already Yahoo format for Stockholm)
    // VOLV-B.ST → VOLV-B.ST
    return symbol;
  }
}
