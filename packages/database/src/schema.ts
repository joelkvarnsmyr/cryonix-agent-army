import { pgTable, text, serial, decimal, timestamp, boolean, jsonb, varchar, integer, doublePrecision, index, uniqueIndex } from 'drizzle-orm/pg-core';

// ============================================================================
// USERS TABLE
// ============================================================================

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  username: varchar('username', { length: 50 }).unique().notNull(),
  email: varchar('email', { length: 100 }).unique().notNull(),
  apiKeys: jsonb('api_keys'), // Encrypted API keys
  createdAt: timestamp('created_at').defaultNow(),
});

// ============================================================================
// PORTFOLIO TABLE
// ============================================================================

export const portfolio = pgTable('portfolio', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id),
  totalValue: decimal('total_value', { precision: 20, scale: 8 }),
  cashBalance: decimal('cash_balance', { precision: 20, scale: 8 }),
  btcBalance: decimal('btc_balance', { precision: 20, scale: 8 }),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// ============================================================================
// POSITIONS TABLE
// ============================================================================

export const positions = pgTable('positions', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id),
  symbol: varchar('symbol', { length: 20 }).notNull(),
  quantity: decimal('quantity', { precision: 20, scale: 8 }).notNull(),
  entryPrice: decimal('entry_price', { precision: 20, scale: 8 }).notNull(),
  currentPrice: decimal('current_price', { precision: 20, scale: 8 }),
  pnl: decimal('pnl', { precision: 20, scale: 8 }),
  pnlPercent: decimal('pnl_percent', { precision: 10, scale: 4 }),
  openedAt: timestamp('opened_at').defaultNow(),
  closedAt: timestamp('closed_at'),
  status: varchar('status', { length: 20 }).default('OPEN'), // 'OPEN' or 'CLOSED'
  stopLoss: decimal('stop_loss', { precision: 20, scale: 8 }),
  takeProfit: decimal('take_profit', { precision: 20, scale: 8 }),
});

// ============================================================================
// TRADES TABLE (Time-series optimized)
// ============================================================================

export const trades = pgTable('trades', {
  id: serial('id').primaryKey(),
  timestamp: timestamp('timestamp').defaultNow().notNull(),
  userId: integer('user_id').references(() => users.id),
  symbol: varchar('symbol', { length: 20 }).notNull(),
  side: varchar('side', { length: 10 }).notNull(), // 'BUY' or 'SELL'
  quantity: decimal('quantity', { precision: 20, scale: 8 }).notNull(),
  entryPrice: decimal('entry_price', { precision: 20, scale: 8 }),
  exitPrice: decimal('exit_price', { precision: 20, scale: 8 }),
  pnl: decimal('pnl', { precision: 20, scale: 8 }),
  confidence: decimal('confidence', { precision: 5, scale: 4 }),
  pattern: varchar('pattern', { length: 50 }),
  reasoning: text('reasoning'),
  status: varchar('status', { length: 20 }).default('PENDING'), // 'PENDING', 'FILLED', 'CLOSED'
  fees: decimal('fees', { precision: 20, scale: 8 }),
  agentId: varchar('agent_id', { length: 50 }),
  configVersion: varchar('config_version', { length: 16 }),
}, (table) => [
  index('trades_timestamp_idx').on(table.timestamp),
  index('trades_symbol_idx').on(table.symbol),
  index('trades_config_version_idx').on(table.configVersion),
]);

// ============================================================================
// SIGNALS TABLE
// ============================================================================

export const signals = pgTable('signals', {
  id: serial('id').primaryKey(),
  timestamp: timestamp('timestamp').defaultNow(),
  symbol: varchar('symbol', { length: 20 }).notNull(),
  action: varchar('action', { length: 10 }).notNull(), // 'BUY', 'SELL', 'WAIT'
  confidence: decimal('confidence', { precision: 5, scale: 4 }),
  pattern: varchar('pattern', { length: 50 }),
  reasoning: jsonb('reasoning'),
  entryPrice: decimal('entry_price', { precision: 20, scale: 8 }),
  targetPrice: decimal('target_price', { precision: 20, scale: 8 }),
  stopLoss: decimal('stop_loss', { precision: 20, scale: 8 }),
  timeframe: varchar('timeframe', { length: 20 }),
  metadata: jsonb('metadata'), // Pattern-specific data
  agentId: varchar('agent_id', { length: 50 }),
  executed: boolean('executed').default(false),
}, (table) => [
  index('signals_timestamp_idx').on(table.timestamp),
  index('signals_symbol_idx').on(table.symbol),
]);

// ============================================================================
// MARKET DATA TABLE (Time-series optimized)
// ============================================================================

