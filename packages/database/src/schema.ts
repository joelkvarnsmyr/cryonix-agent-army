import { pgTable, text, serial, decimal, timestamp, boolean, jsonb, varchar, integer, doublePrecision, index, uniqueIndex } from 'drizzle-orm/pg-core';

// ============================================================================
// USERS TABLE
// ============================================================================

export const users = pgTable('users', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: varchar('name', { length: 255 }),
  email: varchar('email', { length: 255 }).unique().notNull(),
  emailVerified: timestamp('email_verified', { mode: 'date' }),
  image: varchar('image', { length: 255 }),
  username: varchar('username', { length: 50 }).unique(),
  apiKeys: jsonb('api_keys').default([]), // Array of { key: string, label: string, createdAt: string }
  createdAt: timestamp('created_at').defaultNow(),
});

export const accounts = pgTable(
  "account",
  {
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: varchar("type", { length: 255 }).notNull(),
    provider: varchar("provider", { length: 255 }).notNull(),
    providerAccountId: varchar("providerAccountId", { length: 255 }).notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: varchar("token_type", { length: 255 }),
    scope: varchar("scope", { length: 255 }),
    id_token: text("id_token"),
    session_state: varchar("session_state", { length: 255 }),
  },
  (account) => [
    uniqueIndex("account_provider_providerAccountId_idx").on(
      account.provider,
      account.providerAccountId
    ),
  ]
);

export const sessions = pgTable("session", {
  sessionToken: varchar("sessionToken", { length: 255 }).primaryKey(),
  userId: text("userId")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { mode: "date" }).notNull(),
});

export const verificationTokens = pgTable(
  "verificationToken",
  {
    identifier: varchar("identifier", { length: 255 }).notNull(),
    token: varchar("token", { length: 255 }).notNull(),
    expires: timestamp("expires", { mode: "date" }).notNull(),
  },
  (vt) => [
    uniqueIndex("verificationToken_identifier_token_idx").on(
      vt.identifier,
      vt.token
    ),
  ]
);

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
// AKTIENIX POSITIONS TABLE
// ============================================================================

export const aktienixPositions = pgTable('aktienix_positions', {
  id: serial('id').primaryKey(),
  symbol: varchar('symbol', { length: 20 }).notNull(),
  qty: decimal('qty', { precision: 20, scale: 6 }).notNull(),        // Fractional shares (6 decimals)
  avgEntryPrice: decimal('avg_entry_price', { precision: 20, scale: 8 }).notNull(),
  currentPrice: decimal('current_price', { precision: 20, scale: 8 }),
  marketValue: decimal('market_value', { precision: 20, scale: 8 }),
  unrealizedPl: decimal('unrealized_pl', { precision: 20, scale: 8 }),
  realizedPl: decimal('realized_pl', { precision: 20, scale: 8 }),
  highWatermark: decimal('high_watermark', { precision: 20, scale: 8 }), // For trailing stop
  openedAt: timestamp('opened_at').defaultNow().notNull(),
  closedAt: timestamp('closed_at'),
  closeReason: varchar('close_reason', { length: 30 }),  // 'take_profit' | 'stop_loss' | 'trailing_stop' | 'stagnation' | 'eod_close' | 'manual'
  status: varchar('status', { length: 10 }).default('OPEN').notNull(), // 'OPEN' | 'CLOSED'
  broker: varchar('broker', { length: 20 }).default('alpaca').notNull(),  // 'alpaca' | 'ibkr' | 'mock'
  paperTrading: boolean('paper_trading').default(true).notNull(),
  tradingDaysHeld: integer('trading_days_held').default(0),
  metadata: jsonb('metadata'),
}, (table) => [
  index('aktienix_positions_status_idx').on(table.status),
  index('aktienix_positions_symbol_idx').on(table.symbol),
  index('aktienix_positions_opened_at_idx').on(table.openedAt),
]);

