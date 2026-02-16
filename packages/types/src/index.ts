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
  | 'deep_value_crash'
  | 'grid_buy'
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
// ORCHESTRATOR TYPES
// ============================================================================

export interface RiskApproval {
  approved: boolean;
  positionSize: number;
  reasoning: string;
}

export interface GrokAnalysis {
  signal: 'BUY' | 'SELL' | 'HOLD';
  confidence: number;
  entry: number;
  target: number;
  stopLoss: number;
  reasoning: string[];
  summary?: string;
}

export interface OrchestratorState {
  status: AgentStatus;
  isRunning: boolean;
  enableAutoTrading: boolean;
  emergencyStopTriggered: boolean;
  lastScanTime: Date | null;
  dailyStartValue: number;
  currentPortfolioValue: number;
}

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
  | 'WELCOME'
  | 'PING'
  | 'PONG'
  | 'SIGNAL_ALERT'
  | 'TRADE_EXECUTED'
  | 'POSITION_UPDATE'
  | 'RISK_WARNING'
  | 'CIRCUIT_BREAKER_TRIGGERED'
  | 'ORCHESTRATOR_STATUS_UPDATE'
  | 'AGENT_STATUS';

export interface WebSocketMessage<T = any> {
  type: WebSocketMessageType;
  timestamp: number; // Changed to number for serialization
  data: T;
}

export interface WSPayloadSignal {
  signal: TradingSignal;
  source: string;
}

export interface WSPayloadTrade {
  trade: Order; // Using Order as trade representation for now
  positionId?: string;
}

export interface WSPayloadPosition {
  position: Position;
  action: 'OPENED' | 'UPDATED' | 'CLOSED';
}

export interface WSPayloadRisk {
  type: 'daily_loss' | 'max_drawdown' | 'correlation' | 'exposure';
  severity: 'low' | 'medium' | 'high' | 'critical';
  message: string;
  data?: any;
}

export interface WSPayloadCircuitBreaker {
  trigger: string;
  action: 'PAUSE_TRADING' | 'HALT_SYSTEM' | 'REDUCE_EXPOSURE';
  duration?: number; // Minutes
}

export interface WSPayloadOrchestrator {
  status: OrchestratorState;
}

export interface WSPayloadAgentStatus {
  agentId: AgentId;
  status: AgentStatus;
  message?: string;
}

// ============================================================================
// API REQUEST SCHEMAS
// ============================================================================

export const BacktestRequestSchema = z.object({
  symbols: z.array(z.string()).min(1),
  timeframe: z.string().default('15m'),
  days: z.number().min(1).optional(),
  startDate: z.string().or(z.date()).optional(),
  endDate: z.string().or(z.date()).optional(),
  initialCapital: z.number().positive().default(10000),
  patterns: z.array(z.string()).optional(),
  positionSizing: z.enum(['fixed', 'kelly', 'atr']).default('kelly'),
  useHalfKelly: z.boolean().default(true),
  walkForward: z.object({
    enabled: z.boolean(),
    windows: z.number().optional(),
    inSampleDays: z.number().optional(),
    outOfSampleDays: z.number().optional()
  }).optional()
});

export const ClosePositionRequestSchema = z.object({
  positionId: z.string().or(z.number()),
  exitPrice: z.number().or(z.string().transform(val => parseFloat(val))),
  closeReason: z.string(),
  metadata: z.record(z.any()).optional()
});

export const RiskCheckRequestSchema = z.object({
  symbol: z.string(),
  side: z.enum(['BUY', 'SELL']),
  entry_price: z.number().or(z.string().transform(val => parseFloat(val))),
  stop_loss: z.number().or(z.string().transform(val => parseFloat(val))),
  target_price: z.number().or(z.string().transform(val => parseFloat(val))),
  confidence: z.number().min(0).max(1).default(0.5)
});

