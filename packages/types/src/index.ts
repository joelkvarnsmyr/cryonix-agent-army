import { z } from 'zod';

// ============================================================================
// TRADING TYPES
// ============================================================================

export type OrderSide = 'BUY' | 'SELL';
export type OrderType = 'MARKET' | 'LIMIT' | 'STOP_LOSS' | 'STOP_LOSS_LIMIT';
export type OrderStatus = 'PENDING' | 'FILLED' | 'PARTIALLY_FILLED' | 'CANCELLED' | 'REJECTED';
export type PositionStatus = 'OPEN' | 'CLOSED';
export type SignalAction = 'BUY' | 'SELL' | 'WAIT';
export type PatternType =
  | 'bollinger_squeeze'
  | 'triangle_breakout'
  | 'momentum_shift'
  | 'volume_spike'
  | 'whale_movement'
  | 'custom';

// ============================================================================
// AGENT TYPES
// ============================================================================

export type AgentId =
  | 'orchestrator'
  | 'market_scout'
  | 'analyst'
  | 'executor'
  | 'risk_manager'
  | 'reporter'
  | 'learning'
  | 'claude_assistant';

export type AgentStatus = 'idle' | 'running' | 'paused' | 'error';
export type MessagePriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

// ============================================================================
// SCHEMAS
// ============================================================================

export const TradingSignalSchema = z.object({
  id: z.string().uuid(),
  timestamp: z.date(),
  symbol: z.string(),
  action: z.enum(['BUY', 'SELL', 'WAIT']),
  confidence: z.number().min(0).max(1),
  pattern: z.string(),
  reasoning: z.array(z.string()),
  entry_price: z.number().positive(),
  target_price: z.number().positive(),
  stop_loss: z.number().positive(),
  timeframe: z.string().optional(),
  agent_id: z.string(),
});

export const OrderSchema = z.object({
  id: z.string().uuid(),
  timestamp: z.date(),
  symbol: z.string(),
  side: z.enum(['BUY', 'SELL']),
  type: z.enum(['MARKET', 'LIMIT', 'STOP_LOSS', 'STOP_LOSS_LIMIT']),
  quantity: z.number().positive(),
  price: z.number().positive().optional(),
  stop_price: z.number().positive().optional(),
  status: z.enum(['PENDING', 'FILLED', 'PARTIALLY_FILLED', 'CANCELLED', 'REJECTED']),
  filled_quantity: z.number().nonnegative().optional(),
  average_price: z.number().positive().optional(),
});

export const PositionSchema = z.object({
  id: z.string().uuid(),
  symbol: z.string(),
  quantity: z.number(),
  entry_price: z.number().positive(),
  current_price: z.number().positive(),
  pnl: z.number(),
  pnl_percent: z.number(),
  opened_at: z.date(),
  closed_at: z.date().optional(),
  status: z.enum(['OPEN', 'CLOSED']),
  stop_loss: z.number().positive().optional(),
  take_profit: z.number().positive().optional(),
});

export const AgentMessageSchema = z.object({
  agent_id: z.string(),
  timestamp: z.date(),
  message_type: z.string(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  data: z.any(),
  requires_approval: z.boolean(),
});

export const PortfolioSchema = z.object({
  total_value: z.number().nonnegative(),
  cash_balance: z.number().nonnegative(),
  positions_value: z.number().nonnegative(),
  total_pnl: z.number(),
  total_pnl_percent: z.number(),
  daily_pnl: z.number(),
  updated_at: z.date(),
});

export const MarketDataSchema = z.object({
  symbol: z.string(),
  timestamp: z.date(),
  open: z.number().positive(),
  high: z.number().positive(),
  low: z.number().positive(),
  close: z.number().positive(),
  volume: z.number().nonnegative(),
  timeframe: z.string(),
});

// ============================================================================
// INFERRED TYPES
// ============================================================================

export type TradingSignal = z.infer<typeof TradingSignalSchema>;
export type Order = z.infer<typeof OrderSchema>;
export type Position = z.infer<typeof PositionSchema>;
export type AgentMessage = z.infer<typeof AgentMessageSchema>;
export type Portfolio = z.infer<typeof PortfolioSchema>;
export type MarketData = z.infer<typeof MarketDataSchema>;

// ============================================================================
// API TYPES
// ============================================================================

export interface BinanceKline {
  openTime: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  closeTime: number;
  quoteVolume: string;
  trades: number;
  takerBuyBaseVolume: string;
  takerBuyQuoteVolume: string;
}

export interface GrokChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface GrokResponse {
  id: string;
  choices: Array<{
    message: GrokChatMessage;
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// ============================================================================
// AGENT CONFIGURATIONS
// ============================================================================

export interface AgentConfig {
  id: AgentId;
  name: string;
  description: string;
  enabled: boolean;
  config: Record<string, any>;
}

export interface RiskManagerConfig {
  max_portfolio_risk: number;
  max_position_risk: number;
  max_correlation: number;
  max_leverage: number;
  daily_loss_limit: number;
}

export interface ExecutorConfig {
  default_exchange: 'binance' | 'crypto_com';
  max_slippage: number;
  retry_attempts: number;
  timeout_seconds: number;
}

// ============================================================================
// WEBSOCKET TYPES
// ============================================================================

export type WebSocketMessageType =
  | 'SIGNAL'
  | 'TRADE'
  | 'POSITION_UPDATE'
  | 'PORTFOLIO_UPDATE'
  | 'AGENT_STATUS'
  | 'MARKET_DATA';

export interface WebSocketMessage<T = any> {
  type: WebSocketMessageType;
  timestamp: Date;
  data: T;
}