export const marketData = pgTable('market_data', {
  id: serial('id').primaryKey(),
  timestamp: timestamp('timestamp').notNull(),
  symbol: varchar('symbol', { length: 20 }).notNull(),
  open: decimal('open', { precision: 20, scale: 8 }).notNull(),
  high: decimal('high', { precision: 20, scale: 8 }).notNull(),
  low: decimal('low', { precision: 20, scale: 8 }).notNull(),
  close: decimal('close', { precision: 20, scale: 8 }).notNull(),
  volume: decimal('volume', { precision: 30, scale: 8 }).notNull(),
  timeframe: varchar('timeframe', { length: 10 }).notNull(), // '1m', '5m', '15m', '1h', '4h', '1d'
}, (table) => [
  index('market_data_symbol_tf_ts_idx').on(table.symbol, table.timeframe, table.timestamp),
]);

// ============================================================================
// AGENT ACTIONS LOG TABLE
// ============================================================================

export const agentActions = pgTable('agent_actions', {
  id: serial('id').primaryKey(),
  timestamp: timestamp('timestamp').defaultNow(),
  agentId: varchar('agent_id', { length: 50 }),
  actionType: varchar('action_type', { length: 50 }),
  data: jsonb('data'),
  success: boolean('success'),
  errorMessage: text('error_message'),
});

// ============================================================================
// ML MODELS TABLE
// ============================================================================

export const mlModels = pgTable('ml_models', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 100 }),
  version: varchar('version', { length: 20 }),
  modelType: varchar('model_type', { length: 50 }),
  accuracy: decimal('accuracy', { precision: 5, scale: 4 }),
  trainedAt: timestamp('trained_at'),
  modelPath: varchar('model_path', { length: 255 }),
  parameters: jsonb('parameters'),
});

// ============================================================================
// ORCHESTRATOR STATE TABLE
// ============================================================================

export const orchestratorState = pgTable('orchestrator_state', {
  id: serial('id').primaryKey(),
  timestamp: timestamp('timestamp').defaultNow(),
  status: varchar('status', { length: 20 }),
  isRunning: boolean('is_running'),
  dailyStartValue: decimal('daily_start_value', { precision: 20, scale: 8 }),
  emergencyStopTriggered: boolean('emergency_stop_triggered'),
  metadata: jsonb('metadata'),
});

export type OrchestratorState = typeof orchestratorState.$inferSelect;
export type NewOrchestratorState = typeof orchestratorState.$inferInsert;

// ============================================================================
// RISK CHECKS TABLE
// ============================================================================

export const riskChecks = pgTable('risk_checks', {
  id: serial('id').primaryKey(),
  timestamp: timestamp('timestamp').defaultNow(),
  symbol: varchar('symbol', { length: 20 }).notNull(),
  side: varchar('side', { length: 10 }).notNull(), // 'BUY' or 'SELL'
  confidence: decimal('confidence', { precision: 5, scale: 4 }),
  approved: boolean('approved').notNull(),
  positionSize: decimal('position_size', { precision: 20, scale: 8 }),
  positionValue: decimal('position_value', { precision: 20, scale: 2 }),
  riskAmount: decimal('risk_amount', { precision: 20, scale: 2 }),
  kellyFraction: decimal('kelly_fraction', { precision: 5, scale: 4 }),
  reasoning: text('reasoning'),
  portfolioValue: decimal('portfolio_value', { precision: 20, scale: 2 }),
  agentId: varchar('agent_id', { length: 50 }),
});

// ============================================================================
// BACKTEST RESULTS TABLE
// ============================================================================

export const backtestResults = pgTable('backtest_results', {
  id: serial('id').primaryKey(),
  timestamp: timestamp('timestamp').defaultNow().notNull(),
  userId: integer('user_id').references(() => users.id),
  config: jsonb('config').notNull(), // BacktestConfig
  metrics: jsonb('metrics').notNull(), // PerformanceMetrics
  trades: jsonb('trades'), // Array of simulated trades
  walkForwardResults: jsonb('walk_forward_results'), // Walk-forward validation data
  equity: jsonb('equity'), // Equity curve data points
  monthlyReturns: jsonb('monthly_returns'), // Monthly return breakdown
  patternPerformance: jsonb('pattern_performance'), // Performance by pattern
  status: varchar('status', { length: 20 }).default('COMPLETED'), // 'RUNNING', 'COMPLETED', 'FAILED'
  errorMessage: text('error_message'),
});

// ============================================================================
// VALIDATION HISTORY TABLE
// ============================================================================