export const WebSocketPayloadSchema = z.object({
  type: z.enum([
    'REGISTER_AGENT',
    'BROADCAST',
    'PING',
    'PONG',
    'WELCOME',
    'HEARTBEAT',
    'SUBSCRIBE',
    'UNSUBSCRIBE',
    'SUBSCRIBED',
    'UNSUBSCRIBED',
    'GET_ROOMS',
    'ROOMS_LIST',
    'GET_STATUS',
    'STATUS',
    'ERROR',
    'AGENT_REGISTERED',
    'SIGNAL_ALERT',
    'TRADE_EXECUTED',
    'TRADE_FAILED',
    'POSITION_UPDATE',
    'PORTFOLIO_UPDATE',
    'RISK_WARNING',
    'CIRCUIT_BREAKER_TRIGGERED',
    'ORCHESTRATOR_STATUS_UPDATE',
    'AGENT_STATUS',
    'ALERT',
    'NEW_SIGNAL'
  ]),
  payload: z.any().optional(),
  agentId: z.string().optional(),
  timestamp: z.number().optional(),
  room: z.string().optional(),
  rooms: z.array(z.string()).optional(),
  event: z.object({
    type: z.enum(['signal', 'price', 'trade', 'alert', 'position', 'portfolio', 'agent_status']),
    data: z.any(),
    timestamp: z.number(),
    room: z.string().optional(),
  }).optional(),
});

// WebSocket Event Types for client-side usage
export type WSEventType = 'signal' | 'price' | 'trade' | 'alert' | 'position' | 'portfolio' | 'agent_status';

export interface WSEvent<T = unknown> {
  type: WSEventType;
  data: T;
  timestamp: number;
  room?: string;
}

export interface WSPriceData {
  symbol: string;
  price: number;
  change24h?: number;
  volume24h?: number;
}

export interface WSTradeData {
  orderId: string;
  symbol: string;
  side: OrderSide;
  quantity: number;
  price: number;
  timestamp: number;
  status: 'filled' | 'partial' | 'failed';
  slippage?: number;
}

export interface WSAlertData {
  level: 'info' | 'warning' | 'error' | 'critical';
  message: string;
  source?: string;
  data?: unknown;
}

// ============================================================================
// INFERRED REQUEST TYPES
// ============================================================================

export type BacktestRequest = z.infer<typeof BacktestRequestSchema>;
export type ClosePositionRequest = z.infer<typeof ClosePositionRequestSchema>;
export type RiskCheckRequest = z.infer<typeof RiskCheckRequestSchema>;
export type WebSocketPayload = z.infer<typeof WebSocketPayloadSchema>;

// ============================================================================
// BACKTESTING TYPES
// ============================================================================

export interface BacktestConfig {
  symbols: string[];
  timeframe: string;
  startDate: Date;
  endDate: Date;
  initialCapital: number;
  patterns: PatternType[];
  positionSizing: 'fixed' | 'kelly' | 'atr';
  useHalfKelly: boolean;
  walkForward?: {
    enabled: boolean;
    windows?: number;
    inSampleDays?: number;
    outOfSampleDays?: number;
  };
  commissionRate?: number;
  slippageRate?: number;
}

export interface BacktestResult {
  id: string;
  config: BacktestConfig;
  startDate: Date;
  endDate: Date;
  metrics: PerformanceMetrics;
  trades: BacktestTrade[];
  equityCurve: EquityPoint[];
  drawdownCurve: DrawdownPoint[];
  walkForwardResults?: WalkForwardResult[];
  monteCarloResults?: MonteCarloResult;
  completedAt: Date;
}

export interface PerformanceMetrics {
  totalReturn: number;
  totalReturnPercent: number;
  annualizedReturn: number;
  sharpeRatio: number;
  sortinoRatio: number;
  maxDrawdown: number;
  maxDrawdownDuration: number;
  winRate: number;
  profitFactor: number;
  averageWin: number;
  averageLoss: number;
  averageHoldingPeriod: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  largestWin: number;
  largestLoss: number;
  consecutiveWins: number;
  consecutiveLosses: number;
  calmarRatio: number;
  recoveryFactor: number;
}

