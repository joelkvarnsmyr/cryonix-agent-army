// packages/agents/src/alphanix/types.ts

export type AssetClass = 'crypto' | 'stock' | 'commodity' | 'forex';
export type PodState = 'starting' | 'running' | 'paused' | 'liquidating' | 'stopped' | 'error';
export type PodCommand = 'reduce_exposure' | 'pause' | 'resume' | 'update_config' | 'liquidate' | 'shutdown';

// --- Signal Pipeline ---

/** Quant → Risk */
export interface TradeProposal {
  id: string;
  podId: string;
  symbol: string;
  adapter: string;
  side: 'BUY' | 'SELL';
  confidence: number;        // 0-100
  sizing: { qty: number; notional: number };
  reasoning: string;
  models: string[];
  signals: string[];
  timestamp: number;
}

/** Risk → Execution (or veto) */
export interface RiskDecision {
  proposalId: string;
  action: 'approve' | 'veto' | 'reduce';
  adjustedSizing?: { qty: number; notional: number };
  vetoReason?: string;
  riskMetrics: {
    var: number;
    exposure: number;
    drawdown: number;
    esgScore?: number;
  };
}

/** Execution → Audit Log */
export interface ExecutionResult {
  proposalId: string;
  orderId: string;
  adapter: string;
  fillPrice: number;
  fillQty: number;
  slippage: number;
  fees: number;
  timestamp: number;
}

// --- Market Data ---

export interface NormalizedTick {
  timestamp: number;
  adapterId: string;
  symbol: string;
  bid: number;
  ask: number;
  last: number;
  volume24h: number;
  assetClass: AssetClass;
}

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface OrderBook {
  bids: Array<[number, number]>;  // [price, qty]
  asks: Array<[number, number]>;
  timestamp: number;
}

// --- Orders ---

export interface NormalizedOrder {
  symbol: string;
  side: 'BUY' | 'SELL';
  type: 'MARKET' | 'LIMIT';
  qty: number;
  limitPrice?: number;
}

export interface OrderResult {
  success: boolean;
  orderId?: string;
  status?: string;
  message?: string;
  filledQty?: number;
  filledAvgPrice?: number;
}

// --- Account ---

export interface AccountState {
  balance: number;
  equity: number;
  availableCapital: number;
  currency: string;
  updatedAt: number;
}

export interface NormalizedPosition {
  symbol: string;
  qty: number;
  avgEntryPrice: number;
  currentPrice: number;
  marketValue: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  adapter: string;
  openedAt?: string;
}

// --- Pod Config ---

export interface PodConfig {
  id: string;
  enabled: boolean;
  adapter: string;
  capitalPct: number;
  strategy: string;
  symbols: string[];
  pollIntervalMs: number;
  riskMaxDrawdownPct: number;
  riskMaxPositions: number;
  tradingHours?: string;
}

// --- Adapter Errors ---

export type AdapterErrorCategory =
  | 'rate_limit'
  | 'insufficient_funds'
  | 'market_closed'
  | 'auth_failure'
  | 'network'
  | 'order_rejected'
  | 'unknown';

export interface AdapterError {
  adapter: string;
  category: AdapterErrorCategory;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
}
