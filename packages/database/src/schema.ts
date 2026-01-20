import { pgTable, text, serial, decimal, timestamp, boolean, jsonb, varchar, integer } from 'drizzle-orm/pg-core';

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
  agentId: varchar('agent_id', { length: 50 }),
});

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
  targetPrice: decimal('target_price', { precision: 20, scale: 8 }),
  stopLoss: decimal('stop_loss', { precision: 20, scale: 8 }),
  agentId: varchar('agent_id', { length: 50 }),
  executed: boolean('executed').default(false),
});

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
});

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