// ============================================================================
// AKTIENIX TRADES TABLE
// ============================================================================

export const aktienixTrades = pgTable('aktienix_trades', {
  id: serial('id').primaryKey(),
  timestamp: timestamp('timestamp').defaultNow().notNull(),
  symbol: varchar('symbol', { length: 20 }).notNull(),
  side: varchar('side', { length: 4 }).notNull(),           // 'BUY' | 'SELL'
  qty: decimal('qty', { precision: 20, scale: 6 }).notNull(),
  fillPrice: decimal('fill_price', { precision: 20, scale: 8 }),
  dollarAmount: decimal('dollar_amount', { precision: 20, scale: 2 }),
  realizedPnl: decimal('realized_pnl', { precision: 20, scale: 8 }),  // Null on BUY, set on SELL
  confidence: decimal('confidence', { precision: 5, scale: 4 }),
  reasoning: text('reasoning'),
  exitReason: varchar('exit_reason', { length: 30 }),       // Null on BUY; 'take_profit' etc. on SELL
  broker: varchar('broker', { length: 20 }).default('alpaca').notNull(),
  paperTrading: boolean('paper_trading').default(true).notNull(),
  isDayTrade: boolean('is_day_trade').default(false),
  orderId: varchar('order_id', { length: 64 }),             // Broker order ID
  positionId: integer('position_id').references(() => aktienixPositions.id),
  metadata: jsonb('metadata'),
}, (table) => [
  index('aktienix_trades_timestamp_idx').on(table.timestamp),
  index('aktienix_trades_symbol_idx').on(table.symbol),
  index('aktienix_trades_side_idx').on(table.side),
]);

// ============================================================================
// AKTIENIX SIGNALS TABLE
// ============================================================================

export const aktienixSignals = pgTable('aktienix_signals', {
  id: serial('id').primaryKey(),
  timestamp: timestamp('timestamp').defaultNow().notNull(),
  symbol: varchar('symbol', { length: 20 }).notNull(),
  action: varchar('action', { length: 4 }).notNull(),       // 'BUY' | 'SELL' | 'WAIT'
  confidence: decimal('confidence', { precision: 5, scale: 4 }),
  reasoning: text('reasoning'),
  macroBoost: decimal('macro_boost', { precision: 5, scale: 4 }),   // How much confidence was boosted by macro
  macroBlocked: boolean('macro_blocked').default(false),             // Was this signal blocked by macro?
  macroEvent: varchar('macro_event', { length: 50 }),               // Which macro event caused the boost/block
  indicators: jsonb('indicators'),                                   // RSI, MACD, Bollinger etc.
  source: varchar('source', { length: 10 }).default('ta'),          // 'ta' | 'macro' | 'external'
  executed: boolean('executed').default(false),
}, (table) => [
  index('aktienix_signals_timestamp_idx').on(table.timestamp),
  index('aktienix_signals_symbol_idx').on(table.symbol),
  index('aktienix_signals_executed_idx').on(table.executed),
]);

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

export type AktienixPosition = typeof aktienixPositions.$inferSelect;
export type NewAktienixPosition = typeof aktienixPositions.$inferInsert;
export type AktienixTrade = typeof aktienixTrades.$inferSelect;
export type NewAktienixTrade = typeof aktienixTrades.$inferInsert;
export type AktienixSignal = typeof aktienixSignals.$inferSelect;
export type NewAktienixSignal = typeof aktienixSignals.$inferInsert;

// ============================================================================
// WATCHLIST CHANGES TABLE
// ============================================================================

