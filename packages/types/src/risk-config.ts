// Canonical risk config — single source of truth
// Used by: auto-trade, risk-check API, engine (via Redis config:risk key)

export const RISK_CONFIG = {
  // Capital allocation
  TOTAL_CAPITAL: 0 as number, // 0 = auto-detect from Binance balance
  SIGNAL_POOL_PCT: 0.65,
  GRID_POOL_PCT: 0.25,
  SCALP_POOL_PCT: 0,
  RESERVE_PCT: 0.10,

  // Position limits
  MAX_POSITION_SIZE_PCT: 0.25,
  MAX_OPEN_POSITIONS: 3,
  MAX_SIGNAL_POSITIONS: 2,
  MAX_GRID_POSITIONS: 1,
  MAX_SCALP_POSITIONS: 2,
  MIN_ORDER_VALUE: 7.5,

  // Risk limits
  MIN_CONFIDENCE: 0.65,
  MAX_DAILY_LOSS_PCT: 0.05,
  MAX_WEEKLY_LOSS_PCT: 0.10,
  MAX_SLIPPAGE_PCT: 0.5,
  MAX_TRADES_PER_DAY: 6,
  MAX_PENDING_QUEUE: 30,

  // Execution
  SPOT_ONLY: true,
  TRADING_MODE: 'spot' as 'spot' | 'margin' | 'future',
  MARGIN_TYPE: 'cross' as 'cross' | 'isolated',
  DEFAULT_LEVERAGE: 3,
  TRAILING_STOP_PCT: 3,
  AI_VALIDATION: true,
};

export type RiskConfig = typeof RISK_CONFIG;
