import type { Candle, OrderBook, NormalizedOrder, OrderResult,
              NormalizedPosition, AccountState, AssetClass } from '../types';

export interface HealthStatus {
  connected: boolean;
  latencyMs: number;
  error?: string;
}

export interface SymbolInfo {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  minQty: number;
  minNotional: number;
  pricePrecision: number;
  qtyPrecision: number;
}

export interface TradingSchedule {
  alwaysOpen?: boolean;
  hours?: string;
  timezone?: string;
}

export interface FeeStructure {
  maker: number;
  taker: number;
}

export interface MarketAdapter {
  readonly id: string;
  readonly assetClass: AssetClass;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  healthCheck(): Promise<HealthStatus>;
  getOHLCV(symbol: string, timeframe: string, limit?: number): Promise<Candle[]>;
  getOrderBook(symbol: string, depth?: number): Promise<OrderBook>;
  getSymbols(): Promise<SymbolInfo[]>;
  submitOrder(order: NormalizedOrder): Promise<OrderResult>;
  cancelOrder(orderId: string): Promise<void>;
  getPositions(): Promise<NormalizedPosition[]>;
  getOpenOrders(): Promise<NormalizedOrder[]>;
  getAccountState(): Promise<AccountState>;
  getTradingHours(): TradingSchedule;
  getFees(): FeeStructure;
}