export const watchlistChanges = pgTable('watchlist_changes', {
  id:              serial('id').primaryKey(),
  runId:           varchar('run_id', { length: 20 }).notNull(),
  runAt:           timestamp('run_at').defaultNow(),
  symbolsBefore:   text('symbols_before').array().notNull(),
  symbolsAfter:    text('symbols_after').array().notNull(),
  added:           text('added').array(),
  removed:         text('removed').array(),
  skippedRemovals: text('skipped_removals').array(),
  fearGreed:       integer('fear_greed'),
  regime:          varchar('regime', { length: 20 }),
  grokReasoning:   text('grok_reasoning'),
  status:          varchar('status', { length: 20 }).default('applied'),
  error:           text('error'),
});

export type WatchlistChange = typeof watchlistChanges.$inferSelect;
export type NewWatchlistChange = typeof watchlistChanges.$inferInsert;

// ============================================================================
// SOLANIX POSITIONS TABLE
// ============================================================================

export const solanixPositions = pgTable('solanix_positions', {
  id: serial('id').primaryKey(),
  symbol: varchar('symbol', { length: 20 }).notNull(),
  mintAddress: varchar('mint_address', { length: 64 }).notNull(),
  qty: decimal('qty', { precision: 20, scale: 8 }).notNull(),
  avgEntryPrice: decimal('avg_entry_price', { precision: 20, scale: 10 }).notNull(),
  currentPrice: decimal('current_price', { precision: 20, scale: 10 }),
  unrealizedPl: decimal('unrealized_pl', { precision: 20, scale: 8 }),
  highWatermark: decimal('high_watermark', { precision: 20, scale: 10 }),
  trailingStopActive: boolean('trailing_stop_active').default(false),
  openedAt: timestamp('opened_at').defaultNow().notNull(),
  closedAt: timestamp('closed_at'),
  closeReason: varchar('close_reason', { length: 30 }),
  status: varchar('status', { length: 10 }).default('OPEN').notNull(),
  paperTrading: boolean('paper_trading').default(true).notNull(),
  confidence: decimal('confidence', { precision: 5, scale: 4 }),
  reasoning: text('reasoning'),
  pnl: decimal('pnl', { precision: 20, scale: 8 }),
  pnlPercent: decimal('pnl_percent', { precision: 10, scale: 4 }),
  metadata: jsonb('metadata'),
}, (table) => [
  index('solanix_positions_status_idx').on(table.status),
  index('solanix_positions_symbol_idx').on(table.symbol),
  index('solanix_positions_opened_at_idx').on(table.openedAt),
]);

// ============================================================================
// SOLANIX TRADES TABLE
// ============================================================================

export const solanixTrades = pgTable('solanix_trades', {
  id: serial('id').primaryKey(),
  timestamp: timestamp('timestamp').defaultNow().notNull(),
  symbol: varchar('symbol', { length: 20 }).notNull(),
  mintAddress: varchar('mint_address', { length: 64 }),
  side: varchar('side', { length: 4 }).notNull(),
  qty: decimal('qty', { precision: 20, scale: 8 }).notNull(),
  fillPrice: decimal('fill_price', { precision: 20, scale: 10 }),
  dollarAmount: decimal('dollar_amount', { precision: 20, scale: 2 }),
  realizedPnl: decimal('realized_pnl', { precision: 20, scale: 8 }),
  confidence: decimal('confidence', { precision: 5, scale: 4 }),
  reasoning: text('reasoning'),
  exitReason: varchar('exit_reason', { length: 30 }),
  paperTrading: boolean('paper_trading').default(true).notNull(),
  orderId: varchar('order_id', { length: 64 }),
  positionId: integer('position_id').references(() => solanixPositions.id),
  metadata: jsonb('metadata'),
}, (table) => [
  index('solanix_trades_timestamp_idx').on(table.timestamp),
  index('solanix_trades_symbol_idx').on(table.symbol),
]);

export type SolanixPosition = typeof solanixPositions.$inferSelect;
export type NewSolanixPosition = typeof solanixPositions.$inferInsert;
export type SolanixTrade = typeof solanixTrades.$inferSelect;
export type NewSolanixTrade = typeof solanixTrades.$inferInsert;