export interface BacktestTrade {
  id: string;
  symbol: string;
  side: OrderSide;
  pattern: PatternType;
  entryDate: Date;
  entryPrice: number;
  exitDate: Date;
  exitPrice: number;
  quantity: number;
  pnl: number;
  pnlPercent: number;
  holdingPeriod: number;
  commission: number;
  slippage: number;
  stopLoss?: number;
  takeProfit?: number;
  exitReason: 'target' | 'stop_loss' | 'trailing_stop' | 'time_exit' | 'signal';
}

export interface EquityPoint {
  date: Date;
  equity: number;
  drawdown: number;
  position?: string;
}

export interface DrawdownPoint {
  date: Date;
  drawdown: number;
  peak: number;
  trough: number;
}

export interface WalkForwardResult {
  window: number;
  inSampleStart: Date;
  inSampleEnd: Date;
  outOfSampleStart: Date;
  outOfSampleEnd: Date;
  inSampleMetrics: PerformanceMetrics;
  outOfSampleMetrics: PerformanceMetrics;
  efficiency: number;
}

export interface MonteCarloResult {
  iterations: number;
  confidenceLevel: number;
  expectedReturn: number;
  expectedDrawdown: number;
  returnDistribution: number[];
  drawdownDistribution: number[];
  probabilityOfProfit: number;
  valueAtRisk95: number;
  valueAtRisk99: number;
}

// ============================================================================
// SIGNAL VALIDATION TYPES
// ============================================================================

export interface ValidationResult {
  originalSignal: TradingSignal;
  validators: ValidatorResult[];
  consensusScore: number;
  recommendation: 'EXECUTE' | 'REJECT' | 'REVIEW';
  reasoning: string;
  timestamp: Date;
}

export interface ValidatorResult {
  name: string;
  score: number;
  weight: number;
  passed: boolean;
  details: string;
}

export interface ValidatorConfig {
  name: string;
  weight: number;
  enabled: boolean;
  params?: Record<string, any>;
}

// ============================================================================
// EXECUTOR TYPES
// ============================================================================

export interface ExecuteOrderRequest {
  signalId: string;
  symbol: string;
  side: OrderSide;
  quantity: number;
  entryPrice: number;
  stopLoss?: number;
  takeProfit?: number;
  orderType: 'market' | 'limit';
  confidence: number;
  pattern: string;
}

export interface ExecutionResult {
  success: boolean;
  orderId?: string;
  symbol: string;
  side: OrderSide;
  orderType: string;
  requestedQuantity: number;
  executedQuantity: number;
  requestedPrice: number;
  averagePrice: number;
  slippage?: number;
  commission?: number;
  stopLossOrderId?: string;
  takeProfitOrderId?: string;
  timestamp: Date;
  error?: string;
}

// ============================================================================
// RISK MANAGER TYPES
// ============================================================================

export interface RiskLimits {
  dailyLossLimit: number;
  weeklyLossLimit: number;
  maxOpenPositions: number;
  maxCorrelation: number;
  maxPortfolioExposure: number;
  maxPositionSize: number;
  volatilityThreshold: number;
}

export interface RiskCheckResult {
  approved: boolean;
  position_size: number;
  position_value: number;
  risk_amount: number;
  kelly_fraction: number;
  reasoning: string;
  limits: {
    portfolio_exposure: string;
    daily_loss_remaining: string;
    weekly_loss_remaining: string;
    open_positions: number;
  };
  adjustments?: {
    adjusted_stop_loss?: number;
    adjusted_target?: number;
  };
  warnings?: string[];
  blockers?: string[];
}

export interface CircuitBreakerState {
  isTriggered: boolean;
  triggeredAt?: Date;
  reason?: string;
  cooldownEndsAt?: Date;
  action: 'PAUSE_TRADING' | 'HALT_SYSTEM' | 'REDUCE_EXPOSURE';
}

export interface DynamicStopConfig {
  useAtr: boolean;
  atrMultiplier: number;
  useTrailingStop: boolean;
  trailingStopPercent: number;
  useTimeStop: boolean;
  maxHoldingHours: number;
}

// ============================================================================
// CANDLE / OHLCV TYPES
// ============================================================================

export interface OHLCV {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Candle extends OHLCV {
  symbol: string;
  timeframe: string;
}

export { RISK_CONFIG, type RiskConfig } from './risk-config';