export const validationHistory = pgTable('validation_history', {
  id: serial('id').primaryKey(),
  timestamp: timestamp('timestamp').defaultNow().notNull(),
  signalId: integer('signal_id').references(() => signals.id),
  symbol: varchar('symbol', { length: 20 }).notNull(),
  action: varchar('action', { length: 10 }).notNull(), // 'BUY', 'SELL', 'WAIT'
  originalConfidence: decimal('original_confidence', { precision: 5, scale: 4 }),
  adjustedConfidence: decimal('adjusted_confidence', { precision: 5, scale: 4 }),
  consensusLevel: varchar('consensus_level', { length: 20 }), // 'STRONG', 'MODERATE', 'WEAK', 'CONFLICTING'
  sourceVotes: jsonb('source_votes').notNull(), // Array of SourceVote
  technicalIndicators: jsonb('technical_indicators'), // TechnicalIndicators
  priceTargets: jsonb('price_targets'), // { original, adjusted, stopLoss }
  entryTiming: varchar('entry_timing', { length: 20 }), // 'IMMEDIATE', 'WAIT', 'AVOID'
  riskLevel: varchar('risk_level', { length: 20 }), // 'LOW', 'MEDIUM', 'HIGH'
  approved: boolean('approved').notNull(),
  reasoning: text('reasoning'),
  usage: jsonb('usage'), // Token usage data { prompt_tokens, completion_tokens, total_tokens, model }
  agentId: varchar('agent_id', { length: 50 }),
});

export const evolutionRuns = pgTable('evolution_runs', {
  id: serial('id').primaryKey(),
  runId: varchar('run_id', { length: 64 }),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  durationSeconds: integer('duration_seconds'),
  status: varchar('status', { length: 20 }),
  performanceData: jsonb('performance_data'),
  changesMade: jsonb('changes_made'),
  createdAt: timestamp('created_at').defaultNow(),
});

// === Analytical Core: Change Tracking & Calibration History ===

export const configChanges = pgTable('config_changes', {
  id: serial('id').primaryKey(),
  changeType: varchar('change_type', { length: 20 }).notNull(),
  source: text('source'),
  configVersion: varchar('config_version', { length: 16 }),
  parameters: jsonb('parameters'),
  reasoning: text('reasoning'),
  createdAt: timestamp('created_at').defaultNow(),
});

export const calibrationHistory = pgTable('calibration_history', {
  id: serial('id').primaryKey(),
  runType: varchar('run_type', { length: 20 }).notNull(),
  snapshotDate: varchar('snapshot_date', { length: 10 }).notNull(),
  patterns: jsonb('patterns'),
  overall: jsonb('overall'),
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => [
  uniqueIndex('calibration_history_date_type_idx').on(table.snapshotDate, table.runType),
]);

// === AI Brain: Autopilot Action Log ===

export const autopilotActions = pgTable('autopilot_actions', {
  id: serial('id').primaryKey(),
  runId: text('run_id').notNull(),
  actionType: varchar('action_type', { length: 30 }).notNull(),
  target: text('target'),
  oldValue: text('old_value'),
  newValue: text('new_value'),
  reasoning: text('reasoning'),
  confidence: decimal('confidence', { precision: 3, scale: 2 }),
  applied: boolean('applied').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
});

// ============================================================================
// POSITION HISTORY TABLE
// ============================================================================

export const positionHistory = pgTable('position_history', {
  id: serial('id').primaryKey(),
  positionId: integer('position_id').references(() => positions.id),
  userId: integer('user_id').references(() => users.id),
  symbol: varchar('symbol', { length: 20 }).notNull(),
  side: varchar('side', { length: 10 }).notNull(), // 'LONG', 'SHORT'
  quantity: decimal('quantity', { precision: 20, scale: 8 }).notNull(),
  entryPrice: decimal('entry_price', { precision: 20, scale: 8 }).notNull(),
  exitPrice: decimal('exit_price', { precision: 20, scale: 8 }),
  avgEntryPrice: decimal('avg_entry_price', { precision: 20, scale: 8 }),
  stopLoss: decimal('stop_loss', { precision: 20, scale: 8 }),
  takeProfit: decimal('take_profit', { precision: 20, scale: 8 }),
  pnl: decimal('pnl', { precision: 20, scale: 8 }),
  pnlPercent: decimal('pnl_percent', { precision: 10, scale: 4 }),
  fees: decimal('fees', { precision: 20, scale: 8 }),
  holdingPeriod: integer('holding_period'), // Duration in seconds
  openedAt: timestamp('opened_at').notNull(),
  closedAt: timestamp('closed_at'),
  closeReason: varchar('close_reason', { length: 50 }), // 'STOP_LOSS', 'TAKE_PROFIT', 'MANUAL', 'TIMEOUT'
  signalId: integer('signal_id').references(() => signals.id),
  pattern: varchar('pattern', { length: 50 }),
  metadata: jsonb('metadata'), // Additional position data
  agentId: varchar('agent_id', { length: 50 }),
}, (table) => [
  index('position_history_closed_at_idx').on(table.closedAt),
  index('position_history_symbol_idx').on(table.symbol),
]);

// ============================================================================
// TELEGRAM SIGNALS TABLE — Log every parsed signal from Telegram channels
// ============================================================================

export const telegramSignals = pgTable('telegram_signals', {
  id: serial('id').primaryKey(),
  timestamp: timestamp('timestamp').defaultNow().notNull(),
  channelId: varchar('channel_id', { length: 50 }).notNull(),
  channelName: varchar('channel_name', { length: 100 }).notNull(),
  symbol: varchar('symbol', { length: 20 }).notNull(),
  action: varchar('action', { length: 10 }).notNull(),     // 'BUY' or 'SELL'
  entryPrice: decimal('entry_price', { precision: 20, scale: 8 }),
  entryPriceHigh: decimal('entry_price_high', { precision: 20, scale: 8 }),
  stopLoss: decimal('stop_loss', { precision: 20, scale: 8 }),
  tp1: decimal('tp1', { precision: 20, scale: 8 }),
  tp2: decimal('tp2', { precision: 20, scale: 8 }),
  tp3: decimal('tp3', { precision: 20, scale: 8 }),
  rawMessage: text('raw_message').notNull(),
  parsed: boolean('parsed').default(true),
  matchedInternalSignal: boolean('matched_internal_signal').default(false),
  outcome: varchar('outcome', { length: 20 }),  // 'WIN', 'LOSS', 'PENDING', 'EXPIRED'
  metadata: jsonb('metadata'),
});

// ============================================================================
// TELEGRAM CHANNELS TABLE — Track channel quality over time
// ============================================================================

export const telegramChannels = pgTable('telegram_channels', {
  id: serial('id').primaryKey(),
  channelId: varchar('channel_id', { length: 50 }).notNull().unique(),
  channelName: varchar('channel_name', { length: 100 }).notNull(),
  totalSignals: integer('total_signals').default(0),
  wins: integer('wins').default(0),
  losses: integer('losses').default(0),
  winRate: decimal('win_rate', { precision: 5, scale: 2 }),
  avgConfidenceBoost: decimal('avg_confidence_boost', { precision: 5, scale: 4 }),
  isActive: boolean('is_active').default(true),
  addedAt: timestamp('added_at').defaultNow(),
  lastSignalAt: timestamp('last_signal_at'),
  metadata: jsonb('metadata'),
});

// ============================================================================
// EXPORT TYPES
// ============================================================================

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type Portfolio = typeof portfolio.$inferSelect;
export type NewPortfolio = typeof portfolio.$inferInsert;

export type Position = typeof positions.$inferSelect;
export type NewPosition = typeof positions.$inferInsert;

export type Trade = typeof trades.$inferSelect;
export type NewTrade = typeof trades.$inferInsert;

export type Signal = typeof signals.$inferSelect;
export type NewSignal = typeof signals.$inferInsert;

export type MarketData = typeof marketData.$inferSelect;
export type NewMarketData = typeof marketData.$inferInsert;

export type RiskCheck = typeof riskChecks.$inferSelect;
export type NewRiskCheck = typeof riskChecks.$inferInsert;

export type BacktestResult = typeof backtestResults.$inferSelect;
export type NewBacktestResult = typeof backtestResults.$inferInsert;

export type ValidationHistory = typeof validationHistory.$inferSelect;
export type NewValidationHistory = typeof validationHistory.$inferInsert;

export type PositionHistory = typeof positionHistory.$inferSelect;
export type NewPositionHistory = typeof positionHistory.$inferInsert;

export type TelegramSignal = typeof telegramSignals.$inferSelect;
export type NewTelegramSignal = typeof telegramSignals.$inferInsert;

export type TelegramChannel = typeof telegramChannels.$inferSelect;
export type NewTelegramChannel = typeof telegramChannels.$inferInsert;

export type ConfigChange = typeof configChanges.$inferSelect;
export type NewConfigChange = typeof configChanges.$inferInsert;
export type CalibrationHistoryRow = typeof calibrationHistory.$inferSelect;
export type NewCalibrationHistoryRow = typeof calibrationHistory.$inferInsert;

export type AutopilotAction = typeof autopilotActions.$inferSelect;
export type NewAutopilotAction = typeof autopilotActions.$inferInsert;
